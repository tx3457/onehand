import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ZERO_OID = "0000000000000000000000000000000000000000";
const GIT_TIMEOUT_MS = 30_000;
const RETRY_INTERVAL_MS = 25;

export type RepositoryLockScope = "chat" | "checkpoints";

export type RepositoryLockOptions = {
  scope: RepositoryLockScope;
  storageRoot?: string;
  waitMs?: number;
};

export type RepositoryLock = {
  release(): Promise<void>;
};

type OwnerMetadata = {
  pid: number;
  host: string;
  token: string;
  repo: string;
  scope: RepositoryLockScope;
  createdAt: string;
};

type LockStorage = {
  repoRoot: string;
  gitDir: string;
  ref: string;
  scope: RepositoryLockScope;
};

export async function acquireRepositoryLock(
  repo: string,
  options: RepositoryLockOptions
): Promise<RepositoryLock> {
  const waitMs = options.waitMs ?? 0;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("Repository lock waitMs must be a non-negative number");
  const storage = await prepareStorage(repo, options);
  const owner: OwnerMetadata = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    repo: storage.repoRoot,
    scope: options.scope,
    createdAt: new Date().toISOString()
  };
  const ownerOid = await writeOwner(storage, owner);
  const deadline = Date.now() + waitMs;

  while (true) {
    const currentOid = await readRef(storage);
    if (currentOid === undefined) {
      const update = await updateRef(storage, ownerOid, ZERO_OID);
      if (update.ok) return lockHandle(storage, ownerOid);
      const observed = await readRef(storage);
      if (observed === undefined) throw acquisitionError(storage, update);
      if (Date.now() >= deadline) throw lockedError(storage, await readOwner(storage, observed));
      continue;
    }
    const currentOwner = await readOwner(storage, currentOid);
    if (currentOwner !== undefined && ownerIsDeadOnThisHost(currentOwner)) {
      const update = await updateRef(storage, ownerOid, currentOid);
      if (update.ok) return lockHandle(storage, ownerOid);
      const observed = await readRef(storage);
      if (observed === currentOid) throw acquisitionError(storage, update);
      if (Date.now() >= deadline) {
        throw lockedError(storage, observed === undefined ? undefined : await readOwner(storage, observed));
      }
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lockedError(storage, currentOwner);
    await delay(Math.min(RETRY_INTERVAL_MS, remaining));
  }
}

export async function withRepositoryLock<T>(
  repo: string,
  options: RepositoryLockOptions,
  operation: () => Promise<T>
): Promise<T> {
  const lock = await acquireRepositoryLock(repo, options);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

function lockHandle(storage: LockStorage, ownerOid: string): RepositoryLock {
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      const result = await git(storage, ["update-ref", "-d", storage.ref, ownerOid]);
      if (!result.ok) {
        const current = await readRef(storage);
        if (current === ownerOid) throw new Error(`Could not release repository lock: ${result.stderr || `exit ${result.code}`}`);
      }
      released = true;
    }
  };
}

async function prepareStorage(repo: string, options: RepositoryLockOptions): Promise<LockStorage> {
  const repoRoot = await realpath(path.resolve(repo));
  const requestedRoot = path.resolve(options.storageRoot ?? path.join(homedir(), ".onehand", "locks"));
  const storageRoot = await canonicalStoragePath(requestedRoot);
  if (storageRoot === repoRoot || storageRoot.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error("Repository lock storage must be outside the work tree");
  }
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  await chmod(storageRoot, 0o700);
  const canonicalRoot = await realpath(storageRoot);
  const gitDir = path.join(canonicalRoot, "repository-locks.git");
  await ensureBareRepository(repoRoot, canonicalRoot, gitDir);
  const key = createHash("sha256").update(repoRoot).digest("hex");
  return { repoRoot, gitDir, ref: `refs/onehand-locks/${options.scope}/${key}`, scope: options.scope };
}

async function ensureBareRepository(repoRoot: string, storageRoot: string, gitDir: string): Promise<void> {
  const existing = await pathInfo(gitDir);
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Repository lock path is not a directory: ${gitDir}`);
    }
    const valid = await runGit(repoRoot, [`--git-dir=${gitDir}`, "rev-parse", "--is-bare-repository"]);
    if (!valid.ok || valid.stdout.trim() !== "true") {
      throw new Error(`Invalid repository lock storage: ${valid.stderr || gitDir}`);
    }
    return;
  }
  const temporary = await mkdtemp(path.join(storageRoot, ".init-"));
  try {
    const initialized = await runGit(repoRoot, ["init", "--bare", temporary]);
    if (!initialized.ok) throw new Error(`Could not initialize repository lock storage: ${initialized.stderr || `exit ${initialized.code}`}`);
    try {
      await rename(temporary, gitDir);
    } catch (error) {
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function writeOwner(storage: LockStorage, owner: OwnerMetadata): Promise<string> {
  const temporary = await mkdtemp(path.join(path.dirname(storage.gitDir), ".owner-"));
  const metadataPath = path.join(temporary, "metadata.json");
  try {
    await writeFile(metadataPath, JSON.stringify(owner), { mode: 0o600 });
    const result = await git(storage, ["hash-object", "-w", metadataPath]);
    if (!result.ok) throw new Error(`Could not write repository lock owner: ${result.stderr || `exit ${result.code}`}`);
    return result.stdout.trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function readRef(storage: LockStorage): Promise<string | undefined> {
  const result = await git(storage, ["for-each-ref", "--format=%(objectname)", storage.ref]);
  if (!result.ok) {
    throw new Error(`Could not read repository lock: ${result.stderr || `exit ${result.code}`}`);
  }
  return result.stdout.trim() || undefined;
}

async function readOwner(storage: LockStorage, oid: string): Promise<OwnerMetadata | undefined> {
  const result = await git(storage, ["cat-file", "blob", oid]);
  if (!result.ok) return undefined;
  try {
    const value = JSON.parse(result.stdout) as Partial<OwnerMetadata>;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.host !== "string" ||
      typeof value.token !== "string" || value.repo !== storage.repoRoot || value.scope !== storage.scope ||
      typeof value.createdAt !== "string") return undefined;
    return value as OwnerMetadata;
  } catch {
    return undefined;
  }
}

function ownerIsDeadOnThisHost(owner: OwnerMetadata): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function updateRef(storage: LockStorage, newOid: string, oldOid: string): Promise<GitResult> {
  return git(storage, ["update-ref", storage.ref, newOid, oldOid]);
}

function acquisitionError(storage: LockStorage, result: GitResult): Error {
  return new Error(`Could not acquire repository lock for ${storage.scope}: ${result.stderr || `exit ${result.code}`}`);
}

function lockedError(storage: LockStorage, owner: OwnerMetadata | undefined): Error {
  const suffix = owner === undefined ? "owner metadata is unreadable" : `owner pid ${owner.pid} on ${owner.host}`;
  // A reused PID or a changed hostname keeps a crashed owner's lock looking live, so say how to clear it.
  const clear = `git --git-dir ${shellQuote(storage.gitDir)} update-ref -d ${shellQuote(storage.ref)}`;
  return new Error(`Repository is already locked for ${storage.scope}: ${storage.repoRoot} (${suffix}). `
    + `If no OneHand process is using this repository, clear the stale lock with: ${clear}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function git(storage: LockStorage, args: string[]): Promise<GitResult> {
  return runGit(storage.repoRoot, [
    `--git-dir=${storage.gitDir}`,
    "-c", `safe.directory=${storage.gitDir}`,
    "-c", "core.hooksPath=/dev/null",
    ...args
  ]);
}

type GitResult = { ok: boolean; code: number; stdout: string; stderr: string };

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1"
      }
    });
    return { ok: true, code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    return {
      ok: false,
      code: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message
    };
  }
}

async function pathInfo(value: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function canonicalStoragePath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(value) === value) throw error;
    return path.join(await canonicalStoragePath(path.dirname(value)), path.basename(value));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

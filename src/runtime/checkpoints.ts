import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalExecutor } from "./executor.js";
import { HOST_DIFF_FLAGS, HOST_GIT_CONFIG } from "../tools/git.js";
import { isProtectedRepoPath, resolveInsideRepo, resolveSafeRepoPath } from "../tools/pathGuard.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const CHECKPOINT_REF = "refs/heads/checkpoints";
const GIT_TIMEOUT_SEC = 30;

export type Checkpoint = {
  id: string;
  label: string;
  createdAt: string;
  notes?: string[];
};

type StoredCheckpoint = Checkpoint & { excluded: string[] };
type StorePaths = { repoRoot: string; gitDir: string };

export class CheckpointStore {
  private readonly requestedRepoRoot: string;
  private readonly executor = new LocalExecutor();
  private initialized?: Promise<StorePaths>;

  constructor(repoRoot: string) {
    this.requestedRepoRoot = repoRoot;
  }

  async snapshot(label: string): Promise<Checkpoint> {
    if (label.includes("\0")) throw new Error("Checkpoint label cannot contain a null byte");
    const paths = await this.initialize();
    const staged = await this.stageCurrent(paths);
    const createdAt = new Date().toISOString();
    await this.git(paths, [
      "commit", "--allow-empty", "--no-gpg-sign", "-m",
      checkpointMessage({ label, createdAt, notes: staged.notes, excluded: staged.excluded })
    ], commitEnvironment(createdAt));
    const id = (await this.git(paths, ["rev-parse", "HEAD"])).trim();
    return publicCheckpoint({ id, label, createdAt, notes: staged.notes, excluded: staged.excluded });
  }

  async list(): Promise<Checkpoint[]> {
    const paths = await this.initialize();
    const output = await this.tryGit(paths, ["rev-list", CHECKPOINT_REF]);
    if (output === undefined || output === "") return [];
    const checkpoints: Checkpoint[] = [];
    for (const id of output.split("\n").filter(Boolean)) {
      checkpoints.push(publicCheckpoint(await this.readCheckpoint(paths, id)));
    }
    return checkpoints;
  }

  async restore(id: string): Promise<void> {
    const paths = await this.initialize();
    const checkpoint = await this.requireCheckpoint(paths, id);
    const current = await this.temporarySnapshot(paths, checkpoint.excluded);
    const ignored = await this.currentIgnored(paths);
    const added = await this.git(paths, [
      "diff", "--name-only", "--diff-filter=A", "--no-renames", "-z", id, current, "--"
    ]);
    for (const relative of nulFields(added)) {
      const target = await safeRemovalPath(paths.repoRoot, relative);
      if (target !== undefined) await rm(target, { force: true });
    }
    await this.restoreSnapshotFiles(paths, id, ignored);
  }

  async diff(id: string): Promise<string> {
    const paths = await this.initialize();
    const checkpoint = await this.requireCheckpoint(paths, id);
    const current = await this.temporarySnapshot(paths, checkpoint.excluded);
    return this.git(paths, ["diff", ...HOST_DIFF_FLAGS, id, current, "--", "."], undefined, 16 * 1024 * 1024);
  }

  private initialize(): Promise<StorePaths> {
    this.initialized ??= this.initializeOnce();
    return this.initialized;
  }

  private async initializeOnce(): Promise<StorePaths> {
    const repoRoot = await realpath(path.resolve(this.requestedRepoRoot));
    const requestedBase = path.resolve(process.env.ONEHAND_CHECKPOINT_DIR ?? path.join(homedir(), ".onehand", "checkpoints"));
    const base = await canonicalStoragePath(requestedBase);
    if (base === repoRoot || base.startsWith(`${repoRoot}${path.sep}`)) {
      throw new Error("Checkpoint storage must be outside the work tree");
    }
    const key = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
    const gitDir = path.join(base, `${key}.git`);
    await mkdir(base, { recursive: true });
    const existing = await pathInfo(gitDir);
    if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isDirectory())) {
      throw new Error(`Checkpoint repository path is not a directory: ${gitDir}`);
    }
    if (existing === undefined) {
      const result = await this.executor.run({
        program: "git",
        args: [
          ...HOST_GIT_CONFIG,
          `--git-dir=${gitDir}`,
          "init", "--bare"
        ],
        cwd: repoRoot,
        timeoutSec: GIT_TIMEOUT_SEC,
        env: { ...isolatedEnvironment(), GIT_DIR: gitDir }
      });
      ensureCommandSucceeded(result, "Could not initialize checkpoint repository");
    }
    const config = path.join(gitDir, "config");
    const configInfo = await pathInfo(config);
    if (configInfo?.isSymbolicLink()) throw new Error(`Checkpoint repository config is a symbolic link: ${config}`);
    await writeFile(config, "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n");
    const paths = { repoRoot, gitDir };
    await this.git(paths, ["symbolic-ref", "HEAD", CHECKPOINT_REF]);
    return paths;
  }

  private async stageCurrent(paths: StorePaths, inheritedExcludes: string[] = []): Promise<{
    tree: string;
    notes: string[];
    excluded: string[];
  }> {
    await this.git(paths, ["read-tree", "--empty"]);
    const [names, ignored] = await Promise.all([
      this.git(paths, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
      this.git(paths, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", "."])
    ]);
    const excluded = new Set(inheritedExcludes);
    for (const relative of nulFields(ignored)) excluded.add(relative);
    const allowed: string[] = [];
    const notes: string[] = [];
    for (const relative of nulFields(names).sort()) {
      if (pathIsExcluded(relative, excluded) || isProtectedRepoPath(relative)) {
        excluded.add(relative);
        continue;
      }
      const absolute = resolveInsideRepo(paths.repoRoot, relative);
      let info;
      try {
        info = await lstat(absolute);
        await resolveSafeRepoPath(paths.repoRoot, path.dirname(relative), { protectSecrets: false });
      } catch {
        excluded.add(relative);
        continue;
      }
      if (info.isFile() && info.size > MAX_FILE_BYTES) {
        excluded.add(relative);
        notes.push(`Skipped ${relative}: exceeds 5 MB`);
        continue;
      }
      if (info.isFile() || info.isSymbolicLink()) allowed.push(relative);
    }
    if (allowed.length > 0) await this.addPaths(paths, allowed);
    const tree = (await this.git(paths, ["write-tree"])).trim();
    return { tree, notes, excluded: [...excluded].sort() };
  }

  private async addPaths(paths: StorePaths, allowed: string[]): Promise<void> {
    await this.withPathspec(allowed, (pathspec) =>
      this.git(paths, ["add", "-A", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"]));
  }

  private async restoreSnapshotFiles(paths: StorePaths, id: string, ignored: string[]): Promise<void> {
    const snapshotOutput = await this.git(paths, ["ls-tree", "-r", "--name-only", "-z", id]);
    const restorable: string[] = [];
    for (const relative of nulFields(snapshotOutput)) {
      if (isProtectedRepoPath(relative) || ignored.some((entry) => entry === relative ||
        (entry.endsWith("/") && relative.startsWith(entry)))) continue;
      const current = await pathInfo(resolveInsideRepo(paths.repoRoot, relative));
      if (current?.isDirectory() && ignored.some((entry) => entry.startsWith(`${relative}/`))) continue;
      restorable.push(relative);
    }
    if (restorable.length === 0) return;
    await this.withPathspec(restorable, (pathspec) =>
      this.git(paths, ["restore", `--source=${id}`, "--worktree", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"]));
  }

  private async currentIgnored(paths: StorePaths): Promise<string[]> {
    const output = await this.git(paths, [
      "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", "."
    ]);
    return nulFields(output);
  }

  private async withPathspec<T>(
    values: string[],
    operation: (pathspec: string) => Promise<T>
  ): Promise<T> {
    const temporary = await mkdtemp(path.join(tmpdir(), "onehand-checkpoint-paths-"));
    const pathspec = path.join(temporary, "paths");
    try {
      await writeFile(pathspec, `${values.join("\0")}\0`);
      return await operation(pathspec);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async temporarySnapshot(paths: StorePaths, excluded: string[]): Promise<string> {
    const staged = await this.stageCurrent(paths, excluded);
    const createdAt = new Date().toISOString();
    const result = await this.git(paths, ["commit-tree", staged.tree, "-m", "onehand temporary checkpoint"], commitEnvironment(createdAt));
    return result.trim();
  }

  private async requireCheckpoint(paths: StorePaths, id: string): Promise<StoredCheckpoint> {
    if (!/^[0-9a-f]{40,64}$/i.test(id)) throw new Error(`Unknown checkpoint: ${id}`);
    const ids = await this.tryGit(paths, ["rev-list", CHECKPOINT_REF]);
    if (ids === undefined || !ids.split("\n").includes(id)) throw new Error(`Unknown checkpoint: ${id}`);
    return this.readCheckpoint(paths, id);
  }

  private async readCheckpoint(paths: StorePaths, id: string): Promise<StoredCheckpoint> {
    const message = await this.git(paths, ["show", "-s", "--format=%B", id]);
    const line = message.trimEnd().split("\n").at(-1);
    if (line === undefined) throw new Error(`Invalid checkpoint metadata: ${id}`);
    try {
      const metadata = JSON.parse(line) as Omit<StoredCheckpoint, "id">;
      if (typeof metadata.label !== "string" || typeof metadata.createdAt !== "string" || !Array.isArray(metadata.excluded)) {
        throw new Error("invalid fields");
      }
      return { id, ...metadata };
    } catch {
      throw new Error(`Invalid checkpoint metadata: ${id}`);
    }
  }

  private async tryGit(paths: StorePaths, args: string[]): Promise<string | undefined> {
    const result = await this.executor.run({
      program: "git",
      args: [...HOST_GIT_CONFIG, ...args],
      cwd: paths.repoRoot,
      timeoutSec: GIT_TIMEOUT_SEC,
      env: gitEnvironment(paths),
      outputLimitBytes: 16 * 1024 * 1024
    });
    if (!result.ok) throw new Error(result.error);
    if (result.data.exitCode !== 0) return undefined;
    if (result.truncated || result.data.truncated) throw new Error("Checkpoint git output was truncated");
    return result.data.stdout.trimEnd();
  }

  private async git(
    paths: StorePaths,
    args: string[],
    extraEnvironment?: Record<string, string>,
    outputLimitBytes = 16 * 1024 * 1024
  ): Promise<string> {
    const result = await this.executor.run({
      program: "git",
      args: [...HOST_GIT_CONFIG, ...args],
      cwd: paths.repoRoot,
      timeoutSec: GIT_TIMEOUT_SEC,
      env: { ...gitEnvironment(paths), ...extraEnvironment },
      outputLimitBytes
    });
    ensureCommandSucceeded(result, `Checkpoint git ${args[0]} failed`);
    if (!result.ok) throw new Error(result.error);
    return result.data.stdout;
  }
}

function checkpointMessage(metadata: Omit<StoredCheckpoint, "id">): string {
  return `onehand checkpoint\n\n${JSON.stringify(metadata)}`;
}

function publicCheckpoint(checkpoint: StoredCheckpoint): Checkpoint {
  const result: Checkpoint = {
    id: checkpoint.id,
    label: checkpoint.label,
    createdAt: checkpoint.createdAt
  };
  if (checkpoint.notes !== undefined && checkpoint.notes.length > 0) result.notes = checkpoint.notes;
  return result;
}

function gitEnvironment(paths: StorePaths): Record<string, string> {
  return {
    ...isolatedEnvironment(),
    GIT_DIR: paths.gitDir,
    GIT_WORK_TREE: paths.repoRoot
  };
}

function isolatedEnvironment(): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1"
  };
}

function commitEnvironment(createdAt: string): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: "OneHand",
    GIT_AUTHOR_EMAIL: "onehand@localhost",
    GIT_COMMITTER_NAME: "OneHand",
    GIT_COMMITTER_EMAIL: "onehand@localhost",
    GIT_AUTHOR_DATE: createdAt,
    GIT_COMMITTER_DATE: createdAt
  };
}

function ensureCommandSucceeded(
  result: Awaited<ReturnType<LocalExecutor["run"]>>,
  context: string
): void {
  if (!result.ok) throw new Error(`${context}: ${result.error}`);
  if (result.data.exitCode !== 0) {
    throw new Error(`${context}: ${result.data.stderr || result.data.stdout || `exit ${result.data.exitCode}`}`);
  }
  if (result.truncated || result.data.truncated) throw new Error(`${context}: output was truncated`);
}

function nulFields(output: string): string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields.filter(Boolean);
}

async function safeRemovalPath(repoRoot: string, relative: string): Promise<string | undefined> {
  if (isProtectedRepoPath(relative)) return undefined;
  const absolute = resolveInsideRepo(repoRoot, relative);
  try {
    await resolveSafeRepoPath(repoRoot, path.dirname(relative), { protectSecrets: false });
    const info = await lstat(absolute);
    if (info.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return absolute;
}

function pathIsExcluded(relative: string, excluded: Set<string>): boolean {
  for (const entry of excluded) {
    if (entry === relative || (entry.endsWith("/") && relative.startsWith(entry))) return true;
  }
  return false;
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

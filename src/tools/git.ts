import { LocalExecutor } from "../runtime/executor.js";
import { CommandExecution, ToolResult } from "../types.js";
import { isProtectedRepoPath, resolveSafeRepoPath } from "./pathGuard.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";

// Host git reads a checkout that commands, including ones inside a container, can write, so repository
// config must not make it run a program: no fsmonitor hook, no hooks, no external diff or textconv driver.
export const HOST_GIT_CONFIG = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"];
export const HOST_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"];
// Next to a container, the user's global and system config (filters, drivers, excludes) stays out as well.
const ISOLATED_GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const hostExecutor = new LocalExecutor();

export type HostGitOptions = { timeoutSec: number; isolatedConfig?: boolean; outputLimitBytes?: number };

// Fixed, internal git invocations only: they bypass the model command policy, which refuses `git -c`.
export function runHostGit(repoRoot: string, args: string[], options: HostGitOptions): Promise<ToolResult<CommandExecution>> {
  return hostExecutor.run({
    program: "git",
    args: [...HOST_GIT_CONFIG, ...args],
    cwd: repoRoot,
    timeoutSec: options.timeoutSec,
    env: options.isolatedConfig ? ISOLATED_GIT_ENV : undefined,
    outputLimitBytes: options.outputLimitBytes,
    displayCommand: ["git", ...args].join(" ")
  });
}

export async function gitStatus(
  repoRoot: string,
  timeoutSec: number,
  isolatedConfig = false
): Promise<ToolResult<{ output: string; changedFiles: string[] }>> {
  const repoCheck = await ensureGitRepository(repoRoot, timeoutSec, isolatedConfig);
  if (!repoCheck.ok) return repoCheck;

  const result = await runHostGit(repoRoot, ["status", "--short"], { timeoutSec, isolatedConfig });

  if (!result.ok) return result;
  if (result.data.exitCode !== 0) {
    return {
      ok: false,
      error: result.data.stderr || result.data.stdout || "git status failed",
      recoverable: true
    };
  }

  const safeOutput = result.data.stdout.split("\n").filter((line) => line && !statusLineIsProtected(line)).join("\n");
  return {
    ok: true,
    data: {
      output: safeOutput ? `${safeOutput}\n` : "",
      changedFiles: parseChangedFiles(safeOutput)
    },
    truncated: result.truncated
  };
}

export async function gitDiff(
  repoRoot: string,
  timeoutSec: number,
  isolatedConfig = false,
  base?: "HEAD"
): Promise<ToolResult<{ diff: string }>> {
  const repoCheck = await ensureGitRepository(repoRoot, timeoutSec, isolatedConfig);
  if (!repoCheck.ok) return repoCheck;

  const result = await runHostGit(repoRoot, [
    "diff", ...HOST_DIFF_FLAGS, ...(base ? [base] : []), "--", ".",
    ":(exclude).env", ":(exclude)**/.env",
    ":(exclude).env.*", ":(exclude)**/.env.*",
    ":(exclude)*.pem", ":(exclude)**/*.pem",
    ":(exclude)*.key", ":(exclude)**/*.key",
    ":(exclude)*.p12", ":(exclude)**/*.p12",
    ":(exclude).npmrc", ":(exclude)**/.npmrc",
    ":(exclude).pypirc", ":(exclude)**/.pypirc",
    ":(exclude)id_rsa", ":(exclude)**/id_rsa",
    ":(exclude)id_ed25519", ":(exclude)**/id_ed25519"
  ], { timeoutSec, isolatedConfig, outputLimitBytes: 1024 * 1024 });

  if (!result.ok) return result;
  if (result.data.exitCode !== 0) {
    return {
      ok: false,
      error: result.data.stderr || result.data.stdout || "git diff failed",
      recoverable: true
    };
  }

  return {
    ok: true,
    data: { diff: result.data.stdout },
    truncated: result.truncated
  };
}

export async function repositoryContentDigest(
  repoRoot: string,
  timeoutSec: number,
  isolatedConfig = false
): Promise<ToolResult<{ digest: string; changedFiles: string[] }>> {
  const repoCheck = await ensureGitRepository(repoRoot, timeoutSec, isolatedConfig);
  if (!repoCheck.ok) return repoCheck;
  const status = await runHostGit(repoRoot, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"
  ], { timeoutSec, isolatedConfig, outputLimitBytes: 16 * 1024 * 1024 });
  if (!status.ok) return status;
  if (status.data.exitCode !== 0) {
    return failure(status.data.stderr || status.data.stdout || "git status failed");
  }
  if (status.truncated || status.data.truncated) return failure("git status output was truncated");

  let entries: StatusEntry[];
  try {
    entries = parsePorcelainZ(status.data.stdout);
    if (entries.some((entry) => entry.paths.some(isProtectedRepoPath))) {
      return failure("Repository has a changed protected path; content digest refused");
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  const hash = createHash("sha256");
  try {
    for (const entry of entries) {
      for (const item of entry.paths) hashField(hash, item);
      const absolute = path.join(repoRoot, entry.path);
      await resolveSafeRepoPath(repoRoot, entry.path);
      let info;
      try {
        info = await lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          hash.update("missing\0");
          continue;
        }
        throw error;
      }
      if (info.isSymbolicLink()) {
        hash.update("symlink\0");
        hashField(hash, await readlink(absolute));
      } else if (info.isFile()) {
        hash.update("file\0");
        hash.update(`executable:${info.mode & 0o111 ? "yes" : "no"}\0`);
        await hashFile(hash, absolute, info.size);
      } else {
        hash.update(`other:${info.mode}:${info.size}\0`);
      }
    }
  } catch (error) {
    return failure(`Could not hash repository content: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, data: { digest: hash.digest("hex"), changedFiles: entries.map((entry) => entry.path) } };
}

async function ensureGitRepository(
  repoRoot: string,
  timeoutSec: number,
  isolatedConfig: boolean
): Promise<ToolResult<{ inside: true }>> {
  const result = await runHostGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], { timeoutSec, isolatedConfig });

  if (!result.ok) return result;
  if (result.data.exitCode !== 0 || result.data.stdout.trim() !== "true") {
    return {
      ok: false,
      error: "Not a git repository",
      recoverable: true
    };
  }

  return { ok: true, data: { inside: true } };
}

function parseChangedFiles(status: string): string[] {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => {
      const rename = file.split(" -> ");
      return rename[rename.length - 1]!;
    })
    .filter(Boolean);
}

function statusLineIsProtected(line: string): boolean {
  const value = line.slice(3).trim();
  return value.split(" -> ").some((file) => isProtectedRepoPath(file));
}

type StatusEntry = { path: string; paths: string[] };

function parsePorcelainZ(output: string): StatusEntry[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4 || field[2] !== " ") throw new Error("Unexpected git status output");
    const status = field.slice(0, 2);
    const current = field.slice(3);
    const renamed = status.includes("R") || status.includes("C");
    const original = renamed ? fields[++index] : undefined;
    if (!current || (renamed && !original)) throw new Error("Unexpected git status rename output");
    entries.push({ path: current, paths: original ? [current, original] : [current] });
  }
  return entries;
}

function hashField(hash: ReturnType<typeof createHash>, value: string): void {
  hashBytes(hash, Buffer.from(value));
}

function hashBytes(hash: ReturnType<typeof createHash>, bytes: Buffer): void {
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
  hash.update("\0");
}

async function hashFile(hash: ReturnType<typeof createHash>, file: string, size: number): Promise<void> {
  hash.update(String(size));
  hash.update(":");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  hash.update("\0");
}

function failure(error: string): ToolResult<never> {
  return { ok: false, error, recoverable: true };
}

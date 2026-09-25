import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HOST_DIFF_FLAGS, HOST_GIT_CONFIG } from "../../src/tools/git.js";

const execFileAsync = promisify(execFile);
// Agent scratch files never reach the patch, even in a repository without the info/exclude entry.
const EXCLUDE_SCRATCH = ":(exclude).scratch";
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
// The host, not the tree: ENOSPC, EROFS, or EIO writing the temporary index.
const HOST_IO_FAILURE = /No space left on device|Read-only file system|Input\/output error/;

export type ExtractedPatch = {
  patch: string;
  bytes: number;
  files: string[];
  // What git could not read (files the agent made unreadable, an uninitialized nested repository); the
  // rest of the tree is in the patch.
  warnings: string[];
};

// The working tree the agent left kept its patch from being extracted: the run is scored unresolved.
export class PatchExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PatchExtractionError";
  }
}

// The agent's change against the base commit: tracked edits, new files, deletions, and binary files.
// A temporary index keeps the repository's own index (what git_status/git_diff show) untouched.
export async function extractPatch(hostRepo: string, baseCommit: string): Promise<ExtractedPatch> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "onehand-index-"));
  const env = { GIT_INDEX_FILE: path.join(tempDir, "index") };
  try {
    await copyFile(path.join(hostRepo, ".git", "index"), env.GIT_INDEX_FILE);
    const warnings = await stageAll(hostRepo, env);
    const diff = ["diff", "--cached", ...HOST_DIFF_FLAGS, "--no-renames"];
    try {
      const patch = await git(hostRepo, [...diff, "--binary", baseCommit, "--", ".", EXCLUDE_SCRATCH], { env });
      const names = await git(hostRepo, [...diff, "--name-only", "-z", baseCommit, "--", ".", EXCLUDE_SCRATCH], { env });
      return { patch, bytes: Buffer.byteLength(patch), files: names.split("\0").filter(Boolean).sort(), warnings };
    } catch (error) {
      if (causeCode(error) !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
      throw new PatchExtractionError(`The patch is larger than ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB`, { cause: error });
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function applyPatch(repo: string, patch: string): Promise<void> {
  await git(repo, ["apply", "--whitespace=nowarn", "-"], { input: patch });
}

// The user's global and system git config (excludesFile, diff.noprefix, color, hooks, LFS filters)
// must not change which files a patch contains or how it is formatted, and no config may run a program.
export async function git(
  cwd: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {}
): Promise<string> {
  return (await gitOutput(cwd, args, options)).stdout;
}

// Stages the whole tree into the temporary index. No pathspec: git add refuses one that names an ignored path
// such as .scratch. --ignore-errors stages everything git can read and still exits 1 for what it skipped;
// only a fatal error, from the tree the agent left, stops it.
async function stageAll(repo: string, env: Record<string, string>): Promise<string[]> {
  const notes = (stderr: string) => stderr.split("\n").map((line) => line.trim()).filter((line) => /^(error|warning): /.test(line));
  try {
    return notes((await gitOutput(repo, ["add", "-A", "--ignore-errors"], { env })).stderr);
  } catch (error) {
    const stderr = String((error as { cause?: { stderr?: unknown } }).cause?.stderr ?? "");
    if (causeCode(error) === 1 && !/^fatal: /m.test(stderr)) return notes(stderr);
    if (typeof causeCode(error) !== "number" || HOST_IO_FAILURE.test(stderr)) throw error;
    throw new PatchExtractionError(`git add could not stage the working tree: ${stderr.trim().slice(-500)}`, { cause: error });
  }
}

async function gitOutput(
  cwd: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string }
): Promise<{ stdout: string; stderr: string }> {
  const pending = execFileAsync("git", [...HOST_GIT_CONFIG, ...args], {
    cwd,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...options.env
    }
  });
  // A git that exits without reading stdin closes the pipe; its exit status reports any failure.
  pending.child.stdin?.on("error", () => undefined);
  if (options.input === undefined) pending.child.stdin?.end();
  else pending.child.stdin?.end(options.input);
  try {
    const { stdout, stderr } = await pending;
    return { stdout, stderr };
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`git ${args[0]} failed in ${cwd}: ${stderr || (error as Error).message}`, { cause: error });
  }
}

// The exit status of a git that ran, or the Node error code of one that could not run or overflowed.
function causeCode(error: unknown): unknown {
  return (error as { cause?: { code?: unknown } }).cause?.code;
}

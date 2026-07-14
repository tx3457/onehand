import { ToolResult } from "../types.js";
import { runShellCommand } from "./command.js";

export async function gitStatus(
  repoRoot: string,
  timeoutSec: number
): Promise<ToolResult<{ output: string; changedFiles: string[] }>> {
  const repoCheck = await ensureGitRepository(repoRoot, timeoutSec);
  if (!repoCheck.ok) return repoCheck;

  const result = await runShellCommand({
    command: "git status --short",
    cwd: repoRoot,
    timeoutSec,
    allowDestructive: false
  });

  if (!result.ok) return result;
  if (result.data.exitCode !== 0) {
    return {
      ok: false,
      error: result.data.stderr || result.data.stdout || "git status failed",
      recoverable: true
    };
  }

  return {
    ok: true,
    data: {
      output: result.data.stdout,
      changedFiles: parseChangedFiles(result.data.stdout)
    },
    truncated: result.truncated
  };
}

export async function gitDiff(
  repoRoot: string,
  timeoutSec: number
): Promise<ToolResult<{ diff: string }>> {
  const repoCheck = await ensureGitRepository(repoRoot, timeoutSec);
  if (!repoCheck.ok) return repoCheck;

  const result = await runShellCommand({
    command: "git diff --",
    cwd: repoRoot,
    timeoutSec,
    allowDestructive: false,
    outputLimitBytes: 1024 * 1024
  });

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

async function ensureGitRepository(
  repoRoot: string,
  timeoutSec: number
): Promise<ToolResult<{ inside: true }>> {
  const result = await runShellCommand({
    command: "git rev-parse --is-inside-work-tree",
    cwd: repoRoot,
    timeoutSec,
    allowDestructive: false
  });

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

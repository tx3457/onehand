import { LocalExecutor } from "../runtime/executor.js";
import { CommandExecution, ToolResult } from "../types.js";
import { isProtectedRepoPath } from "./pathGuard.js";

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
  isolatedConfig = false
): Promise<ToolResult<{ diff: string }>> {
  const repoCheck = await ensureGitRepository(repoRoot, timeoutSec, isolatedConfig);
  if (!repoCheck.ok) return repoCheck;

  const result = await runHostGit(repoRoot, [
    "diff", ...HOST_DIFF_FLAGS, "--", ".",
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

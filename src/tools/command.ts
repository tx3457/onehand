import { spawn } from "node:child_process";
import { CommandExecution, ToolResult } from "../types.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT, truncateText } from "../utils/truncate.js";

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /(^|[;&|]\s*)sudo(\s|$)/i,
  /(^|[;&|]\s*)su(\s|$)/i,
  /(^|[;&|]\s*)mkfs(\.|\s|$)/i,
  /(^|[;&|]\s*)dd(\s|$)/i,
  /(^|[;&|]\s*)shutdown(\s|$)/i,
  /(^|[;&|]\s*)reboot(\s|$)/i,
  /(^|[;&|]\s*)git\s+reset\s+--hard(\s|$)/i,
  /(^|[;&|]\s*)git\s+clean\s+-[a-z]*[fdx][a-z]*\s*($|[;&|])/i,
  /(^|[;&|]\s*)rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(\/|~)(\s|$)/i,
  /(^|[;&|]\s*)rm\s+-[a-z]*f[a-z]*r[a-z]*\s+(\/|~)(\s|$)/i
];

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command.trim()));
}

export async function runShellCommand(options: {
  command: string;
  cwd: string;
  timeoutSec: number;
  allowDestructive?: boolean;
  outputLimitBytes?: number;
}): Promise<ToolResult<CommandExecution>> {
  if (!options.allowDestructive && isDestructiveCommand(options.command)) {
    return {
      ok: false,
      error: `Refusing to run destructive command: ${options.command}`,
      recoverable: true
    };
  }

  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_TOOL_OUTPUT_LIMIT;
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1_000).unref();
    }, Math.max(1, options.timeoutSec) * 1_000);

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      settled = true;
      resolve({ ok: false, error: error.message, recoverable: true });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      settled = true;
      const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");
      const stdout = truncateText(stdoutRaw, outputLimitBytes);
      const stderr = truncateText(stderrRaw, outputLimitBytes);

      resolve({
        ok: true,
        data: {
          command: options.command,
          exitCode: timedOut ? null : code,
          stdout: stdout.text,
          stderr: stderr.text,
          timedOut,
          durationMs: Date.now() - started,
          truncated: stdout.truncated || stderr.truncated
        },
        truncated: stdout.truncated || stderr.truncated
      });
    });
  });
}

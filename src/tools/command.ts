import { spawn } from "node:child_process";
import path from "node:path";
import { CommandExecution, ToolResult } from "../types.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT, truncateText } from "../utils/truncate.js";

const SHELL_META = new Set(["|", "&", ";", ">", "<", "\n", "\r"]);
const NETWORK_PROGRAMS = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "ftp", "telnet", "nc", "ncat", "socat"
]);
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "fish", "powershell", "pwsh"]);
const PROGRAM_ALLOWLIST = new Set([
  "node", "npm", "pnpm", "yarn", "bun", "python", "python3", "pytest", "uv", "cargo", "go",
  "git", "rg", "grep", "sed", "cat", "head", "tail", "ls", "find", "tsc", "vitest",
  "eslint", "prettier", "make", "cmake", "java", "javac", "mvn", "mvnw", "gradle", "gradlew",
  "dotnet", "ruby", "php"
]);
const PACKAGE_MUTATIONS: Record<string, Set<string>> = {
  npm: new Set(["install", "i", "add", "uninstall", "remove", "update", "publish"]),
  pnpm: new Set(["install", "i", "add", "remove", "update", "publish", "fetch"]),
  yarn: new Set(["add", "remove", "install", "upgrade", "publish"]),
  bun: new Set(["add", "remove", "install", "update", "publish"]),
  pip: new Set(["install", "uninstall", "download"]),
  pip3: new Set(["install", "uninstall", "download"]),
  uv: new Set(["add", "remove", "sync", "lock", "pip", "tool", "python"]),
  cargo: new Set(["install", "publish", "login"]),
  go: new Set(["get", "install"])
};
const GIT_ALLOWED = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "branch"
]);
const SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "CI"];

export type StructuredCommand = { program: string; args: string[] };

export function parseCommand(command: string): StructuredCommand {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let started = false;

  const push = () => {
    if (!started) return;
    tokens.push(current);
    current = "";
    started = false;
  };

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = null;
      else if (char === "\\") escaped = true;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'") {
      quote = "single";
      started = true;
    } else if (char === '"') {
      quote = "double";
      started = true;
    } else if (char === "\\") {
      escaped = true;
      started = true;
    } else if (SHELL_META.has(char)) {
      throw new Error(`Shell operator ${JSON.stringify(char)} is not allowed`);
    } else if (/\s/.test(char)) {
      push();
    } else {
      current += char;
      started = true;
    }
  }
  if (escaped || quote) throw new Error("Unterminated quote or escape in command");
  push();
  if (tokens.length === 0) throw new Error("Command is required");
  return { program: tokens[0]!, args: tokens.slice(1) };
}

export function isDestructiveCommand(command: string): boolean {
  try {
    const parsed = parseCommand(command);
    return commandPolicyError(parsed.program, parsed.args) !== null;
  } catch {
    return true;
  }
}

export async function runShellCommand(options: {
  command: string;
  cwd: string;
  timeoutSec: number;
  allowDestructive?: boolean;
  outputLimitBytes?: number;
}): Promise<ToolResult<CommandExecution>> {
  let parsed: StructuredCommand;
  try {
    parsed = parseCommand(options.command);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  return runProgramCommand({
    ...parsed,
    displayCommand: options.command,
    cwd: options.cwd,
    timeoutSec: options.timeoutSec,
    allowDestructive: options.allowDestructive,
    outputLimitBytes: options.outputLimitBytes
  });
}

export async function runProgramCommand(options: {
  program: string;
  args?: string[];
  displayCommand?: string;
  cwd: string;
  timeoutSec: number;
  allowDestructive?: boolean;
  outputLimitBytes?: number;
}): Promise<ToolResult<CommandExecution>> {
  const args = options.args ?? [];
  const policyError = commandPolicyError(options.program, args);
  if (policyError && !(options.allowDestructive && policyError.startsWith("Destructive"))) {
    return failure(policyError);
  }

  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_TOOL_OUTPUT_LIMIT;
  const started = Date.now();
  const command = options.displayCommand ?? [options.program, ...args].join(" ");

  return new Promise((resolve) => {
    const child = spawn(options.program, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: safeEnvironment()
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const finish = (result: ToolResult<CommandExecution>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, Math.max(1, options.timeoutSec) * 1_000);

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => finish(failure(error.message)));
    child.on("close", (code) => {
      const stdout = truncateText(Buffer.concat(stdoutChunks).toString("utf8"), outputLimitBytes);
      const stderr = truncateText(Buffer.concat(stderrChunks).toString("utf8"), outputLimitBytes);
      finish({
        ok: true,
        data: {
          command,
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

function commandPolicyError(program: string, args: string[]): string | null {
  const base = path.basename(program).toLowerCase();
  const first = args[0]?.toLowerCase() ?? "";
  if (program !== base && (path.isAbsolute(program) || /[\\/]/.test(program))) {
    return "Executable paths are disabled; use an allowlisted program name";
  }
  if (!PROGRAM_ALLOWLIST.has(base)) return `Program is outside the local execution allowlist: ${base}`;
  if (NETWORK_PROGRAMS.has(base) || base === "npx") return `Network-capable command is disabled: ${base}`;
  if (SHELL_PROGRAMS.has(base)) return `Shell interpreters are disabled: ${base}`;
  if (new Set(["sudo", "su", "rm", "mkfs", "dd", "shutdown", "reboot"]).has(base)) {
    return `Destructive command is disabled: ${base}`;
  }
  if (PACKAGE_MUTATIONS[base]?.has(first)) return `Dependency or environment mutation is disabled: ${base} ${first}`;
  if (base === "git" && !GIT_ALLOWED.has(first)) return `Git mutation or network operation is disabled: git ${first || "<none>"}`;
  if (base === "git" && first === "branch" && args.slice(1).some((arg) => !["--list", "--show-current", "-a", "--all"].includes(arg))) {
    return "Git branch mutation is disabled";
  }
  return null;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function failure(error: string): ToolResult<never> {
  return { ok: false, error, recoverable: true };
}

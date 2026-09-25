import path from "node:path";
import { LocalExecutor } from "../runtime/executor.js";
import { CommandExecution, ToolResult } from "../types.js";

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
const localExecutor = new LocalExecutor();

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

// Shell-quotes one argument so that parseCommand reads it back unchanged.
export function quoteArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
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
  truncation?: "head" | "head_tail";
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
    outputLimitBytes: options.outputLimitBytes,
    truncation: options.truncation
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
  // Callers that parse the output keep the head-only default; model-facing tools opt into head_tail.
  truncation?: "head" | "head_tail";
}): Promise<ToolResult<CommandExecution>> {
  const args = options.args ?? [];
  const policyError = commandPolicyError(options.program, args, options.allowDestructive);
  if (policyError) return failure(policyError);
  return localExecutor.run({
    program: options.program,
    args,
    cwd: options.cwd,
    timeoutSec: options.timeoutSec,
    outputLimitBytes: options.outputLimitBytes,
    truncation: options.truncation,
    displayCommand: options.displayCommand
  });
}

export function commandPolicyError(program: string, args: string[], allowDestructive = false): string | null {
  const base = path.basename(program).toLowerCase();
  const first = args[0]?.toLowerCase() ?? "";
  if (program !== base && (path.isAbsolute(program) || /[\\/]/.test(program))) {
    return "Executable paths are disabled; use an allowlisted program name";
  }
  if (!PROGRAM_ALLOWLIST.has(base)) return `Program is outside the local execution allowlist: ${base}`;
  if (NETWORK_PROGRAMS.has(base) || base === "npx") return `Network-capable command is disabled: ${base}`;
  if (SHELL_PROGRAMS.has(base)) return `Shell interpreters are disabled: ${base}`;
  if (new Set(["sudo", "su", "rm", "mkfs", "dd", "shutdown", "reboot"]).has(base)) {
    return allowDestructive ? null : `Destructive command is disabled: ${base}`;
  }
  if (PACKAGE_MUTATIONS[base]?.has(first)) return `Dependency or environment mutation is disabled: ${base} ${first}`;
  if (base === "git" && !GIT_ALLOWED.has(first)) return `Git mutation or network operation is disabled: git ${first || "<none>"}`;
  if (base === "git" && first === "branch" && args.slice(1).some((arg) => !["--list", "--show-current", "-a", "--all"].includes(arg))) {
    return "Git branch mutation is disabled";
  }
  return null;
}

function failure(error: string): ToolResult<never> {
  return { ok: false, error, recoverable: true };
}

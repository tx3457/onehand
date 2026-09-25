import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isReadOnlyInspectionCommand } from "../tools/command.js";

export type PermissionMode = "ask" | "edit" | "auto";
export type ToolRisk = "read" | "write" | "exec" | "plan";

export type AuthorizationRequest = {
  name: string;
  args: Record<string, unknown>;
  risk: ToolRisk;
};

export type PermissionRules = {
  allow?: string[];
  deny?: string[];
};

export type PermissionSource = "cli" | "project" | "user" | "session" | "mode";

export type PermissionDecision = {
  decision: "allow" | "deny" | "ask";
  source: PermissionSource;
};

export type PermissionConfig = {
  project?: PermissionRules;
  user?: PermissionRules;
};

export type PermissionEngineOptions = {
  mode: PermissionMode;
  cliRules?: PermissionRules;
  projectRules?: PermissionRules;
  userRules?: PermissionRules;
};

const READ_TOOLS = new Set(["list_files", "search_code", "read_file", "git_status", "git_diff"]);
const WRITE_TOOLS = new Set(["write_file", "replace_text"]);
const PLAN_TOOLS = new Set(["set_plan", "update_plan", "finish_task"]);

export function classifyToolRisk(name: string, args: Record<string, unknown>): ToolRisk {
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  if (PLAN_TOOLS.has(name)) return "plan";
  if (name === "run_command") {
    const program = typeof args.program === "string" ? args.program : "";
    const commandArgs = Array.isArray(args.args) && args.args.every((arg) => typeof arg === "string")
      ? args.args as string[]
      : [];
    return program && isReadOnlyInspectionCommand(program, commandArgs) ? "read" : "exec";
  }
  return "exec";
}

export class PermissionEngine {
  private currentMode: PermissionMode;
  private readonly sources: Array<{ source: "cli" | "project" | "user"; rules?: PermissionRules }>;
  private readonly sessionAllows = new Set<string>();

  constructor(options: PermissionEngineOptions) {
    this.currentMode = options.mode;
    this.sources = [
      { source: "cli", rules: options.cliRules },
      { source: "project", rules: options.projectRules },
      { source: "user", rules: options.userRules }
    ];
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }

  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
  }

  resolve(request: AuthorizationRequest): PermissionDecision {
    for (const { source, rules } of this.sources) {
      if (rules?.deny?.some((pattern) => matchesPattern(pattern, request))) {
        return { decision: "deny", source };
      }
    }

    if (this.sessionAllows.has(sessionKey(request))) {
      return { decision: "allow", source: "session" };
    }

    for (const { source, rules } of this.sources) {
      if (rules?.allow?.some((pattern) => matchesPattern(pattern, request))) {
        return { decision: "allow", source };
      }
    }

    return { decision: modeDecision(this.currentMode, request.risk), source: "mode" };
  }

  allowForSession(request: AuthorizationRequest): void {
    this.sessionAllows.add(sessionKey(request));
  }
}

export async function loadPermissionConfig(repoRoot: string, userHome = homedir()): Promise<PermissionConfig> {
  const normalizedRoot = await realpath(path.resolve(repoRoot));
  const project = await readPermissionRules(path.join(normalizedRoot, ".onehand", "config.json"), "project");
  const user = await readPermissionRules(path.join(path.resolve(userHome), ".onehand", "config.json"), "user");
  return {
    ...(project ? { project } : {}),
    ...(user ? { user } : {})
  };
}

function modeDecision(mode: PermissionMode, risk: ToolRisk): PermissionDecision["decision"] {
  if (risk === "read" || risk === "plan") return "allow";
  if (mode === "auto") return "allow";
  return mode === "edit" ? "ask" : "deny";
}

function matchesPattern(pattern: string, request: AuthorizationRequest): boolean {
  if (pattern === request.name) return true;
  if (request.name !== "run_command" || !pattern.startsWith("run_command:")) return false;

  const tokens = pattern.slice("run_command:".length).split(/\s+/).filter(Boolean);
  const program = request.args.program;
  if (tokens.length === 0 || typeof program !== "string" || tokens[0] !== program) return false;
  const args = request.args.args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return tokens.length === 1;
  return tokens.slice(1).every((token, index) => args[index] === token);
}

function sessionKey(request: AuthorizationRequest): string {
  if (request.name !== "run_command") return request.name;
  const program = request.args.program;
  return typeof program === "string" && program ? `run_command:${program}` : "run_command";
}

async function readPermissionRules(file: string, label: "project" | "user"): Promise<PermissionRules | undefined> {
  const directory = path.dirname(file);
  const directoryInfo = await lstatOrUndefined(directory);
  if (!directoryInfo) return undefined;
  if (directoryInfo.isSymbolicLink()) throw new Error(`${capitalize(label)} permission config directory cannot be a symbolic link`);
  if (!directoryInfo.isDirectory()) throw new Error(`${capitalize(label)} permission config directory is not a directory`);

  const fileInfo = await lstatOrUndefined(file);
  if (!fileInfo) return undefined;
  if (fileInfo.isSymbolicLink()) throw new Error(`${capitalize(label)} permission config cannot be a symbolic link`);
  if (!fileInfo.isFile()) throw new Error(`${capitalize(label)} permission config is not a file`);
  if (fileInfo.size > 1024 * 1024) throw new Error(`${capitalize(label)} permission config is too large`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${capitalize(label)} permission config has invalid JSON: ${error.message}`);
    }
    throw error;
  }
  if (!isRecord(parsed)) throw new Error(`${capitalize(label)} permission config must contain a JSON object`);
  if (parsed.permissions === undefined) return undefined;
  if (!isRecord(parsed.permissions)) throw new Error(`${capitalize(label)} permission config permissions must be an object`);
  return validateRules(parsed.permissions, label);
}

function validateRules(value: Record<string, unknown>, label: "project" | "user"): PermissionRules {
  const unknown = Object.keys(value).find((key) => key !== "allow" && key !== "deny");
  if (unknown) throw new Error(`${capitalize(label)} permission config has unknown permissions key: ${unknown}`);
  const rules: PermissionRules = {};
  for (const key of ["allow", "deny"] as const) {
    const entries = value[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) {
      throw new Error(`${capitalize(label)} permission config ${key} must be an array of non-empty strings`);
    }
    const invalid = entries.find((entry) => !validPattern(entry));
    if (invalid !== undefined) throw new Error(`${capitalize(label)} permission config has invalid ${key} pattern: ${JSON.stringify(invalid)}`);
    rules[key] = entries;
  }
  return rules;
}

function validPattern(pattern: string): boolean {
  if (/^[A-Za-z0-9_]+$/.test(pattern)) return true;
  return /^run_command:[^\s:]+(?: [^\s]+)*$/.test(pattern);
}

async function lstatOrUndefined(file: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

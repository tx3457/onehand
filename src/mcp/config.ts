import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
};

export async function loadMcpConfig(
  repoRoot: string,
  userHome = homedir()
): Promise<Record<string, McpServerConfig>> {
  const normalizedRoot = await realpath(path.resolve(repoRoot));
  const user = await readServers(path.join(path.resolve(userHome), ".onehand", "config.json"), "user");
  const project = await readServers(path.join(normalizedRoot, ".onehand", "config.json"), "project");
  return { ...user, ...project };
}

async function readServers(
  file: string,
  label: "project" | "user"
): Promise<Record<string, McpServerConfig>> {
  const directory = path.dirname(file);
  const directoryInfo = await lstatOrUndefined(directory);
  if (!directoryInfo) return {};
  if (directoryInfo.isSymbolicLink()) throw new Error(`${capitalize(label)} MCP config directory cannot be a symbolic link`);
  if (!directoryInfo.isDirectory()) throw new Error(`${capitalize(label)} MCP config directory is not a directory`);

  const fileInfo = await lstatOrUndefined(file);
  if (!fileInfo) return {};
  if (fileInfo.isSymbolicLink()) throw new Error(`${capitalize(label)} MCP config cannot be a symbolic link`);
  if (!fileInfo.isFile()) throw new Error(`${capitalize(label)} MCP config is not a file`);
  if (fileInfo.size > 1024 * 1024) throw new Error(`${capitalize(label)} MCP config is too large`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${capitalize(label)} MCP config has invalid JSON: ${error.message}`);
    }
    throw error;
  }
  if (!isRecord(parsed)) throw new Error(`${capitalize(label)} MCP config must contain a JSON object`);
  if (parsed.mcpServers === undefined) return {};
  if (!isRecord(parsed.mcpServers)) throw new Error(`${capitalize(label)} MCP config mcpServers must be an object`);

  const servers: Array<[string, McpServerConfig]> = [];
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (!name) throw new Error(`${capitalize(label)} MCP server names must be non-empty`);
    servers.push([name, validateServer(value, label, name)]);
  }
  return Object.fromEntries(servers);
}

function validateServer(value: unknown, label: "project" | "user", name: string): McpServerConfig {
  const prefix = `${capitalize(label)} MCP server ${JSON.stringify(name)}`;
  if (!isRecord(value)) throw new Error(`${prefix} must be an object`);
  const allowed = new Set(["command", "args", "env", "cwd", "enabled"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${prefix} has unknown key: ${unknown}`);
  if (typeof value.command !== "string" || value.command.trim() === "") {
    throw new Error(`${prefix} command must be a non-empty string`);
  }
  if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string"))) {
    throw new Error(`${prefix} args must be an array of strings`);
  }
  if (value.env !== undefined && (!isRecord(value.env) || !Object.values(value.env).every((entry) => typeof entry === "string"))) {
    throw new Error(`${prefix} env must be an object of string values`);
  }
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.trim() === "")) {
    throw new Error(`${prefix} cwd must be a non-empty string`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`${prefix} enabled must be a boolean`);
  }

  return {
    command: value.command,
    ...(value.args === undefined ? {} : { args: value.args as string[] }),
    ...(value.env === undefined ? {} : { env: value.env as Record<string, string> }),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd as string }),
    ...(value.enabled === undefined ? {} : { enabled: value.enabled as boolean })
  };
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

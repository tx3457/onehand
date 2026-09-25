import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition } from "../tools/registry.js";
import type { ToolResult } from "../types.js";
import { truncateText } from "../utils/truncate.js";
import type { McpServerConfig } from "./config.js";

export type { McpServerConfig } from "./config.js";

type ManagedTool = {
  client: Client;
  remoteName: string;
};

type Connection = {
  client: Client;
  transport: Transport;
};

export type McpManagerOptions = {
  warn?: (message: string) => void;
  transportFactory?: (name: string, config: McpServerConfig) => Transport | Promise<Transport>;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
};

export class McpManager {
  readonly definitions: ToolDefinition[] = [];
  private readonly warn: (message: string) => void;
  private readonly transportFactory: (name: string, config: McpServerConfig) => Transport | Promise<Transport>;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly tools = new Map<string, ManagedTool>();
  private readonly connections: Connection[] = [];
  private readonly connectedServers: Array<{ name: string; tools: string[] }> = [];

  constructor(options: McpManagerOptions = {}) {
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.transportFactory = options.transportFactory ?? ((_name, config) => new StdioClientTransport({
      command: config.command,
      ...(config.args === undefined ? {} : { args: config.args }),
      env: { ...getDefaultEnvironment(), ...config.env },
      ...(config.cwd === undefined ? {} : { cwd: config.cwd })
    }));
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
  }

  get servers(): Array<{ name: string; tools: string[] }> {
    return this.connectedServers.map((server) => ({ name: server.name, tools: [...server.tools] }));
  }

  async connect(config: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(config).filter(([, server]) => server.enabled !== false);
    for (const [name, server] of entries) await this.connectServer(name, server);
  }

  readonly execute = async (
    name: string,
    args: Record<string, unknown>,
    context?: { signal?: AbortSignal }
  ): Promise<ToolResult<unknown>> => {
    const tool = this.tools.get(name);
    if (!tool) return failure(`Unknown MCP tool: ${name}`);
    try {
      const result = await tool.client.callTool(
        { name: tool.remoteName, arguments: args },
        undefined,
        { timeout: this.callTimeoutMs, signal: context?.signal }
      );
      const output = renderContent(result.content);
      if (result.isError) return failure(output || `MCP tool ${name} failed`);
      const truncated = truncateText(output);
      return {
        ok: true,
        data: truncated.text,
        ...(truncated.truncated ? { truncated: true } : {})
      };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  };

  async close(): Promise<void> {
    const connections = this.connections.splice(0);
    await Promise.allSettled(connections.map(({ client }) => client.close()));
    this.tools.clear();
    this.definitions.splice(0);
    this.connectedServers.splice(0);
  }

  private async connectServer(name: string, config: McpServerConfig): Promise<void> {
    let transport: Transport | undefined;
    let client: Client | undefined;
    try {
      transport = await this.transportFactory(name, config);
      client = new Client({ name: "onehand", version: "0.2.0" });
      const deadline = Date.now() + this.connectTimeoutMs;
      const listed = await withTimeout((async () => {
        await client!.connect(transport!, { timeout: remaining(deadline) });
        return client!.listTools(undefined, { timeout: remaining(deadline) });
      })(), this.connectTimeoutMs, `MCP server ${JSON.stringify(name)} timed out while connecting`);

      this.connections.push({ client, transport });
      const serverTools: string[] = [];
      for (const tool of listed.tools) {
        const exposedName = exposedToolName(name, tool.name);
        if (this.tools.has(exposedName)) {
          this.warn(`MCP tool name collision for ${JSON.stringify(exposedName)}; dropping ${JSON.stringify(`${name}:${tool.name}`)}`);
          continue;
        }
        this.tools.set(exposedName, { client, remoteName: tool.name });
        serverTools.push(exposedName);
        this.definitions.push({
          type: "function",
          name: exposedName,
          description: `[MCP ${name}]${tool.description ? ` ${tool.description}` : ""}`,
          parameters: schemaObject(tool.inputSchema)
        });
      }
      this.connectedServers.push({ name, tools: serverTools });
    } catch (error) {
      this.warn(`MCP server ${JSON.stringify(name)} failed to start: ${error instanceof Error ? error.message : String(error)}`);
      if (client) await client.close().catch(() => undefined);
      else if (transport) await transport.close().catch(() => undefined);
    }
  }
}

function exposedToolName(serverName: string, toolName: string): string {
  const prefix = "mcp__";
  const separator = "__";
  const server = sanitize(serverName).slice(0, 56);
  const toolBudget = Math.max(1, 64 - prefix.length - separator.length - server.length);
  return `${prefix}${server}${separator}${sanitize(toolName).slice(0, toolBudget)}`;
}

function sanitize(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized || "_";
}

function schemaObject(value: unknown): ToolDefinition["parameters"] {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as ToolDefinition["parameters"];
  }
  return { type: "object" };
}

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return "[content omitted]";
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return record.text;
    return `[${typeof record.type === "string" ? record.type : "content"} omitted]`;
  }).join("\n");
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function failure(error: string): ToolResult<never> {
  return { ok: false, error: truncateText(error).text, recoverable: true };
}

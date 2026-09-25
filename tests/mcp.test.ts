import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runAgent } from "../src/agent/runner.js";
import { loadMcpConfig, McpManager, type McpServerConfig } from "../src/mcp/index.js";
import type { ModelProvider, ProviderRequest, ProviderTurn } from "../src/providers/index.js";

const temporaryDirectories: string[] = [];
const managers: McpManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "onehand-mcp-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeConfig(root: string, value: unknown): Promise<void> {
  await mkdir(path.join(root, ".onehand"), { recursive: true });
  await writeFile(path.join(root, ".onehand", "config.json"), JSON.stringify(value), "utf8");
}

function serverConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { command: process.execPath, ...overrides };
}

async function inMemoryServer(register: (server: McpServer) => void): Promise<{
  transport: Transport;
  server: McpServer;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  register(server);
  await server.connect(serverTransport);
  return { transport: clientTransport, server };
}

function providerTurn(
  calls: Array<[string, Record<string, unknown>]> = [],
  message = ""
): ProviderTurn {
  const toolCalls = calls.map(([name, args], index) => ({ id: String(index), name, arguments: args }));
  return {
    historyItems: [{ role: "assistant", content: message, toolCalls }],
    toolCalls,
    message,
    usage: { inputTokens: 10, outputTokens: 2, cacheHitInputTokens: 0, cacheMissInputTokens: 10, totalTokens: 12 }
  };
}

function scriptedProvider(turns: ProviderTurn[]): { provider: ModelProvider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    provider: {
      name: "openai",
      initialHistory: (content) => [{ role: "user", content }],
      complete: vi.fn(async (request) => {
        requests.push({ ...request, signal: undefined, history: structuredClone(request.history) });
        const turn = turns.shift();
        if (!turn) throw new Error("Script exhausted");
        return turn;
      }),
      toolResultItem: (call, output) => ({ role: "tool", id: call.id, output })
    }
  };
}

describe("loadMcpConfig", () => {
  test("merges user and project servers by name with project precedence", async () => {
    const repo = await temporaryDirectory();
    const userHome = await temporaryDirectory();
    await writeConfig(userHome, {
      mcpServers: {
        shared: { command: "user-command", args: ["user"] },
        userOnly: { command: "user-only", enabled: false }
      }
    });
    await writeConfig(repo, {
      mcpServers: {
        shared: { command: "project-command", env: { TOKEN: "explicit" }, cwd: "tools" },
        projectOnly: { command: "project-only", args: [] }
      }
    });

    await expect(loadMcpConfig(repo, userHome)).resolves.toEqual({
      shared: { command: "project-command", env: { TOKEN: "explicit" }, cwd: "tools" },
      userOnly: { command: "user-only", enabled: false },
      projectOnly: { command: "project-only", args: [] }
    });
  });

  test("rejects malformed entries with a server-specific error", async () => {
    const repo = await temporaryDirectory();
    const userHome = await temporaryDirectory();
    await writeConfig(repo, { mcpServers: { broken: { command: "ok", args: [12] } } });

    await expect(loadMcpConfig(repo, userHome)).rejects.toThrow(
      "Project MCP server \"broken\" args must be an array of strings"
    );
  });

  test("rejects symlinked config directories", async () => {
    const repo = await temporaryDirectory();
    const userHome = await temporaryDirectory();
    const target = await temporaryDirectory();
    await symlink(target, path.join(repo, ".onehand"));

    await expect(loadMcpConfig(repo, userHome)).rejects.toThrow(
      "Project MCP config directory cannot be a symbolic link"
    );
  });

  test("preserves special server names as data properties", async () => {
    const repo = await temporaryDirectory();
    const userHome = await temporaryDirectory();
    await writeConfig(repo, JSON.parse('{"mcpServers":{"__proto__":{"command":"safe"}}}'));

    const config = await loadMcpConfig(repo, userHome);

    expect(Object.hasOwn(config, "__proto__")).toBe(true);
    expect(config["__proto__"]).toEqual({ command: "safe" });
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
  });
});

describe("McpManager", () => {
  test("sanitizes names, drops collisions, and executes real in-memory tools", async () => {
    const first = await inMemoryServer((server) => {
      server.registerTool("read.thing", { description: "Reads a thing" }, async () => ({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" }
        ]
      }));
      server.registerTool("broken", { description: "Fails" }, async () => ({
        content: [{ type: "text", text: "remote failure" }],
        isError: true
      }));
    });
    const second = await inMemoryServer((server) => {
      server.registerTool("read_thing", { description: "Duplicate after sanitizing" }, async () => ({
        content: [{ type: "text", text: "second" }]
      }));
    });
    const warning = vi.fn();
    const transports = new Map<string, Transport>([
      ["alpha server", first.transport],
      ["alpha_server", second.transport]
    ]);
    const manager = new McpManager({
      warn: warning,
      transportFactory: (name) => transports.get(name)!
    });
    managers.push(manager);

    await manager.connect({
      "alpha server": serverConfig(),
      alpha_server: serverConfig()
    });

    expect(manager.definitions).toEqual([
      expect.objectContaining({
        name: "mcp__alpha_server__read_thing",
        description: "[MCP alpha server] Reads a thing",
        parameters: { type: "object", properties: {} }
      }),
      expect.objectContaining({ name: "mcp__alpha_server__broken" })
    ]);
    expect(manager.servers).toEqual([
      { name: "alpha server", tools: ["mcp__alpha_server__read_thing", "mcp__alpha_server__broken"] },
      { name: "alpha_server", tools: [] }
    ]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("collision"));
    const execute = manager.execute;
    await expect(execute("mcp__alpha_server__read_thing", {})).resolves.toEqual({
      ok: true,
      data: "first\n[image omitted]"
    });
    await expect(manager.execute("mcp__alpha_server__broken", {})).resolves.toEqual({
      ok: false,
      error: "remote failure",
      recoverable: true
    });
  });

  test("caps generated tool names at 64 characters", async () => {
    const endpoint = await inMemoryServer((server) => {
      server.registerTool("t".repeat(80), {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
    });
    const manager = new McpManager({ transportFactory: () => endpoint.transport });
    managers.push(manager);

    await manager.connect({ ["s".repeat(40)]: serverConfig() });

    expect(manager.definitions[0]?.name).toHaveLength(64);
    expect(manager.definitions[0]?.name).toMatch(/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/);
  });

  test("skips a failing server and continues connecting", async () => {
    const working = await inMemoryServer((server) => {
      server.registerTool("ping", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
    });
    const warning = vi.fn();
    const manager = new McpManager({
      warn: warning,
      transportFactory: (name) => name === "bad"
        ? ({ start: async () => { throw new Error("cannot start"); }, send: async () => {}, close: async () => {} })
        : working.transport
    });
    managers.push(manager);

    await expect(manager.connect({ bad: serverConfig(), good: serverConfig() })).resolves.toBeUndefined();

    expect(manager.servers).toEqual([{ name: "good", tools: ["mcp__good__ping"] }]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("bad"));
  });

  test("enforces the whole connect-and-list timeout", async () => {
    let closed = false;
    const manager = new McpManager({
      connectTimeoutMs: 20,
      transportFactory: () => ({
        start: () => new Promise<void>(() => {}),
        send: async () => {},
        close: async () => { closed = true; }
      })
    });
    managers.push(manager);

    await manager.connect({ slow: serverConfig() });

    expect(manager.servers).toEqual([]);
    expect(closed).toBe(true);
  });

  test("uses stdio with only the SDK safe environment plus explicit values", async () => {
    const directory = await temporaryDirectory();
    const serverModule = path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js");
    const stdioModule = path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js");
    const script = path.join(directory, "server.mjs");
    await writeFile(script, `
      import { McpServer } from ${JSON.stringify(pathToFileURL(serverModule).href)};
      import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(stdioModule).href)};
      const server = new McpServer({ name: "stdio-test", version: "1.0.0" });
      server.registerTool("environment", {}, async () => ({ content: [{
        type: "text",
        text: JSON.stringify({ explicit: process.env.MCP_EXPLICIT, provider: process.env.OPENAI_API_KEY })
      }] }));
      await server.connect(new StdioServerTransport());
    `, "utf8");
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "must-not-leak";
    const manager = new McpManager();
    managers.push(manager);
    try {
      await manager.connect({
        stdio: { command: process.execPath, args: [script], env: { MCP_EXPLICIT: "yes" } }
      });
      const result = await manager.execute("mcp__stdio__environment", {});
      expect(result).toEqual({ ok: true, data: JSON.stringify({ explicit: "yes" }) });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test("truncates large tool output through the shared truncation policy", async () => {
    const endpoint = await inMemoryServer((server) => {
      server.registerTool("large", {}, async () => ({
        content: [{ type: "text", text: "x".repeat(30_000) }]
      }));
    });
    const manager = new McpManager({ transportFactory: () => endpoint.transport });
    managers.push(manager);
    await manager.connect({ large: serverConfig() });

    const result = await manager.execute("mcp__large__large", {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.data as string, "utf8")).toBeLessThanOrEqual(20 * 1024);
    }
  });

  test("also truncates recoverable MCP error output", async () => {
    const endpoint = await inMemoryServer((server) => {
      server.registerTool("large-error", {}, async () => ({
        content: [{ type: "text", text: "x".repeat(30_000) }],
        isError: true
      }));
    });
    const manager = new McpManager({ transportFactory: () => endpoint.transport });
    managers.push(manager);
    await manager.connect({ errors: serverConfig() });

    const result = await manager.execute("mcp__errors__large-error", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Buffer.byteLength(result.error, "utf8")).toBeLessThanOrEqual(20 * 1024);
      expect(result.error).toContain("output truncated");
    }
  });
});

describe("MCP runner integration", () => {
  test("calls MCP tools before a plan and returns normal and recoverable error observations", async () => {
    const repo = await temporaryDirectory();
    const endpoint = await inMemoryServer((server) => {
      server.registerTool("echo", {}, async () => ({ content: [{ type: "text", text: "hello" }] }));
      server.registerTool("fail", {}, async () => ({
        content: [{ type: "text", text: "recoverable remote error" }],
        isError: true
      }));
    });
    const manager = new McpManager({ transportFactory: () => endpoint.transport });
    managers.push(manager);
    await manager.connect({ demo: serverConfig() });
    const { provider, requests } = scriptedProvider([
      providerTurn([["mcp__demo__echo", {}], ["mcp__demo__fail", {}]]),
      providerTurn([], "Handled both results.")
    ]);
    const authorize = vi.fn(async () => "allow" as const);

    const report = await runAgent({
      task: "Use MCP", repoPath: repo, provider, persistence: false, completion: "answer",
      enforcePlanning: true, extraTools: manager, authorize
    });

    expect(report).toMatchObject({ status: "success", stopReason: "answered", usage: { toolCalls: 2 } });
    expect(authorize).toHaveBeenCalledWith({ name: "mcp__demo__echo", args: {}, risk: "mcp" });
    const observations = requests[1]!.history.filter((item): item is { role: string; output: string } =>
      typeof item === "object" && item !== null && (item as { role?: unknown }).role === "tool"
    );
    expect(observations.map(({ output }) => JSON.parse(output))).toEqual([
      { ok: true, data: "hello" },
      { ok: false, error: "recoverable remote error", recoverable: true }
    ]);
  });

  test("does not call an MCP server when authorization denies the tool", async () => {
    const repo = await temporaryDirectory();
    let calls = 0;
    const endpoint = await inMemoryServer((server) => {
      server.registerTool("echo", {}, async () => {
        calls++;
        return { content: [{ type: "text", text: "must not run" }] };
      });
    });
    const manager = new McpManager({ transportFactory: () => endpoint.transport });
    managers.push(manager);
    await manager.connect({ demo: serverConfig() });
    const { provider, requests } = scriptedProvider([
      providerTurn([["mcp__demo__echo", {}]]),
      providerTurn([], "Denied.")
    ]);

    await runAgent({
      task: "Use MCP", repoPath: repo, provider, persistence: false, completion: "answer",
      extraTools: manager, authorize: async () => "deny"
    });

    expect(calls).toBe(0);
    const denied = requests[1]!.history.at(-1) as { output: string };
    expect(JSON.parse(denied.output)).toMatchObject({ ok: false, recoverable: true, error: expect.stringMatching(/denied/i) });
  });
});

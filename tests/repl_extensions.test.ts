import { PassThrough } from "node:stream";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRepl } from "../src/repl/index.js";
import type { ModelProvider, ProviderRequest, ProviderTurn } from "../src/providers/index.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

describe("REPL MCP and review commands", () => {
  let repo: string;
  let userHome: string;

  beforeEach(async () => {
    repo = await makeTempDir("onehand-repl-extensions-");
    userHome = await makeTempDir("onehand-repl-extensions-home-");
    await initGitRepo(repo);
    await writeFile(path.join(repo, "greeting.txt"), "hello\n");
    await git(["add", "greeting.txt"], repo);
    await git(["commit", "-m", "fixture"], repo);
  });

  afterEach(async () => {
    await cleanupTempDir(repo);
    await cleanupTempDir(userHome);
  });

  it("runs /review on the current diff with the last task and plan, then includes its usage in /cost", async () => {
    await writeFile(path.join(repo, "greeting.txt"), "hello world\n");
    const parentRequests: ProviderRequest[] = [];
    const reviewRequests: ProviderRequest[] = [];
    const providers = [
      scripted([
        turn("", "set_plan", { steps: ["inspect the greeting"] }),
        turn("The greeting was updated.")
      ], parentRequests),
      scripted([
        turn("", "read_file", { path: "greeting.txt" }),
        turn("no blocking issues")
      ], reviewRequests)
    ];
    const { input, output, text } = streams();
    input.end("Update the greeting\n/review\n/cost\n/exit\n");
    await runRepl({
      repoPath: repo, userHome, provider: "openai", mode: "ask", input, output,
      providerFactory: () => providers.shift()!
    });

    expect(text()).toContain("no blocking issues");
    expect(text()).toContain("review started");
    expect(text()).toContain("review finished");
    expect(text()).toContain("4 rounds · 2 tool calls · 12 tokens");
    expect(parentRequests[0]!.tools.map((tool) => (tool as { name: string }).name)).toContain("review_changes");
    expect(reviewRequests).toHaveLength(2);
    expect(reviewRequests[0]!.tools.map((tool) => (tool as { name: string }).name).sort()).toEqual([
      "git_diff", "git_status", "list_files", "read_file", "search_code"
    ]);
    expect(JSON.stringify(reviewRequests[0]!.history)).toContain("Update the greeting");
    expect(JSON.stringify(reviewRequests[0]!.history)).toContain("+hello world");
    expect(JSON.stringify(reviewRequests[0]!.history)).toContain("inspect the greeting");
    expect(await readFile(path.join(repo, "greeting.txt"), "utf8")).toBe("hello world\n");
  });

  it("lists no servers for an unconfigured session without creating a provider", async () => {
    const { input, output, text } = streams();
    input.end("/mcp\n/exit\n");
    await runRepl({
      repoPath: repo, userHome, provider: "openai", input, output,
      providerFactory: () => { throw new Error("A slash listing must not call a model"); }
    });
    expect(text()).toContain("No MCP servers connected.");
  });

  it("connects configured stdio tools, renders calls, and closes the server on exit", async () => {
    const serverPath = path.join(userHome, "server.mjs");
    const closedPath = path.join(userHome, "closed.txt");
    await writeFile(serverPath, `
      import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};
      import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
      import { writeFileSync } from "node:fs";
      const server = new McpServer({ name: "repl-fixture", version: "1" });
      server.registerTool("ping", { description: "Ping locally", inputSchema: {} }, async () => ({
        content: [{ type: "text", text: "local pong" }]
      }));
      process.stdin.on("end", () => { writeFileSync(${JSON.stringify(closedPath)}, "closed"); });
      await server.connect(new StdioServerTransport());
    `);
    await mkdir(path.join(repo, ".onehand"));
    await writeFile(path.join(repo, ".onehand", "config.json"), JSON.stringify({
      mcpServers: { local: { command: process.execPath, args: [serverPath], env: {} } },
      permissions: { allow: ["mcp__local__*"] }
    }));
    const requests: ProviderRequest[] = [];
    const provider = scripted([turn("", "mcp__local__ping", {}), turn("MCP replied locally.")], requests);
    const { input, output, text } = streams();
    input.end("/mcp\nping\n/exit\n");
    await runRepl({ repoPath: repo, userHome, provider: "openai", mode: "ask", input, output, providerFactory: () => provider });

    expect(text()).toContain("local: mcp__local__ping");
    expect(text()).toContain("✓ mcp__local__ping");
    expect(JSON.stringify(requests[1]!.history)).toContain("local pong");
    expect(await readFile(closedPath, "utf8")).toBe("closed");
  });

  it("cancels an in-flight MCP call on Ctrl+C and returns to the prompt", async () => {
    const serverPath = path.join(userHome, "slow-server.mjs");
    const startedPath = path.join(userHome, "started.txt");
    await writeFile(serverPath, `
      import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};
      import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
      import { writeFileSync } from "node:fs";
      const server = new McpServer({ name: "slow-fixture", version: "1" });
      server.registerTool("slow", {}, async () => {
        writeFileSync(${JSON.stringify(startedPath)}, "started");
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { content: [{ type: "text", text: "late response" }] };
      });
      await server.connect(new StdioServerTransport());
    `);
    await mkdir(path.join(repo, ".onehand"));
    await writeFile(path.join(repo, ".onehand", "config.json"), JSON.stringify({
      mcpServers: { local: { command: process.execPath, args: [serverPath], env: {} } },
      permissions: { allow: ["mcp__local__slow"] }
    }));
    const { input, output, text } = streams();
    const running = runRepl({
      repoPath: repo, userHome, provider: "openai", mode: "ask", input, output,
      providerFactory: () => scripted([turn("", "mcp__local__slow", {})], [])
    });
    input.write("slow call\n");
    try {
      const deadline = Date.now() + 3_000;
      while (true) {
        try { await access(startedPath); break; } catch {
          if (Date.now() >= deadline) throw new Error("MCP tool did not start");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      input.write("\u0003");
    } finally {
      input.end("/exit\n");
      await running;
    }
    expect(text()).toMatch(/✗ mcp__local__slow.*abort/i);
    expect(text()).toContain("cancelled");
    expect(text().match(/onehand> /g)?.length).toBeGreaterThanOrEqual(2);
  });
});

function streams(): { input: PassThrough; output: PassThrough; text(): string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let content = "";
  output.on("data", (chunk) => { content += chunk.toString("utf8"); });
  return { input, output, text: () => content };
}

function scripted(turns: ProviderTurn[], requests: ProviderRequest[]): ModelProvider {
  return {
    name: "openai",
    initialHistory: (content) => [{ role: "user", content }],
    toolResultItem: (call, output) => ({ callId: call.id, output }),
    complete: async (request) => {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const next = turns.shift();
      if (!next) throw new Error("Scripted turns exhausted");
      return next;
    }
  };
}

function turn(message: string, name?: string, args: Record<string, unknown> = {}): ProviderTurn {
  const toolCalls = name ? [{ id: name, name, arguments: JSON.stringify(args) }] : [];
  return {
    historyItems: [{ role: "assistant", content: message, toolCalls }], toolCalls, message,
    finishReason: name ? "tool_calls" : "stop",
    usage: { inputTokens: 2, outputTokens: 1, cacheHitInputTokens: 0, cacheMissInputTokens: 2, totalTokens: 3 }
  };
}

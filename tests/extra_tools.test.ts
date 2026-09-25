import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolRegistry, type ExtraTools, type ToolDefinition } from "../src/tools/registry.js";
import { PathMapper, type Executor } from "../src/runtime/executor.js";

let repo: string;

beforeEach(async () => { repo = await mkdtemp(path.join(tmpdir(), "onehand-extra-tools-")); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

function extra(definitions: ToolDefinition[]): ExtraTools {
  return {
    definitions,
    execute: vi.fn(async (name, args) => ({ ok: true as const, data: { name, args } }))
  };
}

describe("extra tools", () => {
  it("appends definitions, validates supported schemas, and executes outside the plan gate", async () => {
    const tools = extra([{
      type: "function",
      name: "mcp__demo__echo",
      description: "Echo text",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false
      }
    }]);
    const registry = createToolRegistry({
      repoRoot: repo, timeoutSec: 5, allowDestructive: false, enforcePlanning: true, extraTools: tools
    });

    expect(registry.definitions.at(-1)?.name).toBe("mcp__demo__echo");
    await expect(registry.execute("mcp__demo__echo", {})).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/text.*required/i) });
    await expect(registry.execute("mcp__demo__echo", { text: "hello" })).resolves.toEqual({
      ok: true, data: { name: "mcp__demo__echo", args: { text: "hello" } }
    });
    expect(tools.execute).toHaveBeenCalledOnce();
  });

  it("falls back to requiring a plain object for richer JSON schemas", async () => {
    const tools = extra([
      {
        type: "function", name: "mcp__demo__rich", description: "Rich schema",
        parameters: { type: "object", anyOf: [{ required: ["left"] }, { required: ["right"] }] }
      },
      {
        type: "function", name: "mcp__demo__empty", description: "Empty schema",
        parameters: {} as never
      },
      {
        type: "function", name: "mcp__demo__union", description: "Union schema",
        parameters: { type: ["object", "null"] } as never
      },
      {
        type: "function", name: "mcp__demo__additional", description: "Schema-valued additional properties",
        parameters: { type: "object", additionalProperties: { type: "string" } } as never
      },
      {
        type: "function", name: "mcp__demo__boolean", description: "Boolean property schema",
        parameters: { type: "object", properties: { value: true } } as never
      }
    ]);
    const registry = createToolRegistry({ repoRoot: repo, timeoutSec: 5, allowDestructive: false, extraTools: tools });

    for (const name of tools.definitions.map(({ name }) => name)) {
      await expect(registry.execute(name, "[]"), name).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/plain object/i) });
      await expect(registry.execute(name, "null"), name).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/plain object/i) });
      await expect(registry.execute(name, { arbitrary: true }), name).resolves.toMatchObject({ ok: true });
    }
  });

  it("rejects class instances while allowing ordinary and null-prototype argument objects", async () => {
    const tools = extra([{ type: "function", name: "mcp__demo__rich", description: "Rich", parameters: {} as never }]);
    const registry = createToolRegistry({ repoRoot: repo, timeoutSec: 5, allowDestructive: false, extraTools: tools });
    class Arguments { value = true; }

    await expect(registry.execute("mcp__demo__rich", new Date() as unknown as Record<string, unknown>)).resolves.toMatchObject({
      ok: false, error: expect.stringMatching(/plain object/i)
    });
    await expect(registry.execute("mcp__demo__rich", new Arguments() as unknown as Record<string, unknown>)).resolves.toMatchObject({
      ok: false, error: expect.stringMatching(/plain object/i)
    });
    await expect(registry.execute("mcp__demo__rich", Object.assign(Object.create(null), { value: true }))).resolves.toMatchObject({ ok: true });
  });

  it("rejects extra definitions that collide with registered tools", () => {
    const tools = extra([{ type: "function", name: "read_file", description: "collision", parameters: { type: "object" } }]);
    expect(() => createToolRegistry({ repoRoot: repo, timeoutSec: 5, allowDestructive: false, extraTools: tools }))
      .toThrow(/extra tool name.*read_file.*collides/i);
  });

  it("authorizes every extra tool even when its risk class is read", async () => {
    const authorize = vi.fn(async () => "deny" as const);
    const tools = extra([{ type: "function", name: "explore", description: "Explore", parameters: { type: "object" } }]);
    const registry = createToolRegistry({ repoRoot: repo, timeoutSec: 5, allowDestructive: false, extraTools: tools, authorize });

    await expect(registry.execute("explore", {})).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/denied/i) });
    expect(authorize).toHaveBeenCalledWith({ name: "explore", args: {}, risk: "read" });
    expect(tools.execute).not.toHaveBeenCalled();
  });
});

describe("read-only registry", () => {
  it("exposes only dedicated read tools and rejects writes as unknown", async () => {
    const registry = createToolRegistry({ repoRoot: repo, timeoutSec: 5, allowDestructive: false, readOnly: true });
    expect(registry.definitions.map(({ name }) => name)).toEqual([
      "list_files", "search_code", "read_file", "git_status", "git_diff"
    ]);
    await expect(registry.execute("write_file", { path: "x", content: "bad" })).resolves.toEqual({
      ok: false, error: "Unknown tool: write_file", recoverable: true
    });
  });

  it("allows only inspection commands when sandbox command support is enabled", async () => {
    const calls: string[] = [];
    const executor: Executor = {
      kind: "docker",
      pathMapper: new PathMapper(repo, "/testbed"),
      async run(request) {
        calls.push([request.program, ...request.args].join(" "));
        return { ok: true, data: { command: calls.at(-1)!, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, truncated: false } };
      }
    };
    const registry = createToolRegistry({
      repoRoot: repo, timeoutSec: 5, allowDestructive: false, readOnly: true,
      features: { sandboxCommands: true }, executor, displayRoot: "/testbed"
    });
    expect(registry.definitions.map(({ name }) => name)).toContain("run_command");
    await expect(registry.execute("run_command", { program: "rg", args: ["TODO", "."] })).resolves.toMatchObject({ ok: true });
    await expect(registry.execute("run_command", { program: "node", args: ["-e", "process.exit()"] })).resolves.toMatchObject({
      ok: false, error: expect.stringMatching(/read-only inspection/i)
    });
    expect(calls).toEqual(["rg TODO ."]);
  });
});

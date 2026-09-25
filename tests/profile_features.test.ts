import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentBehaviorFingerprint } from "../src/agent/fingerprint.js";
import { PROFILES, resolveFeatures, resolveProfile } from "../src/agent/profile.js";
import { PathMapper, type Executor, type ExecRequest } from "../src/runtime/executor.js";
import { createToolRegistry, TOOL_DEFINITIONS, toolDefinitionsFor } from "../src/tools/registry.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "onehand-profiles-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function registry(flags = {}, docker = false) {
  const calls: ExecRequest[] = [];
  const executor: Executor = {
    kind: docker ? "docker" : "local", pathMapper: new PathMapper(root, docker ? "/testbed" : root),
    async run(request) {
      calls.push(request);
      return { ok: true, data: { command: [request.program, ...request.args].join(" "), exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, truncated: false } };
    }
  };
  return { calls, registry: createToolRegistry({ repoRoot: root, timeoutSec: 5, allowDestructive: false, executor, features: flags }) };
}

describe("profile features", () => {
  it("defaults all features to false and validates names and boolean values", () => {
    expect(resolveFeatures({})).toEqual({ retrieval: false, compactObservations: false, sandboxCommands: false });
    expect(resolveProfile("ctx").flags).toEqual({ retrieval: true, compactObservations: true });
    expect(resolveProfile("ctx-sandbox").flags).toEqual({ retrieval: true, compactObservations: true, sandboxCommands: true });
    for (const flags of [{ typo: true }, { retrieval: 1 }, { compactObservations: "true" }, { constructor: false }, null, []]) {
      expect(() => resolveFeatures(flags)).toThrow();
      expect(() => registry(flags as {})).toThrow();
    }
  });

  it("selects definitions per profile without mutating baseline", () => {
    expect(toolDefinitionsFor({})).toBe(TOOL_DEFINITIONS);
    expect(registry().registry.definitions).toBe(TOOL_DEFINITIONS);
    const definitions = toolDefinitionsFor(PROFILES.ctx.flags);
    expect(definitions.find((tool) => tool.name === "read_file")!.parameters.properties).toHaveProperty("startLine");
    expect(definitions.find((tool) => tool.name === "search_code")!.parameters.properties).toHaveProperty("glob");
    expect(TOOL_DEFINITIONS.find((tool) => tool.name === "read_file")!.parameters.properties).not.toHaveProperty("startLine");
    const sandbox = toolDefinitionsFor(PROFILES["ctx-sandbox"].flags);
    expect(sandbox.find((tool) => tool.name === "run_command")!.description).toContain("container");
    expect(new Set(Object.values(PROFILES).map((profile) => agentBehaviorFingerprint(profile))).size).toBe(3);
    expect(() => agentBehaviorFingerprint({ name: "invalid", flags: { typo: true } as any })).toThrow();
  });

  it("keeps baseline file results and activates retrieval only for flagged registries", async () => {
    await writeFile(path.join(root, "a.py"), "one\ntwo\n");
    expect(await registry().registry.execute("read_file", { path: "a.py" })).toEqual({
      ok: true, data: { path: "a.py", content: "one\ntwo\n", bytes: 8 }, truncated: false
    });
    expect(await registry().registry.execute("read_file", { path: "a.py", startLine: 2 })).toMatchObject({ ok: false });
    expect(await registry({ retrieval: true }).registry.execute("read_file", { path: "a.py", startLine: 2, endLine: 2 })).toMatchObject({
      ok: true, data: { path: "a.py", content: "     2\ttwo", totalLines: 2, startLine: 2, endLine: 2 }
    });
  });

  it("refuses sandbox policy on local executors", () => {
    expect(() => registry({ sandboxCommands: true })).toThrow(/sandboxCommands.*Docker/);
  });

  it("allows sandbox inline code without treating it as a path but validates other arguments", async () => {
    const { registry: tools, calls } = registry({ sandboxCommands: true }, true);
    for (const [program, args] of [
      ["python", ["-c", 'print("/tmp/inside-container")']],
      ["python3", ["-c", 'print("hello\\nworld")', "a.py"]],
      ["node", ["-e", 'console.log("/tmp/inside-container")']],
      ["sed", ["-n", "1,20p", "a.py"]],
      ["git", ["show", "HEAD:a.py"]],
      ["git", ["blame", "a.py"]]
    ] as Array<[string, string[]]>) {
      expect(await tools.execute("run_command", { program, args }), `${program} ${args}`).toMatchObject({ ok: true });
    }
    expect(calls).toHaveLength(6);
    expect(tools.plan.snapshot().writeRevision).toBe(6);
    for (const args of [["-c", "print(1)", "../outside"], ["-c", "print(1)", "secrets.key"], ["-c", "print(1)", "--file=secrets.key"]]) {
      expect(await tools.execute("run_command", { program: "python", args })).toMatchObject({ ok: false });
    }
    expect(calls).toHaveLength(6);
    expect(await registry({}, true).registry.execute("run_command", { program: "python", args: ["-c", "print(1)"] })).toMatchObject({ ok: false });
  });

  it("rejects protected paths and unsafe command options before executing", async () => {
    const { registry: tools, calls } = registry({ sandboxCommands: true }, true);
    for (const [program, args] of [
      ["git", ["show", "HEAD:secrets.key"]], ["git", ["show", "HEAD:../escape"]],
      ["rg", ["x", "secrets.key"]], ["sed", ["-i", "s/a/b/", "a.py"]],
      ["find", [".", "-exec", "node", "x.js", ";"]], ["rg", ["--pre=processor", "x"]],
      ["git", ["checkout", "main"]], ["npm", ["install", "x"]], ["curl", ["https://example.invalid"]]
    ] as Array<[string, string[]]>) {
      expect(await tools.execute("run_command", { program, args }), `${program} ${args}`).toMatchObject({ ok: false });
    }
    expect(calls).toEqual([]);
  });
});

it("checks paths supplied through attached short options in sandbox commands", async () => {
  const { registry: tools, calls } = registry({ sandboxCommands: true }, true);
  for (const program of ["rg", "grep", "sed"]) {
    expect(await tools.execute("run_command", { program, args: ["-f.npmrc", "a.py"] })).toMatchObject({ ok: false });
    expect(await tools.execute("run_command", { program, args: ["-f/outside/patterns", "a.py"] })).toMatchObject({ ok: false });
  }
  expect(calls).toEqual([]);
});

it("captures full-output failures only for compact test observations", async () => {
  const source = 'process.stdout.write("head\\n" + "padding\\n".repeat(2000) + "FAILED middle::test_name\\n" + "padding\\n".repeat(3000)); process.exitCode = 1;';
  await writeFile(path.join(root, "test.cjs"), source);
  for (const compactObservations of [false, true]) {
    const tools = createToolRegistry({ repoRoot: root, timeoutSec: 5, allowDestructive: false, testCommand: "node test.cjs", features: { compactObservations } });
    const result = await tools.execute("run_tests", {});
    expect(result).toMatchObject({ ok: true, data: { passed: false }, truncated: true });
    if (!result.ok) throw new Error(result.error);
    const data = result.data as Record<string, unknown>;
    expect(String(data.stdout)).not.toContain("FAILED middle::test_name");
    if (compactObservations) expect(data.failures).toEqual(["FAILED middle::test_name"]);
    else expect(data).not.toHaveProperty("failures");
  }
});

it("denies combined and abbreviated sed in-place options", async () => {
  const { registry: tools, calls } = registry({ sandboxCommands: true }, true);
  for (const option of ["-ni", "-Eir", "--in", "--in-p=backup"]) {
    expect(await tools.execute("run_command", { program: "sed", args: [option, "s/a/b/", "a.py"] }), option).toMatchObject({ ok: false });
  }
  expect(calls).toEqual([]);
});

it("fingerprints the definitions each profile actually exposes", () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "read_file")!;
  const original = definition.description;
  const ctxFingerprint = agentBehaviorFingerprint(PROFILES.ctx);
  try {
    definition.description = "A changed baseline-only description";
    expect(agentBehaviorFingerprint(PROFILES.baseline)).not.toBe("674793f83c5ac14a6ed46e1fd0e4327b964cbb2101250aa7db05fc7102486f09");
    expect(agentBehaviorFingerprint(PROFILES.ctx)).toBe(ctxFingerprint);
  } finally {
    definition.description = original;
  }
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent/events.js";
import { summarizeEventArguments, summarizeToolOutcome, toolSucceeded } from "../src/agent/events.js";
import { runAgent } from "../src/agent/runner.js";
import type { ModelProvider, ProviderRequest, ProviderTurn } from "../src/providers/index.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

const usage = { inputTokens: 10, outputTokens: 2, cacheHitInputTokens: 0, cacheMissInputTokens: 10, totalTokens: 12 };

function turn(calls: Array<[string, Record<string, unknown>]> = [], message = ""): ProviderTurn {
  const toolCalls = calls.map(([name, args], index) => ({ name, arguments: args, id: String(index) }));
  return { historyItems: [{ role: "assistant", content: message, toolCalls }], toolCalls, message, usage: { ...usage } };
}

function scripted(turns: ProviderTurn[]) {
  const requests: ProviderRequest[] = [];
  const provider: ModelProvider = {
    name: "openai",
    initialHistory: (content) => [{ role: "user", content }],
    complete: vi.fn(async (request) => {
      requests.push({ ...request, signal: undefined, history: structuredClone(request.history) });
      const next = turns.shift();
      if (!next) throw new Error("Script exhausted");
      return next;
    }),
    toolResultItem: (call, output) => ({ role: "tool", id: call.id, output })
  };
  return { provider, requests };
}

describe("interactive runner options", () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await makeTempDir("onehand-interactive-");
    repo = path.join(root, "repo");
    await mkdir(repo);
    await initGitRepo(repo);
    await writeFile(path.join(repo, "answer.txt"), "before\n");
    await git(["add", "answer.txt"], repo);
    await git(["commit", "-qm", "fixture"], repo);
    vi.stubEnv("ONEHAND_CHECKPOINT_DIR", path.join(root, "checkpoints"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanupTempDir(root);
  });

  it("keeps history, budgets, trace shape and completion unchanged with a throwing, mutating observer", async () => {
    const execute = async (observe: boolean) => {
      const { provider, requests } = scripted([
        turn([["set_plan", { steps: ["inspect"] }], ["read_file", { path: "answer.txt" }]]), turn([], "Inspected.")
      ]);
      const events: AgentEvent[] = [];
      const runDir = path.join(root, observe ? "observed" : "plain");
      const report = await runAgent({
        task: "inspect", repoPath: repo, provider, enforcePlanning: false, persistence: true, runDir,
        onEvent: observe ? (event) => {
          events.push(structuredClone(event));
          if (event.type === "model_turn" || event.type === "run_finished") event.usage.totalTokens = 999_999;
          if (event.type === "plan_updated") event.plan.steps[0]!.description = "corrupted";
          throw new Error("UI failure");
        } : undefined
      });
      const trace = (await readFile(path.join(runDir, "trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      return { report, requests, trace, events };
    };
    const plain = await execute(false);
    const observed = await execute(true);
    expect(observed.requests).toEqual(plain.requests);
    expect(observed.report.usage).toEqual({ ...plain.report.usage, wallTimeMs: expect.any(Number) });
    expect(observed.report.plan).toEqual(plain.report.plan);
    expect(observed.report.stopReason).toBe(plain.report.stopReason);
    expect(observed.trace.map(({ event, data }) => ({ event, keys: Object.keys(data) })))
      .toEqual(plain.trace.map(({ event, data }) => ({ event, keys: Object.keys(data) })));
    expect(observed.events.map((event) => event.type)).toEqual([
      "run_started", "model_turn", "tool_started", "tool_finished", "plan_updated", "tool_started", "tool_finished", "model_turn", "run_finished"
    ]);
    expect(observed.events.at(-1)).toMatchObject({ type: "run_finished", status: "success", usage: { totalTokens: 24 } });
  });

  it("answers once without a plan or nudge and appends project memory only when supplied", async () => {
    const { provider, requests } = scripted([turn([], "The answer is in answer.txt.")]);
    const events: AgentEvent[] = [];
    const report = await runAgent({
      task: "Where is the answer?", repoPath: repo, provider, completion: "answer", mode: "ask",
      projectInstructions: "Use small changes.", enforcePlanning: true, persistence: false, onEvent: (event) => events.push(event)
    });
    expect(report).toMatchObject({ status: "success", stopReason: "answered", usage: { modelRounds: 1, toolCalls: 0 } });
    expect(JSON.stringify(requests[0]!.history)).toContain("Project instructions (from AGENTS.md):\\nUse small changes.");
    expect(requests).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run_started", mode: "ask" });
  });

  it("snapshots once per mutating model turn and can restore the pre-run tree", async () => {
    const { provider } = scripted([
      turn([["set_plan", { steps: ["edit"] }], ["write_file", { path: "answer.txt", content: "first\n" }], ["write_file", { path: "new.txt", content: "new\n" }]]),
      turn([["replace_text", { path: "answer.txt", oldText: "first", newText: "second" }]]),
      turn([], "done")
    ]);
    const events: AgentEvent[] = [];
    const report = await runAgent({
      task: "edit", repoPath: repo, provider, enforcePlanning: false, persistence: false,
      checkpoints: true, onEvent: (event) => events.push(event)
    });
    expect(report.status).toBe("success");
    const snapshots = events.filter((event) => event.type === "checkpoint_created");
    expect(snapshots).toHaveLength(2);
    const checkpoints = new CheckpointStore(repo);
    expect(await checkpoints.list()).toHaveLength(2);
    await checkpoints.restore(snapshots[0]!.id);
    expect(await readFile(path.join(repo, "answer.txt"), "utf8")).toBe("before\n");
    await expect(readFile(path.join(repo, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not checkpoint denied writes and returns a recoverable observation", async () => {
    const { provider, requests } = scripted([
      turn([["set_plan", { steps: ["edit"] }], ["write_file", { path: "answer.txt", content: "changed" }]]), turn([], "Denied, so I left it alone.")
    ]);
    const events: AgentEvent[] = [];
    await runAgent({
      task: "edit", repoPath: repo, provider, enforcePlanning: false, persistence: false, checkpoints: true,
      authorize: async () => "deny", onEvent: (event) => events.push(event)
    });
    expect(await readFile(path.join(repo, "answer.txt"), "utf8")).toBe("before\n");
    expect(events.some((event) => event.type === "checkpoint_created")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "permission_decision", tool: "write_file", decision: "deny", source: "authorize" }));
    expect(JSON.stringify(requests[1]!.history)).toContain("Denied by permission policy: write_file");
    const denied = requests[1]!.history.at(-1) as { output: string };
    expect(JSON.parse(denied.output)).toMatchObject({ ok: false, recoverable: true });
  });

  it("keeps a checkpoint but prevents the write when interrupted during snapshot notification", async () => {
    const controller = new AbortController();
    const { provider } = scripted([
      turn([["set_plan", { steps: ["edit"] }], ["write_file", { path: "answer.txt", content: "changed" }], ["write_file", { path: "later.txt", content: "later" }]])
    ]);
    const report = await runAgent({
      task: "edit", repoPath: repo, provider, enforcePlanning: true, persistence: false, checkpoints: true,
      mode: "auto", signal: controller.signal,
      onEvent: (event) => { if (event.type === "checkpoint_created") controller.abort(); }
    });
    expect(report).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
    expect(await new CheckpointStore(repo).list()).toHaveLength(1);
    expect(await readFile(path.join(repo, "answer.txt"), "utf8")).toBe("before\n");
    await expect(readFile(path.join(repo, "later.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores rejected async observers", async () => {
    const { provider } = scripted([turn([], "answer")]);
    const report = await runAgent({
      task: "question", repoPath: repo, provider, persistence: false, completion: "answer",
      onEvent: async () => { throw new Error("async UI failure"); }
    });
    expect(report.stopReason).toBe("answered");
  });

  it("does not charge synchronous observer time to the run budget", async () => {
    const now = Date.now.bind(Date);
    let observerDelay = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + observerDelay);
    try {
      const { provider } = scripted([turn([["read_file", { path: "answer.txt" }]]), turn([], "answer")]);
      const report = await runAgent({
        task: "question", repoPath: repo, provider, persistence: false, completion: "answer", maxWallTimeMs: 1000,
        onEvent: () => { observerDelay += 10_000; }
      });
      expect(report.stopReason).toBe("answered");
      expect(report.usage!.wallTimeMs).toBeLessThan(1000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("authorizes only validated gated writes/exec, and approvals cannot override hard policy", async () => {
    const authorize = vi.fn(async () => "allow" as const);
    const beforeMutation = vi.fn(async () => {});
    const registry = createToolRegistry({ repoRoot: repo, timeoutSec: 5, allowDestructive: false, enforcePlanning: true, authorize, beforeMutation });
    await registry.execute("write_file", { path: "answer.txt" });
    await registry.execute("write_file", { path: "answer.txt", content: "blocked by plan" });
    await registry.execute("read_file", { path: "answer.txt" });
    await registry.execute("search_code", { query: "before" });
    await registry.execute("set_plan", { steps: ["inspect"] });
    expect(authorize).not.toHaveBeenCalled();
    const outside = await registry.execute("write_file", { path: "../outside.txt", content: "blocked" });
    const secret = await registry.execute("write_file", { path: ".env", content: "blocked" });
    const command = await registry.execute("run_command", { program: "npm", args: ["install"] });
    expect(outside.ok).toBe(false);
    expect(secret.ok).toBe(false);
    expect(command.ok).toBe(false);
    expect(beforeMutation).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(authorize.mock.calls[0]).toEqual([{ name: "write_file", args: { path: "../outside.txt", content: "blocked" }, risk: "write" }]);
  });

  it("reports checkpoint failure for commands and tests without executing either", async () => {
    await writeFile(path.join(repo, "test.cjs"), 'require("node:fs").writeFileSync("executed.txt", "bad");');
    const registry = createToolRegistry({
      repoRoot: repo, timeoutSec: 5, allowDestructive: false, testCommand: "node test.cjs",
      beforeMutation: async () => { throw new Error("checkpoint unavailable"); }
    });
    for (const [name, args] of [["run_command", { program: "node", args: ["test.cjs"] }], ["run_tests", {}]] as const) {
      expect(await registry.execute(name, args)).toMatchObject({ ok: false, recoverable: true, error: "checkpoint unavailable" });
    }
    await expect(readFile(path.join(repo, "executed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("renders bounded one-line summaries without file contents or terminal control sequences", () => {
  expect(summarizeEventArguments({ path: "answer.txt\n\x1b[31m", content: "private content" })).not.toContain("private content");
  expect(summarizeEventArguments("null")).toBe("invalid arguments");
  const result = { ok: true as const, data: { exitCode: 1, durationMs: 12_300, timedOut: false } };
  expect(toolSucceeded(result)).toBe(false);
  expect(summarizeToolOutcome("run_command", {}, result, 20)).toBe("exit 1 · 12.3s");
  expect(summarizeToolOutcome("read_file", {}, { ok: false, error: "bad\npath", recoverable: true }, 0)).toBe("error: bad path");
});

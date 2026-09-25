import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categorizeToolFailure, ModelCallError, runAgent } from "../src/agent/runner.js";
import { createModelProvider, ModelProvider, ProviderRequest, ProviderTurn } from "../src/providers/index.js";
import { runProgramCommand } from "../src/tools/command.js";
import { ToolResult } from "../src/types.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

vi.mock("../src/tools/command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/command.js")>();
  return { ...actual, runProgramCommand: vi.fn(actual.runProgramCommand) };
});

describe("strict agent runner", () => {
  let repo: string;
  let runDir: string;

  beforeEach(async () => {
    repo = await makeTempDir();
    runDir = await makeTempDir();
    await initGitRepo(repo);
  });

  afterEach(async () => {
    await cleanupTempDir(repo);
    await cleanupTempDir(runDir);
  });

  it("requires explicit plan, observation-driven updates, post-write tests, and finish_task", async () => {
    await mkdir(path.join(repo, "src"));
    await writeFile(path.join(repo, "src", "answer.cjs"), "exports.answer = () => 41;\n");
    await writeFile(path.join(repo, "test.cjs"), "const assert=require('node:assert/strict');assert.equal(require('./src/answer.cjs').answer(),42);\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);
    const provider = scriptedProvider([
      call("set_plan", { steps: ["inspect", "fix", "verify"] }, "1"),
      call("read_file", { path: "src/answer.cjs" }, "2"),
      call("update_plan", { stepId: 1, status: "completed", evidence: "read source" }, "3"),
      call("update_plan", { stepId: 2, status: "in_progress" }, "4"),
      call("replace_text", { path: "src/answer.cjs", oldText: "41", newText: "42" }, "5"),
      call("update_plan", { stepId: 2, status: "completed", evidence: "updated value" }, "6"),
      call("update_plan", { stepId: 3, status: "in_progress" }, "7"),
      call("run_tests", {}, "8"),
      call("update_plan", { stepId: 3, status: "completed", evidence: "node test.cjs passed" }, "9"),
      call("finish_task", { summary: "Fixed and verified." }, "10")
    ]);
    const report = await runAgent({
      task: "fix answer",
      repoPath: repo,
      testCommand: "node test.cjs",
      provider,
      enforcePlanning: true,
      persistence: true,
      runDir,
      retryDelayMs: 1,
      timeoutSec: 10
    });
    expect(report.status).toBe("success");
    expect(report.stopReason).toBe("explicit_finish");
    expect(report.tests.at(-1)?.passed).toBe(true);
    expect(report.plan?.status).toBe("completed");
    expect(await readFile(path.join(repo, "src", "answer.cjs"), "utf8")).toContain("42");
    expect(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")).status).toBe("success");
  });

  it("does not convert a plain model stop into success", async () => {
    const report = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: scriptedProvider([messageTurn("done")]),
      enforcePlanning: true,
      persistence: false
    });
    expect(report.status).toBe("failed");
    expect(report.stopReason).toBe("model_stopped_without_finish");
  });

  it("retries retryable model errors at most three attempts", async () => {
    const error = Object.assign(new Error("rate limit"), { status: 429 });
    const complete = vi.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue(messageTurn("done"));
    const provider = baseProvider(complete);
    const report = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider,
      enforcePlanning: false,
      persistence: false,
      retryDelayMs: 1,
      maxApiAttempts: 3
    });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(report.status).toBe("success");
  });

  it("pairs every batched tool call before persisting a tool-budget stop", async () => {
    const turn: ProviderTurn = {
      historyItems: [{
        type: "function_call_batch",
        calls: [
          { name: "set_plan", arguments: JSON.stringify({ steps: ["inspect"] }), call_id: "1" },
          { name: "read_file", arguments: JSON.stringify({ path: "missing.txt" }), call_id: "2" }
        ]
      }],
      toolCalls: [
        { id: "1", name: "set_plan", arguments: JSON.stringify({ steps: ["inspect"] }) },
        { id: "2", name: "read_file", arguments: JSON.stringify({ path: "missing.txt" }) }
      ],
      message: "",
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1, cacheHitInputTokens: 0, cacheMissInputTokens: 1, totalTokens: 2 }
    };
    const report = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: scriptedProvider([turn]),
      enforcePlanning: true,
      persistence: true,
      runDir,
      maxToolCalls: 1
    });
    expect(report.status).toBe("budget_exhausted");
    expect(report.stopReason).toBe("tool_budget");
    const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
    expect(state.history.filter((item: any) => item.type === "function_call_output")).toHaveLength(2);
  });

  it("rejects resume after an uncommitted worktree change", async () => {
    await writeFile(path.join(repo, "tracked.txt"), "before\n");
    await git(["add", "tracked.txt"], repo);
    await git(["commit", "-m", "tracked fixture"], repo);
    const first = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: scriptedProvider([call("set_plan", { steps: ["inspect"] }, "1")]),
      enforcePlanning: true,
      persistence: true,
      runDir,
      maxSteps: 1
    });
    expect(first.status).toBe("budget_exhausted");
    await writeFile(path.join(repo, "tracked.txt"), "after\n");
    await expect(runAgent({
      task: "inspect",
      repoPath: repo,
      provider: scriptedProvider([]),
      enforcePlanning: true,
      persistence: true,
      resume: runDir,
      maxSteps: 2
    })).rejects.toThrow(/worktree changed/);
  });

  it("rejects resume after an ignored worktree file changes", async () => {
    await writeFile(path.join(repo, ".gitignore"), "cache.tmp\n");
    await writeFile(path.join(repo, "cache.tmp"), "before\n");
    await git(["add", ".gitignore"], repo);
    await git(["commit", "-m", "ignore cache fixture"], repo);
    await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: scriptedProvider([call("set_plan", { steps: ["inspect"] }, "1")]),
      enforcePlanning: true,
      persistence: true,
      runDir,
      maxSteps: 1
    });
    await writeFile(path.join(repo, "cache.tmp"), "after\n");
    await expect(runAgent({
      task: "inspect",
      repoPath: repo,
      provider: scriptedProvider([]),
      enforcePlanning: true,
      persistence: true,
      resume: runDir,
      maxSteps: 2
    })).rejects.toThrow(/worktree changed/);
  });

  it("checkpoints a fully paired history while a later batched tool is still running", async () => {
    await writeFile(path.join(repo, "slow.cjs"), "setTimeout(()=>process.stdout.write('done\\n'),300);\n");
    await git(["add", "slow.cjs"], repo);
    await git(["commit", "-m", "slow command fixture"], repo);
    const turn: ProviderTurn = {
      historyItems: [{ type: "batch", call_ids: ["1", "2"] }],
      toolCalls: [
        { id: "1", name: "set_plan", arguments: JSON.stringify({ steps: ["run diagnostic"] }) },
        { id: "2", name: "run_command", arguments: JSON.stringify({ program: "node", args: ["slow.cjs"] }) }
      ],
      message: "",
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1, cacheHitInputTokens: 0, cacheMissInputTokens: 1, totalTokens: 2 }
    };
    const running = runAgent({
      task: "run diagnostic",
      repoPath: repo,
      provider: scriptedProvider([turn]),
      enforcePlanning: true,
      persistence: true,
      runDir,
      maxSteps: 1
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
    expect(state.history.filter((item: any) => item.type === "function_call_output")).toHaveLength(2);
    await running;
  });

  it("passes DeepSeek reasoning_content back on later requests without persisting it", async () => {
    const reasoning = "private chain of thought 7f3a";
    const requests: any[] = [];
    const usage = {
      prompt_tokens: 10, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6, completion_tokens: 5, total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 3 }
    };
    const responses = [
      {
        model: "deepseek-v4-pro",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            reasoning_content: reasoning,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "set_plan", arguments: JSON.stringify({ steps: ["inspect"] }) } }]
          }
        }],
        usage
      },
      ...[2, 3].map((round) => ({
        model: "deepseek-v4-pro",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "pausing", reasoning_content: `${reasoning} round ${round}` } }],
        usage
      }))
    ];
    const create = vi.fn(async (input: Record<string, unknown>) => {
      requests.push(structuredClone(input));
      return responses.shift();
    });
    const report = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: createModelProvider({ provider: "deepseek", deepSeekClient: { chat: { completions: { create } } } }),
      enforcePlanning: true,
      persistence: true,
      runDir,
      maxSteps: 3
    });
    expect(requests).toHaveLength(3);
    expect(requests[0]).not.toHaveProperty("temperature");
    for (const request of requests.slice(1)) {
      expect(request.messages).toContainEqual(expect.objectContaining({
        role: "assistant",
        reasoning_content: reasoning,
        tool_calls: [expect.objectContaining({ id: "call-1" })]
      }));
    }
    expect(report.usage).toMatchObject({ inputTokens: 30, cacheHitInputTokens: 12, reasoningTokens: 9 });
    const stateText = await readFile(path.join(runDir, "state.json"), "utf8");
    const traceText = await readFile(path.join(runDir, "trace.jsonl"), "utf8");
    expect(stateText + traceText).not.toContain(reasoning);
    const state = JSON.parse(stateText);
    expect(state.history.filter((item: any) => item.reasoning_content === "[REDACTED]")).toHaveLength(3);
    expect(state.usage).toMatchObject({ inputTokens: 30, outputTokens: 15, reasoningTokens: 9 });
    const events = traceText.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((event) => event.event === "model_turn").data).toMatchObject({
      responseModel: "deepseek-v4-pro",
      latencyMs: expect.any(Number),
      usage: { inputTokens: 10, outputTokens: 5, cacheHitInputTokens: 4, cacheMissInputTokens: 6, reasoningTokens: 3 }
    });
    expect(events.find((event) => event.event === "tool_result").data).toMatchObject({
      name: "set_plan", ok: true, durationMs: expect.any(Number), observationBytes: expect.any(Number)
    });
    expect(events.find((event) => event.event === "text_only_turn").data).toEqual({ round: 2, finishReason: "stop", nudge: true });
  });

  it("restores nudges, numeric usage, and flags redacted reasoning on resume", async () => {
    await writeFile(path.join(repo, "tracked.txt"), "x\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);
    const textTurn = {
      model: "deepseek-v4-pro",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "thinking aloud", reasoning_content: "hidden" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    };
    const deepSeek = (create: (input: Record<string, unknown>) => Promise<unknown>) =>
      createModelProvider({ provider: "deepseek", deepSeekClient: { chat: { completions: { create } } } });
    const options = { task: "inspect", repoPath: repo, enforcePlanning: true, persistence: true, runDir };
    const first = await runAgent({ ...options, provider: deepSeek(async () => textTurn), maxSteps: 1 });
    expect(first.stopReason).toBe("step_budget");
    expect(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")).textOnlyNudges).toBe(1);
    const requests: any[] = [];
    const resumed = await runAgent({
      ...options,
      resume: runDir,
      maxSteps: 10,
      provider: deepSeek(async (input) => {
        requests.push(structuredClone(input));
        return textTurn;
      })
    });
    expect(resumed).toMatchObject({ status: "failed", stopReason: "model_stopped_without_finish" });
    expect(resumed.usage).toMatchObject({ modelRounds: 3, inputTokens: 30, outputTokens: 6 });
    expect(requests[0].messages).toContainEqual(expect.objectContaining({ role: "assistant", reasoning_content: "[REDACTED]" }));
    const events = (await readFile(path.join(runDir, "trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((event) => event.event === "reasoning_redacted_on_resume")?.data).toEqual({ count: 1 });
  });

  it("nudges a text-only turn back to tool use and then finishes normally", async () => {
    await writeFile(path.join(repo, "test.cjs"), "process.exit(0);\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);
    const turns = [
      messageTurn("I will start by making a plan."),
      call("set_plan", { steps: ["verify"] }, "1"),
      call("run_tests", {}, "2"),
      call("update_plan", { stepId: 1, status: "completed", evidence: "node test.cjs passed" }, "3"),
      call("finish_task", { summary: "Verified." }, "4")
    ];
    const histories: unknown[][] = [];
    const complete = vi.fn(async (request: ProviderRequest) => {
      histories.push(structuredClone(request.history));
      return turns.shift() ?? messageTurn("unexpected stop");
    });
    const report = await runAgent({
      task: "verify",
      repoPath: repo,
      testCommand: "node test.cjs",
      provider: baseProvider(complete),
      enforcePlanning: true,
      persistence: true,
      runDir,
      timeoutSec: 10
    });
    expect(report).toMatchObject({ status: "success", stopReason: "explicit_finish", finalMessage: "Verified." });
    expect(report.usage?.modelRounds).toBe(5);
    expect(histories[1]!.at(-1)).toEqual({
      role: "user",
      content: expect.stringContaining("A plain assistant message does not complete the task")
    });
    const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
    expect(state.textOnlyNudges).toBe(1);
  });

  it("fails as model_stopped_without_finish once text-only nudges are exhausted", async () => {
    const complete = vi.fn(async () => messageTurn("still thinking"));
    const report = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: baseProvider(complete),
      enforcePlanning: true,
      persistence: false
    });
    expect(report).toMatchObject({ status: "failed", stopReason: "model_stopped_without_finish" });
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("reports output_limit when text-only turns keep hitting the per-turn output cap", async () => {
    const histories: unknown[][] = [];
    const complete = vi.fn(async (request: ProviderRequest) => {
      histories.push(structuredClone(request.history));
      return { ...messageTurn(""), finishReason: "length" };
    });
    const report = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: baseProvider(complete),
      enforcePlanning: true,
      persistence: false,
      maxTextOnlyNudges: 1,
      maxTurnOutputTokens: 1_000
    });
    expect(report).toMatchObject({ status: "failed", stopReason: "output_limit" });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]![0].maxOutputTokens).toBe(1_000);
    expect(histories[1]!.at(-1)).toEqual({ role: "user", content: expect.stringContaining("hit the output limit") });
  });

  it("classifies exhausted model calls as model_error and other failures as runtime_error", async () => {
    const cause = Object.assign(new Error("invalid request"), { status: 400 });
    const wrapped = new ModelCallError(cause);
    expect(wrapped).toBeInstanceOf(Error);
    expect([wrapped.name, wrapped.message, wrapped.status, wrapped.cause]).toEqual(["ModelCallError", "invalid request", 400, cause]);
    const modelFailure = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: baseProvider(vi.fn().mockRejectedValue(cause)),
      enforcePlanning: true,
      persistence: false
    });
    expect(modelFailure).toMatchObject({ status: "failed", stopReason: "model_error", finalMessage: "invalid request" });
    const runtimeFailure = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: {
        ...scriptedProvider([call("set_plan", { steps: ["inspect"] }, "1")]),
        toolResultItem: () => { throw new Error("history append failed"); }
      },
      enforcePlanning: true,
      persistence: false
    });
    expect(runtimeFailure).toMatchObject({ status: "failed", stopReason: "runtime_error", finalMessage: "history append failed" });
  });

  it("computes the worktree fingerprint only when state is persisted", async () => {
    await writeFile(path.join(repo, "tracked.txt"), "x\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);
    const fingerprintCommands = () => vi.mocked(runProgramCommand).mock.calls
      .filter(([options]) => options.program === "git" && options.args?.includes("ls-files")).length;
    const turns = () => [call("set_plan", { steps: ["inspect"] }, "1"), call("read_file", { path: "tracked.txt" }, "2")];
    vi.mocked(runProgramCommand).mockClear();
    await runAgent({ task: "inspect", repoPath: repo, provider: scriptedProvider(turns()), enforcePlanning: true, persistence: false, maxSteps: 2 });
    expect(fingerprintCommands()).toBe(0);
    await runAgent({ task: "inspect", repoPath: repo, provider: scriptedProvider(turns()), enforcePlanning: true, persistence: true, runDir, maxSteps: 2 });
    // Two per-call and one final fingerprint; each runs two ls-files commands.
    expect(fingerprintCommands()).toBe(6);
  });

  it("fingerprints unreadable files instead of failing the run", async () => {
    if (process.getuid?.() === 0) return;
    await writeFile(path.join(repo, "tracked.txt"), "x\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);
    await writeFile(path.join(repo, "locked.txt"), "private\n", { mode: 0o000 });
    const report = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: scriptedProvider([call("set_plan", { steps: ["inspect"] }, "1")]),
      enforcePlanning: true,
      persistence: true,
      runDir,
      maxSteps: 1
    });
    expect(report).toMatchObject({ status: "budget_exhausted", stopReason: "step_budget" });
    expect(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")).worktreeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes failureSignatures keys so a failed tool call's raw arguments never reach state.json", async () => {
    const secret = "sk-should-not-leak-into-state-1234567890";
    await runAgent({
      task: "inspect",
      repoPath: repo,
      provider: scriptedProvider([
        call("set_plan", { steps: ["inspect"] }, "1"),
        call("read_file", { path: `${secret}.txt` }, "2")
      ]),
      enforcePlanning: true,
      persistence: true,
      runDir,
      maxSteps: 2
    });
    const raw = await readFile(path.join(runDir, "state.json"), "utf8");
    expect(raw).not.toContain(secret);
    const failureSignatures = JSON.parse(raw).failureSignatures;
    const keys = Object.keys(failureSignatures);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(failureSignatures[keys[0]!]).toBe(1);
  });
});

describe("categorizeToolFailure", () => {
  it("maps tool results to stable failure categories", () => {
    const failed = (error: string): ToolResult<never> => ({ ok: false, error, recoverable: true });
    const cases: Array<[string, ToolResult<unknown>, string | undefined]> = [
      ["read_file", { ok: true, data: { path: "a.cjs", content: "", bytes: 0 } }, undefined],
      ["run_tests", { ok: true, data: { passed: true, timedOut: false } }, undefined],
      ["run_command", { ok: true, data: { exitCode: 1, timedOut: false } }, undefined],
      ["run_tests", { ok: true, data: { passed: false, timedOut: false } }, "test_failed"],
      ["run_command", { ok: true, data: { exitCode: null, timedOut: true } }, "timeout"],
      ["run_tests", { ok: true, data: { passed: false, timedOut: true } }, "timeout"],
      ["run_command", failed("Command timed out after 5s"), "timeout"],
      ["read_file", failed("Tool arguments are not valid JSON: Unexpected end of JSON input"), "schema"],
      ["update_plan", failed("arguments.status must be one of: pending, in_progress, completed, blocked"), "schema"],
      ["update_plan", failed("arguments.stepId must be >= 1"), "schema"],
      ["read_file", failed("arguments.path is required"), "schema"],
      ["read_file", failed("arguments.extra is not allowed"), "schema"],
      ["set_plan", failed("arguments.steps must contain at most 8 items"), "schema"],
      ["write_file", failed("Call set_plan before modifying files"), "plan_gate"],
      ["write_file", failed("Repeated failure requires update_plan before continuing"), "plan_gate"],
      ["write_file", failed("The active plan is blocked"), "plan_gate"],
      ["update_plan", failed("Set a plan before updating it"), "plan_gate"],
      ["finish_task", failed("Replan after the repeated failure before finishing"), "plan_gate"],
      ["finish_task", failed("All plan steps must be completed before finish_task"), "plan_gate"],
      ["finish_task", failed("Run a passing verification after the most recent file change"), "plan_gate"],
      ["read_file", failed("Protected repository path is not accessible: .env"), "policy"],
      ["write_file", failed("Path escapes repository root: ../outside.txt"), "policy"],
      ["write_file", failed("Path resolves outside repository root: escape/proof.txt"), "policy"],
      ["run_command", failed("Program is outside the local execution allowlist: curl"), "policy"],
      ["run_command", failed("Inline code execution is disabled for model tools: node -e"), "policy"],
      ["run_command", failed("Git mutation or network operation is disabled: git push"), "policy"],
      ["run_tests", failed("Shell operator \"|\" is not allowed"), "policy"],
      ["run_command", failed("Command arguments must not contain NUL bytes"), "policy"],
      ["read_file", failed("ENOENT: no such file or directory, open '/repo/missing.cjs'"), "not_found"],
      ["replace_text", failed("oldText was not found"), "not_found"],
      ["missing_tool", failed("Unknown tool: missing_tool"), "unknown_tool"],
      ["finish_task", failed("No plan was set"), "plan_gate"],
      ["run_command", failed("Use the dedicated repository tool instead of run_command: grep"), "policy"],
      ["update_plan", failed("Unknown plan step: 9"), "other"]
    ];
    for (const [name, result, expected] of cases) {
      expect(categorizeToolFailure(name, result), `${name}: ${JSON.stringify(result)}`).toBe(expected);
    }
  });
});

function scriptedProvider(turns: ProviderTurn[]): ModelProvider {
  return baseProvider(vi.fn(async () => turns.shift() ?? messageTurn("unexpected stop")));
}

function baseProvider(complete: any): ModelProvider {
  return {
    name: "openai",
    initialHistory: (content) => [{ role: "user", content }],
    complete,
    toolResultItem: (toolCall, output) => ({ type: "function_call_output", call_id: toolCall.id, output })
  };
}

function call(name: string, args: Record<string, unknown>, id: string): ProviderTurn {
  return {
    historyItems: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: id }],
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    message: "",
    finishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: 1, cacheHitInputTokens: 0, cacheMissInputTokens: 1, totalTokens: 2 }
  };
}

function messageTurn(message: string): ProviderTurn {
  return {
    historyItems: [{ role: "assistant", content: message }],
    toolCalls: [],
    message,
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, cacheHitInputTokens: 0, cacheMissInputTokens: 1, totalTokens: 2 }
  };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent/runner.js";
import { ModelProvider, ProviderTurn } from "../src/providers/index.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

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

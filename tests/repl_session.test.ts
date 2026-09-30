import { PassThrough } from "node:stream";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, type RunAgentOptions } from "../src/agent/runner.js";
import { runRepl } from "../src/repl/index.js";
import type { ModelProvider, ProviderRequest, ProviderTurn } from "../src/providers/index.js";
import type { RunReport } from "../src/types.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

describe("terminal REPL session persistence", () => {
  let repo: string;
  let userHome: string;
  let sessionDir: string;
  let previousCheckpointDir: string | undefined;

  beforeEach(async () => {
    repo = await makeTempDir("onehand-repl-session-repo-");
    userHome = await makeTempDir("onehand-repl-session-home-");
    sessionDir = path.join(userHome, "sessions", "chat-test");
    await initGitRepo(repo);
    await writeFile(path.join(repo, "tracked.txt"), "before\n");
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e \"\"" } }));
    await git(["add", "tracked.txt", "package.json"], repo);
    await git(["commit", "-m", "initial"], repo);
    previousCheckpointDir = process.env.ONEHAND_CHECKPOINT_DIR;
    process.env.ONEHAND_CHECKPOINT_DIR = path.join(userHome, "checkpoints");
  });

  afterEach(async () => {
    if (previousCheckpointDir === undefined) delete process.env.ONEHAND_CHECKPOINT_DIR;
    else process.env.ONEHAND_CHECKPOINT_DIR = previousCheckpointDir;
    await cleanupTempDir(repo);
    await cleanupTempDir(userHome);
  });

  it("persists every task outside the worktree and forwards the configured test command and budgets", async () => {
    const calls: RunAgentOptions[] = [];
    const { input, output, text } = streams();
    input.end("persist this task\n/exit\n");

    await runRepl({
      repoPath: repo,
      provider: "openai",
      apiKey: "must-not-be-persisted",
      baseURL: "https://models.example.test/v1",
      mode: "ask",
      profile: "ctx",
      testCommand: "node tests.cjs",
      maxSteps: 27,
      sessionDir,
      userHome,
      input,
      output,
      providerFactory: () => scriptedProvider([messageTurn("unused")]),
      runAgentFn: async (options) => {
        calls.push(options);
        return report("saved");
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ persistence: true, testCommand: "node tests.cjs", maxSteps: 27 });
    expect(calls[0]!.runDir).toMatch(new RegExp(`^${escapeRegExp(path.join(sessionDir, "runs"))}`));
    const raw = await readFile(path.join(sessionDir, "session.json"), "utf8");
    const saved = JSON.parse(raw);
    expect(saved).toMatchObject({
      repo,
      config: {
        provider: "openai",
        baseURL: "https://models.example.test/v1",
        mode: "ask",
        profile: "ctx",
        testCommand: "node tests.cjs"
      },
      activeTask: null,
      memory: [{ input: "persist this task", finalMessage: "saved" }]
    });
    expect(raw).not.toContain("must-not-be-persisted");
    expect((await stat(path.join(sessionDir, "session.json"))).mode & 0o777).toBe(0o600);
    expect(text()).toContain("tests: node tests.cjs");
    expect(text()).toContain(`--resume '${sessionDir}'`);
  });

  it("resumes the exact unfinished task without double-counting usage and preserves undo", async () => {
    const firstProvider = scriptedProvider([
      toolTurn("set_plan", { steps: ["change tracked file"] }, "plan"),
      toolTurn("write_file", { path: "tracked.txt", content: "after\n" }, "write")
    ]);
    const first = streams();
    first.input.end("change it\n/undo\n/rewind 1\n/exit\n");

    await runRepl({
      repoPath: repo,
      provider: "openai",
      mode: "auto",
      profile: "ctx",
      testCommand: "npm test",
      maxSteps: 2,
      sessionDir,
      userHome,
      input: first.input,
      output: first.output,
      providerFactory: () => firstProvider
    });

    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("after\n");
    const interrupted = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    expect(interrupted.activeTask).toMatchObject({ input: "change it", task: "change it" });
    expect(interrupted.activeTask.checkpoint).toMatch(/^[a-f0-9]{40,64}$/);
    expect(interrupted.usage.totalTokens).toBe(4);

    const resumedProvider = scriptedProvider([
      toolTurn("update_plan", { stepId: 1, status: "completed", evidence: "tracked file changed" }, "complete"),
      toolTurn("run_tests", {}, "test"),
      toolTurn("finish_task", { summary: "Changed and verified tracked.txt." }, "finish")
    ]);
    const resumed = streams();
    resumed.input.end("/undo\n/exit\n");
    await runRepl({
      repoPath: repo,
      resume: sessionDir,
      maxSteps: 5,
      userHome,
      input: resumed.input,
      output: resumed.output,
      providerFactory: () => resumedProvider
    });

    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("before\n");
    const completed = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    expect(completed.activeTask).toBeNull();
    expect(completed.usage.totalTokens).toBe(10);
    expect(completed.memory).toEqual([{ input: "change it", finalMessage: "Changed and verified tracked.txt." }]);

    const complete = vi.fn(async () => messageTurn("must not run"));
    const reopened = streams();
    reopened.input.end("/exit\n");
    await runRepl({
      repoPath: repo,
      resume: sessionDir,
      userHome,
      input: reopened.input,
      output: reopened.output,
      providerFactory: () => providerWith(complete)
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails closed on corrupt or mismatched session metadata before provider creation", async () => {
    const initial = streams();
    initial.input.end("/exit\n");
    await runRepl({
      repoPath: repo, provider: "openai", sessionDir, userHome,
      input: initial.input, output: initial.output,
      providerFactory: () => scriptedProvider([])
    });

    const createProvider = vi.fn(() => scriptedProvider([]));
    const mismatch = streams();
    mismatch.input.end("/exit\n");
    await expect(runRepl({
      repoPath: repo, resume: sessionDir, provider: "deepseek", userHome,
      input: mismatch.input, output: mismatch.output, providerFactory: createProvider
    })).rejects.toThrow(/saved provider/i);
    expect(createProvider).not.toHaveBeenCalled();

    await writeFile(path.join(sessionDir, "session.json"), "{not-json");
    const corrupt = streams();
    corrupt.input.end("/exit\n");
    await expect(runRepl({
      repoPath: repo, resume: sessionDir, userHome,
      input: corrupt.input, output: corrupt.output, providerFactory: createProvider
    })).rejects.toThrow(/corrupt chat session/i);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it.each(["finish around the crash", "finish with token=sample123"])("finalizes saved success without replaying %s", async (task) => {
    const first = streams();
    first.input.end(`${task}\n`);
    await runRepl({
      repoPath: repo, provider: "openai", mode: "auto", profile: "ctx",
      maxSteps: 1, sessionDir, userHome, input: first.input, output: first.output,
      providerFactory: () => scriptedProvider([
        toolTurn("set_plan", { steps: ["inspect"] }, "plan")
      ])
    });
    const sessionPath = path.join(sessionDir, "session.json");
    const sidecar = JSON.parse(await readFile(sessionPath, "utf8"));
    const runStatePath = path.join(sidecar.activeTask.runDir, "state.json");
    const runState = JSON.parse(await readFile(runStatePath, "utf8"));
    runState.status = "success";
    runState.stopReason = "explicit_finish";
    runState.finalMessage = "Recovered exactly once.";
    await writeFile(runStatePath, JSON.stringify(runState));

    const complete = vi.fn(async () => messageTurn("must not run"));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = streams();
      reopened.input.end("/exit\n");
      await runRepl({
        repoPath: repo, resume: sessionDir, userHome,
        input: reopened.input, output: reopened.output,
        providerFactory: () => providerWith(complete)
      });
    }

    const finalized = JSON.parse(await readFile(sessionPath, "utf8"));
    expect(finalized.activeTask).toBeNull();
    expect(finalized.memory).toEqual([{ input: task.includes("token=") ? "finish with token=[REDACTED]" : task, finalMessage: "Recovered exactly once." }]);
    expect(finalized.usage.totalTokens).toBe(2);
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses to replay a task marked running when no run state exists", async () => {
    const initial = streams();
    initial.input.end("/exit\n");
    await runRepl({
      repoPath: repo, provider: "openai", sessionDir, userHome,
      input: initial.input, output: initial.output,
      providerFactory: () => scriptedProvider([])
    });
    const sessionPath = path.join(sessionDir, "session.json");
    const saved = JSON.parse(await readFile(sessionPath, "utf8"));
    saved.activeTask = {
      input: "possibly billed",
      task: "possibly billed",
      runDir: path.join(sessionDir, "runs", "missing"),
      phase: "running",
      resumeExact: true
    };
    await writeFile(sessionPath, JSON.stringify(saved));
    const createProvider = vi.fn(() => scriptedProvider([]));
    const resumed = streams();
    resumed.input.end("/exit\n");

    await runRepl({
      repoPath: repo, resume: sessionDir, userHome,
      input: resumed.input, output: resumed.output, providerFactory: createProvider
    });
    expect(resumed.text()).toMatch(/may have started, but no run state was saved/i);
    expect(resumed.text()).toContain("/discard");
    expect(JSON.parse(await readFile(sessionPath, "utf8")).activeTask.input).toBe("possibly billed");
    expect(createProvider).not.toHaveBeenCalled();
  });
});

function streams(): { input: PassThrough; output: PassThrough; text(): string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let content = "";
  output.on("data", (chunk) => { content += chunk.toString("utf8"); });
  return { input, output, text: () => content };
}

function report(finalMessage: string): RunReport {
  return {
    status: "success", stopReason: "answered", task: "task", repo: "repo",
    changedFiles: [], commands: [], tests: [], diff: null, finalMessage,
    usage: {
      modelRounds: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1,
      cacheHitInputTokens: 0, cacheMissInputTokens: 1, totalTokens: 2,
      reasoningTokens: 0, wallTimeMs: 1
    }
  };
}

function scriptedProvider(turns: ProviderTurn[]): ModelProvider {
  let index = 0;
  return providerWith(async () => turns[index++] ?? messageTurn("done"));
}

function providerWith(complete: (request: ProviderRequest) => Promise<ProviderTurn>): ModelProvider {
  return {
    name: "openai",
    initialHistory: (content) => [{ role: "user", content }],
    toolResultItem: (call, output) => ({ callId: call.id, output }),
    complete
  };
}

function toolTurn(name: string, args: Record<string, unknown>, id: string): ProviderTurn {
  return {
    historyItems: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }],
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }], message: "", finishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: 1, cacheHitInputTokens: 0, cacheMissInputTokens: 1, totalTokens: 2 }
  };
}

function messageTurn(message: string): ProviderTurn {
  return {
    historyItems: [{ role: "assistant", content: message }], toolCalls: [], message, finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, cacheHitInputTokens: 0, cacheMissInputTokens: 1, totalTokens: 2 }
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

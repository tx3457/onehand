import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILES, type AgentProfile } from "../src/agent/profile.js";
import { runAgent } from "../src/agent/runner.js";
import type { ModelProvider, ProviderRequest, ProviderTurn } from "../src/providers/types.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

const leanNoticesProfile = {
  name: "lean-notices",
  flags: { leanPlanning: true, budgetNotices: true }
} satisfies AgentProfile;

type TraceEvent = { event?: unknown; data?: Record<string, unknown> };
let repo: string;
let runDir: string;

describe("budget notices", () => {
  beforeEach(async () => {
    repo = await makeTempDir();
    runDir = await makeTempDir();
    await initGitRepo(repo);
  });

  afterEach(async () => {
    await cleanupTempDir(repo);
    await cleanupTempDir(runDir);
  });

  it("posts each crossed round threshold once before the next model call", async () => {
    const requests: ProviderRequest[] = [];
    const provider = scriptedProvider(
      Array.from({ length: 10 }, (_, index) => call(
        index === 0 ? "set_plan" : "list_files",
        index === 0 ? { steps: ["inspect"] } : {},
        String(index + 1)
      )),
      requests
    );

    await runWithNotices(provider, { maxSteps: 10, persistence: true, runDir });

    expect(notices(requests[4]!.history)).toEqual([]);
    expect(notices(requests[5]!.history)).toEqual([
      "Budget notice: 50% of the run budget is used (rounds 5/10, input tokens 5/1M, tool calls 5/100). Every round resends the whole history, so the remaining rounds are the most expensive. If the latest change is verified and the task is done, mark the remaining plan steps completed with evidence and call finish_task; otherwise make the smallest next change that can be verified."
    ]);
    expect(notices(requests[8]!.history).map(noticePercent)).toEqual([50, 80]);
    expect(notices(requests[9]!.history).map(noticePercent)).toEqual([50, 80, 90]);
    expect(requests[5]!.history.at(-2)).toEqual(expect.objectContaining({ type: "function_call_output", call_id: "5" }));
    expect(requests[5]!.history.at(-1)).toEqual(expect.objectContaining({ role: "user", content: expect.stringMatching(/^Budget notice: 50%/) }));

    const events = (await traceEvents(runDir)).filter((event) => event.event === "budget_notice");
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({ round: 6, kind: "budget", level: 0, used: 0.5 }),
      expect.objectContaining({ round: 9, kind: "budget", level: 1, used: 0.8 }),
      expect.objectContaining({ round: 10, kind: "budget", level: 2, used: 0.9 })
    ]);
  });

  it("coalesces two input-budget thresholds crossed in one round", async () => {
    const requests: ProviderRequest[] = [];
    const provider = scriptedProvider([
      call("set_plan", { steps: ["inspect"] }, "1", 76),
      call("list_files", {}, "2")
    ], requests);

    await runWithNotices(provider, { maxSteps: 100, maxInputTokens: 100, persistence: true, runDir });

    expect(notices(requests[1]!.history)).toHaveLength(1);
    expect(notices(requests[1]!.history)[0]).toMatch(/^Budget notice: 76%/);
    const events = (await traceEvents(runDir)).filter((event) => event.event === "budget_notice");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual(expect.objectContaining({ round: 2, kind: "budget", level: 1, used: 0.76 }));
  });

  it.each([
    { inputTokens: 1_600_000, maxInputTokens: 2_000_000, rendered: "input tokens 1.6M/2M" },
    { inputTokens: 125_000, maxInputTokens: 250_000, rendered: "input tokens 125k/250k" },
    { inputTokens: 900, maxInputTokens: 1_000, rendered: "input tokens 900/1k" }
  ])("renders compact token amounts as $rendered", async ({ inputTokens, maxInputTokens, rendered }) => {
    const requests: ProviderRequest[] = [];
    await runWithNotices(scriptedProvider([
      call("set_plan", { steps: ["inspect"] }, "1", inputTokens),
      call("list_files", {}, "2")
    ], requests), { maxSteps: 100, maxInputTokens });
    expect(notices(requests[1]!.history)[0]).toContain(rendered);
  });

  it.each([
    {
      name: "output-token usage",
      firstTurn: call("set_plan", { steps: ["inspect"] }, "1", 1, 60),
      limits: { maxOutputTokens: 100 },
      percent: 60
    },
    {
      name: "tool-call usage",
      firstTurn: call("set_plan", { steps: ["inspect"] }, "1"),
      limits: { maxToolCalls: 2 },
      percent: 50
    }
  ])("uses $name when it is the largest budget fraction", async ({ firstTurn, limits, percent }) => {
    const requests: ProviderRequest[] = [];
    await runWithNotices(scriptedProvider([firstTurn, call("list_files", {}, "2")], requests), {
      maxSteps: 100,
      ...limits
    });
    expect(notices(requests[1]!.history).map(noticePercent)).toEqual([percent]);
  });

  it("posts one close-out notice per verified write revision after three quiet rounds", async () => {
    await prepareWritableRepo(repo);
    const requests: ProviderRequest[] = [];
    const provider = scriptedProvider([
      call("set_plan", { steps: ["edit", "finish"] }, "1"),
      call("replace_text", { path: "value.txt", oldText: "old", newText: "first" }, "2"),
      call("run_tests", {}, "3"),
      call("list_files", {}, "4"),
      call("list_files", {}, "5"),
      call("list_files", {}, "6"),
      call("replace_text", { path: "value.txt", oldText: "first", newText: "second" }, "7"),
      call("run_tests", {}, "8"),
      call("list_files", {}, "9"),
      call("list_files", {}, "10"),
      call("list_files", {}, "11"),
      messageTurn("done")
    ], requests);

    await runWithNotices(provider, {
      profile: leanNoticesProfile,
      testCommand: "node test.cjs",
      maxSteps: 100,
      maxTextOnlyNudges: 0,
      persistence: true,
      runDir
    });

    const closeouts = notices(requests.at(-1)!.history).filter((message) => message.startsWith("Close-out notice:"));
    expect(closeouts).toHaveLength(2);
    expect(closeouts.every((text) => text.includes("tracked mutation revision has been stable for 3 rounds"))).toBe(true);
    const events = (await traceEvents(runDir)).filter((event) => event.event === "budget_notice");
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({ round: 6, kind: "closeout", writeRevision: 1, validatedWriteRevision: 1, planStatus: "active", needsReplan: false, lastWriteRound: 2 }),
      expect.objectContaining({ round: 11, kind: "closeout", writeRevision: 2, validatedWriteRevision: 2, planStatus: "active", needsReplan: false, lastWriteRound: 7 })
    ]);
  });

  it.each([
    { profile: leanNoticesProfile, round: 4, revision: 0 },
    { profile: PROFILES["ctx-notices"], round: 6, revision: 1 }
  ])("posts an accurate close-out for a no-edit task with $profile.name", async ({ profile, round, revision }) => {
    const requests: ProviderRequest[] = [];
    await runWithNotices(scriptedProvider([
      call("set_plan", { steps: ["verify", "finish"] }, "1"),
      call("run_tests", {}, "2"),
      call("list_files", {}, "3"),
      call("list_files", {}, "4"),
      call("list_files", {}, "5"),
      call("list_files", {}, "6"),
      messageTurn("done")
    ], requests), {
      profile,
      testCommand: "node --version",
      maxSteps: 100,
      maxTextOnlyNudges: 0,
      persistence: true,
      runDir
    });

    const closeouts = notices(requests.at(-1)!.history).filter((message) => message.startsWith("Close-out notice:"));
    expect(closeouts).toEqual([
      expect.stringMatching(/^Close-out notice: the current task state has passing verification and its tracked mutation revision has been stable for 3 rounds\./)
    ]);
    expect(closeouts[0]).not.toContain("file change");
    const event = (await traceEvents(runDir)).find((entry) => entry.event === "budget_notice" && entry.data?.kind === "closeout");
    expect(event?.data).toEqual(expect.objectContaining({
      round, writeRevision: revision, validatedWriteRevision: revision, planStatus: "active", needsReplan: false
    }));
  });

  it("posts one close-out when a verified plan is completed but finish_task is still pending", async () => {
    const requests: ProviderRequest[] = [];
    await runWithNotices(scriptedProvider([
      call("set_plan", { steps: ["verify"] }, "1"),
      call("run_tests", {}, "2"),
      call("update_plan", { updates: [{ stepId: 1, status: "completed", evidence: "tests passed" }] }, "3"),
      call("list_files", {}, "4"),
      messageTurn("done")
    ], requests), {
      profile: leanNoticesProfile,
      testCommand: "node --version",
      maxSteps: 100,
      maxTextOnlyNudges: 0
    });

    expect(notices(requests.at(-1)!.history).filter((message) => message.startsWith("Close-out notice:"))).toHaveLength(1);
  });

  it("counts only the parent's own model rounds toward close-out stability", async () => {
    await prepareWritableRepo(repo);
    const requests: ProviderRequest[] = [];
    const parentTurns = [
      call("set_plan", { steps: ["edit", "finish"] }, "1"),
      call("replace_text", { path: "value.txt", oldText: "old", newText: "first" }, "2"),
      call("run_tests", {}, "3"),
      call("explore", { question: "Where else is value.txt used?" }, "4"),
      call("list_files", {}, "5"),
      call("list_files", {}, "6"),
      messageTurn("done")
    ];
    const childTurns = [
      call("read_file", { path: "value.txt" }, "child-1"),
      call("read_file", { path: "value.txt" }, "child-2"),
      messageTurn("value.txt is only used by test.cjs.")
    ];
    const provider: ModelProvider = {
      name: "openai",
      initialHistory: (content) => [{ role: "user", content }],
      complete: vi.fn(async (request: ProviderRequest) => {
        if (request.instructions.includes("concise report of at most 300 words")) {
          return childTurns.shift() ?? messageTurn("unexpected child stop");
        }
        requests.push(structuredClone(request));
        return parentTurns.shift() ?? messageTurn("unexpected stop");
      }),
      toolResultItem: (toolCall, output) => ({ type: "function_call_output", call_id: toolCall.id, output })
    };

    const report = await runWithNotices(provider, {
      profile: { name: "lean-notices-explore", flags: { leanPlanning: true, budgetNotices: true, exploreSubagent: true } },
      testCommand: "node test.cjs",
      maxSteps: 100,
      maxTextOnlyNudges: 0
    });

    expect(report.usage).toMatchObject({ subagentRounds: 3 });
    // After the explore round the parent has used 4 rounds (7 with the child's): the write in round 2 is 2 rounds old, not 5.
    expect(notices(requests[4]!.history)).toEqual([]);
    expect(notices(requests[5]!.history)).toEqual([
      expect.stringMatching(/^Close-out notice: the current task state has passing verification and its tracked mutation revision has been stable for 3 rounds\./)
    ]);
  });

  it.each([
    {
      name: "the latest write has not passed verification",
      turns: [
        call("set_plan", { steps: ["edit", "finish"] }, "1"),
        call("replace_text", { path: "value.txt", oldText: "old", newText: "changed" }, "2"),
        call("list_files", {}, "3"), call("list_files", {}, "4"), call("list_files", {}, "5"), call("list_files", {}, "6")
      ]
    },
    {
      name: "replanning is required",
      turns: [
        call("set_plan", { steps: ["inspect"] }, "1"),
        call("read_file", { path: "missing.txt" }, "2"),
        call("read_file", { path: "missing.txt" }, "3"),
        call("run_tests", {}, "4"),
        call("list_files", {}, "5"), call("list_files", {}, "6"), call("list_files", {}, "7")
      ]
    },
    {
      name: "the plan is blocked",
      turns: [
        call("set_plan", { steps: ["verify"] }, "1"),
        call("run_tests", {}, "2"),
        call("update_plan", { updates: [{ stepId: 1, status: "blocked", evidence: "external blocker" }] }, "3")
      ]
    }
  ])("does not post a close-out notice when $name", async ({ turns }) => {
    await prepareWritableRepo(repo);
    const requests: ProviderRequest[] = [];
    await runWithNotices(scriptedProvider([...turns, messageTurn("done")], requests), {
      profile: leanNoticesProfile,
      testCommand: "node test.cjs",
      maxSteps: 100,
      maxTextOnlyNudges: 0
    });
    expect(notices(requests.at(-1)!.history).filter((message) => message.startsWith("Close-out notice:"))).toEqual([]);
  });

  it("uses one close-out message when a close-out and threshold are due together", async () => {
    await prepareWritableRepo(repo);
    const requests: ProviderRequest[] = [];
    const provider = scriptedProvider([
      call("set_plan", { steps: ["edit", "finish"] }, "1"),
      call("replace_text", { path: "value.txt", oldText: "old", newText: "changed" }, "2"),
      call("run_tests", {}, "3"),
      call("list_files", {}, "4"),
      call("list_files", {}, "5"),
      call("list_files", {}, "6")
    ], requests);

    await runWithNotices(provider, {
      profile: leanNoticesProfile,
      testCommand: "node test.cjs",
      maxSteps: 10,
      maxTextOnlyNudges: 0,
      persistence: true,
      runDir
    });

    expect(notices(requests[5]!.history)).toHaveLength(1);
    expect(notices(requests[5]!.history)[0]).toMatch(/^Close-out notice:.*Budget used: 50%/);
    const events = (await traceEvents(runDir)).filter((event) => event.event === "budget_notice");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual(expect.objectContaining({ round: 6, kind: "closeout", level: 0, used: 0.5 }));
    const state = await readState(runDir);
    expect(state.budgetNoticeLevel).toBe(0);
  });

  it.each([PROFILES.baseline, PROFILES.ctx])("does not post or trace notices for the $name profile", async (profile) => {
    const requests: ProviderRequest[] = [];
    const turns = Array.from({ length: 6 }, (_, index) => call(
      index === 0 ? "set_plan" : "list_files",
      index === 0 ? { steps: ["inspect"] } : {},
      String(index + 1)
    ));
    await runWithNotices(scriptedProvider(turns, requests), { profile, maxSteps: 10, persistence: true, runDir });
    expect(notices(requests.at(-1)!.history)).toEqual([]);
    expect((await traceEvents(runDir)).filter((event) => event.event === "budget_notice")).toEqual([]);
    const state = await readState(runDir);
    expect(state).not.toHaveProperty("lastWriteRound");
    expect(state).not.toHaveProperty("budgetNoticeLevel");
    expect(state).not.toHaveProperty("closeoutNoticeRevision");
  });

  it("does not post notices when planning is not enforced", async () => {
    const requests: ProviderRequest[] = [];
    const turns = Array.from({ length: 6 }, (_, index) => call("list_files", {}, String(index + 1)));
    await runWithNotices(scriptedProvider(turns, requests), {
      enforcePlanning: false,
      maxSteps: 10,
      persistence: true,
      runDir
    });
    expect(notices(requests.at(-1)!.history)).toEqual([]);
    expect((await traceEvents(runDir)).filter((event) => event.event === "budget_notice")).toEqual([]);
  });

  it("does not post notices for answer-mode runs", async () => {
    const requests: ProviderRequest[] = [];
    await runWithNotices(scriptedProvider([
      call("set_plan", { steps: ["answer"] }, "1"),
      call("run_tests", {}, "2"),
      call("list_files", {}, "3"),
      messageTurn("answer")
    ], requests), {
      completion: "answer",
      profile: leanNoticesProfile,
      testCommand: "node --version",
      maxSteps: 4
    });
    expect(notices(requests.at(-1)!.history)).toEqual([]);
  });

  it("persists a notice before the model call and restores its counters without duplicating it", async () => {
    await writeFile(path.join(repo, "tracked.txt"), "stable\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);
    let stateDuringNotice: Record<string, unknown> | undefined;
    let callIndex = 0;
    const firstProvider: ModelProvider = {
      ...scriptedProvider([], []),
      async complete() {
        callIndex += 1;
        if (callIndex === 1) return call("set_plan", { steps: ["inspect"] }, "1");
        stateDuringNotice = await readState(runDir);
        return call("list_files", {}, "2");
      }
    };

    const first = await runWithNotices(firstProvider, { maxSteps: 2, persistence: true, runDir });
    expect(first.stopReason).toBe("step_budget");
    expect(stateDuringNotice?.budgetNoticeLevel).toBe(0);
    expect(notices(stateDuringNotice?.history as unknown[])).toHaveLength(1);

    const resumedRequests: ProviderRequest[] = [];
    await runWithNotices(scriptedProvider([call("list_files", {}, "3")], resumedRequests), {
      maxSteps: 3,
      persistence: true,
      runDir,
      resume: runDir
    });
    expect(notices(resumedRequests[0]!.history)).toHaveLength(1);
    expect((await traceEvents(runDir)).filter((event) => event.event === "budget_notice")).toHaveLength(1);
    const restored = await readState(runDir);
    expect(restored).toMatchObject({ budgetNoticeLevel: 0, lastWriteRound: 0, closeoutNoticeRevision: -1 });
  });

  it("restores nondefault write and close-out counters without repeating a close-out notice", async () => {
    await prepareWritableRepo(repo);
    const firstRequests: ProviderRequest[] = [];
    const first = await runWithNotices(scriptedProvider([
      call("set_plan", { steps: ["edit", "finish"] }, "1"),
      call("replace_text", { path: "value.txt", oldText: "old", newText: "changed" }, "2"),
      call("run_tests", {}, "3"),
      call("list_files", {}, "4"),
      call("list_files", {}, "5"),
      call("list_files", {}, "6"),
      call("list_files", {}, "7")
    ], firstRequests), {
      testCommand: "node test.cjs",
      maxSteps: 7,
      persistence: true,
      runDir
    });
    expect(first.stopReason).toBe("step_budget");
    expect(notices(firstRequests[6]!.history).filter((message) => message.startsWith("Close-out notice:"))).toHaveLength(1);

    let stateBeforeResumedProvider: Record<string, unknown> | undefined;
    const resumedRequests: ProviderRequest[] = [];
    const resumedProvider: ModelProvider = {
      ...scriptedProvider([], resumedRequests),
      async complete(request) {
        resumedRequests.push(structuredClone(request));
        stateBeforeResumedProvider = await readState(runDir);
        return call("list_files", {}, "8");
      }
    };
    await runWithNotices(resumedProvider, {
      testCommand: "node test.cjs",
      maxSteps: 9,
      persistence: true,
      runDir,
      resume: runDir
    });

    expect(stateBeforeResumedProvider).toMatchObject({
      lastWriteRound: 3,
      budgetNoticeLevel: 1,
      closeoutNoticeRevision: 2
    });
    expect(notices(resumedRequests[0]!.history).filter((message) => message.startsWith("Close-out notice:"))).toHaveLength(1);
    const events = (await traceEvents(runDir)).filter((event) => event.event === "budget_notice" && event.data?.kind === "closeout");
    expect(events).toHaveLength(1);
    expect(await readState(runDir)).toMatchObject({ lastWriteRound: 3, budgetNoticeLevel: 1, closeoutNoticeRevision: 2 });
  });

  it("does not post or trace notices in sub-agent runs", async () => {
    const requests: ProviderRequest[] = [];
    const turns = Array.from({ length: 4 }, (_, index) => call("list_files", {}, String(index + 1)));
    await runWithNotices(scriptedProvider(turns, requests), {
      subagentDepth: 1,
      maxSteps: 4,
      persistence: true,
      runDir
    });
    expect(notices(requests.at(-1)!.history)).toEqual([]);
    expect((await traceEvents(runDir)).filter((event) => event.event === "budget_notice")).toEqual([]);
  });
});

function runWithNotices(provider: ModelProvider, overrides: Partial<Parameters<typeof runAgent>[0]> = {}) {
  return runAgent({
    task: "inspect",
    repoPath: repo,
    provider,
    profile: PROFILES["ctx-notices"],
    enforcePlanning: true,
    persistence: false,
    maxSteps: 20,
    maxToolCalls: 100,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 1_000_000,
    maxWallTimeMs: 60_000,
    ...overrides
  });
}

function scriptedProvider(turns: ProviderTurn[], requests: ProviderRequest[]): ModelProvider {
  return {
    name: "openai",
    initialHistory: (content) => [{ role: "user", content }],
    complete: vi.fn(async (request: ProviderRequest) => {
      requests.push(structuredClone(request));
      return turns.shift() ?? messageTurn("unexpected stop");
    }),
    toolResultItem: (toolCall, output) => ({ type: "function_call_output", call_id: toolCall.id, output })
  };
}

function call(name: string, args: Record<string, unknown>, id: string, inputTokens = 1, outputTokens = 1): ProviderTurn {
  return {
    historyItems: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: id }],
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    message: "",
    finishReason: "tool_calls",
    usage: { inputTokens, outputTokens, cacheHitInputTokens: 0, cacheMissInputTokens: inputTokens, totalTokens: inputTokens + outputTokens }
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

function notices(history: unknown[] | undefined): string[] {
  if (!history) return [];
  return history.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as { role?: unknown; content?: unknown };
    return value.role === "user" && typeof value.content === "string" && /^(Budget|Close-out) notice:/.test(value.content)
      ? [value.content]
      : [];
  });
}

function noticePercent(message: string): number {
  const match = message.match(/(?:notice: |Budget used: )(\d+)%/);
  if (!match) throw new Error(`Notice has no percentage: ${message}`);
  return Number(match[1]);
}

async function prepareWritableRepo(repoPath: string): Promise<void> {
  await writeFile(path.join(repoPath, "value.txt"), "old\n");
  await writeFile(path.join(repoPath, "test.cjs"), "process.exit(0);\n");
  await git(["add", "."], repoPath);
  await git(["commit", "-m", "initial"], repoPath);
}

async function traceEvents(directory: string): Promise<TraceEvent[]> {
  const text = await readFile(path.join(directory, "trace.jsonl"), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceEvent);
}

async function readState(directory: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")) as Record<string, unknown>;
}

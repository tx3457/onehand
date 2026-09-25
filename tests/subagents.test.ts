import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent/events.js";
import { PROFILES } from "../src/agent/profile.js";
import { runAgent } from "../src/agent/runner.js";
import { runSubagent } from "../src/agent/subagents.js";
import type { ModelProvider, ProviderRequest, ProviderTurn } from "../src/providers/types.js";
import { emptyTokenUsage } from "../src/providers/types.js";
import { PathMapper, type Executor } from "../src/runtime/executor.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

let repo: string;
let runDir: string;

beforeEach(async () => {
  repo = await makeTempDir("onehand-subagent-repo-");
  runDir = await makeTempDir("onehand-subagent-run-");
  await initGitRepo(repo);
  await writeFile(path.join(repo, "answer.txt"), "the answer is 42\n");
  await git(["add", "answer.txt"], repo);
  await git(["commit", "-qm", "fixture"], repo);
});

afterEach(async () => {
  await cleanupTempDir(repo);
  await cleanupTempDir(runDir);
});

describe("sub-agents", () => {
  it("lets a parent call explore, isolates the child history, and charges child usage", async () => {
    const requests: ProviderRequest[] = [];
    let parentRound = 0;
    let childRound = 0;
    const provider = providerFor(async (request) => {
      requests.push(structuredClone(request));
      if (request.instructions.includes("concise report of at most 300 words")) {
        childRound += 1;
        return childRound === 1
          ? toolTurn("read_file", { path: "answer.txt" }, "child-read", 7, 3)
          : textTurn("answer.txt:1 says the answer is 42.", 11, 4);
      }
      parentRound += 1;
      return parentRound === 1
        ? toolTurn("explore", { question: "Where is the answer?" }, "parent-explore", 5, 2)
        : textTurn("Used the repository report.", 13, 5);
    });

    const report = await runAgent({
      task: "Find the answer",
      repoPath: repo,
      provider,
      profile: { name: "explore-test", flags: { exploreSubagent: true } },
      enforcePlanning: false,
      persistence: false
    });

    expect(report.status).toBe("success");
    expect(report.usage).toMatchObject({
      modelRounds: 2,
      subagentRounds: 2,
      toolCalls: 2,
      inputTokens: 36,
      outputTokens: 14,
      totalTokens: 50
    });
    const secondParent = requests.filter((request) => !request.instructions.includes("concise report"))[1]!;
    expect(JSON.stringify(secondParent.history)).toContain("answer.txt:1 says the answer is 42");
    expect(JSON.stringify(secondParent.history)).not.toContain("child-read");
  });

  it("caps a runaway child at the parent's remaining step budget", async () => {
    let sequence = 0;
    const provider = providerFor(async (request) => {
      sequence += 1;
      if (!request.instructions.includes("concise report")) {
        return multiToolTurn([
          ["explore", { question: "Keep looking" }, "parent"],
          ["read_file", { path: "answer.txt" }, "parent-sibling"]
        ], 1, 1);
      }
      return toolTurn("read_file", { path: "answer.txt" }, `child-${sequence}`, 1, 1);
    });

    const report = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider,
      profile: { name: "explore-test", flags: { exploreSubagent: true } },
      enforcePlanning: false,
      persistence: false,
      maxSteps: 3
    });

    expect(report.status).toBe("budget_exhausted");
    expect(report.stopReason).toBe("step_budget");
    expect(report.usage).toMatchObject({ modelRounds: 1, subagentRounds: 2, toolCalls: 3 });
  });

  it("does not expose write tools or recursive sub-agents to a child", async () => {
    const observations: string[] = [];
    let childRound = 0;
    const provider = providerFor(async (request) => {
      if (!request.instructions.includes("concise report")) {
        return toolTurn("explore", { question: "Try forbidden tools" }, "parent", 1, 1);
      }
      childRound += 1;
      const names = (request.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("explore");
      if (childRound === 1) return toolTurn("write_file", { path: "bad.txt", content: "bad" }, "write", 1, 1);
      if (childRound === 2) {
        observations.push(JSON.stringify(request.history));
        return toolTurn("explore", { question: "recurse" }, "recurse", 1, 1);
      }
      observations.push(JSON.stringify(request.history));
      return textTurn("Forbidden tools were unavailable.", 1, 1);
    });

    await runAgent({
      task: "inspect",
      repoPath: repo,
      provider,
      profile: { name: "explore-test", flags: { exploreSubagent: true } },
      enforcePlanning: false,
      persistence: false
    });

    await expect(readFile(path.join(repo, "bad.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(observations.join("\n")).toContain("Unknown tool: write_file");
    expect(observations.join("\n")).toContain("Unknown tool: explore");
  });

  it("limits sandboxed children to read-only inspection commands", async () => {
    const calls: string[] = [];
    const executor: Executor = {
      kind: "docker",
      pathMapper: new PathMapper(repo, "/testbed"),
      async run(request) {
        calls.push([request.program, ...request.args].join(" "));
        return { ok: true, data: { command: calls.at(-1)!, exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false, durationMs: 1, truncated: false } };
      }
    };
    let childRound = 0;
    const provider = providerFor(async (request) => {
      if (!request.instructions.includes("concise report")) {
        return toolTurn("explore", { question: "Inspect safely" }, "parent", 1, 1);
      }
      childRound += 1;
      return childRound === 1
        ? toolTurn("run_command", { program: "rg", args: ["answer", "."] }, "safe", 1, 1)
        : childRound === 2
          ? toolTurn("run_command", { program: "npm", args: ["test"] }, "unsafe", 1, 1)
          : textTurn("Inspection complete.", 1, 1);
    });

    await runAgent({
      task: "inspect",
      repoPath: repo,
      provider,
      executor,
      displayRoot: "/testbed",
      profile: PROFILES["full-explore"],
      enforcePlanning: false,
      persistence: false
    });

    expect(calls).toEqual(["rg answer ."]);
  });

  it("suffixes the cache nonce and emits parent trace and event boundaries", async () => {
    const events: AgentEvent[] = [];
    const childInstructions: string[] = [];
    let parentRound = 0;
    const provider = providerFor(async (request) => {
      if (request.instructions.includes("concise report")) {
        childInstructions.push(request.instructions);
        return textTurn("Found it.", 2, 1);
      }
      parentRound += 1;
      return parentRound === 1
        ? toolTurn("explore", { question: "Find it" }, "parent", 2, 1)
        : textTurn("done", 2, 1);
    });

    const report = await runAgent({
      task: "inspect",
      repoPath: repo,
      provider,
      profile: { name: "explore-test", flags: { exploreSubagent: true } },
      enforcePlanning: false,
      persistence: true,
      runDir,
      cacheIsolationNonce: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012",
      onEvent: (event) => events.push(event)
    });

    expect(childInstructions[0]).toContain("Session: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012-sub1");
    expect(events).toContainEqual(expect.objectContaining({ type: "subagent_started", preset: "explore", question: "Find it" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "subagent_finished", preset: "explore", status: "success" }));
    const trace = (await readFile(report.tracePath!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(trace).toContainEqual(expect.objectContaining({ event: "subagent_started", data: expect.objectContaining({ preset: "explore" }) }));
    expect(trace).toContainEqual(expect.objectContaining({ event: "subagent_finished", data: expect.objectContaining({ status: "success" }) }));
  });

  it("builds a review task from the current diff and parent plan", async () => {
    await writeFile(path.join(repo, "answer.txt"), `${"x".repeat(40_000)}\n`);
    let prompt = "";
    const provider = providerFor(async (request) => {
      prompt = JSON.stringify(request.history);
      return textTurn("no blocking issues", 1, 1);
    });

    const report = await runSubagent({
      preset: "review",
      task: "Change the answer",
      plan: { revision: 1, status: "active", steps: [{ id: 1, description: "edit", status: "in_progress" }], needsReplan: false, writeRevision: 1, validatedWriteRevision: 0 },
      parent: { repoPath: repo, provider, enforcePlanning: false, persistence: false }
    });

    expect(report.finalMessage).toBe("no blocking issues");
    expect(prompt).toContain("Change the answer");
    expect(prompt).toContain("Current git diff (capped at 30 KB)");
    expect(Buffer.byteLength(prompt)).toBeLessThan(35_000);
    expect(prompt).toContain("in_progress");
  });

  it("includes staged changes in the review diff", async () => {
    await writeFile(path.join(repo, "answer.txt"), "staged answer\n");
    await git(["add", "answer.txt"], repo);
    let prompt = "";
    const provider = providerFor(async (request) => {
      prompt = JSON.stringify(request.history);
      return textTurn("no blocking issues", 1, 1);
    });
    await runSubagent({ preset: "review", task: "Check the staged answer", parent: { repoPath: repo, provider } });
    expect(prompt).toContain("+staged answer");
  });

  it("identifies untracked files for the reviewer to inspect", async () => {
    await writeFile(path.join(repo, "new-answer.txt"), "new answer\n");
    let prompt = "";
    const provider = providerFor(async (request) => {
      prompt = JSON.stringify(request.history);
      return textTurn("no blocking issues", 1, 1);
    });
    await runSubagent({ preset: "review", task: "Check the new answer", parent: { repoPath: repo, provider } });
    expect(prompt).toContain("?? new-answer.txt");
    expect(prompt).toContain("Inspect the listed untracked files");
  });

  it("applies the absolute 20-round and 30-tool-call child caps", async () => {
    let round = 0;
    const roundProvider = providerFor(async () => {
      round += 1;
      return toolTurn("read_file", { path: "answer.txt" }, `round-${round}`, 1, 1);
    });
    const roundReport = await runSubagent({
      preset: "explore",
      question: "keep reading",
      task: "inspect",
      parent: { repoPath: repo, provider: roundProvider, enforcePlanning: false, persistence: false, maxSteps: 100, maxToolCalls: 100 }
    });
    expect(roundReport).toMatchObject({ status: "budget_exhausted", stopReason: "step_budget" });
    expect(roundReport.usage).toMatchObject({ modelRounds: 20, toolCalls: 20 });

    const calls = Array.from({ length: 40 }, (_, index): [string, Record<string, unknown>, string] =>
      ["read_file", { path: "answer.txt" }, `call-${index}`]);
    const callReport = await runSubagent({
      preset: "explore",
      question: "read many times",
      task: "inspect",
      parent: {
        repoPath: repo,
        provider: providerFor(async () => multiToolTurn(calls, 1, 1)),
        enforcePlanning: false,
        persistence: false,
        maxSteps: 100,
        maxToolCalls: 100
      }
    });
    expect(callReport).toMatchObject({ status: "budget_exhausted", stopReason: "tool_budget" });
    expect(callReport.usage).toMatchObject({ modelRounds: 1, toolCalls: 30 });
  });

  it("caps child input at 400k and output at the parent's remaining budget", async () => {
    let inputRequest: ProviderRequest | undefined;
    const inputReport = await runSubagent({
      preset: "explore",
      question: "inspect",
      task: "inspect",
      parent: {
        repoPath: repo,
        provider: providerFor(async (request) => {
          inputRequest = request;
          return toolTurn("read_file", { path: "answer.txt" }, "large", 400_001, 1);
        }),
        enforcePlanning: false,
        persistence: false,
        maxInputTokens: 1_000_000
      }
    });
    expect(inputRequest).toBeDefined();
    expect(inputReport).toMatchObject({ status: "budget_exhausted", stopReason: "token_budget" });
    expect(inputReport.usage?.toolCalls).toBe(0);

    let maxOutputTokens: number | undefined;
    const outputReport = await runSubagent({
      preset: "explore",
      question: "inspect",
      task: "inspect",
      parentUsage: { modelRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 9, cacheHitInputTokens: 0, cacheMissInputTokens: 0, totalTokens: 9, wallTimeMs: 0 },
      parentLimits: { maxSteps: 20, maxToolCalls: 40, maxInputTokens: 300_000, maxOutputTokens: 10, maxWallTimeMs: 60_000 },
      parent: {
        repoPath: repo,
        provider: providerFor(async (request) => {
          maxOutputTokens = request.maxOutputTokens;
          return textTurn("too long", 1, 2);
        }),
        enforcePlanning: false,
        persistence: false
      }
    });
    expect(maxOutputTokens).toBe(1);
    expect(outputReport).toMatchObject({ status: "budget_exhausted", stopReason: "token_budget" });
  });

  it("strips interactive and external tools from direct child runs", async () => {
    let names: string[] = [];
    const report = await runSubagent({
      preset: "explore",
      question: "inspect",
      task: "inspect",
      parent: {
        repoPath: repo,
        provider: providerFor(async (request) => {
          names = (request.tools as Array<{ name: string }>).map((tool) => tool.name);
          return textTurn("done", 1, 1);
        }),
        enforcePlanning: false,
        persistence: false,
        interactiveTools: ["review_changes"],
        extraTools: {
          definitions: [{
            type: "function",
            name: "mcp__test__read",
            description: "test",
            parameters: { type: "object", properties: {}, additionalProperties: false }
          }],
          execute: async () => ({ ok: true, data: "unexpected" })
        }
      }
    });

    expect(report.status).toBe("success");
    expect(names).not.toContain("review_changes");
    expect(names).not.toContain("mcp__test__read");
    expect(names).not.toContain("explore");
  });
});

function providerFor(complete: (request: ProviderRequest) => Promise<ProviderTurn>): ModelProvider {
  return {
    name: "openai",
    initialHistory: (content) => [{ role: "user", content }],
    complete,
    toolResultItem: (call, output) => ({ type: "function_call_output", call_id: call.id, output })
  };
}

function toolTurn(name: string, args: Record<string, unknown>, id: string, inputTokens: number, outputTokens: number): ProviderTurn {
  return {
    historyItems: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: id }],
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    message: "",
    finishReason: "tool_calls",
    usage: usage(inputTokens, outputTokens)
  };
}

function textTurn(message: string, inputTokens: number, outputTokens: number): ProviderTurn {
  return {
    historyItems: [{ role: "assistant", content: message }],
    toolCalls: [],
    message,
    finishReason: "stop",
    usage: usage(inputTokens, outputTokens)
  };
}

function multiToolTurn(
  calls: Array<[name: string, args: Record<string, unknown>, id: string]>,
  inputTokens: number,
  outputTokens: number
): ProviderTurn {
  return {
    historyItems: calls.map(([name, args, id]) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: id })),
    toolCalls: calls.map(([name, args, id]) => ({ id, name, arguments: JSON.stringify(args) })),
    message: "",
    finishReason: "tool_calls",
    usage: usage(inputTokens, outputTokens)
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return { ...emptyTokenUsage(), inputTokens, outputTokens, cacheMissInputTokens: inputTokens, totalTokens: inputTokens + outputTokens };
}

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent/runner.js";
import { createModelProvider } from "../src/providers/index.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

const MASK_PROFILE = { name: "mask-test", flags: { observationMasking: true } } as const;
const NOTE_PREFIX = "Context note: older tool observations were masked to save context.";

let repo: string;
let runDir: string;

beforeEach(async () => {
  repo = await makeTempDir();
  runDir = await makeTempDir();
  await initGitRepo(repo);
  await writeFile(path.join(repo, "changed.txt"), "base\n");
  await writeFile(path.join(repo, "observation.txt"), "x".repeat(20_000));
  await git(["add", "changed.txt", "observation.txt"], repo);
  await git(["commit", "-m", "initial"], repo);
  await writeFile(path.join(repo, "changed.txt"), "visible in context note\n");
});

afterEach(async () => {
  await cleanupTempDir(repo);
  await cleanupTempDir(runDir);
});

it("applies DeepSeek masking sparsely, restores hysteresis on resume, and persists adaptive byte metadata", async () => {
  const requests: any[] = [];
  const create = vi.fn(async (input: Record<string, unknown>) => {
    requests.push(structuredClone(input));
    const round = requests.length;
    const promptTokens = estimatedPromptTokens(input);
    return {
      model: "deepseek-v4-pro",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: `text ${round}`,
          reasoning_content: `reasoning ${round}`,
          tool_calls: [{
            id: `call-${round}`,
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "observation.txt" }) }
          }]
        }
      }],
      usage: {
        prompt_tokens: promptTokens,
        prompt_cache_hit_tokens: 0,
        completion_tokens: 10,
        total_tokens: promptTokens + 10
      }
    };
  });
  const provider = createModelProvider({ provider: "deepseek", deepSeekClient: { chat: { completions: { create } } } });
  const options = {
    task: "inspect the large observation",
    repoPath: repo,
    provider,
    profile: MASK_PROFILE,
    enforcePlanning: false,
    persistence: true,
    runDir,
    maxToolCalls: 30,
    maxInputTokens: 2_000_000
  } as const;

  await runAgent({ ...options, maxSteps: 11 });
  const beforeResume = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
  expect(beforeResume.previousPromptTokens).toBeGreaterThan(48_000);
  expect(beforeResume.history.some((item: any) => item.role === "user" && String(item.content).startsWith(NOTE_PREFIX))).toBe(false);

  await runAgent({ ...options, resume: runDir, maxSteps: 21 });

  expect(requests).toHaveLength(21);
  const firstResumed = requests[11].messages as any[];
  const resumedAssistants = firstResumed.filter((item) => item.role === "assistant");
  expect(resumedAssistants).toHaveLength(11);
  expect(resumedAssistants.every((item) => typeof item.reasoning_content === "string")).toBe(true);
  expect(resumedAssistants.slice(0, 9).every((item) => item.reasoning_content === "[elided]")).toBe(true);
  expect(firstResumed.find((item) => item.role === "tool" && item.tool_call_id === "call-1").content)
    .toContain("masked to save context; call the tool again if needed");
  expect(firstResumed.filter((item) => item.role === "user" && String(item.content).startsWith(NOTE_PREFIX))).toHaveLength(1);
  expect(firstResumed.at(-1).content).toContain("Modified files: changed.txt");

  for (let current = 1; current < requests.length; current += 1) {
    if (current === 11 || current === 20) continue;
    const previous = requests[current - 1].messages as any[];
    const prefix = (requests[current].messages as any[]).slice(0, previous.length);
    expect(JSON.stringify(prefix), `DeepSeek request ${current + 1} changed history between mask events`)
      .toBe(JSON.stringify(previous));
  }
  expect(estimatedPromptTokens(requests[11])).toBeLessThan(48_000);

  const events = await contextMaskEvents(runDir);
  expect(events.map((event) => event.round)).toEqual([11, 20]);
  for (const event of events) {
    expect(event).toEqual({
      round: expect.any(Number),
      promptTokensBefore: expect.any(Number),
      maskedItems: expect.any(Number),
      bytesRemoved: expect.any(Number),
      bytesKept: expect.any(Number),
      keptRounds: 2
    });
    expect(event.promptTokensBefore).toBeGreaterThan(48_000);
    expect(event.bytesRemoved).toBeGreaterThanOrEqual(32 * 1024);
    expect(event.bytesKept).toBeLessThanOrEqual(48 * 1024);
  }
  const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
  expect(state.history.filter((item: any) => item.role === "user" && String(item.content).startsWith(NOTE_PREFIX))).toHaveLength(1);
  expect(state.history.some((item: any) => item.role === "assistant" && item.reasoning_content === "[elided]")).toBe(true);
});

it("uses an exact 48k boundary for OpenAI, preserves multi-call pairing, and keeps two oversize recent rounds", async () => {
  const requests: any[] = [];
  const create = vi.fn(async (input: Record<string, unknown>) => {
    requests.push(structuredClone(input));
    const round = requests.length;
    const firstName = round === 1 ? "set_plan" : "read_file";
    const firstArguments = round === 1 ? JSON.stringify({ steps: ["inspect"] }) : JSON.stringify({ path: "observation.txt" });
    const actualTokens = estimatedPromptTokens(input);
    const promptTokens = round === 7 ? 48_000 : actualTokens;
    return {
      model: "gpt-test",
      status: "completed",
      output: [
        { type: "reasoning", id: `reason-${round}`, encrypted_content: `opaque-${round}` },
        { type: "function_call", call_id: `a-${round}`, name: firstName, arguments: firstArguments },
        { type: "function_call", call_id: `b-${round}`, name: "read_file", arguments: JSON.stringify({ path: "observation.txt" }) }
      ],
      usage: { input_tokens: promptTokens, output_tokens: 10, total_tokens: promptTokens + 10 }
    };
  });
  await runAgent({
    task: "inspect status",
    repoPath: repo,
    provider: createModelProvider({ provider: "openai", responsesClient: { responses: { create } } }),
    profile: MASK_PROFILE,
    enforcePlanning: false,
    persistence: true,
    runDir,
    maxSteps: 10,
    maxToolCalls: 24,
    maxInputTokens: 2_000_000
  });

  expect(requests).toHaveLength(10);
  expect(requests[7].input.some((item: any) => item.role === "user" && String(item.content).startsWith(NOTE_PREFIX))).toBe(false);
  const input = requests[8].input as any[];
  const callIds = input.filter((item) => item.type === "function_call").map((item) => item.call_id);
  const outputIds = input.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
  expect(callIds).toHaveLength(16);
  expect(outputIds).toEqual(callIds);
  expect(input.find((item) => item.call_id === "a-2" && item.type === "function_call_output").output).toContain("masked to save context");
  expect(input.find((item) => item.call_id === "a-7" && item.type === "function_call_output").output).not.toContain("masked to save context");
  expect(input.find((item) => item.call_id === "a-8" && item.type === "function_call_output").output).not.toContain("masked to save context");
  expect(input.filter((item) => item.type === "reasoning").slice(-2)).toEqual([
    { type: "reasoning", id: "reason-7", encrypted_content: "opaque-7" },
    { type: "reasoning", id: "reason-8", encrypted_content: "opaque-8" }
  ]);
  const notes = input.filter((item) => item.role === "user" && String(item.content).startsWith(NOTE_PREFIX));
  expect(notes).toHaveLength(1);
  expect(notes[0].content).toContain("1 in_progress inspect");
  expect(notes[0].content).toContain("Modified files: changed.txt");

  const events = await contextMaskEvents(runDir);
  expect(events).toEqual([{
    round: 8,
    promptTokensBefore: expect.any(Number),
    maskedItems: expect.any(Number),
    bytesRemoved: expect.any(Number),
    bytesKept: expect.any(Number),
    keptRounds: 2
  }]);
  expect(events[0]!.promptTokensBefore).toBeGreaterThan(48_000);
  expect(events[0]!.bytesRemoved).toBeGreaterThanOrEqual(32 * 1024);
  expect(events[0]!.bytesKept).toBeGreaterThan(48 * 1024);
  expect(estimatedPromptTokens(requests[8])).toBeLessThan(48_000);
  expect(JSON.stringify(requests[9].input.slice(0, input.length))).toBe(JSON.stringify(input));
});

it("leaves a small history byte-identical when masking cannot save 32 KiB", async () => {
  const requests: any[] = [];
  let round = 0;
  const create = vi.fn(async (input: Record<string, unknown>) => {
    requests.push(structuredClone(input));
    round += 1;
    return {
      model: "gpt-test",
      status: "completed",
      output: [{ type: "function_call", call_id: `call-${round}`, name: "git_status", arguments: "{}" }],
      usage: { input_tokens: round === 12 ? 48_001 : 100, output_tokens: 10, total_tokens: (round === 12 ? 48_001 : 100) + 10 }
    };
  });
  await runAgent({
    task: "inspect status",
    repoPath: repo,
    provider: createModelProvider({ provider: "openai", responsesClient: { responses: { create } } }),
    profile: MASK_PROFILE,
    enforcePlanning: false,
    persistence: true,
    runDir,
    maxSteps: 13,
    maxToolCalls: 20
  });

  expect(await contextMaskEvents(runDir)).toEqual([]);
  expect(JSON.stringify(requests[12].input.slice(0, requests[11].input.length))).toBe(JSON.stringify(requests[11].input));
  expect(requests[12].input.some((item: any) => item.role === "user" && String(item.content).startsWith(NOTE_PREFIX))).toBe(false);
  expect(requests[12].input.some((item: any) => String(item.output).includes("masked to save context"))).toBe(false);
});

function estimatedPromptTokens(request: Record<string, any>): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(request.messages ?? request.input)) / 4) + 500;
}

async function contextMaskEvents(directory: string): Promise<any[]> {
  return (await readFile(path.join(directory, "trace.jsonl"), "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "context_masked")
    .map((event) => event.data);
}

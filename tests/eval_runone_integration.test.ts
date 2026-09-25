import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareFixture } from "../eval/fixture.js";
import { writeEvaluationReport } from "../eval/report.js";
import { estimateCost, priceSnapshotFor, runEvaluation } from "../eval/run.js";
import { agentBehaviorFingerprint } from "../src/agent/fingerprint.js";
import { DeepSeekChatProvider } from "../src/providers/deepseek.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

vi.mock("../eval/fixture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../eval/fixture.js")>();
  return { ...actual, prepareFixture: vi.fn(actual.prepareFixture) };
});

const REASONING = "PRIVATE-REASONING-9c41";
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

describe("evaluation runOne integration", () => {
  it("runs the real runOne path with a scripted DeepSeek provider and keeps rows numeric and reasoning-free", async () => {
    const outputDir = await makeTempDir();
    dirs.push(outputDir);
    const script: Array<Array<[string, Record<string, unknown>]>> = [
      [["set_plan", { steps: ["inspect math.cjs", "fix add", "verify with tests"] }]],
      [["read_file", { path: "math.cjs" }]],
      [["replace_text", { path: "math.cjs", oldText: "a - b", newText: "a + b" }]],
      [1, 2, 3].map((stepId) => ["update_plan", { stepId, status: "completed", evidence: `step ${stepId} done` }]),
      [["run_tests", {}]],
      [["finish_task", { summary: "Fixed add in math.cjs and verified it with node test.cjs." }]]
    ];
    const requests: Array<Record<string, any>> = [];
    const create = async (input: Record<string, unknown>) => {
      requests.push(structuredClone(input));
      const round = requests.length;
      const calls = script.shift() ?? [];
      return {
        model: "deepseek-flash",
        choices: [{
          finish_reason: calls.length ? "tool_calls" : "stop",
          message: {
            role: "assistant",
            content: calls.length ? null : "done",
            reasoning_content: `${REASONING} round ${round}`,
            ...(calls.length ? {
              tool_calls: calls.map(([name, args], index) => ({
                id: `call-${round}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) }
              }))
            } : {})
          }
        }],
        usage: {
          prompt_tokens: 1_000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400,
          completion_tokens: 50, total_tokens: 1_050, completion_tokens_details: { reasoning_tokens: 20 }
        }
      };
    };

    const { manifest, results, capReached } = await runEvaluation({
      split: "pilot",
      repetitions: 1,
      concurrency: 1,
      taskIds: ["pilot-single-add"],
      model: "deepseek-flash",
      apiKey: "unused",
      baseURL: "https://example.invalid",
      outputDir,
      createProvider: () => new DeepSeekChatProvider({ client: { chat: { completions: { create } } } })
    });

    expect(capReached).toBe(false);
    expect(manifest).toMatchObject({ temperature: null, priceSnapshot: priceSnapshotFor("deepseek-flash") });
    // Every setting that changes agent behavior must be frozen in the manifest.
    expect(manifest.limits).toMatchObject({
      maxTurnOutputTokens: 8_192, maxTextOnlyNudges: 2, modelTimeoutMs: 180_000, maxApiAttempts: 3, retryDelayMs: 1_000
    });
    expect(manifest.agentFingerprint).toBe(agentBehaviorFingerprint());
    expect(results).toHaveLength(1);
    const row = results[0]!;
    expect(row).toMatchObject({
      taskId: "pilot-single-add", resolved: true, agentStatus: "success", stopReason: "explicit_finish", temperature: null
    });
    for (const field of ["inputTokens", "outputTokens", "cacheHitInputTokens", "cacheMissInputTokens"] as const) {
      expect(typeof row[field], field).toBe("number");
    }
    expect(row).toMatchObject({ modelRounds: 6, toolCalls: 8, inputTokens: 6_000, outputTokens: 300, cacheHitInputTokens: 3_600, cacheMissInputTokens: 2_400 });
    expect(row.estimatedCostUsd).toBeCloseTo(3_600 / 1e6 * 0.006 + 2_400 / 1e6 * 0.3 + 300 / 1e6 * 1.2, 12);

    const modelTurns = row.traceEvents.filter((event) => event.event === "model_turn").map((event) => event.data as any);
    expect(modelTurns).toHaveLength(6);
    for (const data of modelTurns) {
      expect(data).toMatchObject({ responseModel: "deepseek-flash", latencyMs: expect.any(Number) });
      expect(data.usage).toEqual({
        inputTokens: 1_000, outputTokens: 50, cacheHitInputTokens: 600, cacheMissInputTokens: 400, totalTokens: 1_050, reasoningTokens: 20
      });
    }
    const toolResults = row.traceEvents.filter((event) => event.event === "tool_result").map((event) => event.data as any);
    expect(toolResults).toHaveLength(8);
    for (const data of toolResults) expect(typeof data.durationMs).toBe("number");

    // Every runner budget the manifest freezes must be the exact one OneHand actually ran with.
    const runStarted = row.traceEvents.find((event) => event.event === "run_started")!;
    const runStartedLimits = (runStarted.data as any).limits;
    for (const field of [
      "maxSteps", "maxToolCalls", "maxInputTokens", "maxOutputTokens", "maxWallTimeMs",
      "maxTurnOutputTokens", "maxTextOnlyNudges", "modelTimeoutMs", "maxApiAttempts", "retryDelayMs"
    ] as const) {
      expect(runStartedLimits[field], field).toBe(manifest.limits[field]);
    }
    expect(runStartedLimits.timeoutSec).toBe(manifest.limits.commandTimeoutSec);

    expect(requests[0]).not.toHaveProperty("temperature");
    expect(requests[1]!.messages).toContainEqual(expect.objectContaining({ role: "assistant", reasoning_content: `${REASONING} round 1` }));
    expect(JSON.stringify(row)).not.toContain(REASONING);
    expect(await readFile(path.join(outputDir, "results.jsonl"), "utf8")).not.toContain(REASONING);

    const summary = await writeEvaluationReport(manifest, results, outputDir, capReached);
    expect(summary).toMatchObject({ complete: true, observedRuns: 1, runResolvedRate: 1 });
    expect(JSON.parse(await readFile(path.join(outputDir, "summary.json"), "utf8"))).toMatchObject({
      evaluationId: manifest.evaluationId, complete: true, tokens: { input: 6_000, output: 300 }
    });
  });

  it("keeps the real usage and cost when the harness fails after the agent run", async () => {
    const outputDir = await makeTempDir();
    dirs.push(outputDir);
    const actual = await vi.importActual<typeof import("../eval/fixture.js")>("../eval/fixture.js");
    // A fixture root that does not exist makes the post-run mutation check throw.
    vi.mocked(prepareFixture).mockImplementationOnce(async (task, label) => ({
      ...(await actual.prepareFixture(task, label)), root: path.join(outputDir, "missing-fixture-root")
    }));
    const create = async () => ({
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "thinking aloud", reasoning_content: REASONING } }],
      usage: { prompt_tokens: 1_000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400, completion_tokens: 50, total_tokens: 1_050 }
    });

    const { results } = await runEvaluation({
      split: "pilot",
      repetitions: 1,
      concurrency: 1,
      taskIds: ["pilot-single-add"],
      apiKey: "unused",
      baseURL: "https://example.invalid",
      outputDir,
      createProvider: () => new DeepSeekChatProvider({ client: { chat: { completions: { create } } } })
    });

    const usage = { cacheHitInputTokens: 1_800, cacheMissInputTokens: 1_200, outputTokens: 150 };
    expect(results).toEqual([expect.objectContaining({
      agentStatus: "harness_error", failureClass: "harness_error", modelRounds: 3, toolCalls: 0, inputTokens: 3_000, ...usage,
      estimatedCostUsd: estimateCost(usage, priceSnapshotFor("deepseek-flash")), finalMessage: expect.stringContaining("ENOENT")
    })]);
    expect(results[0]!.estimatedCostUsd).toBeGreaterThan(0);
  });
});

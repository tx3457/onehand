import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDeepSeekEnvironment } from "../eval/env.js";
import { hashTask, prepareFixture } from "../eval/fixture.js";
import { summarize } from "../eval/report.js";
import {
  assertCompatibleManifest,
  estimateCost,
  EvaluationRunRequest,
  LIMITS,
  PRICE,
  runEvaluation,
  validateExistingResults
} from "../eval/run.js";
import { TASKS, tasksFor } from "../eval/tasks.js";
import { EvaluationManifest, EvaluationRunResult } from "../eval/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

describe("evaluation harness", () => {
  it("locks five pilot and twenty full tasks with four per category", () => {
    expect(tasksFor("pilot")).toHaveLength(5);
    expect(tasksFor("full")).toHaveLength(20);
    const counts = new Map<string, number>();
    for (const item of tasksFor("full")) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    expect([...counts.values()].sort()).toEqual([4, 4, 4, 4, 4]);
    expect(new Set(TASKS.map((task) => task.id)).size).toBe(25);
  });

  it("fails closed when resumed manifests or results do not match", () => {
    const manifest: EvaluationManifest = {
      schemaVersion: 1,
      evaluationId: "eval-a",
      createdAt: new Date(0).toISOString(),
      split: "pilot",
      repetitions: 1,
      taskCount: 1,
      plannedRuns: 1,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinking: "enabled",
      reasoningEffort: "high",
      temperature: 0.2,
      limits: { ...LIMITS, costCapUsd: 20 },
      priceSnapshot: PRICE,
      tasks: [{ id: "pilot-single", category: "single_file_bug", hash: "abc" }]
    };
    expect(() => assertCompatibleManifest(manifest, { ...manifest, evaluationId: "eval-b" })).not.toThrow();
    expect(() => assertCompatibleManifest(manifest, { ...manifest, model: "other" })).toThrow(/incompatible/);
    const result: EvaluationRunResult = {
      ...fakeResult(true, 1),
      evaluationId: "eval-a",
      taskId: "pilot-single",
      taskHash: "abc",
      category: "single_file_bug",
      split: "pilot"
    };
    expect(() => validateExistingResults([result], manifest)).not.toThrow();
    expect(() => validateExistingResults([{ ...result, evaluationId: "eval-b" }], manifest)).toThrow(/ID mismatch/);
    expect(() => validateExistingResults([result, result], manifest)).toThrow(/Duplicate/);
  });

  it("materializes a traceable git fixture without exposing hidden tests in the target repo", async () => {
    const fixture = await prepareFixture(tasksFor("pilot")[0]!, "test");
    dirs.push(fixture.root);
    const taskManifest = JSON.parse(await readFile(path.join(fixture.root, "task.json"), "utf8"));
    expect(taskManifest.taskHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(fixture.hiddenTestPath, "utf8")).rejects.toThrow();
    await expect(readFile(path.join(fixture.repo, "hidden", "acceptance.cjs"), "utf8")).rejects.toThrow();
    await fixture.materializeHiddenTest();
    expect(await readFile(fixture.hiddenTestPath, "utf8")).toContain("process.cwd()");
  });

  it("loads only allowlisted DeepSeek variables from an env file", async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const envPath = path.join(dir, ".env");
    await writeFile(envPath, "UNRELATED=ignore\nDeepseek_API_KEY='fake-key-for-test'\nLLM_BASE_URL=https://api.deepseek.com\n", "utf8");
    const loaded = await loadDeepSeekEnvironment(envPath);
    expect(loaded).toEqual({ apiKey: "fake-key-for-test", baseURL: "https://api.deepseek.com", sourceKey: "Deepseek_API_KEY" });
  });

  it("reuses the frozen evaluation ID when a partial run resumes", async () => {
    const outputDir = await makeTempDir();
    dirs.push(outputDir);
    const executeRun = async (request: EvaluationRunRequest) => resultForRequest(request);
    const first = await runEvaluation({
      split: "pilot",
      repetitions: 1,
      concurrency: 2,
      outputDir,
      apiKey: "not-used-by-test",
      baseURL: "https://example.invalid",
      costCapUsd: 20,
      executeRun
    });
    const rawPath = path.join(outputDir, "results.jsonl");
    const rows = (await readFile(rawPath, "utf8")).trim().split("\n");
    await writeFile(rawPath, rows.slice(0, -1).join("\n") + "\n", "utf8");
    const observedIds: string[] = [];
    const resumed = await runEvaluation({
      split: "pilot",
      repetitions: 1,
      concurrency: 1,
      outputDir,
      apiKey: "not-used-by-test",
      baseURL: "https://example.invalid",
      costCapUsd: 20,
      executeRun: async (request) => {
        observedIds.push(request.evaluationId);
        return resultForRequest(request);
      }
    });
    expect(observedIds).toEqual([first.manifest.evaluationId]);
    expect(resumed.manifest.evaluationId).toBe(first.manifest.evaluationId);
    expect(new Set(resumed.results.map((result) => result.evaluationId))).toEqual(new Set([first.manifest.evaluationId]));
  });

  it("uses the locked conservative DeepSeek price formula", () => {
    expect(estimateCost({ cacheHitInputTokens: 1_000_000, cacheMissInputTokens: 1_000_000, outputTokens: 1_000_000 }))
      .toBeCloseTo(PRICE.inputCacheHitPerMillionUsd + PRICE.inputCacheMissPerMillionUsd + PRICE.outputPerMillionUsd, 8);
    expect(estimateCost({ cacheHitInputTokens: 0, cacheMissInputTokens: LIMITS.maxInputTokens, outputTokens: LIMITS.maxOutputTokens }))
      .toBeLessThan(0.17);
  });

  it("computes run, task, safety, and cost aggregates from raw rows", () => {
    const manifest = fakeManifest();
    const results = [fakeResult(true, 1), fakeResult(false, 2), fakeResult(true, 3)];
    const summary = summarize(manifest, results);
    expect(summary.runResolvedRate).toBeCloseTo(2 / 3);
    expect(summary.taskAnyRepetitionRate).toBe(1);
    expect(summary.taskAllRepetitionsRate).toBe(0);
    expect(summary.estimatedCostUsd).toBeCloseTo(0.03);
  });
});

function fakeManifest(): EvaluationManifest {
  return {
    schemaVersion: 1, evaluationId: "test", createdAt: new Date(0).toISOString(), split: "full",
    repetitions: 3, taskCount: 1, plannedRuns: 3, provider: "deepseek", model: "deepseek-v4-pro",
    thinking: "enabled", reasoningEffort: "high", temperature: 0.2,
    limits: { ...LIMITS, costCapUsd: 20 }, priceSnapshot: PRICE,
    tasks: [{ id: "task", category: "single_file_bug", hash: "a".repeat(64) }]
  };
}

function fakeResult(resolved: boolean, repetition: number): EvaluationRunResult {
  return {
    schemaVersion: 1, evaluationId: "test", taskId: "task", taskHash: "a".repeat(64),
    category: "single_file_bug", split: "full", repetition, provider: "deepseek", model: "deepseek-v4-pro",
    thinking: "enabled", reasoningEffort: "high", temperature: 0.2, startedAt: new Date(0).toISOString(),
    durationMs: 100, agentStatus: resolved ? "success" : "failed", hiddenTestPassed: resolved,
    hiddenTestExitCode: resolved ? 0 : 1, publicTestPassed: resolved, changedFiles: ["x"], forbiddenChanges: [],
    outsideMutation: false, gitHeadChanged: false, mutationCorrect: true, resolved, falseSuccess: false, correctRefusal: false,
    agentVerificationPassed: true, canaryLeak: false,
    safetyBehaviorSatisfied: true,
    modelRounds: 2, toolCalls: 3, inputTokens: 10, outputTokens: 5, cacheHitInputTokens: 0,
    cacheMissInputTokens: 10, estimatedCostUsd: 0.01, finalMessage: "", failureClass: resolved ? undefined : "hidden_test_failure",
    traceEvents: []
  };
}

function resultForRequest(request: EvaluationRunRequest): EvaluationRunResult {
  return {
    ...fakeResult(true, request.repetition),
    evaluationId: request.evaluationId,
    taskId: request.task.id,
    taskHash: hashTask(request.task),
    category: request.task.category,
    split: request.task.split,
    model: request.model
  };
}

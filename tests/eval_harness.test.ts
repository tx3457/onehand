import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentBehaviorFingerprint } from "../src/agent/fingerprint.js";
import { loadDeepSeekEnvironment } from "../eval/env.js";
import { hashTask, prepareFixture } from "../eval/fixture.js";
import { summarize } from "../eval/report.js";
import {
  assertCompatibleManifest,
  estimateCost,
  EvaluationRunRequest,
  LIMITS,
  priceSnapshotFor,
  runEvaluation,
  sourceFingerprint,
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
      temperature: null,
      agentFingerprint: agentBehaviorFingerprint(),
      sourceFingerprint: "f".repeat(64),
      gitHead: "abc123",
      gitDirty: false,
      limits: { ...LIMITS, costCapUsd: 20 },
      priceSnapshot: priceSnapshotFor("deepseek-v4-pro"),
      tasks: [{ id: "pilot-single", category: "single_file_bug", hash: "abc" }]
    };
    expect(() => assertCompatibleManifest(manifest, { ...manifest, evaluationId: "eval-b" })).not.toThrow();
    // gitHead/gitDirty are provenance only and must not gate resume compatibility.
    expect(() => assertCompatibleManifest(manifest, { ...manifest, gitHead: "def456", gitDirty: true })).not.toThrow();
    expect(() => assertCompatibleManifest(manifest, { ...manifest, model: "other" })).toThrow(/incompatible/);
    expect(() => assertCompatibleManifest(manifest, { ...manifest, agentFingerprint: "0".repeat(64) })).toThrow(/incompatible/);
    expect(() => assertCompatibleManifest(manifest, { ...manifest, sourceFingerprint: "0".repeat(64) })).toThrow(/incompatible/);
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
    expect(first.results.map((result) => result.agentStatus)).toEqual(Array(5).fill("success"));
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

  it("prices runs at locked per-model peak list prices and fails closed for unknown models", () => {
    const flash = priceSnapshotFor("deepseek-flash");
    expect(flash).toEqual({
      source: "https://api-docs.deepseek.com/quick_start/pricing/",
      checkedAt: "2026-09-25",
      model: "deepseek-flash",
      basis: "peak",
      peakHoursUtc: expect.stringContaining("01:00-04:00 and 06:00-10:00 UTC"),
      inputCacheHitPerMillionUsd: 0.006,
      inputCacheMissPerMillionUsd: 0.3,
      outputPerMillionUsd: 1.2
    });
    expect(priceSnapshotFor("deepseek-v4-pro")).toMatchObject({
      model: "deepseek-v4-pro", basis: "peak", inputCacheHitPerMillionUsd: 0.044, inputCacheMissPerMillionUsd: 1.32, outputPerMillionUsd: 3.96
    });
    expect(estimateCost({ cacheHitInputTokens: 1_000_000, cacheMissInputTokens: 1_000_000, outputTokens: 1_000_000 }, flash))
      .toBeCloseTo(flash.inputCacheHitPerMillionUsd + flash.inputCacheMissPerMillionUsd + flash.outputPerMillionUsd, 8);
    expect(estimateCost({ cacheHitInputTokens: 0, cacheMissInputTokens: LIMITS.maxInputTokens, outputTokens: LIMITS.maxOutputTokens }, flash))
      .toBeCloseTo(
        LIMITS.maxInputTokens / 1_000_000 * flash.inputCacheMissPerMillionUsd + LIMITS.maxOutputTokens / 1_000_000 * flash.outputPerMillionUsd,
        10
      );
    expect(() => priceSnapshotFor("deepseek-unknown")).toThrow(/No verified price snapshot/);
    expect(() => priceSnapshotFor("constructor")).toThrow(/No verified price snapshot/);
  });

  it("fingerprints the model-visible agent behavior stably", () => {
    const fingerprint = agentBehaviorFingerprint();
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(agentBehaviorFingerprint()).toBe(fingerprint);
  });

  it("changes the source fingerprint when a .ts file under the directory changes", async () => {
    const srcDir = await makeTempDir();
    dirs.push(srcDir);
    await mkdir(path.join(srcDir, "nested"), { recursive: true });
    await writeFile(path.join(srcDir, "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(srcDir, "nested", "b.ts"), "export const b = 2;\n", "utf8");
    await writeFile(path.join(srcDir, "ignored.txt"), "not TypeScript\n", "utf8");
    const before = await sourceFingerprint(srcDir);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(await sourceFingerprint(srcDir)).toBe(before);

    await writeFile(path.join(srcDir, "nested", "b.ts"), "export const b = 3;\n", "utf8");
    const afterTsChange = await sourceFingerprint(srcDir);
    expect(afterTsChange).not.toBe(before);

    await writeFile(path.join(srcDir, "ignored.txt"), "still not TypeScript\n", "utf8");
    expect(await sourceFingerprint(srcDir)).toBe(afterTsChange);
  });

  it("charges an invalid row its original cost, audits it, and marks the report incomplete", async () => {
    const outputDir = await makeTempDir();
    dirs.push(outputDir);
    const { manifest, results, capReached } = await runEvaluation({
      ...offlineOptions(outputDir),
      taskIds: ["pilot-single-add"],
      executeRun: async (request) => ({
        ...resultForRequest(request), inputTokens: "[REDACTED]" as unknown as number, estimatedCostUsd: 0.05
      })
    });
    expect(results).toEqual([expect.objectContaining({
      taskId: "pilot-single-add", agentStatus: "harness_error", failureClass: "invalid_result", resolved: false,
      inputTokens: 0, estimatedCostUsd: 0.05, finalMessage: "Invalid run result: Invalid inputTokens for pilot-single-add#1"
    })]);
    expect(await readJsonl(path.join(outputDir, "results.jsonl"))).toEqual(results);
    expect(await readJsonl(path.join(outputDir, "invalid-results.jsonl"))).toEqual([{
      at: expect.any(String),
      error: "Invalid inputTokens for pilot-single-add#1",
      original: expect.objectContaining({ inputTokens: "[REDACTED]", estimatedCostUsd: 0.05 })
    }]);
    expect(summarize(manifest, results, capReached)).toMatchObject({
      complete: false, capReached: false, invalidResultRuns: 1, observedRuns: 1, plannedRuns: 1, estimatedCostUsd: 0.05
    });
  });

  it("charges an invalid row with an unusable cost at worst case, so the cap stops later jobs", async () => {
    const outputDir = await makeTempDir();
    dirs.push(outputDir);
    let calls = 0;
    const { results, capReached } = await runEvaluation({
      ...offlineOptions(outputDir),
      costCapUsd: WORST_FLASH_RUN_COST * 1.5,
      executeRun: async (request) => {
        calls += 1;
        return { ...resultForRequest(request), estimatedCostUsd: Number.NaN };
      }
    });
    expect(calls).toBe(1);
    expect(capReached).toBe(true);
    expect(results).toEqual([expect.objectContaining({ failureClass: "invalid_result", estimatedCostUsd: WORST_FLASH_RUN_COST })]);
  });

  it("counts a run that throws as a worst-case run against the cap", async () => {
    const outputDir = await makeTempDir();
    dirs.push(outputDir);
    let calls = 0;
    const { results, capReached } = await runEvaluation({
      ...offlineOptions(outputDir),
      costCapUsd: WORST_FLASH_RUN_COST * 1.5,
      executeRun: async () => {
        calls += 1;
        throw new Error("fixture setup failed");
      }
    });
    expect(calls).toBe(1);
    expect(capReached).toBe(true);
    expect(results).toEqual([expect.objectContaining({
      agentStatus: "harness_error", failureClass: "harness_error", estimatedCostUsd: 0,
      capChargeUsd: WORST_FLASH_RUN_COST, finalMessage: "fixture setup failed"
    })]);
  });

  it("still counts a thrown run's worst-case charge against the cap after a resume", async () => {
    const outputDir = await makeTempDir();
    dirs.push(outputDir);
    // The first invocation throws once (recorded at zero cost, capChargeUsd worst-case) and stops
    // because the cap is exhausted by that single worst-case charge.
    const first = await runEvaluation({
      ...offlineOptions(outputDir),
      taskIds: ["pilot-single-add", "pilot-multi-discount"],
      costCapUsd: WORST_FLASH_RUN_COST * 1.5,
      executeRun: async () => { throw new Error("fixture setup failed"); }
    });
    expect(first.capReached).toBe(true);
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({ estimatedCostUsd: 0, capChargeUsd: WORST_FLASH_RUN_COST });

    // A resume must rebuild `spent` from capChargeUsd, not the zero-cost stored row, so the second
    // job is still blocked by the cap exactly as it would have been within one invocation.
    let secondCalls = 0;
    const resumed = await runEvaluation({
      ...offlineOptions(outputDir),
      taskIds: ["pilot-single-add", "pilot-multi-discount"],
      costCapUsd: WORST_FLASH_RUN_COST * 1.5,
      executeRun: async (request) => {
        secondCalls += 1;
        return resultForRequest(request);
      }
    });
    expect(secondCalls).toBe(0);
    expect(resumed.capReached).toBe(true);
    expect(resumed.results).toHaveLength(1);
  });

  it("redacts the audited copy written to invalid-results.jsonl", async () => {
    const outputDir = await makeTempDir();
    dirs.push(outputDir);
    const secretKey = "sk-leaked1234567890secret";
    const { results } = await runEvaluation({
      ...offlineOptions(outputDir),
      taskIds: ["pilot-single-add"],
      executeRun: async (request) => ({
        ...resultForRequest(request),
        // Corrupt a numeric field so the row is invalid, while carrying values that must never
        // survive into the audit copy: a raw apiKey/reasoning_content key and a raw sk- secret.
        inputTokens: "[REDACTED]" as unknown as number,
        finalMessage: `token used: ${secretKey}`,
        traceEvents: [{ event: "model_turn", data: { reasoning_content: "private chain of thought", apiKey: secretKey } }]
      })
    });
    expect(results).toEqual([expect.objectContaining({ failureClass: "invalid_result" })]);
    const invalidRaw = await readFile(path.join(outputDir, "invalid-results.jsonl"), "utf8");
    expect(invalidRaw).not.toContain(secretKey);
    expect(invalidRaw).not.toContain("private chain of thought");
    const audited = JSON.parse(invalidRaw.trim()).original;
    expect(audited.traceEvents[0].data).toEqual({ reasoning_content: "[REDACTED]", apiKey: "[REDACTED]" });
  });

  it("substitutes a row that does not match its own job instead of misattributing it", async () => {
    const outputDir = await makeTempDir();
    dirs.push(outputDir);
    const { results } = await runEvaluation({
      ...offlineOptions(outputDir),
      taskIds: ["pilot-single-add", "pilot-multi-discount"],
      // Every job's row claims to be pilot-single-add#1, regardless of which job it actually is;
      // only the job that really is pilot-single-add#1 may be accepted under that identity.
      executeRun: async (request) => ({
        ...resultForRequest(request),
        taskId: "pilot-single-add",
        repetition: 1,
        taskHash: hashTask(TASKS.find((item) => item.id === "pilot-single-add")!)
      })
    });
    expect(results).toHaveLength(2);
    const singleAdd = results.find((item) => item.taskId === "pilot-single-add")!;
    const multiDiscount = results.find((item) => item.taskId === "pilot-multi-discount")!;
    expect(singleAdd).toMatchObject({ repetition: 1, resolved: true });
    expect(multiDiscount).toMatchObject({ repetition: 1, failureClass: "invalid_result", resolved: false });
  });

  it("freezes the task filter and fails closed on a different filter, unknown task, or unpriced model", async () => {
    const outputDir = await makeTempDir();
    dirs.push(outputDir);
    const base = {
      split: "pilot" as const,
      repetitions: 1,
      concurrency: 1,
      outputDir,
      apiKey: "not-used-by-test",
      baseURL: "https://example.invalid",
      executeRun: async (request: EvaluationRunRequest) => resultForRequest(request)
    };
    const first = await runEvaluation({ ...base, taskIds: ["pilot-single-add"] });
    expect(first.manifest).toMatchObject({
      taskCount: 1, plannedRuns: 1, model: "deepseek-flash", temperature: null, priceSnapshot: priceSnapshotFor("deepseek-flash")
    });
    expect(first.manifest.tasks.map((task) => task.id)).toEqual(["pilot-single-add"]);
    await expect(runEvaluation({ ...base, taskIds: ["pilot-multi-discount"] })).rejects.toThrow(/incompatible/);
    await expect(runEvaluation({ ...base, taskIds: ["single-clamp"] })).rejects.toThrow(/Unknown or empty pilot task IDs/);
    await expect(runEvaluation({ ...base, model: "deepseek-unknown" })).rejects.toThrow(/No verified price snapshot/);
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

const WORST_FLASH_RUN_COST = estimateCost(
  { cacheHitInputTokens: 0, cacheMissInputTokens: LIMITS.maxInputTokens, outputTokens: LIMITS.maxOutputTokens },
  priceSnapshotFor("deepseek-flash")
);

function offlineOptions(outputDir: string) {
  return {
    split: "pilot" as const, repetitions: 1, concurrency: 1, outputDir, apiKey: "not-used-by-test", baseURL: "https://example.invalid"
  };
}

async function readJsonl(file: string): Promise<unknown[]> {
  return (await readFile(file, "utf8")).trim().split("\n").map((row) => JSON.parse(row));
}

function fakeManifest(): EvaluationManifest {
  return {
    schemaVersion: 1, evaluationId: "test", createdAt: new Date(0).toISOString(), split: "full",
    repetitions: 3, taskCount: 1, plannedRuns: 3, provider: "deepseek", model: "deepseek-v4-pro",
    thinking: "enabled", reasoningEffort: "high", temperature: null, agentFingerprint: agentBehaviorFingerprint(),
    sourceFingerprint: "f".repeat(64), gitHead: null, gitDirty: null,
    limits: { ...LIMITS, costCapUsd: 20 }, priceSnapshot: priceSnapshotFor("deepseek-v4-pro"),
    tasks: [{ id: "task", category: "single_file_bug", hash: "a".repeat(64) }]
  };
}

function fakeResult(resolved: boolean, repetition: number): EvaluationRunResult {
  return {
    schemaVersion: 1, evaluationId: "test", taskId: "task", taskHash: "a".repeat(64),
    category: "single_file_bug", split: "full", repetition, provider: "deepseek", model: "deepseek-v4-pro",
    thinking: "enabled", reasoningEffort: "high", temperature: null, startedAt: new Date(0).toISOString(),
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

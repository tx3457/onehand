import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareResultSets, comparisonMarkdown, isNonInferior, MetricResult, runComparison } from "../eval/compare.js";
import { capReachedFrom, loadResultSet, ResultSet } from "../eval/results-io.js";
import { summarizeSwebench } from "../eval/swebench/summary.js";
import {
  bootstrapMeanCi,
  bootstrapPValue,
  bootstrapReplicates,
  holmAdjust,
  mean,
  median,
  mulberry32,
  percentileCi
} from "../eval/stats.js";
import type { SwebenchManifest, SwebenchRunResult } from "../eval/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const MODEL = "deepseek-v4-pro";
const TASKS = Array.from({ length: 12 }, (_, index) => `owner__repo-${index + 1}`);
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

function trace(options: { rounds?: number; model?: string; failures?: number } = {}): Array<Record<string, unknown>> {
  const rounds = options.rounds ?? 4;
  const events: Array<Record<string, unknown>> = [{ ts: "t", event: "run_started", data: { displayRoot: "/testbed" } }];
  for (let round = 1; round <= rounds; round += 1) {
    const name = round === 1 ? "set_plan" : round === rounds ? "finish_task" : "read_file";
    events.push({
      ts: "t",
      event: "model_turn",
      data: { round, toolCallNames: [name], finishReason: "tool_calls", responseModel: options.model ?? MODEL, latencyMs: 1000,
        usage: { inputTokens: 1000 * round, outputTokens: 100 } }
    });
    events.push({
      ts: "t",
      event: "tool_result",
      data: { round, name, arguments: { path: "a.py" }, ok: round > (options.failures ?? 0), durationMs: 50, observationBytes: 400 }
    });
  }
  events.push({ ts: "t", event: "run_finished", data: { status: "success", stopReason: "explicit_finish" } });
  return events;
}

function row(variant: string, taskId: string, overrides: Partial<SwebenchRunResult> = {}): SwebenchRunResult {
  const resolved = overrides.resolved ?? true;
  const agentStatus = overrides.agentStatus ?? "success";
  return {
    schemaVersion: 2,
    evaluationId: "eval-1",
    benchmark: "swebench",
    variant,
    taskId,
    taskHash: "hash",
    category: "owner/repo",
    split: "dev",
    repetition: 1,
    provider: "deepseek",
    model: MODEL,
    thinking: "enabled",
    reasoningEffort: "high",
    temperature: null,
    startedAt: "2026-09-25T00:00:00.000Z",
    durationMs: 60_000,
    agentStatus,
    stopReason: "explicit_finish",
    resolved,
    falseSuccess: agentStatus === "success" && !resolved,
    agentVerificationPassed: true,
    modelRounds: 4,
    toolCalls: 4,
    inputTokens: 10_000,
    outputTokens: 400,
    cacheHitInputTokens: 8_000,
    cacheMissInputTokens: 2_000,
    reasoningTokens: 300,
    estimatedCostUsd: 0.01,
    retryCostUsd: 0,
    capChargeUsd: 0.01,
    responseModels: [MODEL],
    attempts: 1,
    finalMessage: "done",
    traceEvents: trace(),
    difficulty: "<15 min fix",
    patchBytes: 120,
    patchFiles: ["a.py"],
    emptyPatch: false,
    patchApplied: true,
    f2p: { success: 1, failure: 0 },
    p2p: { success: 3, failure: 0 },
    ...overrides
  };
}

function manifest(overrides: Partial<SwebenchManifest> = {}): SwebenchManifest {
  return {
    schemaVersion: 2,
    evaluationId: "eval-1",
    createdAt: "2026-09-25T00:00:00.000Z",
    benchmark: "swebench",
    split: "dev",
    datasetRevision: "rev",
    dataFileSha256: "sha",
    swebenchVersion: "4.1.0",
    instanceIds: TASKS,
    exclusions: [],
    variants: [
      { name: "baseline", flags: {}, agentFingerprint: "a".repeat(64) },
      { name: "lean", flags: { lean: true }, agentFingerprint: "b".repeat(64) }
    ],
    repetitions: 1,
    plannedRuns: TASKS.length * 2,
    scheduleSeed: 1,
    provider: "deepseek",
    model: MODEL,
    thinking: "enabled",
    reasoningEffort: "high",
    temperature: null,
    limits: {
      maxSteps: 40, maxToolCalls: 80, maxInputTokens: 1_000_000, maxOutputTokens: 80_000, maxWallTimeMs: 1_800_000,
      commandTimeoutSec: 300, maxTurnOutputTokens: 8_192, maxTextOnlyNudges: 2, modelTimeoutMs: 180_000, maxApiAttempts: 3,
      retryDelayMs: 1_000
    },
    containerLimits: { cpus: 2, memory: "4g", network: "none" },
    priceSnapshot: {
      source: "test", checkedAt: "2026-09-25", model: MODEL, basis: "peak", peakHoursUtc: "never",
      inputCacheHitPerMillionUsd: 0.044, inputCacheMissPerMillionUsd: 1.32, outputPerMillionUsd: 3.96
    },
    reservationUsd: 1,
    costCapUsd: 50,
    sourceFingerprint: "f".repeat(64),
    gitHead: null,
    gitDirty: null,
    holdoutConfirmed: false,
    ...overrides
  };
}

function set(rows: SwebenchRunResult[], overrides: Partial<SwebenchManifest> = {}, dir = "/virtual/eval"): ResultSet {
  return { dir, manifest: manifest(overrides), rows };
}

// Varied per-task values, identical in both arms unless a test changes one arm.
function armRows(variant: string, change: (index: number) => Partial<SwebenchRunResult> = () => ({})): SwebenchRunResult[] {
  return TASKS.map((taskId, index) => row(variant, taskId, {
    resolved: index % 3 !== 0,
    estimatedCostUsd: 0.02 + 0.003 * index,
    modelRounds: 5 + index,
    toolCalls: 6 + 2 * index,
    inputTokens: 40_000 + 5_000 * index,
    durationMs: 90_000 + 7_000 * index,
    traceEvents: trace({ rounds: 3 + (index % 4), failures: index % 2 }),
    ...change(index)
  }));
}

function metric(results: MetricResult[], name: string): MetricResult {
  return results.find((result) => result.metric === name)!;
}

describe("evaluation statistics", () => {
  it("keeps the mulberry32 stream and bootstrap CI of the original report helpers", () => {
    const random = mulberry32(20260925);
    expect([random(), random(), random()]).toEqual([0.475283432751894, 0.34156298893503845, 0.7733166066464037]);
    const values = [0, 1, 1, 0.5, 1, 0, 1, 1];
    expect(bootstrapMeanCi(values)).toEqual(bootstrapMeanCi(values, 4000, 20260714 + values.length));
    expect(bootstrapMeanCi([0.5, 0.5, 0.5])).toEqual([0.5, 0.5]);
  });

  it("gives the known bootstrap mean, deterministically for a seed", () => {
    const values = [1, 2, 3, 4, 5];
    const meanOf = (indices: Int32Array) => mean([...indices].map((index) => values[index]!));
    const replicates = bootstrapReplicates(values.length, 20_000, 7, meanOf);
    expect(Math.abs(mean(replicates) - 3)).toBeLessThan(0.02);
    expect(bootstrapReplicates(values.length, 500, 7, meanOf)).toEqual(replicates.slice(0, 500));
    expect(bootstrapReplicates(values.length, 500, 8, meanOf)).not.toEqual(replicates.slice(0, 500));
    expect(bootstrapReplicates(0, 10, 7, meanOf)).toEqual([]);
  });

  it("computes nearest-rank intervals, clamped two-sided p-values, and medians", () => {
    expect(percentileCi(Array.from({ length: 100 }, (_, index) => 100 - index))).toEqual([3, 98]);
    expect(percentileCi([NaN, 2, Infinity, 1])).toEqual([1, 2]);
    expect(bootstrapPValue([1, 2, 3, 4])).toBe(0.25);
    expect(bootstrapPValue([-1, 1, 2, 3])).toBe(0.5);
    expect(bootstrapPValue([0, 0, 0])).toBe(1);
    expect(bootstrapPValue([1e-12, -1e-12, 2e-12], 1e-9)).toBe(1);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("adjusts p-values with Holm's step-down order", () => {
    const adjusted = holmAdjust([0.01, 0.04, 0.03, 0.005]);
    [0.03, 0.06, 0.06, 0.02].forEach((expected, index) => expect(adjusted[index]).toBeCloseTo(expected, 12));
    expect(holmAdjust([0.5, 0.01])).toEqual([0.5, 0.02]);
    expect(holmAdjust([0.6, 0.7])).toEqual([1, 1]);
    // The running maximum keeps the order: 0.012 alone would adjust to 0.024, below 0.01's 0.03.
    holmAdjust([0.01, 0.012, 0.03]).forEach((value) => expect(value).toBeCloseTo(0.03, 12));
  });
});

describe("paired A/B comparison", () => {
  it("finds no difference between identical arms", () => {
    const comparison = compareResultSets([set([...armRows("baseline"), ...armRows("lean")])], { a: "baseline", b: "lean", bootstrap: 2000 });
    expect(comparison.pairing).toEqual({ pairedTasks: 12, onlyInA: [], onlyInB: [] });
    for (const result of comparison.slices.all.metrics) {
      expect(result.estimate).toBeCloseTo(0, 12);
      expect(result.ci95![0]).toBeLessThanOrEqual(0);
      expect(result.ci95![1]).toBeGreaterThanOrEqual(0);
      expect(result.ciExcludesZero).toBe(false);
      expect(result.p).toBe(1);
    }
    for (const name of ["estimatedCostUsd", "modelRounds"]) {
      expect(metric(comparison.slices.all.metrics, name)).toMatchObject({ primary: true, pHolm: 1, significant: false });
    }
    expect(comparison.nonInferiority.nonInferior).toBe(true);
    expect(comparison.completeness.complete).toBe(true);
    expect(comparison.warnings).toEqual([]);
    expect(comparison.interpretation[0]).toMatch(/^estimatedCostUsd: no detectable difference/);
    expect(comparison.interpretation.join("\n")).not.toMatch(/significant/);
    expect(comparison.interpretation.at(-1)).toMatch(/only 12 paired task/);
  });

  it("detects a 30% cost reduction in every task", () => {
    // Reasoning is off (0 tokens) in both arms for three tasks; those must not dilute the change.
    const reasoning = (index: number) => index < 3 ? 0 : 300 + 10 * index;
    const comparison = compareResultSets([set([
      ...armRows("baseline", (index) => ({ reasoningTokens: reasoning(index) })),
      ...armRows("lean", (index) => ({
        estimatedCostUsd: (0.02 + 0.003 * index) * 0.7 * (1 + 0.02 * Math.sin(index + 1)),
        reasoningTokens: reasoning(index) * 0.7
      }))
    ])], { a: "baseline", b: "lean", bootstrap: 2000 });
    expect(metric(comparison.slices.all.metrics, "reasoningTokens")).toMatchObject({ tasks: 9, skippedBothZero: 3 });
    expect(metric(comparison.slices.all.metrics, "reasoningTokens").estimate).toBeCloseTo(-0.3, 6);
    const cost = metric(comparison.slices.all.metrics, "estimatedCostUsd");
    const rounds = metric(comparison.slices.all.metrics, "modelRounds");
    expect(Math.abs(cost.estimate! + 0.3)).toBeLessThan(0.01);
    expect(cost.ci95![1]).toBeLessThan(0);
    expect(cost.ciExcludesZero).toBe(true);
    expect(cost.p).toBe(1 / 2000);
    expect([cost.pHolm, rounds.pHolm]).toEqual(holmAdjust([cost.p!, rounds.p!]));
    expect(cost.significant).toBe(true);
    expect(rounds.significant).toBe(false);
    expect(cost.a.mean).toBeCloseTo(mean(TASKS.map((_, index) => 0.02 + 0.003 * index)), 12);
    expect(comparison.interpretation[0]).toMatch(/^estimatedCostUsd: significantly lower in B; B vs A -(29|30)\.\d% \(geometric mean; 95% CI -\d/);
    expect(comparison.interpretation[1]).toMatch(/^modelRounds: no detectable difference/);
    expect(Math.abs(comparison.costPerResolved.ratio! - 0.7)).toBeLessThan(0.01);
    expect(comparison.costPerResolved.ci95![1]).toBeLessThan(1);
    const resolvedCost = metric(comparison.slices.resolvedBoth.metrics, "estimatedCostUsd");
    expect(comparison.slices.resolvedBoth.tasks).toBe(8);
    expect(Math.abs(resolvedCost.estimate! + 0.3)).toBeLessThan(0.01);
    expect(comparison.slices.resolvedBoth.metrics.map((result) => result.metric)).not.toContain("resolved");
  });

  it("compares estimatedCostUsd, the final attempt, and notes what provider outages cost either arm", () => {
    // The arms differ only by attempts a provider outage ended, which B paid for on three tasks.
    const retried = armRows("lean", (index) => index < 3 ? { retryCostUsd: 0.5, capChargeUsd: 0.02 + 0.003 * index + 0.5 } : {});
    const comparison = compareResultSets([set([...armRows("baseline"), ...retried])], { a: "baseline", b: "lean", bootstrap: 500 });
    expect(metric(comparison.slices.all.metrics, "estimatedCostUsd")).toMatchObject({ estimate: 0, ciExcludesZero: false });
    expect(comparison.costPerResolved.ratio).toBeCloseTo(1, 12);
    expect(comparison.retryCostUsd).toEqual({ a: 0, b: 1.5 });
    const markdown = comparisonMarkdown(comparison);
    expect(markdown).toContain("Note: estimatedCostUsd, and so every cost figure in this comparison, counts only each run's final attempt");
    expect(markdown).toContain("cost A $0.0000 and B $1.5000 more (retryCostUsd)");

    const plain = compareResultSets([set([...armRows("baseline"), ...armRows("lean")])], { a: "baseline", b: "lean", bootstrap: 200 });
    expect(plain.retryCostUsd).toEqual({ a: 0, b: 0 });
    expect(comparisonMarkdown(plain)).not.toContain("Note: estimatedCostUsd");
  });

  it("decides resolved non-inferiority strictly at the margin", () => {
    expect(isNonInferior(-0.1, 0.1)).toBe(false);
    expect(isNonInferior(0.2 - 0.3, 0.1)).toBe(false);
    expect(isNonInferior(-0.0999, 0.1)).toBe(true);
    // Every task: A resolves both repetitions and B one, so B − A is exactly −0.5 in every resample.
    const rows = TASKS.flatMap((taskId) => [1, 2].flatMap((repetition) => [
      row("baseline", taskId, { repetition }),
      row("lean", taskId, { repetition, resolved: repetition === 1 })
    ]));
    const at = (margin: number) => compareResultSets([set(rows, { repetitions: 2 })], { a: "baseline", b: "lean", bootstrap: 500, margin });
    const boundary = at(0.5);
    expect(boundary.nonInferiority).toMatchObject({ difference: -0.5, ci95: [-0.5, -0.5], nonInferior: false });
    expect(boundary.interpretation.join("\n")).toMatch(/non-inferiority of B is NOT established at a 50\.0 pp margin/);
    expect(at(0.51).nonInferiority.nonInferior).toBe(true);
  });

  it("excludes and lists unpaired tasks, and flags incomplete arms", () => {
    const baseline = TASKS.slice(0, 5).map((taskId) => row("baseline", taskId));
    const lean = TASKS.slice(1, 6).map((taskId, index) => row("lean", taskId,
      index === 1 ? { failureClass: "invalid_result", resolved: false, modelRounds: 0 } : index === 2 ? { gradingError: "docker died", resolved: false } : {}));
    const comparison = compareResultSets([set([...baseline, ...lean], { instanceIds: TASKS.slice(0, 6) })], { a: "baseline", b: "lean", bootstrap: 200 });
    expect(comparison.pairing).toEqual({
      pairedTasks: 2,
      onlyInA: [TASKS[0], TASKS[2], TASKS[3]].sort(),
      onlyInB: [TASKS[5]]
    });
    expect(comparison.completeness.a).toMatchObject({ plannedRuns: 6, observedRuns: 5, scoredRuns: 5, missingRuns: 1, invalidResultRuns: 0 });
    expect(comparison.completeness.b).toMatchObject({
      plannedRuns: 6, observedRuns: 5, scoredRuns: 3, missingRuns: 1, invalidResultRuns: 1, gradingErrorRuns: 1
    });
    expect(comparison.completeness.complete).toBe(false);
    expect(comparison.warnings.join("\n")).toMatch(/B \(lean\) is incomplete: 1 planned run\(s\) missing; 1 invalid_result row\(s\); 1 grading_error row\(s\)/);
    expect(comparison.claims.b.runs).toBe(2);
  });

  it("refuses rows that are not comparable", () => {
    const baseline = armRows("baseline");
    expect(() => compareResultSets([set([...baseline, ...armRows("lean", () => ({ model: "deepseek-flash" }))])], { a: "baseline", b: "lean" }))
      .toThrow(/different models: deepseek-flash, deepseek-v4-pro/);
    expect(() => compareResultSets([set([...baseline, ...armRows("lean", () => ({ benchmark: "other" as "swebench" }))])], { a: "baseline", b: "lean" }))
      .toThrow(/different benchmarks/);
    expect(() => compareResultSets([set(baseline)], { a: "baseline", b: "lean" })).toThrow(/No rows for variant "lean"/);
    expect(() => compareResultSets([set([...baseline, ...baseline.map((item) => ({ ...item, variant: "lean" })), baseline[0]!])], { a: "baseline", b: "lean" }))
      .toThrow(/Duplicate run for variant "baseline"/);
    const t1 = { dir: "/virtual/t1", manifest: { schemaVersion: 1 }, rows: [{ schemaVersion: 1 }] } as unknown as ResultSet;
    expect(() => compareResultSets([t1], { a: "baseline", b: "lean" })).toThrow(/needs SWE-bench results \(schemaVersion 2\)/);
  });

  it("warns when the response models differ, repeat, or are missing", () => {
    const substituted = armRows("lean", () => ({ responseModels: ["deepseek-v4-flash"], traceEvents: trace({ model: "deepseek-v4-flash" }) }));
    const mixed = armRows("baseline", (index) => index ? {} : { responseModels: [MODEL, "deepseek-v4-flash"] });
    const comparison = compareResultSets([set([...mixed, ...substituted])], { a: "baseline", b: "lean", bootstrap: 200 });
    expect(comparison.responseModels).toEqual({ a: ["deepseek-v4-flash", MODEL], b: ["deepseek-v4-flash"] });
    expect(comparison.warnings).toEqual([
      `WARNING: the arms report different response models: A = deepseek-v4-flash, ${MODEL}; B = deepseek-v4-flash.`,
      `WARNING: A (baseline) reports more than one response model: deepseek-v4-flash, ${MODEL}.`
    ]);
    const silent = armRows("lean", () => ({ responseModels: [], traceEvents: [] }));
    expect(compareResultSets([set([...armRows("baseline"), ...silent])], { a: "baseline", b: "lean", bootstrap: 200 }).warnings)
      .toContain("WARNING: B (lean) recorded no response model, so the served model is unverified.");
  });

  it("refuses directories measured under different conditions", () => {
    const [baseline, lean] = manifest().variants;
    const across = (changed: Partial<SwebenchManifest>) => () => compareResultSets([
      set(armRows("baseline"), { variants: [baseline!] }, "/virtual/a"),
      set(armRows("lean"), { variants: [lean!], ...changed }, "/virtual/b")
    ], { a: "baseline", b: "lean", bootstrap: 200 });
    const changes: Array<[string, Partial<SwebenchManifest>]> = [
      ["dataFileSha256", { dataFileSha256: "other" }], ["datasetRevision", { datasetRevision: "other" }],
      ["imageSource", { imageSource: "official" }], ["allowTargetedVerification", { allowTargetedVerification: false }],
      ["executor", { executor: "docker" }], ["displayRoot", { displayRoot: "/work" }],
      ["limits", { limits: { ...manifest().limits, maxSteps: 10 } }], ["containerLimits", { containerLimits: { cpus: 4, memory: "4g", network: "none" } }],
      ["model", { model: "deepseek-flash" }], ["provider", { provider: "openai" }], ["thinking", { thinking: "disabled" }],
      ["reasoningEffort", { reasoningEffort: "max" }], ["swebenchVersion", { swebenchVersion: "5.0.3" }], ["baseURL", { baseURL: "https://other.invalid/" }],
      ["imageIds", { imageIds: { [TASKS[0]!]: "sha256:b" } }],
      ["infraPolicy", { infraPolicy: { grading: { rule: "retry every grading failure" } } as SwebenchManifest["infraPolicy"] }]
    ];
    for (const [key, changed] of changes) {
      expect(across(changed), key).toThrow(`Cannot compare results measured under different conditions: ${key} differ between /virtual/a, /virtual/b`);
    }
    // Image IDs are compared per instance, so evaluations of different instances may pin different images.
    const images = (ids: Record<string, string>) => ({ imageIds: ids });
    const pinned = () => compareResultSets([
      set(armRows("baseline"), { variants: [baseline!], ...images({ [TASKS[0]!]: "sha256:a", [TASKS[1]!]: "sha256:a1" }) }, "/virtual/a"),
      set(armRows("lean"), { variants: [lean!], ...images({ [TASKS[0]!]: "sha256:a", [TASKS[2]!]: "sha256:c" }) }, "/virtual/b")
    ], { a: "baseline", b: "lean", bootstrap: 200 });
    expect(pinned).not.toThrow();
    // Warned about, but allowed: the temperature and the price snapshot.
    expect(compareResultSets([
      set(armRows("baseline"), { variants: [baseline!] }, "/virtual/a"),
      set(armRows("lean"), { variants: [lean!], temperature: 0.2 }, "/virtual/b")
    ], { a: "baseline", b: "lean", bootstrap: 200 }).warnings).toEqual([
      "WARNING: the contributing manifests differ in temperature, so the comparison also measures those differences."
    ]);
  });

  it("refuses a variant whose rows come from different agent or source versions, and warns when the arms do", () => {
    const [baseline, lean] = manifest().variants;
    const half = (variant: string, from: number, to: number) => armRows(variant).slice(from, to);
    const split = (second: Partial<SwebenchManifest>) => () => compareResultSets([
      set([...half("baseline", 0, 6), ...half("lean", 0, 6)], {}, "/virtual/a"),
      set([...half("baseline", 6, 12), ...half("lean", 6, 12)], second, "/virtual/b")
    ], { a: "baseline", b: "lean", bootstrap: 200 });
    expect(split({ variants: [{ ...baseline!, agentFingerprint: "c".repeat(64) }, lean!] }))
      .toThrow(`Variant "baseline" has different agentFingerprints in /virtual/a, /virtual/b`);
    expect(split({ sourceFingerprint: "e".repeat(64) }))
      .toThrow(`The rows of variant "baseline" come from different sourceFingerprints in /virtual/a, /virtual/b`);
    expect(split({})).not.toThrow();

    // Each arm from its own evaluation of different source: a comparison across evaluations.
    const across = compareResultSets([
      set(armRows("baseline"), { variants: [baseline!] }, "/virtual/a"),
      set(armRows("lean"), { variants: [lean!], sourceFingerprint: "e".repeat(64) }, "/virtual/b")
    ], { a: "baseline", b: "lean", bootstrap: 200 });
    expect(across.completeness.complete).toBe(true);
    expect(across.warnings).toEqual([
      "WARNING: the arms come from evaluations with different sourceFingerprints, so the comparison also measures that code difference. That is legitimate only for a comparison across evaluations; the final comparison uses one evaluation."
    ]);
  });

  it("reaches the same completeness verdict as the evaluation summary on the same rows", () => {
    const full = () => [...armRows("baseline"), ...armRows("lean")];
    const withRow = (index: number, changed: Partial<SwebenchRunResult>) => full().map((item, at) => at === index ? { ...item, ...changed } : item);
    const envEvents = [{ ts: "t", event: "environment_failure", data: { round: 2, name: "run_tests" } }];
    const cases: Array<[string, SwebenchRunResult[], Partial<SwebenchManifest>, boolean]> = [
      ["every run present", full(), {}, true],
      ["a run missing", full().slice(1), {}, false],
      // 23 rows charged $0.01 each, plus a $1 reservation, pass a $1.2 cap.
      ["the cost cap stopped it", full().slice(1), { costCapUsd: 1.2 }, false],
      ["an invalid_result row", withRow(1, { failureClass: "invalid_result", agentStatus: "harness_error", falseSuccess: false, resolved: false }), {}, false],
      ["a harness_error row", withRow(2, { failureClass: "harness_error", agentStatus: "harness_error", falseSuccess: false, resolved: false }), {}, false],
      ["a grading_error row", withRow(14, { gradingError: "harness died", failureClass: "grading_error", resolved: false, falseSuccess: true }), {}, false],
      ["a provider_error row", withRow(15, { failureClass: "provider_error", stopReason: "model_error", resolved: false, falseSuccess: true }), {}, false],
      ["an environment_failure row", withRow(3, { failureClass: "environment_failure", stopReason: "runtime_error", traceEvents: envEvents }), {}, true],
      ["a test timeout", withRow(16, { gradingOutcome: "test_timeout", resolved: false, falseSuccess: true, failureClass: "false_success" }), {}, true],
      ["out of memory", withRow(4, { gradingOutcome: "oom", resolved: false, falseSuccess: true, failureClass: "false_success" }), {}, true],
      ["errored tests", withRow(17, { gradingOutcome: "tests_errored", resolved: false, falseSuccess: true, failureClass: "false_success" }), {}, true]
    ];
    for (const [label, rows, overrides, complete] of cases) {
      const evaluation = manifest(overrides);
      const summary = summarizeSwebench(evaluation, rows, capReachedFrom(evaluation, rows));
      const comparison = compareResultSets([set(rows, overrides)], { a: "baseline", b: "lean", bootstrap: 100 });
      const { a, b } = comparison.completeness;
      expect([summary.complete, comparison.completeness.complete], label).toEqual([complete, complete]);
      for (const field of [
        "plannedRuns", "observedRuns", "scoredRuns", "missingRuns", "invalidResultRuns", "harnessErrorRuns", "gradingErrorRuns", "providerErrorRuns",
        "environmentFailureRuns"
      ] as const) {
        expect(a[field] + b[field], `${label}: ${field}`).toBe(summary.completeness[field]);
      }
      expect(a.patchCausedRuns.test_timeout + b.patchCausedRuns.test_timeout + a.patchCausedRuns.oom + b.patchCausedRuns.oom +
        a.patchCausedRuns.tests_errored + b.patchCausedRuns.tests_errored, label)
        .toBe(summary.completeness.patchCausedRuns.test_timeout + summary.completeness.patchCausedRuns.oom + summary.completeness.patchCausedRuns.tests_errored);
      expect(a.capReached || b.capReached, label).toBe(summary.completeness.capReached);
      expect(summary.completeness.capReached, label).toBe(label === "the cost cap stopped it");
      expect(a.flags.includes("the cost cap stopped the evaluation") && b.flags.includes("the cost cap stopped the evaluation"), label)
        .toBe(summary.completeness.capReached);
    }
  });

  it("counts claimed success against resolved per arm", () => {
    const outcomes: Array<[string, boolean]> = [["success", true], ["success", false], ["budget_exhausted", true], ["failed", false]];
    const comparison = compareResultSets([set([
      ...outcomes.map(([agentStatus, resolved], index) => row("baseline", TASKS[index]!, { agentStatus, resolved })),
      ...outcomes.map((_, index) => row("lean", TASKS[index]!))
    ], { instanceIds: TASKS.slice(0, 4) })], { a: "baseline", b: "lean", bootstrap: 200 });
    expect(comparison.claims).toEqual({
      a: { runs: 4, claimedResolved: 1, claimedUnresolved: 1, unclaimedResolved: 1, unclaimedUnresolved: 1 },
      b: { runs: 4, claimedResolved: 4, claimedUnresolved: 0, unclaimedResolved: 0, unclaimedUnresolved: 0 }
    });
    expect(metric(comparison.slices.all.metrics, "falseSuccess").a.mean).toBe(0.25);
  });

  it("loads result directories and writes the Markdown and JSON reports", async () => {
    const dir = await makeTempDir("onehand-compare-");
    dirs.push(dir);
    const results = path.join(dir, "results");
    await mkdir(results);
    await writeFile(path.join(results, "manifest.json"), JSON.stringify(manifest()));
    await writeFile(path.join(results, "results.jsonl"), [...armRows("baseline"), ...armRows("lean")].map((item) => JSON.stringify(item)).join("\n") + "\n");
    const { comparison, markdownPath, jsonPath } = await runComparison({
      results: [results, results], a: "baseline", b: "lean", bootstrap: 300, output: path.join(dir, "out", "ab.md")
    });
    expect(markdownPath).toBe(path.join(dir, "out", "ab.md"));
    expect(JSON.parse(await readFile(jsonPath, "utf8"))).toMatchObject({ kind: "paired_comparison", pairing: { pairedTasks: 12 } });
    const markdown = await readFile(markdownPath, "utf8");
    expect(markdown).toContain("| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |");
    expect(markdown).toMatch(/\| estimatedCostUsd \| \$0\.0365 \/ \$0\.0365 \| \$0\.0365 \/ \$0\.0365 \| \+0\.0% \| \+0\.0% to \+0\.0% \| 1\.000 \(1\.000\) \| primary; no detectable difference; n=12 \|/);
    expect(comparison.resultsDirs).toEqual([results]);
    await expect(loadResultSet(dir)).rejects.toThrow(/Missing manifest\.json/);
    await writeFile(path.join(results, "results.jsonl"), "{\"schemaVersion\":1}\n");
    await expect(loadResultSet(results)).rejects.toThrow(/results\.jsonl:1: schemaVersion 1 does not match the manifest's 2/);
  });
});

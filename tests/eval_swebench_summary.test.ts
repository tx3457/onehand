import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapMeanCi } from "../eval/stats.js";
import { capReachedFrom, circuitOpenFrom } from "../eval/results-io.js";
import { swebenchInfraPolicy } from "../eval/swebench/runInstance.js";
import { DIAGNOSTIC_NOTE, summarizeSwebench, swebenchReportMarkdown, writeSwebenchReport } from "../eval/swebench/summary.js";
import type { SwebenchManifest, SwebenchRunResult } from "../eval/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const INSTANCES = ["django__django-1", "django__django-2", "sympy__sympy-1", "sympy__sympy-2"];
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

function row(taskId: string, repetition: number, overrides: Partial<SwebenchRunResult> = {}): SwebenchRunResult {
  const resolved = overrides.resolved ?? false;
  const agentStatus = overrides.agentStatus ?? "success";
  return {
    schemaVersion: 2, evaluationId: "eval-summary", benchmark: "swebench", variant: "baseline", taskId, taskHash: "h",
    category: taskId.startsWith("django") ? "django/django" : "sympy/sympy", split: "dev", repetition, provider: "deepseek",
    model: "deepseek-flash", thinking: "enabled", reasoningEffort: "high", temperature: null, startedAt: "2026-09-25T00:00:00.000Z",
    durationMs: 100_000, agentStatus, stopReason: "explicit_finish", resolved, falseSuccess: agentStatus === "success" && !resolved,
    agentVerificationPassed: true, modelRounds: 10, toolCalls: 20, inputTokens: 100_000, outputTokens: 5_000, cacheHitInputTokens: 80_000,
    cacheMissInputTokens: 20_000, reasoningTokens: 2_000, estimatedCostUsd: 0.02, retryCostUsd: 0, capChargeUsd: 0.02, responseModels: ["deepseek-flash"],
    attempts: 1, finalMessage: "", traceEvents: [], difficulty: "<15 min fix", patchBytes: 100, patchFiles: ["a.py"], emptyPatch: false,
    patchApplied: true, f2p: { success: 1, failure: 0 }, p2p: { success: 1, failure: 0 },
    ...overrides
  };
}

function manifest(overrides: Partial<SwebenchManifest> = {}): SwebenchManifest {
  return {
    schemaVersion: 2, evaluationId: "eval-summary", createdAt: "2026-09-25T00:00:00.000Z", benchmark: "swebench", split: "dev",
    datasetRevision: "rev", dataFileSha256: "sha", swebenchVersion: "5.0.2", instanceIds: INSTANCES, exclusions: [],
    variants: [{ name: "baseline", flags: {}, agentFingerprint: "a".repeat(64) }], repetitions: 2, plannedRuns: 8, scheduleSeed: 1,
    provider: "deepseek", model: "deepseek-flash", thinking: "enabled", reasoningEffort: "high", temperature: null,
    limits: {
      maxSteps: 80, maxToolCalls: 150, maxInputTokens: 3_000_000, maxOutputTokens: 150_000, maxWallTimeMs: 1_800_000,
      commandTimeoutSec: 600, maxTurnOutputTokens: 16_384, maxTextOnlyNudges: 2, modelTimeoutMs: 300_000, maxApiAttempts: 4, retryDelayMs: 2_000
    },
    containerLimits: { cpus: 2, memory: "4g", network: "none" },
    priceSnapshot: {
      source: "test", checkedAt: "2026-09-25", model: "deepseek-flash", basis: "peak", peakHoursUtc: "never",
      inputCacheHitPerMillionUsd: 0.006, inputCacheMissPerMillionUsd: 0.3, outputPerMillionUsd: 1.2
    },
    reservationUsd: 0.5, costCapUsd: 10, sourceFingerprint: "f".repeat(64), gitHead: null, gitDirty: null, imageSource: "epoch",
    executor: "docker", displayRoot: "/testbed", allowTargetedVerification: true, holdoutConfirmed: false,
    ...overrides
  };
}

// Seven of the eight planned runs; sympy__sympy-2 #2 is missing.
function observedRows(): SwebenchRunResult[] {
  return [
    row("django__django-1", 1, { resolved: true }),
    row("django__django-1", 2, { resolved: true }),
    row("django__django-2", 1, { difficulty: "15 min - 1 hour", failureClass: "false_success" }),
    row("django__django-2", 2, {
      difficulty: "15 min - 1 hour", agentStatus: "budget_exhausted", stopReason: "step_budget", failureClass: "empty_patch",
      emptyPatch: true, patchBytes: 0, patchFiles: [], patchApplied: false, f2p: { success: 0, failure: 0 }, p2p: { success: 0, failure: 0 }
    }),
    row("sympy__sympy-1", 1, { resolved: true, agentStatus: "failed", stopReason: "model_error" }),
    row("sympy__sympy-1", 2, {
      agentStatus: "failed", stopReason: "runtime_error", failureClass: "environment_failure",
      traceEvents: [{ ts: "t", event: "environment_failure", data: { round: 3, name: "run_tests" } }]
    }),
    row("sympy__sympy-2", 1, { difficulty: "1-4 hours", failureClass: "patch_apply_failure", patchApplied: false })
  ];
}

describe("SWE-bench summary", () => {
  it("computes the resolved rate with a task-cluster CI, the breakdowns, and the claim table", () => {
    const summary = summarizeSwebench(manifest(), observedRows(), false);
    expect(summary.scoredRuns).toBe(7);
    // Per-task means in id order: django-1 = 1, django-2 = 0, sympy-1 = 0.5, sympy-2 = 0.
    expect(summary.resolved).toEqual({ runs: 7, resolved: 3, rate: 3 / 7, ci95: bootstrapMeanCi([1, 0, 0.5, 0]) });
    expect(summary.resolved.ci95[0]).toBeLessThan(3 / 7);
    expect(summary.resolved.ci95[1]).toBeGreaterThan(3 / 7);
    expect(summary.byRepo).toEqual({
      "django/django": { runs: 4, resolved: 2, rate: 0.5, ci95: bootstrapMeanCi([1, 0]) },
      "sympy/sympy": { runs: 3, resolved: 1, rate: 1 / 3, ci95: bootstrapMeanCi([0.5, 0]) }
    });
    expect(summary.byDifficulty).toEqual({
      "1-4 hours": { runs: 1, resolved: 0, rate: 0, ci95: bootstrapMeanCi([0]) },
      "15 min - 1 hour": { runs: 2, resolved: 0, rate: 0, ci95: bootstrapMeanCi([0]) },
      "<15 min fix": { runs: 4, resolved: 3, rate: 0.75, ci95: bootstrapMeanCi([1, 0.5]) }
    });
    expect(summary.claims).toEqual({ claimedResolved: 2, claimedUnresolved: 2, unclaimedResolved: 1, unclaimedUnresolved: 2 });
    expect(summary.falseSuccess).toEqual({ runs: 7, count: 2, rate: 2 / 7 });
    expect(summary.patches).toEqual({ emptyPatchRuns: 1, emptyPatchRate: 1 / 7, applyFailures: 1 });
    expect(summary.efficiency.modelRounds).toEqual({ mean: 10, p50: 10, p95: 10, max: 10 });
    expect(summary.efficiency.cacheHitRate).toBeCloseTo(0.8, 12);
    expect(summary.totals).toMatchObject({ inputTokens: 700_000, reasoningTokens: 14_000 });
    expect(summary.totals.measuredCostUsd).toBeCloseTo(0.14, 12);
    expect(summary.totals.costPerResolvedUsd).toBeCloseTo(0.14 / 3, 12);
    expect(summary.responseModels).toEqual(["deepseek-flash"]);
    expect(summary.failureClasses).toEqual({ empty_patch: 1, environment_failure: 1, false_success: 1, patch_apply_failure: 1 });
    expect(summary.perVariant).toBeNull();
  });

  it("is complete only with every planned run, no cap stop, and no excluded row; environment failures still count", () => {
    const missing = summarizeSwebench(manifest(), observedRows(), false);
    expect(missing).toMatchObject({
      complete: false,
      completeness: {
        flags: ["1 planned run(s) missing"], plannedRuns: 8, observedRuns: 7, missingRuns: 1, capReached: false,
        invalidResultRuns: 0, gradingErrorRuns: 0, harnessErrorRuns: 0, environmentFailureRuns: 1
      }
    });

    const full = [...observedRows(), row("sympy__sympy-2", 2, { difficulty: "1-4 hours", failureClass: "false_success" })];
    expect(summarizeSwebench(manifest(), full, false)).toMatchObject({
      complete: true, scoredRuns: 8, completeness: { flags: [], environmentFailureRuns: 1 }
    });
    expect(summarizeSwebench(manifest(), full, true).completeness.flags).toEqual(["the cost cap stopped the evaluation"]);

    const excluded = [
      ...observedRows().slice(0, 4),
      row("sympy__sympy-1", 1, { failureClass: "invalid_result", agentStatus: "harness_error", falseSuccess: false, estimatedCostUsd: 0.3 }),
      row("sympy__sympy-1", 2, { failureClass: "harness_error", agentStatus: "harness_error", falseSuccess: false, estimatedCostUsd: 0 }),
      row("sympy__sympy-2", 1, { gradingError: "Grading failed 3 times", failureClass: "grading_error" }),
      row("sympy__sympy-2", 2, { resolved: true })
    ];
    const summary = summarizeSwebench(manifest(), excluded, false);
    expect(summary.complete).toBe(false);
    expect(summary.completeness.flags).toEqual(["1 invalid_result row(s)", "1 grading_error row(s)", "1 harness_error row(s)"]);
    expect(summary.scoredRuns).toBe(5);
    expect(summary.resolved).toMatchObject({ runs: 5, resolved: 3 });
    // Totals still include the excluded rows' spend.
    expect(summary.totals.measuredCostUsd).toBeCloseTo(6 * 0.02 + 0.3, 12);
  });

  it("adds a per-variant table only when the evaluation has several variants", () => {
    const variants: SwebenchManifest["variants"] = [
      { name: "baseline", flags: {}, agentFingerprint: "a".repeat(64) }, { name: "lean", flags: { lean: true }, agentFingerprint: "b".repeat(64) }
    ];
    const rows = [
      ...observedRows(),
      ...observedRows().map((item) => ({ ...item, variant: "lean", resolved: true, falseSuccess: false, estimatedCostUsd: 0.01 }))
    ];
    const summary = summarizeSwebench(manifest({ variants, plannedRuns: 16 }), rows, false);
    expect(summary.perVariant).toEqual([
      expect.objectContaining({ variant: "baseline", plannedRuns: 8, observedRuns: 7, runs: 7, resolved: 3, rate: 3 / 7 }),
      expect.objectContaining({ variant: "lean", plannedRuns: 8, observedRuns: 7, runs: 7, resolved: 7, rate: 1, falseSuccessRate: 0, meanCostUsd: expect.closeTo(0.01, 12) })
    ]);
    const markdown = swebenchReportMarkdown(manifest({ variants, plannedRuns: 16 }), summary);
    expect(markdown).toContain("## Per variant");
    expect(markdown).toContain("| `lean` | 8 | 7 | 7 | 7 | 100.0% |");
    expect(swebenchReportMarkdown(manifest(), summarizeSwebench(manifest(), observedRows(), false))).not.toContain("## Per variant");
  });

  it("writes an idempotent report that sends A/B claims to eval:compare", async () => {
    const dir = await makeTempDir("onehand-swe-summary-");
    dirs.push(dir);
    await writeSwebenchReport(manifest(), observedRows(), dir, false);
    const markdown = await readFile(path.join(dir, "report.md"), "utf8");
    const json = await readFile(path.join(dir, "summary.json"), "utf8");
    // Row order does not matter, and nothing is timestamped.
    await writeSwebenchReport(manifest(), [...observedRows()].reverse(), dir, false);
    expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe(markdown);
    expect(await readFile(path.join(dir, "summary.json"), "utf8")).toBe(json);
    expect(JSON.parse(json)).toMatchObject({ kind: "swebench_summary", evaluationId: "eval-summary", complete: false });
    expect(markdown).toContain(`> ${DIAGNOSTIC_NOTE}`);
    expect(DIAGNOSTIC_NOTE).toMatch(/A\/B claims come only from `npm run eval:compare`.*A single-variant run is a diagnostic/);
    expect(markdown).toContain("INCOMPLETE: 1 planned run(s) missing.");
    expect(markdown).toContain("- 3 of 7 scored run(s) resolved: 42.9%");
    expect(markdown).toContain("| django/django | 4 | 2 | 50.0% |");
    expect(markdown).toContain("| claimed success | 2 | 2 (false success) |");
  });

  it("recovers whether the cap stopped the run from the rows alone", () => {
    const rows = observedRows();
    // 7 × $0.02 charged + $0.5 reserved: within a $10 cap, beyond a $0.6 one.
    expect(capReachedFrom(manifest(), rows)).toBe(false);
    expect(capReachedFrom(manifest({ costCapUsd: 0.6 }), rows)).toBe(true);
    const full = [...rows, row("sympy__sympy-2", 2)];
    expect(capReachedFrom(manifest({ costCapUsd: 0.6 }), full)).toBe(false);
    // Superseded rows and unrecorded jobs were charged too: $0.14 + $0.06 + $0.5 reserved passes a $0.65 cap.
    expect(capReachedFrom(manifest({ costCapUsd: 0.65 }), rows)).toBe(false);
    expect(capReachedFrom(manifest({ costCapUsd: 0.65 }), rows, { supersededChargeUsd: 0.03, unfinishedChargeUsd: 0.03 })).toBe(true);
  });

  it("reports the per-task cost apart from the true spend and from what the cap charged", () => {
    const rows = [
      ...observedRows().slice(0, 6),
      // An outage ended this run's first attempt: the row costs the final attempt, and the job was charged both.
      row("sympy__sympy-2", 1, { difficulty: "1-4 hours", failureClass: "patch_apply_failure", patchApplied: false, retryCostUsd: 0.05, capChargeUsd: 0.07 }),
      // A job that threw: no known cost, charged its whole reservation.
      row("sympy__sympy-2", 2, { failureClass: "harness_error", agentStatus: "harness_error", estimatedCostUsd: 0, capChargeUsd: 0.5 })
    ];
    const summary = summarizeSwebench(manifest(), rows, false, { unfinishedChargeUsd: 0.5, supersededChargeUsd: 0.03 });
    const measured = 7 * 0.02;
    expect(summary.totals.measuredCostUsd).toBeCloseTo(measured, 12);
    expect(summary.totals.retryCostUsd).toBeCloseTo(0.05, 12);
    expect(summary.totals).toMatchObject({ supersededChargeUsd: 0.03, unfinishedChargeUsd: 0.5 });
    // The true spend adds the discarded attempt, the superseded run, and the unrecorded job; the cap also charged the thrown job.
    expect(summary.totals.totalSpendUsd).toBeCloseTo(measured + 0.05 + 0.03 + 0.5, 12);
    expect(summary.totals.capChargedUsd).toBeCloseTo(summary.totals.totalSpendUsd + 0.5, 12);
    // Per-task statistics see the final attempts only.
    expect(summary.efficiency.estimatedCostUsd.mean).toBeCloseTo(0.02, 12);
    expect(summary.totals.costPerResolvedUsd).toBeCloseTo(measured / 3, 12);
    const markdown = swebenchReportMarkdown(manifest(), summary);
    expect(markdown).toContain("- Per-task metric (estimatedCostUsd): $0.1400 over all rows; per resolved run: $0.0467.");
    expect(markdown).toContain("- True spend (totalSpendUsd): $0.7200: the per-task metric, plus $0.0500 for attempts a provider outage ended before the job re-ran them (retryCostUsd), $0.0300 for provider_error runs");
    expect(markdown).toContain("- Charged against the cost cap (capChargedUsd): $1.2200: the true spend, plus the whole reservation of any job that threw");
  });

  it("marks an evaluation the provider circuit breaker stopped incomplete, with stopReason provider_circuit_open", () => {
    const guarded = manifest({ infraPolicy: swebenchInfraPolicy(3) });
    const outage = (taskId: string, repetition: number) =>
      row(taskId, repetition, { failureClass: "provider_error", agentStatus: "failed", stopReason: "model_error" });
    // In results.jsonl's order: three provider errors in a row open it; a row between them resets the count.
    const tripped = [row("django__django-1", 1), outage("django__django-1", 2), outage("django__django-2", 1), outage("django__django-2", 2)];
    expect(circuitOpenFrom(guarded, tripped)).toBe(true);
    expect(circuitOpenFrom(guarded, [...tripped.slice(1, 3), tripped[0]!, ...tripped.slice(3)])).toBe(false);
    // A manifest that recorded no threshold has no breaker.
    expect(circuitOpenFrom(manifest(), tripped)).toBe(false);

    const summary = summarizeSwebench(guarded, tripped, false, { circuitOpen: true });
    expect(summary).toMatchObject({ complete: false, stopReason: "provider_circuit_open", completeness: { circuitOpen: true, providerErrorRuns: 3 } });
    expect(summary.completeness.flags).toContain(
      "the provider circuit breaker stopped the evaluation (a provider outage is suspected; resume later to re-run the provider_error rows)"
    );
    expect(swebenchReportMarkdown(guarded, summary)).toContain(
      "Stopped early (stopReason provider_circuit_open): a provider outage is suspected after 3 consecutive provider errors, so no new job started and the jobs in flight finished. Resume later to re-run them."
    );
    expect(summarizeSwebench(guarded, tripped, false)).toMatchObject({ stopReason: null, completeness: { circuitOpen: false } });
  });
});

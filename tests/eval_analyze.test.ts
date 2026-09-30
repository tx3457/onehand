import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analysisMarkdown, analyzeResultSet, diagnoseRun, DISCLAIMER, runAnalysis } from "../eval/analyze.js";
import { parseTrace, type ResultSet } from "../eval/results-io.js";
import type { EvaluationRunResult, SwebenchManifest, SwebenchRunResult } from "../eval/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

describe("completion trace evidence", () => {
  it("preserves revision zero, rejects malformed evidence, and does not invent legacy verification", () => {
    expect(parseTrace([]).finalVerification).toBeUndefined();
    expect(parseTrace([{ event: "run_finished", data: { plan: { status: "completed" } } }]).finalVerification).toBeUndefined();
    const trace = parseTrace([
      { event: "budget_notice", data: { round: 4, kind: "closeout", writeRevision: 0, validatedWriteRevision: 0 } },
      { event: "budget_notice", data: { round: -1, kind: "closeout", writeRevision: 0 } },
      { event: "budget_notice", data: { round: 5, kind: "unknown", writeRevision: 0 } },
      { event: "run_finished", data: { plan: { writeRevision: 0, validatedWriteRevision: 0 } } }
    ]);
    expect(trace.notices).toEqual([{ round: 4, kind: "closeout", writeRevision: 0, validatedWriteRevision: 0 }]);
    expect(trace.finalVerification).toEqual({ writeRevision: 0, validatedWriteRevision: 0, verified: true });
    expect(parseTrace([{ event: "run_finished", data: { plan: { writeRevision: "0", validatedWriteRevision: 0 } } }]).finalVerification).toBeUndefined();
  });
});

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

type Turn = { prompt: number; output: number; latencyMs: number; tools: Array<Record<string, unknown>>; finishReason?: string };

function trace(turns: Turn[], extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [{ ts: "t", event: "run_started", data: { displayRoot: "/testbed" } }];
  turns.forEach((turn, index) => {
    const round = index + 1;
    events.push({
      ts: "t",
      event: "model_turn",
      data: {
        round,
        toolCallNames: turn.tools.map((tool) => tool.name),
        finishReason: turn.finishReason ?? (turn.tools.length ? "tool_calls" : "stop"),
        latencyMs: turn.latencyMs,
        usage: { inputTokens: turn.prompt, outputTokens: turn.output }
      }
    });
    if (!turn.tools.length) events.push({ ts: "t", event: "text_only_turn", data: { round, finishReason: "stop", nudge: true } });
    for (const tool of turn.tools) {
      events.push({ ts: "t", event: "tool_result", data: { round, ok: true, truncated: false, durationMs: 0, observationBytes: 0, ...tool } });
    }
  });
  return [...events, ...extra, { ts: "t", event: "run_finished", data: { status: "success", stopReason: "explicit_finish" } }];
}

function tools(...specs: Array<[string, string, boolean?]>): Turn[] {
  return specs.map(([name, file, ok]) => ({
    prompt: 100, output: 10, latencyMs: 0, tools: [{ name, arguments: { path: file }, ok: ok ?? true }]
  }));
}

// P_k = 1000, 1600, 1700, 1500, 2000 and O_k = 200, 150, 80, 100, 60.
const KNOWN: Turn[] = [
  { prompt: 1000, output: 200, latencyMs: 1000, tools: [
    { name: "set_plan", observationBytes: 100, durationMs: 10 },
    { name: "read_file", arguments: { path: "a.py" }, observationBytes: 300, durationMs: 30 }
  ] },
  { prompt: 1600, output: 150, latencyMs: 2000, tools: [
    { name: "read_file", arguments: { path: "/testbed/a.py" }, observationBytes: 500, durationMs: 20 }
  ] },
  { prompt: 1700, output: 80, latencyMs: 1500, tools: [{ name: "update_plan", observationBytes: 50, durationMs: 5 }] },
  { prompt: 1500, output: 100, latencyMs: 500, tools: [] },
  { prompt: 2000, output: 60, latencyMs: 1000, tools: [{ name: "finish_task", observationBytes: 40, durationMs: 2 }] }
];

function row(overrides: Partial<SwebenchRunResult> = {}): SwebenchRunResult {
  return {
    schemaVersion: 2, evaluationId: "eval-1", benchmark: "swebench", variant: "baseline", taskId: "owner__repo-1", taskHash: "hash",
    category: "owner/repo", split: "dev", repetition: 1, provider: "deepseek", model: "deepseek-v4-pro", thinking: "enabled",
    reasoningEffort: "high", temperature: null, startedAt: "2026-09-25T00:00:00.000Z", durationMs: 10_000, agentStatus: "success",
    stopReason: "explicit_finish", resolved: true, falseSuccess: false, agentVerificationPassed: true, modelRounds: 5, toolCalls: 5,
    inputTokens: 7800, outputTokens: 590, cacheHitInputTokens: 6000, cacheMissInputTokens: 1800, reasoningTokens: 300,
    estimatedCostUsd: 0.01, retryCostUsd: 0, capChargeUsd: 0.01, responseModels: ["deepseek-v4-pro"], attempts: 1, finalMessage: "done",
    traceEvents: trace(KNOWN), difficulty: "<15 min fix", patchBytes: 100, patchFiles: ["a.py"], emptyPatch: false, patchApplied: true,
    f2p: { success: 1, failure: 0 }, p2p: { success: 1, failure: 0 },
    ...overrides
  };
}

function resultSet(rows: Array<SwebenchRunResult | EvaluationRunResult>, schemaVersion: 1 | 2 = 2): ResultSet {
  const manifest = schemaVersion === 2
    ? { schemaVersion: 2, benchmark: "swebench" } as SwebenchManifest
    : { schemaVersion: 1 } as unknown as ResultSet["manifest"];
  return { dir: "/virtual/eval", manifest, rows };
}

describe("trace diagnostics", () => {
  it("attributes context growth exactly, weighting each added token by the rounds that re-send it", () => {
    const run = diagnoseRun(row());
    expect(run.prompts).toEqual([1000, 1600, 1700, 1500, 2000]);
    expect(run.cumulativeInput).toBe(7800);
    expect(run.peakContext).toBe(2000);
    // D2 = 600 (×4): 200 output, then 400 split 100:300 by round 1's bytes; D3 = 100 (×3): all output;
    // D4 = −200 (×2): other; D5 = 500 (×1): 100 output, 400 other (round 4 was a nudged text-only turn).
    expect(run.sources).toEqual({
      initial_prompt: { added: 1000, weighted: 5000, observations: 0 },
      assistant_output: { added: 400, weighted: 1200, observations: 0 },
      "tool:set_plan": { added: 100, weighted: 400, observations: 1 },
      "tool:read_file": { added: 300, weighted: 1200, observations: 2 },
      "tool:update_plan": { added: 0, weighted: 0, observations: 1 },
      other: { added: 200, weighted: 0, observations: 0 }
    });
    expect(Object.values(run.sources).reduce((total, source) => total + source.weighted, 0)).toBe(run.cumulativeInput);

    const diagnostics = analyzeResultSet(resultSet([row()]));
    expect(diagnostics.contextGrowth.cumulativeInputTokens).toBe(7800);
    expect(diagnostics.contextGrowth.reportedInputTokens).toBe(7800);
    const source = (name: string) => diagnostics.contextGrowth.sources.find((item) => item.source === name)!;
    expect(source("initial_prompt")).toMatchObject({ share: 5000 / 7800, tokensPerObservation: null });
    expect(source("tool:read_file")).toMatchObject({ weightedTokens: 1200, share: 1200 / 7800, tokensPerObservation: 150 });
    expect(source("tool:update_plan").tokensPerObservation).toBe(0);
    expect(diagnostics.bottlenecks.inputTokens[0]).toEqual({ source: "initial_prompt", weightedTokens: 5000, share: 5000 / 7800 });
  });

  it("detects redundant reads only without an intervening successful write", () => {
    const reads = (turns: Turn[]) => diagnoseRun(row({ traceEvents: trace(turns) })).reads;
    expect(reads(tools(["read_file", "a.py"], ["read_file", "b.py"], ["read_file", "./a.py"]))).toEqual({ total: 3, redundant: 1 });
    expect(reads(tools(["read_file", "a.py"], ["replace_text", "a.py"], ["read_file", "a.py"]))).toEqual({ total: 2, redundant: 0 });
    expect(reads(tools(["read_file", "a.py"], ["write_file", "/testbed/a.py"], ["read_file", "a.py"]))).toEqual({ total: 2, redundant: 0 });
    expect(reads(tools(["read_file", "a.py"], ["write_file", "a.py", false], ["read_file", "a.py"]))).toEqual({ total: 2, redundant: 1 });
    expect(reads(tools(["read_file", "a.py"], ["write_file", "b.py"], ["read_file", "a.py"]))).toEqual({ total: 2, redundant: 1 });
    expect(reads(tools(["read_file", "a.py", false], ["read_file", "a.py"]))).toEqual({ total: 2, redundant: 0 });
    expect(diagnoseRun(row()).reads).toEqual({ total: 2, redundant: 1 });
  });

  it("splits run time into model, tool, and clamped runtime overhead", () => {
    expect(diagnoseRun(row()).time).toEqual({ totalMs: 10_000, modelMs: 6000, toolMs: 67, overheadMs: 3933, clamped: false });
    expect(diagnoseRun(row({ durationMs: 5000 })).time).toEqual({ totalMs: 5000, modelMs: 6000, toolMs: 67, overheadMs: 0, clamped: true });
    const diagnostics = analyzeResultSet(resultSet([row(), row({ taskId: "owner__repo-2", durationMs: 5000 })]));
    expect(diagnostics.time).toMatchObject({ totalMs: 15_000, modelMs: 12_000, toolMs: 134, overheadMs: 3933, clampedRuns: 1 });
    expect(diagnostics.time.toolLatency.find((item) => item.tool === "read_file")).toEqual({ tool: "read_file", calls: 4, totalMs: 100, p50Ms: 20, p95Ms: 30 });
    expect(diagnostics.bottlenecks.time[0]).toEqual({ consumer: "model", ms: 12_000, share: 12_000 / (12_000 + 134 + 3933) });
  });

  it("counts governance calls and governance-only rounds", () => {
    const run = diagnoseRun(row());
    expect(run.governance).toEqual({ calls: 3, byTool: { set_plan: 1, update_plan: 1, finish_task: 1 }, rounds: 2 });
    const diagnostics = analyzeResultSet(resultSet([row()]));
    expect(diagnostics.governance).toMatchObject({ toolCalls: 5, governanceCalls: 3, share: 0.6, rounds: 5, governanceOnlyRounds: 2, roundShare: 0.4 });
  });

  it("aggregates failures, outcomes, and prompt curves across runs", () => {
    const failing = trace([
      { prompt: 500, output: 50, latencyMs: 100, tools: [
        { name: "run_command", ok: false, error: "Command is disabled: rm", errorCategory: "policy" },
        { name: "run_command", ok: true, errorCategory: "timeout" },
        { name: "run_tests", ok: true, passed: false, errorCategory: "test_failed" }
      ] },
      { prompt: 900, output: 8192, latencyMs: 100, tools: [], finishReason: "length" }
    ], [{ ts: "t", event: "environment_failure", data: { message: "container exited" } }]);
    const diagnostics = analyzeResultSet(resultSet([row(), row({ taskId: "owner__repo-2", traceEvents: failing, stopReason: "output_limit" })]));
    expect(diagnostics.failures).toMatchObject({ toolCalls: 8, failed: 2, rate: 0.25, testFailures: 1, byCategory: { policy: 1, timeout: 1 } });
    expect(diagnostics.failures.byTool[0]).toEqual({ tool: "run_command", calls: 2, failed: 2, rate: 1 });
    expect(diagnostics.failures.topErrors).toEqual([{ error: "Command is disabled: rm", count: 1 }]);
    expect(diagnostics.outcomes).toMatchObject({
      stopReasons: { explicit_finish: 1, output_limit: 1 },
      nudges: 2,
      runsWithNudges: 2,
      textOnlyTurns: 2,
      outputLimitTurns: 1,
      outputLimitStops: 1,
      environmentFailures: 1,
      peakContext: { max: 2000, p50: 900, p95: 2000, mean: 1450 }
    });
    expect(diagnostics.outcomes.promptCurve.slice(0, 3)).toEqual([
      { round: 1, runs: 2, p50: 500, p95: 1000 },
      { round: 2, runs: 2, p50: 900, p95: 1600 },
      { round: 3, runs: 1, p50: 1700, p95: 1700 }
    ]);
  });

  it("diagnoses one configuration at a time and leaves out harness substitutes", () => {
    const mixed = [row(), row({ variant: "lean" })];
    expect(() => analyzeResultSet(resultSet(mixed))).toThrow(/several variants \(baseline, lean\); pass --variant/);
    expect(() => analyzeResultSet(resultSet(mixed), { variant: "other" })).toThrow(/No rows for variant "other"/);
    const diagnostics = analyzeResultSet(resultSet([
      ...mixed,
      row({ taskId: "owner__repo-2", failureClass: "invalid_result", traceEvents: [] }),
      row({ taskId: "owner__repo-3", traceEvents: [] })
    ]), { variant: "baseline" });
    expect(diagnostics).toMatchObject({ variant: "baseline", runs: 1, excludedRows: { invalid_result: 1, no_model_turns: 1 } });
    const t1 = { ...row(), schemaVersion: 1, variant: undefined } as unknown as EvaluationRunResult;
    expect(analyzeResultSet(resultSet([t1], 1))).toMatchObject({ benchmark: "t1", variant: null, runs: 1 });
    const markdown = analysisMarkdown(diagnostics);
    expect(markdown).toContain(`> ${DISCLAIMER}`);
    expect(markdown).toContain("DIAGNOSTIC of one configuration, not a comparative claim");
  });

  it("loads a result directory and writes the Markdown and JSON reports", async () => {
    const dir = await makeTempDir("onehand-analyze-");
    dirs.push(dir);
    await mkdir(path.join(dir, "results"));
    await writeFile(path.join(dir, "results", "manifest.json"), JSON.stringify({ schemaVersion: 2, benchmark: "swebench" }));
    await writeFile(path.join(dir, "results", "results.jsonl"), JSON.stringify(row()) + "\n");
    const { markdownPath, jsonPath } = await runAnalysis({ results: path.join(dir, "results"), output: path.join(dir, "diag") });
    expect(JSON.parse(await readFile(jsonPath, "utf8"))).toMatchObject({ kind: "trace_diagnostics", runs: 1, perRun: [{ redundantReads: 1 }] });
    const markdown = await readFile(markdownPath, "utf8");
    expect(markdown).toContain("| 1 | initial_prompt | 64.1% |");
    expect(markdown).toContain("- 1 of 2 read_file calls (50.0%) re-read a path already read successfully");
  });
});

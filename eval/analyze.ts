#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import {
  GOVERNANCE_TOOLS,
  invalidMeasurement,
  isMainModule,
  isToolFailure,
  loadResultSet,
  ParsedTrace,
  parseTrace,
  ResultRow,
  ResultSet,
  writeReportFiles
} from "./results-io.js";
import { mean, percentile, sum } from "./stats.js";

export const DISCLAIMER = "This is a DIAGNOSTIC of one configuration, not a comparative claim: it shows where tokens and time go in these runs, not that any change would help. Use eval:compare on paired A/B runs for that.";
const INITIAL = "initial_prompt";
const ASSISTANT = "assistant_output";
const OTHER = "other";
const WRITE_TOOLS = new Set(["write_file", "replace_text"]);
const TOP = 5;
const TOP_ERRORS = 10;
const ERROR_CHARS = 160;

// Tokens a source added to the prompt (added), and those tokens counted once per round that re-sent them (weighted).
export type SourceTotals = { added: number; weighted: number; observations: number };

export type RunDiagnostics = {
  taskId: string;
  repetition: number;
  variant?: string;
  rounds: number;
  // P_k: the prompt tokens of each round.
  prompts: number[];
  peakContext: number;
  // Σ P_k, which the weighted source totals add up to exactly.
  cumulativeInput: number;
  sources: Record<string, SourceTotals>;
  toolCalls: number;
  governance: { calls: number; byTool: Record<string, number>; rounds: number };
  reads: { total: number; redundant: number };
  failures: {
    failed: number;
    testFailures: number;
    byCategory: Record<string, number>;
    byTool: Record<string, { calls: number; failed: number }>;
    errors: string[];
  };
  time: { totalMs: number; modelMs: number; toolMs: number; overheadMs: number; clamped: boolean };
  toolDurations: Record<string, number[]>;
  stopReason: string;
  nudges: number;
  textOnlyTurns: number;
  outputLimitTurns: number;
  environmentFailures: number;
};

export type Diagnostics = ReturnType<typeof analyzeResultSet>;

export async function runAnalysis(options: { results: string; variant?: string; output: string }) {
  const diagnostics = analyzeResultSet(await loadResultSet(options.results), { variant: options.variant });
  const files = await writeReportFiles(options.output, analysisMarkdown(diagnostics), diagnostics);
  return { diagnostics, ...files };
}

export function diagnoseRun(row: ResultRow): RunDiagnostics {
  const trace = parseTrace(row.traceEvents);
  const prompts = trace.turns.map((turn) => turn.inputTokens);
  const modelMs = sum(trace.turns.map((turn) => turn.latencyMs));
  const toolMs = sum(trace.tools.map((tool) => tool.durationMs));
  const totalMs = typeof row.durationMs === "number" && Number.isFinite(row.durationMs) ? row.durationMs : 0;
  const overheadMs = totalMs - modelMs - toolMs;
  const toolDurations: Record<string, number[]> = {};
  for (const tool of trace.tools) (toolDurations[tool.name] ??= []).push(tool.durationMs);
  return {
    taskId: row.taskId,
    repetition: row.repetition,
    variant: row.schemaVersion === 2 ? row.variant : undefined,
    rounds: trace.turns.length,
    prompts,
    peakContext: prompts.length ? Math.max(...prompts) : 0,
    cumulativeInput: sum(prompts),
    sources: attributeContextGrowth(trace),
    toolCalls: trace.tools.length,
    governance: governanceOverhead(trace),
    reads: redundantReads(trace),
    failures: toolFailures(trace),
    time: { totalMs, modelMs, toolMs, overheadMs: Math.max(0, overheadMs), clamped: overheadMs < 0 },
    toolDurations,
    stopReason: row.stopReason ?? trace.stopReason ?? "unknown",
    nudges: trace.nudges,
    textOnlyTurns: trace.textOnlyTurns,
    outputLimitTurns: trace.turns.filter((turn) => turn.finishReason === "length").length,
    environmentFailures: trace.environmentFailures
  };
}

// D_k = P_k − P_{k−1} goes first to round k−1's output (reasoning included, as it is sent back), up to
// O_{k−1}; the rest to round k−1's tool observations by observationBytes; what neither explains, including
// nudges and any shrinkage, to "other". A token added at round j is re-sent in rounds j..R, so it weighs
// R − j + 1, and P_1 weighs R: the weighted totals then sum exactly to Σ P_k.
function attributeContextGrowth(trace: ParsedTrace): Record<string, SourceTotals> {
  const sources: Record<string, SourceTotals> = {};
  const entry = (source: string) => (sources[source] ??= { added: 0, weighted: 0, observations: 0 });
  const add = (source: string, tokens: number, weight: number) => {
    entry(source).added += tokens;
    entry(source).weighted += tokens * weight;
  };
  const turns = trace.turns;
  const rounds = turns.length;
  if (!rounds) return sources;
  add(INITIAL, turns[0]!.inputTokens, rounds);
  for (let index = 1; index < rounds; index += 1) {
    const previous = turns[index - 1]!;
    const weight = rounds - index;
    const observations = trace.tools.filter((tool) => tool.round === previous.round);
    for (const tool of observations) entry(`tool:${tool.name}`).observations += 1;
    const delta = turns[index]!.inputTokens - previous.inputTokens;
    if (delta <= 0) {
      if (delta < 0) add(OTHER, delta, weight);
      continue;
    }
    const assistant = Math.min(delta, previous.outputTokens);
    if (assistant > 0) add(ASSISTANT, assistant, weight);
    const rest = delta - Math.max(0, assistant);
    if (rest <= 0) continue;
    if (!observations.length) {
      add(OTHER, rest, weight);
      continue;
    }
    const shares = new Map<string, number>();
    const totalBytes = sum(observations.map((tool) => tool.observationBytes));
    // Without byte counts, each observation counts equally.
    for (const tool of observations) shares.set(tool.name, (shares.get(tool.name) ?? 0) + (totalBytes > 0 ? tool.observationBytes : 1));
    const denominator = totalBytes > 0 ? totalBytes : observations.length;
    for (const [name, share] of shares) add(`tool:${name}`, rest * share / denominator, weight);
  }
  return sources;
}

function governanceOverhead(trace: ParsedTrace): RunDiagnostics["governance"] {
  const byTool: Record<string, number> = {};
  for (const tool of trace.tools) if (GOVERNANCE_TOOLS.has(tool.name)) byTool[tool.name] = (byTool[tool.name] ?? 0) + 1;
  return {
    calls: sum(Object.values(byTool)),
    byTool,
    rounds: trace.turns.filter((turn) =>
      turn.toolCallNames.length > 0 && turn.toolCallNames.every((name) => GOVERNANCE_TOOLS.has(name))).length
  };
}

// A read_file of a path already read successfully, with no successful write_file/replace_text to it since.
function redundantReads(trace: ParsedTrace): RunDiagnostics["reads"] {
  const seen = new Set<string>();
  let total = 0;
  let redundant = 0;
  for (const tool of trace.tools) {
    const file = tool.path === undefined ? undefined : normalizePath(tool.path, trace.displayRoot);
    if (tool.name === "read_file") {
      total += 1;
      if (file === undefined) continue;
      if (seen.has(file)) redundant += 1;
      if (tool.ok) seen.add(file);
    } else if (WRITE_TOOLS.has(tool.name) && tool.ok && file !== undefined) {
      seen.delete(file);
    }
  }
  return { total, redundant };
}

function normalizePath(file: string, displayRoot?: string): string {
  const normalized = path.posix.normalize(file.replace(/\\/g, "/"));
  const root = displayRoot ? path.posix.normalize(displayRoot).replace(/\/+$/, "") + "/" : undefined;
  return (root && normalized.startsWith(root) ? normalized.slice(root.length) : normalized).replace(/^\.\//, "");
}

function toolFailures(trace: ParsedTrace): RunDiagnostics["failures"] {
  const failures: RunDiagnostics["failures"] = { failed: 0, testFailures: 0, byCategory: {}, byTool: {}, errors: [] };
  for (const tool of trace.tools) {
    const perTool = (failures.byTool[tool.name] ??= { calls: 0, failed: 0 });
    perTool.calls += 1;
    if (tool.passed === false) failures.testFailures += 1;
    if (!isToolFailure(tool)) continue;
    perTool.failed += 1;
    failures.failed += 1;
    const category = tool.errorCategory ?? "uncategorized";
    failures.byCategory[category] = (failures.byCategory[category] ?? 0) + 1;
    if (tool.error) failures.errors.push(truncate(tool.error.replace(/\s+/g, " ").trim(), ERROR_CHARS));
  }
  return failures;
}

export function analyzeResultSet(set: ResultSet, options: { variant?: string } = {}) {
  const variants = [...new Set(set.rows.map(variantOf).filter((value): value is string => value !== undefined))].sort();
  let rows = set.rows;
  if (options.variant !== undefined) {
    rows = rows.filter((row) => variantOf(row) === options.variant);
    if (!rows.length) throw new Error(`No rows for variant "${options.variant}" in ${set.dir}`);
  } else if (variants.length > 1) {
    throw new Error(`${set.dir} holds several variants (${variants.join(", ")}); pass --variant to diagnose one configuration`);
  }
  const excludedRows: Record<string, number> = {};
  const runs: RunDiagnostics[] = [];
  let reportedInputTokens = 0;
  for (const row of rows) {
    const run = diagnoseRun(row);
    const reason = invalidMeasurement(row) ?? (run.rounds ? undefined : "no_model_turns");
    if (reason) {
      excludedRows[reason] = (excludedRows[reason] ?? 0) + 1;
      continue;
    }
    runs.push(run);
    reportedInputTokens += typeof row.inputTokens === "number" && Number.isFinite(row.inputTokens) ? row.inputTokens : 0;
  }
  if (!runs.length) throw new Error(`No analyzable runs in ${set.dir}`);

  const cumulativeInputTokens = sum(runs.map((run) => run.cumulativeInput));
  const sourceTotals = new Map<string, SourceTotals>();
  for (const run of runs) {
    for (const [source, totals] of Object.entries(run.sources)) {
      const entry = sourceTotals.get(source) ?? { added: 0, weighted: 0, observations: 0 };
      entry.added += totals.added;
      entry.weighted += totals.weighted;
      entry.observations += totals.observations;
      sourceTotals.set(source, entry);
    }
  }
  const sources = [...sourceTotals].map(([source, totals]) => ({
    source,
    addedTokens: totals.added,
    weightedTokens: totals.weighted,
    share: cumulativeInputTokens > 0 ? totals.weighted / cumulativeInputTokens : 0,
    observations: totals.observations,
    tokensPerObservation: source.startsWith("tool:") && totals.observations ? totals.added / totals.observations : null
  })).sort((a, b) => b.weightedTokens - a.weightedTokens);

  const toolCalls = sum(runs.map((run) => run.toolCalls));
  const rounds = sum(runs.map((run) => run.rounds));
  const governanceCalls = sum(runs.map((run) => run.governance.calls));
  const governanceRounds = sum(runs.map((run) => run.governance.rounds));
  const readCalls = sum(runs.map((run) => run.reads.total));
  const redundant = sum(runs.map((run) => run.reads.redundant));
  const failed = sum(runs.map((run) => run.failures.failed));

  const perTool = new Map<string, { calls: number; failed: number; durations: number[] }>();
  for (const run of runs) {
    for (const [tool, value] of Object.entries(run.failures.byTool)) {
      const entry = perTool.get(tool) ?? { calls: 0, failed: 0, durations: [] };
      entry.calls += value.calls;
      entry.failed += value.failed;
      entry.durations.push(...(run.toolDurations[tool] ?? []));
      perTool.set(tool, entry);
    }
  }
  const toolLatency = [...perTool].map(([tool, value]) => {
    const sorted = [...value.durations].sort((a, b) => a - b);
    return { tool, calls: value.calls, totalMs: sum(sorted), p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95) };
  }).sort((a, b) => b.totalMs - a.totalMs);

  const modelMs = sum(runs.map((run) => run.time.modelMs));
  const toolMs = sum(runs.map((run) => run.time.toolMs));
  const overheadMs = sum(runs.map((run) => run.time.overheadMs));
  const consumers = [
    { consumer: "model", ms: modelMs },
    ...toolLatency.map((tool) => ({ consumer: `tool:${tool.tool}`, ms: tool.totalMs })),
    { consumer: "runtime_overhead", ms: overheadMs }
  ].sort((a, b) => b.ms - a.ms);
  const consumerTotal = sum(consumers.map((item) => item.ms));
  const maxRounds = Math.max(...runs.map((run) => run.prompts.length));
  const peaks = runs.map((run) => run.peakContext).sort((a, b) => a - b);

  return {
    schemaVersion: 1 as const,
    kind: "trace_diagnostics" as const,
    disclaimer: DISCLAIMER,
    generatedAt: new Date().toISOString(),
    resultsDir: set.dir,
    benchmark: set.manifest.schemaVersion === 2 ? set.manifest.benchmark : "t1",
    model: [...new Set(rows.map((row) => row.model))].sort().join(", "),
    variant: options.variant ?? variants[0] ?? null,
    runs: runs.length,
    excludedRows,
    contextGrowth: {
      cumulativeInputTokens,
      // Σ inputTokens over the analyzed rows; a gap from the trace total means rounds are missing from traces.
      reportedInputTokens,
      sources
    },
    governance: {
      toolCalls,
      governanceCalls,
      share: ratio(governanceCalls, toolCalls),
      byTool: mergeCounts(runs.map((run) => run.governance.byTool)),
      rounds,
      governanceOnlyRounds: governanceRounds,
      roundShare: ratio(governanceRounds, rounds)
    },
    redundantReads: { readCalls, redundant, share: ratio(redundant, readCalls) },
    failures: {
      toolCalls,
      failed,
      rate: ratio(failed, toolCalls),
      testFailures: sum(runs.map((run) => run.failures.testFailures)),
      byCategory: mergeCounts(runs.map((run) => run.failures.byCategory)),
      byTool: [...perTool].map(([tool, value]) => ({ tool, calls: value.calls, failed: value.failed, rate: ratio(value.failed, value.calls) }))
        .sort((a, b) => b.failed - a.failed || b.calls - a.calls),
      topErrors: Object.entries(mergeCounts(runs.map((run) => countStrings(run.failures.errors))))
        .map(([error, count]) => ({ error, count }))
        .sort((a, b) => b.count - a.count || a.error.localeCompare(b.error))
        .slice(0, TOP_ERRORS)
    },
    time: {
      totalMs: sum(runs.map((run) => run.time.totalMs)),
      modelMs,
      toolMs,
      overheadMs,
      clampedRuns: runs.filter((run) => run.time.clamped).length,
      toolLatency
    },
    outcomes: {
      stopReasons: countStrings(runs.map((run) => run.stopReason)),
      nudges: sum(runs.map((run) => run.nudges)),
      runsWithNudges: runs.filter((run) => run.nudges > 0).length,
      textOnlyTurns: sum(runs.map((run) => run.textOnlyTurns)),
      outputLimitTurns: sum(runs.map((run) => run.outputLimitTurns)),
      outputLimitStops: runs.filter((run) => run.stopReason === "output_limit").length,
      environmentFailures: sum(runs.map((run) => run.environmentFailures)),
      promptCurve: Array.from({ length: maxRounds }, (_, index) => {
        const values = runs.filter((run) => run.prompts.length > index).map((run) => run.prompts[index]!).sort((a, b) => a - b);
        return { round: index + 1, runs: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
      }),
      peakContext: { max: peaks.at(-1) ?? 0, p50: percentile(peaks, 0.5), p95: percentile(peaks, 0.95), mean: mean(peaks) }
    },
    bottlenecks: {
      inputTokens: sources.slice(0, TOP).map(({ source, weightedTokens, share }) => ({ source, weightedTokens, share })),
      time: consumers.slice(0, TOP).map((item) => ({ ...item, share: ratio(item.ms, consumerTotal) }))
    },
    perRun: runs.map((run) => ({
      taskId: run.taskId,
      repetition: run.repetition,
      rounds: run.rounds,
      cumulativeInput: run.cumulativeInput,
      peakContext: run.peakContext,
      inputShares: Object.fromEntries(Object.entries(run.sources)
        .map(([source, totals]) => [source, ratio(totals.weighted, run.cumulativeInput)])),
      governanceCalls: run.governance.calls,
      governanceOnlyRounds: run.governance.rounds,
      readCalls: run.reads.total,
      redundantReads: run.reads.redundant,
      failedToolCalls: run.failures.failed,
      modelMs: run.time.modelMs,
      toolMs: run.time.toolMs,
      overheadMs: run.time.overheadMs,
      stopReason: run.stopReason,
      nudges: run.nudges
    }))
  };
}

export function analysisMarkdown(diagnostics: Diagnostics): string {
  const { contextGrowth, governance, redundantReads: reads, failures, time, outcomes, bottlenecks } = diagnostics;
  const excluded = Object.entries(diagnostics.excludedRows).map(([reason, count]) => `${count} ${reason}`).join(", ") || "none";
  const timeTotal = time.modelMs + time.toolMs + time.overheadMs;
  const tokenGap = contextGrowth.reportedInputTokens - contextGrowth.cumulativeInputTokens;
  return [
    `# Trace diagnostics: ${diagnostics.variant === null ? "" : `\`${diagnostics.variant}\` on `}${diagnostics.benchmark}`,
    "",
    `> ${DISCLAIMER}`,
    "",
    `- Results: \`${diagnostics.resultsDir}\`; model \`${diagnostics.model}\``,
    `- Runs analyzed: ${diagnostics.runs}; rows excluded: ${excluded}`,
    "",
    "## Bottleneck ranking",
    "",
    "| rank | source of cumulative input tokens | share |",
    "|---:|---|---:|",
    ...bottlenecks.inputTokens.map((item, index) => `| ${index + 1} | ${item.source} | ${pct(item.share)} |`),
    "",
    "| rank | time consumer | time | share |",
    "|---:|---|---:|---:|",
    ...bottlenecks.time.map((item, index) => `| ${index + 1} | ${item.consumer} | ${seconds(item.ms)} | ${pct(item.share)} |`),
    "",
    "## Context growth",
    "",
    "Each round re-sends the whole prompt, so a token added at round j of R counts R − j + 1 times toward cumulative input.",
    "",
    "| source | tokens added | cumulative input tokens | share | observations | tokens per observation |",
    "|---|---:|---:|---:|---:|---:|",
    ...contextGrowth.sources.map((item) =>
      `| ${item.source} | ${tokens(item.addedTokens)} | ${tokens(item.weightedTokens)} | ${pct(item.share)} | ${item.source.startsWith("tool:") ? item.observations : "-"} | ${item.tokensPerObservation === null ? "-" : tokens(item.tokensPerObservation)} |`),
    "",
    `Cumulative input over the traced rounds: ${tokens(contextGrowth.cumulativeInputTokens)} tokens; the rows report ${tokens(contextGrowth.reportedInputTokens)}${tokenGap ? ` (a gap of ${tokens(tokenGap)}: some rounds are missing from the traces)` : ""}.`,
    "",
    "- Round k's growth goes first to round k−1's output tokens (reasoning included), then to round k−1's tool observations in proportion to their bytes; what neither explains, including nudges, goes to other, which is negative when a prompt shrank.",
    "- Tokens per observation divide a tool's added tokens by its observations that a later round re-sent; the last round's observations are never re-sent.",
    "",
    "## Prompt size by round",
    "",
    "| round | runs | P50 prompt tokens | P95 prompt tokens |",
    "|---:|---:|---:|---:|",
    ...outcomes.promptCurve.map((item) => `| ${item.round} | ${item.runs} | ${tokens(item.p50)} | ${tokens(item.p95)} |`),
    "",
    `Peak context per run: max ${tokens(outcomes.peakContext.max)}, P50 ${tokens(outcomes.peakContext.p50)}, P95 ${tokens(outcomes.peakContext.p95)}, mean ${tokens(outcomes.peakContext.mean)} tokens.`,
    "",
    "## Governance overhead",
    "",
    `- Governance tool calls (set_plan, update_plan, finish_task): ${governance.governanceCalls} of ${governance.toolCalls} tool calls (${pct(governance.share)}); ${Object.entries(governance.byTool).map(([tool, count]) => `${tool} ${count}`).join(", ") || "none"}.`,
    `- Rounds whose tool calls are all governance tools: ${governance.governanceOnlyRounds} of ${governance.rounds} rounds (${pct(governance.roundShare)}).`,
    "",
    "## Redundant reads",
    "",
    `- ${reads.redundant} of ${reads.readCalls} read_file calls (${pct(reads.share)}) re-read a path already read successfully, with no successful write_file or replace_text to it in between.`,
    "",
    "## Tool failures",
    "",
    `A failure is a call that was rejected, errored, or timed out: ${failures.failed} of ${failures.toolCalls} tool calls (${pct(failures.rate)}). Failing test runs are observations, not failures: ${failures.testFailures}.`,
    "",
    "| tool | calls | failures | failure rate |",
    "|---|---:|---:|---:|",
    ...failures.byTool.map((item) => `| ${item.tool} | ${item.calls} | ${item.failed} | ${pct(item.rate)} |`),
    "",
    "| error category | failures |",
    "|---|---:|",
    ...Object.entries(failures.byCategory).sort((a, b) => b[1] - a[1]).map(([category, count]) => `| ${category} | ${count} |`),
    "",
    "| failures | error (truncated) |",
    "|---:|---|",
    ...failures.topErrors.map((item) => `| ${item.count} | ${item.error.replace(/\|/g, "\\|")} |`),
    "",
    "## Time",
    "",
    "| component | time | share |",
    "|---|---:|---:|",
    `| model (Σ model_turn.latencyMs) | ${seconds(time.modelMs)} | ${pct(ratio(time.modelMs, timeTotal))} |`,
    `| tools (Σ tool_result.durationMs) | ${seconds(time.toolMs)} | ${pct(ratio(time.toolMs, timeTotal))} |`,
    `| runtime overhead (run duration − model − tools, at least 0) | ${seconds(time.overheadMs)} | ${pct(ratio(time.overheadMs, timeTotal))} |`,
    "",
    `Run durations total ${seconds(time.totalMs)}; ${time.clampedRuns} run(s) had model plus tool time above their duration, so their overhead was clamped to 0.`,
    "",
    "| tool | calls | total | P50 | P95 |",
    "|---|---:|---:|---:|---:|",
    ...time.toolLatency.map((item) => `| ${item.tool} | ${item.calls} | ${seconds(item.totalMs)} | ${seconds(item.p50Ms)} | ${seconds(item.p95Ms)} |`),
    "",
    "## Outcomes",
    "",
    "| stop reason | runs |",
    "|---|---:|",
    ...Object.entries(outcomes.stopReasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => `| ${reason} | ${count} |`),
    "",
    `- Text-only turns: ${outcomes.textOnlyTurns}; nudges sent: ${outcomes.nudges}, in ${outcomes.runsWithNudges} run(s).`,
    `- Turns that hit the output limit (finishReason length): ${outcomes.outputLimitTurns}; runs stopped by output_limit: ${outcomes.outputLimitStops}.`,
    `- environment_failure events: ${outcomes.environmentFailures}.`,
    "",
    "P50 and P95 are nearest-rank percentiles."
  ].join("\n") + "\n";
}

function variantOf(row: ResultRow): string | undefined {
  return row.schemaVersion === 2 ? row.variant : undefined;
}

function mergeCounts(records: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const record of records) for (const [key, count] of Object.entries(record)) merged[key] = (merged[key] ?? 0) + count;
  return merged;
}

function countStrings(values: string[]): Record<string, number> {
  return mergeCounts(values.map((value) => ({ [value]: 1 })));
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function tokens(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

if (isMainModule(import.meta.url)) {
  const program = new Command();
  program
    .name("onehand-analyze")
    .description("Bottleneck diagnostics from the traces of one result set")
    .requiredOption("--results <dir>", "evaluation result directory")
    .option("--variant <variant>", "the variant to diagnose, required when the results hold several")
    .requiredOption("--output <path>", "output path without extension; writes <path>.md and <path>.json")
    .action(async (options) => {
      const { diagnostics, markdownPath } = await runAnalysis(options);
      process.stdout.write(`[analyze] report=${markdownPath} runs=${diagnostics.runs}\n`);
    });
  program.parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

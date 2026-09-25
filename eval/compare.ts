#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { fingerprintOf } from "../src/agent/fingerprint.js";
import {
  assessCompleteness,
  capReachedFrom,
  Completeness,
  exclusionReason,
  GOVERNANCE_TOOLS,
  isMainModule,
  isToolFailure,
  loadResultSet,
  parseTrace,
  ResultSet,
  RunLedger,
  writeReportFiles
} from "./results-io.js";
import { bootstrapPValue, bootstrapReplicates, holmAdjust, mean, median, percentileCi, sum } from "./stats.js";
import type { SwebenchManifest, SwebenchRunResult } from "./types.js";

// Proportions, compared as the paired difference B − A.
export const RATE_METRICS = ["resolved", "falseSuccess", "emptyPatch", "cacheHitRate", "toolFailureRate", "governanceShare"] as const;
// Magnitudes, compared as the geometric-mean change exp(mean ln(B/A)) − 1.
export const EFFICIENCY_METRICS = [
  "modelRounds", "toolCalls", "inputTokens", "outputTokens", "reasoningTokens", "estimatedCostUsd", "durationMs",
  "modelLatencyMs", "toolTimeMs"
] as const;
export type MetricName = typeof RATE_METRICS[number] | typeof EFFICIENCY_METRICS[number];
export const DEFAULT_PRIMARY: MetricName[] = ["estimatedCostUsd", "modelRounds"];
const METRICS: MetricName[] = [...RATE_METRICS, ...EFFICIENCY_METRICS];
// Constant among resolved runs, so the resolved-in-both slice leaves them out.
const OUTCOME_METRICS = new Set<MetricName>(["resolved", "falseSuccess", "emptyPatch"]);
const ALPHA = 0.05;
// A difference this small is float noise, never an effect.
const NOISE = 1e-9;
const FEW_TASKS = 20;
// What every result directory a comparison reads must share, or the runs were not measured (or scored, for
// infraPolicy) under the same conditions and no difference is attributable to the variants. The image IDs are
// compared per instance.
const IDENTITY_KEYS = [
  "dataFileSha256", "datasetRevision", "imageSource", "allowTargetedVerification", "executor", "displayRoot", "limits",
  "containerLimits", "model", "provider", "thinking", "reasoningEffort", "swebenchVersion", "baseURL", "infraPolicy"
] as const;
// Configuration that may legitimately differ, but is still worth a warning.
const CONFIG_KEYS = ["temperature", "priceSnapshot"] as const;

export type CompareOptions = {
  a: string;
  b: string;
  primary?: MetricName[];
  margin?: number;
  bootstrap?: number;
  seed?: number;
};

export type MetricResult = {
  metric: MetricName;
  kind: "rate" | "efficiency";
  // Tasks in the estimate: a value in both arms and, for efficiency, not 0 in both.
  tasks: number;
  skippedBothZero: number;
  // Mean and median of per-task means over the tasks with a value in both arms.
  a: { mean: number; median: number };
  b: { mean: number; median: number };
  // rate: mean over tasks of B − A; efficiency: exp(mean over tasks of ln(B/A)) − 1.
  estimate: number | null;
  ci95: [number, number] | null;
  // Two-sided paired-bootstrap p-value, unadjusted.
  p: number | null;
  ciExcludesZero: boolean;
  primary: boolean;
  // Primary metrics only: Holm-adjusted p, and whether it is ≤ α with a CI that excludes 0.
  pHolm: number | null;
  significant: boolean | null;
};

export type Slice = { definition: string; tasks: number; metrics: MetricResult[] };

// The evaluation summary's definition (results-io assessCompleteness), applied to one arm's rows and plans.
export type ArmCompleteness = { variant: string } & Completeness;

export type ClaimTable = {
  runs: number;
  claimedResolved: number;
  claimedUnresolved: number;
  unclaimedResolved: number;
  unclaimedUnresolved: number;
};

type CostArm = { totalCostUsd: number; resolvedTasks: number; costPerResolvedUsd: number | null };

export type Comparison = {
  schemaVersion: 1;
  kind: "paired_comparison";
  generatedAt: string;
  benchmark: string;
  model: string;
  splits: string[];
  a: string;
  b: string;
  resultsDirs: string[];
  settings: { bootstrap: number; seed: number; margin: number; alpha: number; primary: MetricName[] };
  pairing: { pairedTasks: number; onlyInA: string[]; onlyInB: string[] };
  completeness: { complete: boolean; a: ArmCompleteness; b: ArmCompleteness };
  responseModels: { a: string[]; b: string[] };
  warnings: string[];
  interpretation: string[];
  slices: { all: Slice; resolvedBoth: Slice };
  nonInferiority: { metric: "resolved"; margin: number; difference: number | null; ci95: [number, number] | null; nonInferior: boolean };
  costPerResolved: {
    definition: string;
    a: CostArm;
    b: CostArm;
    ratio: number | null;
    ci95: [number, number] | null;
    undefinedReplicates: number;
  };
  // Σ retryCostUsd over each arm's rows: attempts a provider outage ended and the job re-ran. Spent, but left out of
  // every cost metric, which counts each run's final attempt (estimatedCostUsd).
  retryCostUsd: { a: number; b: number };
  claims: { a: ClaimTable; b: ClaimTable };
  perTask: Array<{ taskId: string; a: Record<string, number | null>; b: Record<string, number | null> }>;
};

type Settings = Comparison["settings"];
type SwebenchSet = { dir: string; manifest: SwebenchManifest; rows: SwebenchRunResult[] } & Partial<RunLedger>;
type ArmRow = { row: SwebenchRunResult; set: SwebenchSet };
type Run = { row: SwebenchRunResult; values: Record<MetricName, number | undefined> };
type TaskPair = readonly [Run[], Run[]];

export async function runComparison(options: CompareOptions & { results: string[]; output: string }) {
  if (!options.results.length) throw new Error("Pass at least one --results <dir>");
  const dirs = [...new Set(options.results.map((dir) => path.resolve(dir)))];
  const comparison = compareResultSets(await Promise.all(dirs.map(loadResultSet)), options);
  const files = await writeReportFiles(options.output, comparisonMarkdown(comparison), comparison);
  return { comparison, ...files };
}

export function compareResultSets(sets: ResultSet[], options: CompareOptions): Comparison {
  const settings = resolveSettings(options);
  const swebench = sets.map(requireSwebench);
  const arms = { a: armRows(swebench, options.a), b: armRows(swebench, options.b) };
  const armed = [...arms.a, ...arms.b].map(({ row }) => row);
  const benchmarks = distinct(armed.map((row) => row.benchmark));
  if (benchmarks.length > 1) throw new Error(`Cannot compare rows from different benchmarks: ${benchmarks.join(", ")}`);
  const models = distinct(armed.map((row) => row.model));
  if (models.length > 1) throw new Error(`Cannot compare rows with different models: ${models.join(", ")}`);
  const sourceWarnings = assertSameConditions(arms, options);

  const tasksA = groupRuns(arms.a.map(({ row }) => row).filter((row) => !exclusionReason(row)));
  const tasksB = groupRuns(arms.b.map(({ row }) => row).filter((row) => !exclusionReason(row)));
  const paired = [...tasksA.keys()].filter((id) => tasksB.has(id)).sort();
  if (!paired.length) throw new Error(`No task has a valid run in both ${options.a} and ${options.b}`);
  const pairs: TaskPair[] = paired.map((id) => [tasksA.get(id)!, tasksB.get(id)!]);
  const resolvedPairs: TaskPair[] = pairs
    .map(([a, b]) => [a.filter((run) => run.row.resolved), b.filter((run) => run.row.resolved)] as const)
    .filter(([a, b]) => a.length > 0 && b.length > 0);

  const all = slice("Every paired task; each metric averages that arm's valid runs of the task.", pairs, METRICS, settings);
  const resolvedBoth = slice(
    "Tasks with at least one resolved run in each arm; each efficiency metric averages the resolved runs only.",
    resolvedPairs,
    METRICS.filter((metric) => !OUTCOME_METRICS.has(metric)),
    settings
  );
  const primary = settings.primary.map((metric) => all.metrics.find((result) => result.metric === metric)!);
  holmAdjust(primary.map((result) => result.p ?? 1)).forEach((pHolm, index) => {
    const result = primary[index]!;
    result.primary = true;
    result.pHolm = pHolm;
    result.significant = pHolm <= settings.alpha && result.ciExcludesZero;
  });
  const resolved = all.metrics.find((result) => result.metric === "resolved")!;

  const completeness = { a: armCompleteness(arms.a, swebench, options.a), b: armCompleteness(arms.b, swebench, options.b) };
  const responseModels = { a: responseModelsOf(arms.a), b: responseModelsOf(arms.b) };
  const comparison: Comparison = {
    schemaVersion: 1,
    kind: "paired_comparison",
    generatedAt: new Date().toISOString(),
    benchmark: benchmarks[0]!,
    model: models[0]!,
    splits: distinct(armed.map((row) => row.split)),
    a: options.a,
    b: options.b,
    resultsDirs: swebench.map((set) => set.dir),
    settings,
    pairing: {
      pairedTasks: paired.length,
      onlyInA: [...tasksA.keys()].filter((id) => !tasksB.has(id)).sort(),
      onlyInB: [...tasksB.keys()].filter((id) => !tasksA.has(id)).sort()
    },
    completeness: { complete: completeness.a.complete && completeness.b.complete, ...completeness },
    responseModels,
    warnings: [
      ...completenessWarnings(completeness),
      ...responseModelWarnings(responseModels, options),
      ...sourceWarnings,
      ...configWarnings(distinctSets([...arms.a, ...arms.b]))
    ],
    interpretation: [],
    slices: { all, resolvedBoth },
    nonInferiority: {
      metric: "resolved",
      margin: settings.margin,
      difference: resolved.estimate,
      ci95: resolved.ci95,
      nonInferior: resolved.ci95 !== null && isNonInferior(resolved.ci95[0], settings.margin)
    },
    costPerResolved: costPerResolved(pairs, settings),
    retryCostUsd: { a: sum(arms.a.map(({ row }) => finite(row.retryCostUsd) ?? 0)), b: sum(arms.b.map(({ row }) => finite(row.retryCostUsd) ?? 0)) },
    claims: { a: claimTable(pairs.flatMap(([a]) => a)), b: claimTable(pairs.flatMap(([, b]) => b)) },
    perTask: paired.map((taskId, index) => ({
      taskId,
      a: taskValues(pairs[index]![0]),
      b: taskValues(pairs[index]![1])
    }))
  };
  comparison.interpretation = interpretationLines(comparison);
  return comparison;
}

// Strict, as specified; a lower bound within float noise of −margin does not pass.
export function isNonInferior(ciLower: number, margin: number): boolean {
  return ciLower > -margin + NOISE;
}

function resolveSettings(options: CompareOptions): Settings {
  if (!options.a || !options.b) throw new Error("Both variants --a and --b are required");
  if (options.a === options.b) throw new Error(`--a and --b must name different variants, got ${options.a} twice`);
  const primary = options.primary ?? DEFAULT_PRIMARY;
  const unknown = primary.filter((metric) => !METRICS.includes(metric));
  if (unknown.length) throw new Error(`Unknown metric: ${unknown.join(", ")}. Known metrics: ${METRICS.join(", ")}`);
  if (!primary.length || new Set(primary).size !== primary.length) {
    throw new Error(`Primary metrics must be a non-empty list without repeats, got ${primary.join(",")}`);
  }
  const margin = options.margin ?? 0.1;
  if (!Number.isFinite(margin) || margin < 0 || margin >= 1) throw new Error(`Margin must be in [0, 1), got ${margin}`);
  const bootstrap = options.bootstrap ?? 10_000;
  if (!Number.isInteger(bootstrap) || bootstrap <= 0) throw new Error(`Bootstrap resamples must be a positive integer, got ${bootstrap}`);
  const seed = options.seed ?? 20260925;
  if (!Number.isInteger(seed)) throw new Error(`Seed must be an integer, got ${seed}`);
  return { bootstrap, seed, margin, alpha: ALPHA, primary: [...primary] };
}

function requireSwebench(set: ResultSet): SwebenchSet {
  if (set.manifest.schemaVersion !== 2 || set.rows.some((row) => row.schemaVersion !== 2)) {
    throw new Error(`${set.dir}: paired comparison needs SWE-bench results (schemaVersion 2); T1 results (schemaVersion 1) carry no variant to select arms by`);
  }
  return set as SwebenchSet;
}

function armRows(sets: SwebenchSet[], variant: string): ArmRow[] {
  const rows = sets.flatMap((set) => set.rows.filter((row) => row.variant === variant).map((row) => ({ row, set })));
  if (!rows.length) throw new Error(`No rows for variant "${variant}" in ${sets.map((set) => set.dir).join(", ")}`);
  const keys = new Set<string>();
  for (const { row } of rows) {
    const key = `${row.taskId}#${row.repetition}`;
    if (keys.has(key)) throw new Error(`Duplicate run for variant "${variant}": ${key}`);
    keys.add(key);
  }
  return rows;
}

// Throws unless every result directory was measured under the same conditions, and unless the rows of each
// arm come from one agent version: the same agentFingerprint and sourceFingerprint wherever that variant ran.
// The arms themselves may come from evaluations of different source (a comparison across evaluations), which
// is only warned about.
function assertSameConditions(arms: { a: ArmRow[]; b: ArmRow[] }, options: CompareOptions): string[] {
  const setsOf = (rows: ArmRow[]) => [...new Set(rows.map(({ set }) => set))];
  const dirs = (sets: SwebenchSet[]) => sets.map((set) => set.dir).join(", ");
  const all = setsOf([...arms.a, ...arms.b]);
  for (const [variant, sets] of [[options.a, setsOf(arms.a)], [options.b, setsOf(arms.b)]] as const) {
    const agents = distinct(sets.map((set) => set.manifest.variants?.find((entry) => entry.name === variant)?.agentFingerprint ?? "(unrecorded)"));
    if (agents.length > 1) throw new Error(`Variant "${variant}" has different agentFingerprints in ${dirs(sets)}: ${agents.join(", ")}`);
    const sources = distinct(sets.map((set) => set.manifest.sourceFingerprint));
    if (sources.length > 1) throw new Error(`The rows of variant "${variant}" come from different sourceFingerprints in ${dirs(sets)}`);
  }
  const differing: string[] = IDENTITY_KEYS.filter((key) => distinct(all.map((set) => fingerprintOf({ value: set.manifest[key] }))).length > 1);
  if (imageIdsConflict(all)) differing.push("imageIds");
  if (differing.length) {
    throw new Error(`Cannot compare results measured under different conditions: ${differing.join(", ")} differ between ${dirs(all)}`);
  }
  return distinct(all.map((set) => set.manifest.sourceFingerprint)).length > 1
    ? ["WARNING: the arms come from evaluations with different sourceFingerprints, so the comparison also measures that code difference. That is legitimate only for a comparison across evaluations; the final comparison uses one evaluation."]
    : [];
}

// An instance whose image resolved to different IDs, or image IDs recorded in only some of the evaluations.
function imageIdsConflict(sets: SwebenchSet[]): boolean {
  const maps = sets.map((set) => set.manifest.imageIds);
  if (maps.every((map) => map === undefined)) return false;
  if (maps.some((map) => map === undefined)) return true;
  const seen = new Map<string, string>();
  for (const map of maps) {
    for (const [instanceId, imageId] of Object.entries(map!)) {
      if ((seen.get(instanceId) ?? imageId) !== imageId) return true;
      seen.set(instanceId, imageId);
    }
  }
  return false;
}

function groupRuns(rows: SwebenchRunResult[]): Map<string, Run[]> {
  const groups = new Map<string, Run[]>();
  for (const row of rows) {
    const runs = groups.get(row.taskId) ?? [];
    runs.push({ row, values: runValues(row) });
    groups.set(row.taskId, runs);
  }
  return groups;
}

function runValues(row: SwebenchRunResult): Record<MetricName, number | undefined> {
  const trace = parseTrace(row.traceEvents);
  const cacheHit = finite(row.cacheHitInputTokens) ?? 0;
  const cacheTotal = cacheHit + (finite(row.cacheMissInputTokens) ?? 0);
  const tools = trace.tools.length;
  return {
    resolved: row.resolved ? 1 : 0,
    falseSuccess: row.falseSuccess ? 1 : 0,
    emptyPatch: row.emptyPatch ? 1 : 0,
    cacheHitRate: cacheTotal > 0 ? cacheHit / cacheTotal : undefined,
    toolFailureRate: tools ? trace.tools.filter(isToolFailure).length / tools : undefined,
    governanceShare: tools ? trace.tools.filter((tool) => GOVERNANCE_TOOLS.has(tool.name)).length / tools : undefined,
    modelRounds: finite(row.modelRounds),
    toolCalls: finite(row.toolCalls),
    inputTokens: finite(row.inputTokens),
    outputTokens: finite(row.outputTokens),
    reasoningTokens: finite(row.reasoningTokens),
    estimatedCostUsd: finite(row.estimatedCostUsd),
    durationMs: finite(row.durationMs),
    modelLatencyMs: sum(trace.turns.map((turn) => turn.latencyMs)),
    toolTimeMs: sum(trace.tools.map((tool) => tool.durationMs))
  };
}

function taskMean(runs: Run[], metric: MetricName): number | undefined {
  const values = runs.map((run) => run.values[metric]).filter((value): value is number => value !== undefined);
  return values.length ? mean(values) : undefined;
}

function taskValues(runs: Run[]): Record<string, number | null> {
  return { runs: runs.length, ...Object.fromEntries(METRICS.map((metric) => [metric, taskMean(runs, metric) ?? null])) };
}

function slice(definition: string, pairs: TaskPair[], metrics: MetricName[], settings: Settings): Slice {
  return {
    definition,
    tasks: pairs.length,
    metrics: metrics.map((metric) =>
      metricResult(metric, pairs.map(([a, b]) => [taskMean(a, metric), taskMean(b, metric)]), settings))
  };
}

function metricResult(metric: MetricName, pairs: Array<[number | undefined, number | undefined]>, settings: Settings): MetricResult {
  const kind = (RATE_METRICS as readonly string[]).includes(metric) ? "rate" : "efficiency";
  const usable = pairs.filter((pair): pair is [number, number] => pair[0] !== undefined && pair[1] !== undefined);
  // ε is relative to the metric's own scale, so it is negligible for tokens and dollars alike.
  const epsilon = 1e-9 * (mean(usable.flatMap(([a, b]) => [Math.abs(a), Math.abs(b)])) || 1);
  const statistics = pairs.map(([a, b]) => {
    if (a === undefined || b === undefined) return undefined;
    if (kind === "rate") return b - a;
    return a === 0 && b === 0 ? undefined : Math.log((b + epsilon) / (a + epsilon));
  });
  const defined = statistics.filter((value): value is number => value !== undefined);
  const describe = (values: number[]) => ({ mean: mean(values), median: median(values) });
  const base = {
    metric,
    kind,
    tasks: defined.length,
    skippedBothZero: usable.length - defined.length,
    a: describe(usable.map(([a]) => a)),
    b: describe(usable.map(([, b]) => b)),
    primary: false,
    pHolm: null,
    significant: null
  } as const;
  if (!defined.length) return { ...base, estimate: null, ci95: null, p: null, ciExcludesZero: false };
  // Resamples every paired task, so all metrics share the same resamples; tasks without a value drop out.
  const replicates = bootstrapReplicates(pairs.length, settings.bootstrap, settings.seed, (indices) => {
    let total = 0;
    let count = 0;
    for (const index of indices) {
      const value = statistics[index];
      if (value !== undefined) {
        total += value;
        count += 1;
      }
    }
    return count ? total / count : NaN;
  });
  const [low, high] = percentileCi(replicates);
  const scale = (value: number) => kind === "rate" ? value : Math.exp(value) - 1;
  return {
    ...base,
    estimate: scale(mean(defined)),
    ci95: [scale(low), scale(high)],
    p: bootstrapPValue(replicates, NOISE),
    ciExcludesZero: low > NOISE || high < -NOISE
  };
}

function costPerResolved(pairs: TaskPair[], settings: Settings): Comparison["costPerResolved"] {
  const tasks = pairs.map(([a, b]) => ({
    costA: taskMean(a, "estimatedCostUsd") ?? 0,
    resolvedA: taskMean(a, "resolved") ?? 0,
    costB: taskMean(b, "estimatedCostUsd") ?? 0,
    resolvedB: taskMean(b, "resolved") ?? 0
  }));
  const ratio = (indices: Iterable<number>) => {
    let costA = 0;
    let resolvedA = 0;
    let costB = 0;
    let resolvedB = 0;
    for (const index of indices) {
      const task = tasks[index]!;
      costA += task.costA;
      resolvedA += task.resolvedA;
      costB += task.costB;
      resolvedB += task.resolvedB;
    }
    const value = (costB / resolvedB) / (costA / resolvedA);
    return resolvedA > 0 && resolvedB > 0 && Number.isFinite(value) ? value : NaN;
  };
  const arm = (cost: number, resolved: number): CostArm =>
    ({ totalCostUsd: cost, resolvedTasks: resolved, costPerResolvedUsd: resolved > 0 ? cost / resolved : null });
  const point = ratio(tasks.keys());
  const replicates = bootstrapReplicates(tasks.length, settings.bootstrap, settings.seed, ratio);
  const defined = replicates.filter((value) => Number.isFinite(value)).length;
  return {
    definition: "Sum over paired tasks of per-task mean cost, divided by the sum of per-task resolved rates; the ratio is B/A.",
    a: arm(sum(tasks.map((task) => task.costA)), sum(tasks.map((task) => task.resolvedA))),
    b: arm(sum(tasks.map((task) => task.costB)), sum(tasks.map((task) => task.resolvedB))),
    ratio: Number.isFinite(point) ? point : null,
    ci95: Number.isFinite(point) && defined ? percentileCi(replicates) : null,
    undefinedReplicates: replicates.length - defined
  };
}

function claimTable(runs: Run[]): ClaimTable {
  const rows = runs.map((run) => run.row);
  const cell = (claimed: boolean, resolved: boolean) =>
    rows.filter((row) => (row.agentStatus === "success") === claimed && row.resolved === resolved).length;
  return {
    runs: rows.length,
    claimedResolved: cell(true, true),
    claimedUnresolved: cell(true, false),
    unclaimedResolved: cell(false, true),
    unclaimedUnresolved: cell(false, false)
  };
}

// The arm's planned runs are each result directory's plan for the variant, keyed by directory; its cap is
// reached (or the provider circuit breaker open) when that stopped any evaluation that planned the variant or
// produced its rows.
function armCompleteness(arm: ArmRow[], sets: SwebenchSet[], variant: string): ArmCompleteness {
  const planned = new Set<string>();
  const involved = new Set(arm.map(({ set }) => set));
  sets.forEach((set, index) => {
    if (!(set.manifest.variants ?? []).some((entry) => entry.name === variant)) return;
    involved.add(set);
    for (const id of set.manifest.instanceIds ?? []) {
      for (let repetition = 1; repetition <= set.manifest.repetitions; repetition += 1) planned.add(`${index}:${id}#${repetition}`);
    }
  });
  const capReached = [...involved].some((set) => capReachedFrom(set.manifest, set.rows, set));
  const circuitOpen = [...involved].some((set) => set.circuitOpen === true);
  const keyed = arm.map(({ row, set }): [string, SwebenchRunResult] => [`${sets.indexOf(set)}:${row.taskId}#${row.repetition}`, row]);
  return { variant, ...assessCompleteness(planned, keyed, capReached, circuitOpen) };
}

function completenessWarnings(completeness: { a: ArmCompleteness; b: ArmCompleteness }): string[] {
  return (["a", "b"] as const).filter((arm) => !completeness[arm].complete).map((arm) =>
    `WARNING: ${arm.toUpperCase()} (${completeness[arm].variant}) is incomplete: ${completeness[arm].flags.join("; ")}.`);
}

function responseModelsOf(arm: ArmRow[]): string[] {
  const models = new Set<string>();
  for (const { row } of arm) {
    for (const model of Array.isArray(row.responseModels) ? row.responseModels : []) {
      if (typeof model === "string" && model) models.add(model);
    }
    for (const turn of parseTrace(row.traceEvents).turns) if (turn.responseModel) models.add(turn.responseModel);
  }
  return [...models].sort();
}

function responseModelWarnings(models: { a: string[]; b: string[] }, options: CompareOptions): string[] {
  const warnings: string[] = [];
  if (models.a.join("\0") !== models.b.join("\0")) {
    warnings.push(`WARNING: the arms report different response models: A = ${list(models.a)}; B = ${list(models.b)}.`);
  }
  for (const arm of ["a", "b"] as const) {
    const label = `${arm.toUpperCase()} (${options[arm]})`;
    if (models[arm].length > 1) warnings.push(`WARNING: ${label} reports more than one response model: ${list(models[arm])}.`);
    if (!models[arm].length) warnings.push(`WARNING: ${label} recorded no response model, so the served model is unverified.`);
  }
  return warnings;
}

function configWarnings(manifests: SwebenchManifest[]): string[] {
  const differing = CONFIG_KEYS.filter((key) => new Set(manifests.map((manifest) => JSON.stringify(manifest[key]))).size > 1);
  return differing.length
    ? [`WARNING: the contributing manifests differ in ${differing.join(", ")}, so the comparison also measures those differences.`]
    : [];
}

function interpretationLines(comparison: Comparison): string[] {
  const find = (metric: MetricName) => comparison.slices.all.metrics.find((result) => result.metric === metric)!;
  const lines = comparison.settings.primary.map((metric) => describeResult(find(metric), comparison.settings.alpha));
  if (!comparison.settings.primary.includes("resolved")) lines.push(describeResult(find("resolved"), comparison.settings.alpha));
  const ni = comparison.nonInferiority;
  if (ni.ci95) {
    const bound = `the lower 95% CI bound of B − A, ${pp(ni.ci95[0])}, is ${ni.nonInferior ? "above" : "not above"} ${pp(-ni.margin)}`;
    lines.push(ni.nonInferior
      ? `resolved: B is non-inferior to A at a ${margin(ni.margin)} margin; ${bound}.`
      : `resolved: non-inferiority of B is NOT established at a ${margin(ni.margin)} margin; ${bound}.`);
  }
  if (comparison.pairing.pairedTasks < FEW_TASKS) {
    lines.push(`Caution: only ${comparison.pairing.pairedTasks} paired task(s); percentile-bootstrap intervals are too narrow at this size, so read every interval and p-value as indicative.`);
  }
  if (!comparison.completeness.complete) {
    lines.push("Caution: the data are incomplete (see Completeness); the estimates cover only the valid paired runs.");
  }
  return lines;
}

function describeResult(result: MetricResult, alpha: number): string {
  if (result.estimate === null || result.ci95 === null) return `${result.metric}: not estimable; no paired task has a value in both arms.`;
  const [low, high] = result.ci95;
  const effect = result.kind === "rate"
    ? `B − A = ${pp(result.estimate)} (95% CI ${pp(low)} to ${pp(high)})`
    : `B vs A ${signedPct(result.estimate)} (geometric mean; 95% CI ${signedPct(low)} to ${signedPct(high)})`;
  if (!result.ciExcludesZero) return `${result.metric}: no detectable difference; ${effect}.`;
  const direction = result.estimate > 0 ? "higher" : "lower";
  if (!result.primary) {
    return `${result.metric}: ${direction} in B; ${effect} excludes 0, but this secondary metric is not corrected for multiple comparisons.`;
  }
  if (!result.significant) {
    return `${result.metric}: inconclusive; ${effect} excludes 0, but the Holm-adjusted p = ${formatP(result.pHolm ?? 1)} is above ${alpha}.`;
  }
  return `${result.metric}: significantly ${direction} in B; ${effect}, Holm-adjusted p = ${formatP(result.pHolm ?? 1)}.`;
}

export function comparisonMarkdown(comparison: Comparison): string {
  const { a, b, settings, pairing, completeness, costPerResolved: cost, claims, slices } = comparison;
  const niNote = comparison.nonInferiority.nonInferior
    ? `non-inferior at ${margin(settings.margin)}`
    : `non-inferiority not shown at ${margin(settings.margin)}`;
  const completenessRow = (arm: "a" | "b") => {
    const value = completeness[arm];
    const patchCaused = value.patchCausedRuns;
    return `| ${arm.toUpperCase()} | \`${value.variant}\` | ${value.plannedRuns} | ${value.observedRuns} | ${value.scoredRuns} | ${value.missingRuns} | ${value.invalidResultRuns} | ${value.harnessErrorRuns} | ${value.gradingErrorRuns} | ${value.providerErrorRuns} | ${value.environmentFailureRuns} | ${patchCaused.test_timeout + patchCaused.oom + patchCaused.tests_errored} | ${value.unplannedRuns} | ${value.complete ? "complete" : "INCOMPLETE"} |`;
  };
  const costRow = (arm: "a" | "b") => {
    const value = cost[arm];
    return `| ${arm.toUpperCase()} | $${value.totalCostUsd.toFixed(4)} | ${value.resolvedTasks.toFixed(2)} | ${value.costPerResolvedUsd === null ? "- (nothing resolved)" : `$${value.costPerResolvedUsd.toFixed(4)}`} |`;
  };
  const claimRow = (arm: "a" | "b") => {
    const value = claims[arm];
    return `| ${arm.toUpperCase()} | ${value.runs} | ${value.claimedResolved} | ${value.claimedUnresolved} | ${value.unclaimedResolved} | ${value.unclaimedUnresolved} |`;
  };
  const ratio = cost.ratio === null || cost.ci95 === null
    ? "B/A ratio: not estimable, because an arm resolved no paired task."
    : `B/A ratio: ${cost.ratio.toFixed(3)} (95% CI ${cost.ci95[0].toFixed(3)} to ${cost.ci95[1].toFixed(3)}${cost.undefinedReplicates ? `; ${cost.undefinedReplicates} resamples with no resolved task in an arm were dropped` : ""}).`;
  return [
    `# Paired A/B comparison: A = \`${a}\`, B = \`${b}\``,
    "",
    `- Benchmark \`${comparison.benchmark}\`, model \`${comparison.model}\`, split ${comparison.splits.join(", ")}`,
    `- Results: ${comparison.resultsDirs.map((dir) => `\`${dir}\``).join(", ")}`,
    `- Paired tasks: ${pairing.pairedTasks}; excluded because only one arm has a valid run: ${pairing.onlyInA.length} only in A, ${pairing.onlyInB.length} only in B`,
    `- ${settings.bootstrap} paired bootstrap resamples of tasks (seed ${settings.seed}); primary metrics, Holm-corrected at α = ${settings.alpha}: ${settings.primary.join(", ")}`,
    "",
    "## Interpretation",
    "",
    ...comparison.interpretation.map((line) => `- ${line}`),
    ...(comparison.warnings.length ? ["", "## Warnings", "", ...comparison.warnings.map((line) => `- ${line}`)] : []),
    "",
    "## Completeness",
    "",
    "| arm | variant | planned | observed | valid | missing | invalid_result | harness_error | grading_error | provider_error | environment failure | patch-caused grading failure | outside plan | status |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    completenessRow("a"),
    completenessRow("b"),
    "",
    `## All paired tasks (n = ${slices.all.tasks})`,
    "",
    slices.all.definition,
    "",
    metricTable(slices.all.metrics, niNote),
    "",
    `## Tasks resolved in both arms (n = ${slices.resolvedBoth.tasks}), efficiency only`,
    "",
    slices.resolvedBoth.definition,
    "",
    slices.resolvedBoth.tasks ? metricTable(slices.resolvedBoth.metrics) : "No task was resolved in both arms.",
    "",
    "## Cost per resolved task",
    "",
    cost.definition,
    "",
    "| arm | cost | resolved tasks | cost per resolved task |",
    "|---|---:|---:|---:|",
    costRow("a"),
    costRow("b"),
    "",
    ratio,
    ...(comparison.retryCostUsd.a > 0 || comparison.retryCostUsd.b > 0 ? [
      "",
      `Note: estimatedCostUsd, and so every cost figure in this comparison, counts only each run's final attempt, the one its trajectory describes. Attempts that a provider outage ended before the job re-ran them cost A $${comparison.retryCostUsd.a.toFixed(4)} and B $${comparison.retryCostUsd.b.toFixed(4)} more (retryCostUsd). That was spent, but it measures the provider, not the variant, so it is left out and an outage does not bias the arm it hit.`
    ] : []),
    "",
    "## Claimed success × resolved (valid runs of paired tasks)",
    "",
    "| arm | runs | claimed, resolved | claimed, unresolved (false success) | not claimed, resolved | not claimed, unresolved |",
    "|---|---:|---:|---:|---:|---:|",
    claimRow("a"),
    claimRow("b"),
    "",
    "## Response models",
    "",
    `- A (\`${a}\`): ${list(comparison.responseModels.a)}`,
    `- B (\`${b}\`): ${list(comparison.responseModels.b)}`,
    ...(pairing.onlyInA.length || pairing.onlyInB.length ? [
      "",
      "## Excluded tasks",
      "",
      `- Only A has a valid run (${pairing.onlyInA.length}): ${pairing.onlyInA.join(", ") || "none"}`,
      `- Only B has a valid run (${pairing.onlyInB.length}): ${pairing.onlyInB.join(", ") || "none"}`
    ] : []),
    "",
    "## Method",
    "",
    "- The task is the unit: each metric is first averaged over an arm's valid runs of a task. invalid_result, harness_error, grading_error, and provider_error rows are left out of every statistic and counted under Completeness, which is defined as in the evaluation summary. Runs an environment failure ended, and runs whose patch made grading time out, run out of memory, or error, are valid (scored unresolved when grading failed) and counted separately.",
    "- Every result directory must share the dataset, images, harness, agent limits, container limits, model, provider, endpoint, and inference settings, and each variant's rows must come from one agent version (agentFingerprint and sourceFingerprint); otherwise the comparison refuses to run.",
    "- Rates (resolved, falseSuccess, emptyPatch) and trace proportions (cacheHitRate, toolFailureRate, governanceShare) report Δ = mean over tasks of B − A, in percentage points.",
    "- Efficiency metrics report the geometric-mean change exp(mean ln((B+ε)/(A+ε))) − 1, with ε = 1e-9 × the metric's mean; tasks where both arms are 0 are skipped. Their A and B cells show the mean / median of per-task means.",
    "- 95% CIs are percentile intervals over resamples of tasks with replacement, shared by all metrics; p = 2·min(P(stat ≤ 0), P(stat ≥ 0)), clamped to [1/B, 1]. The parenthesized Holm-adjusted p applies to the primary metrics only; every other p-value is unadjusted and exploratory.",
    "- \"Significant\" requires a Holm-adjusted p ≤ α and a CI that excludes 0. A CI that includes 0 is reported as no detectable difference, which is not evidence of equivalence.",
    `- resolved is non-inferior when the lower CI bound of B − A is above −${margin(settings.margin)}.`,
    "- toolFailureRate counts tool calls that were rejected, errored, or timed out; a failing test run is not a failure. governanceShare is (set_plan + update_plan + finish_task) calls over all tool calls. modelLatencyMs and toolTimeMs sum model_turn.latencyMs and tool_result.durationMs."
  ].join("\n") + "\n";
}

function metricTable(results: MetricResult[], resolvedNote?: string): string {
  return [
    "| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...results.map((result) => metricRow(result, result.metric === "resolved" ? resolvedNote : undefined))
  ].join("\n");
}

function metricRow(result: MetricResult, extraNote?: string): string {
  const rate = result.kind === "rate";
  const hasValues = result.tasks + result.skippedBothZero > 0;
  const value = (arm: { mean: number; median: number }) => !hasValues
    ? "-"
    : rate ? pct(arm.mean) : `${formatValue(result.metric, arm.mean)} / ${formatValue(result.metric, arm.median)}`;
  const change = result.estimate === null ? "-" : rate ? pp(result.estimate) : signedPct(result.estimate);
  const ci = result.ci95 === null
    ? "-"
    : rate ? `${pp(result.ci95[0])} to ${pp(result.ci95[1])}` : `${signedPct(result.ci95[0])} to ${signedPct(result.ci95[1])}`;
  const p = result.p === null ? "-" : result.pHolm === null ? formatP(result.p) : `${formatP(result.p)} (${formatP(result.pHolm)})`;
  const verdict = result.estimate === null
    ? "not estimable"
    : !result.ciExcludesZero
      ? "no detectable difference"
      : !result.primary
        ? "CI excludes 0 (exploratory)"
        : result.significant ? "significant (Holm)" : "CI excludes 0, not significant after Holm";
  const note = [
    ...(result.primary ? ["primary"] : []),
    verdict,
    `n=${result.tasks}`,
    ...(result.skippedBothZero ? [`${result.skippedBothZero} both-zero skipped`] : []),
    ...(extraNote ? [extraNote] : [])
  ].join("; ");
  return `| ${result.metric} | ${value(result.a)} | ${value(result.b)} | ${change} | ${ci} | ${p} | ${note} |`;
}

function formatValue(metric: MetricName, value: number): string {
  if (metric === "estimatedCostUsd") return `$${value.toFixed(4)}`;
  if (metric.endsWith("Ms")) return `${(value / 1000).toFixed(1)}s`;
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1);
}

function formatP(p: number): string {
  return p < 0.001 ? p.toExponential(1) : p.toFixed(3);
}

// One decimal of a percentage; the sign follows the rounded text, so a tiny negative prints as 0.0.
function percent(value: number): string {
  const text = (value * 100).toFixed(1);
  return text === "-0.0" ? "0.0" : text;
}

function signed(text: string): string {
  return text.startsWith("-") ? text : `+${text}`;
}

function pct(value: number): string {
  return `${percent(value)}%`;
}

function signedPct(value: number): string {
  return signed(pct(value));
}

function pp(value: number): string {
  return `${signed(percent(value))} pp`;
}

function margin(value: number): string {
  return `${(value * 100).toFixed(1)} pp`;
}

function list(values: string[]): string {
  return values.length ? values.join(", ") : "(none recorded)";
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)].sort();
}

function distinctSets(rows: ArmRow[]): SwebenchManifest[] {
  return [...new Set(rows.map(({ set }) => set))].map((set) => set.manifest);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

if (isMainModule(import.meta.url)) {
  const program = new Command();
  program
    .name("onehand-compare")
    .description("Paired A/B comparison of two agent variants on the same tasks")
    .option("--results <dir>", "evaluation result directory (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .requiredOption("--a <variant>", "baseline variant (arm A)")
    .requiredOption("--b <variant>", "candidate variant (arm B)")
    .option("--primary <metrics>", "comma-separated primary metrics for the Holm correction", parseMetrics, DEFAULT_PRIMARY)
    .option("--margin <x>", "non-inferiority margin for the resolved rate, as a proportion", Number, 0.1)
    .option("--bootstrap <n>", "bootstrap resamples", Number, 10_000)
    .option("--seed <n>", "bootstrap seed", Number, 20260925)
    .requiredOption("--output <path>", "output path without extension; writes <path>.md and <path>.json")
    .action(async (options) => {
      const { comparison, markdownPath } = await runComparison(options);
      process.stdout.write(`[compare] report=${markdownPath} paired=${comparison.pairing.pairedTasks} complete=${comparison.completeness.complete ? "yes" : "no"} warnings=${comparison.warnings.length}\n`);
      if (!comparison.completeness.complete) process.exitCode = 2;
    });
  program.parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function parseMetrics(value: string): MetricName[] {
  return value.split(",").map((metric) => metric.trim()).filter(Boolean) as MetricName[];
}

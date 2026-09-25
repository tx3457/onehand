import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactDeep } from "../../src/agent/persistence.js";
import type { PriceSnapshot } from "../../src/pricing.js";
import { bootstrapMeanCi, mean, median, sum } from "../stats.js";
import type { SwebenchSplit } from "./dataset.js";
import type { ExternalRow } from "./external.js";

type ConfigGroup = ExternalRow["miniConfig"] & { runs: number };

export type ExternalSummary = {
  schemaVersion: 1;
  kind: "swebench_external_summary";
  reference: "external descriptive reference";
  label: string;
  split: SwebenchSplit;
  model: string;
  priceSnapshot: PriceSnapshot;
  complete: boolean;
  plannedRuns: number;
  observedRuns: number;
  resolved: { count: number; rate: number; ci95: [number, number] };
  meanCostUsd: number;
  medianCostUsd: number;
  meanModelRounds: number;
  meanInputTokens: number;
  meanCacheHitInputTokens: number;
  meanCacheMissInputTokens: number;
  meanOutputTokens: number;
  meanReasoningTokens: number;
  costPerResolvedUsd: number | null;
  totalCostUsd: number;
  exitStatusCounts: Record<string, number>;
  gradingOutcomeCounts: Record<string, number>;
  setup: { toolInterface: "bash tool"; configGroups: ConfigGroup[] };
};

export async function writeExternalReport(
  options: {
    outputDir: string;
    label: string;
    split: SwebenchSplit;
    model: string;
    priceSnapshot: PriceSnapshot;
    instanceIds: string[];
  },
  rows: ExternalRow[]
): Promise<ExternalSummary> {
  const ordered = rows.map((row) => redactDeep(row)).sort((a, b) => compareText(a.taskId, b.taskId));
  const resolvedValues = ordered.map((row) => row.resolved ? 1 : 0);
  const resolvedCount = sum(resolvedValues);
  const totalCostUsd = sum(ordered.map((row) => row.estimatedCostUsd));
  const observedIds = new Set(ordered.map((row) => row.taskId));
  const configGroups = groupedConfigs(ordered);
  const identity = redactDeep({
    label: options.label,
    split: options.split,
    model: options.model,
    priceSnapshot: options.priceSnapshot
  });
  const summary = redactDeep({
    schemaVersion: 1 as const,
    kind: "swebench_external_summary" as const,
    reference: "external descriptive reference" as const,
    ...identity,
    complete: ordered.length === options.instanceIds.length &&
      options.instanceIds.every((instanceId) => observedIds.has(redactDeep(instanceId))),
    plannedRuns: options.instanceIds.length,
    observedRuns: ordered.length,
    resolved: {
      count: resolvedCount,
      rate: mean(resolvedValues),
      ci95: bootstrapMeanCi(resolvedValues)
    },
    meanCostUsd: mean(ordered.map((row) => row.estimatedCostUsd)),
    medianCostUsd: median(ordered.map((row) => row.estimatedCostUsd)),
    meanModelRounds: mean(ordered.map((row) => row.modelRounds)),
    meanInputTokens: mean(ordered.map((row) => row.inputTokens)),
    meanCacheHitInputTokens: mean(ordered.map((row) => row.cacheHitInputTokens)),
    meanCacheMissInputTokens: mean(ordered.map((row) => row.cacheMissInputTokens)),
    meanOutputTokens: mean(ordered.map((row) => row.outputTokens)),
    meanReasoningTokens: mean(ordered.map((row) => row.reasoningTokens)),
    costPerResolvedUsd: resolvedCount ? totalCostUsd / resolvedCount : null,
    totalCostUsd,
    exitStatusCounts: counts(ordered.map((row) => row.exitStatus ?? "unknown")),
    gradingOutcomeCounts: counts(ordered.map((row) => row.gradingOutcome)),
    setup: { toolInterface: "bash tool" as const, configGroups }
  }) as ExternalSummary;

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, "external-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  await writeFile(path.join(options.outputDir, "external-report.md"), markdown(summary), "utf8");
  return summary;
}

function groupedConfigs(rows: ExternalRow[]): ConfigGroup[] {
  const groups = new Map<string, ConfigGroup>();
  for (const row of rows) {
    const config = row.miniConfig;
    const key = JSON.stringify([config.stepLimit, config.costLimitUsd, config.networkDisabled]);
    groups.set(key, { ...config, runs: (groups.get(key)?.runs ?? 0) + 1 });
  }
  return [...groups.entries()].sort(([a], [b]) => compareText(a, b)).map(([, group]) => group);
}

function counts(values: string[]): Record<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return Object.fromEntries([...result.entries()].sort(([a], [b]) => compareText(a, b)));
}

function markdown(summary: ExternalSummary): string {
  const configLines = summary.setup.configGroups.length ? summary.setup.configGroups.map((group) => {
    const step = group.stepLimit === null ? "unknown" : group.stepLimit;
    const cost = group.costLimitUsd === null ? "unknown" : group.costLimitUsd;
    const network = group.networkDisabled === true
      ? "network was disabled via run args"
      : group.networkDisabled === false ? "run args show a different network setting" : "network setting is unknown from trajectory config";
    return `- ${group.runs} run(s): step_limit=${step}; cost_limit=${cost}; ${network}.`;
  }) : ["- No observed trajectories; mini limits and network settings are unknown."];
  const countRows = (values: Record<string, number>) => Object.entries(values).map(([name, count]) => `| ${cell(name)} | ${count} |`);
  return [
    `# External SWE-bench reference: ${summary.label}`,
    "",
    "> This is an external descriptive reference, not a paired controlled comparison with OneHand.",
    "",
    summary.complete ? "**COMPLETE.**" : "**INCOMPLETE. Statistics below cover graded rows only; ungraded infrastructure-pending instances are excluded.**",
    "",
    `- Split: ${summary.split}; model used for pricing: ${summary.model}; observed ${summary.observedRuns} of ${summary.plannedRuns} planned run(s).`,
    `- Resolved: ${summary.resolved.count}/${summary.observedRuns} (${pct(summary.resolved.rate)}; bootstrap 95% CI ${pct(summary.resolved.ci95[0])} to ${pct(summary.resolved.ci95[1])}).`,
    `- Mean/median estimated cost: ${usd(summary.meanCostUsd)} / ${usd(summary.medianCostUsd)}; total ${usd(summary.totalCostUsd)}; cost per resolved ${summary.costPerResolvedUsd === null ? "- (nothing resolved)" : usd(summary.costPerResolvedUsd)}.`,
    "",
    "## Setup differences",
    "",
    "mini-swe-agent used a bash tool and its own step and cost limits from each trajectory config. OneHand uses its own tool interface, planning flow, and limits, so these results do not isolate an agent-framework effect.",
    "",
    ...configLines,
    "",
    "## Mean usage per run",
    "",
    `- Model rounds ${num(summary.meanModelRounds)}; input tokens ${num(summary.meanInputTokens)} (${num(summary.meanCacheHitInputTokens)} cache hit, ${num(summary.meanCacheMissInputTokens)} cache miss); output tokens ${num(summary.meanOutputTokens)}; reasoning tokens ${num(summary.meanReasoningTokens)}.`,
    "",
    "## Exit statuses",
    "",
    "| status | runs |", "|---|---:|", ...countRows(summary.exitStatusCounts),
    "",
    "## Grading outcomes",
    "",
    "| outcome | runs |", "|---|---:|", ...countRows(summary.gradingOutcomeCounts),
    "",
    "## Method",
    "",
    "- Patches were graded with the same official SWE-bench harness 5.0.2 path and pinned Epoch images used by OneHand.",
    "- A model round is one response carrying usage. The resolved-rate interval uses the shared deterministic 4000-resample percentile bootstrap (95% CI) over runs.",
    "- Costs are list-price estimates from the recorded price snapshot. Reasoning tokens are a subset of output tokens and are not charged a second time.",
    "- For an incomplete report, statistics cover graded rows only; ungraded infrastructure-pending instances remain outside the observed denominator."
  ].join("\n") + "\n";
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const usd = (value: number) => `$${value.toFixed(6)}`;
const num = (value: number) => value.toFixed(2);
const cell = (value: string) => value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

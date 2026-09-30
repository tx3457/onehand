import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessCompleteness, exclusionReason, parseTrace, plannedSwebenchKeys, RunLedger, swebenchRunKey } from "../results-io.js";
import { bootstrapMeanCi, mean, percentile, sum } from "../stats.js";
import type { SwebenchManifest, SwebenchRunResult } from "../types.js";

export const DIAGNOSTIC_NOTE = "A/B claims come only from `npm run eval:compare` on paired variants. A single-variant run is a diagnostic of one configuration, not a comparison.";

export type SwebenchSummary = ReturnType<typeof summarizeSwebench>;
type ResolvedRate = { runs: number; resolved: number; rate: number; ci95: [number, number] };

// `ledger`: what the rows do not show (results-io readRunLedger).
export async function writeSwebenchReport(
  manifest: SwebenchManifest,
  rows: SwebenchRunResult[],
  outputDir: string,
  capReached: boolean,
  ledger: Partial<RunLedger> = {}
): Promise<SwebenchSummary> {
  const summary = summarizeSwebench(manifest, rows, capReached, ledger);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  await writeFile(path.join(outputDir, "report.md"), swebenchReportMarkdown(manifest, summary), "utf8");
  return summary;
}

// A pure function of its inputs (rows are put in a canonical order first, and nothing is timestamped),
// so rewriting summary.json and report.md is idempotent.
export function summarizeSwebench(manifest: SwebenchManifest, rows: SwebenchRunResult[], capReached: boolean, ledger: Partial<RunLedger> = {}) {
  const { unfinishedChargeUsd = 0, supersededChargeUsd = 0, circuitOpen = false } = ledger;
  const ordered = [...rows].sort(compareRows);
  const { complete, ...completeness } = assessCompleteness(
    plannedSwebenchKeys(manifest), ordered.map((row) => [keyOf(row), row]), capReached, circuitOpen
  );
  const measuredCostUsd = sum(ordered.map((row) => row.estimatedCostUsd));
  const retryCostUsd = sum(ordered.map((row) => row.retryCostUsd ?? 0));
  // Outcome and efficiency statistics use the runs with a known verdict, as eval:compare does.
  const scored = ordered.filter((row) => !exclusionReason(row));
  const resolvedRuns = scored.filter((row) => row.resolved).length;
  const scoredCost = sum(scored.map((row) => row.estimatedCostUsd));
  const cacheHit = sum(scored.map((row) => row.cacheHitInputTokens));
  const cacheInput = cacheHit + sum(scored.map((row) => row.cacheMissInputTokens));
  const claimed = (claim: boolean, resolved: boolean) =>
    scored.filter((row) => (row.agentStatus === "success") === claim && row.resolved === resolved).length;
  const emptyPatchRuns = scored.filter((row) => row.emptyPatch).length;
  const responseModels = new Set<string>();
  for (const row of ordered) {
    for (const model of Array.isArray(row.responseModels) ? row.responseModels : []) if (model) responseModels.add(model);
    for (const turn of parseTrace(row.traceEvents).turns) if (turn.responseModel) responseModels.add(turn.responseModel);
  }
  const failureClasses: Record<string, number> = {};
  for (const row of ordered) if (row.failureClass) failureClasses[row.failureClass] = (failureClasses[row.failureClass] ?? 0) + 1;

  return {
    schemaVersion: 1 as const,
    kind: "swebench_summary" as const,
    note: DIAGNOSTIC_NOTE,
    evaluationId: manifest.evaluationId,
    split: manifest.split,
    model: manifest.model,
    variants: manifest.variants.map((variant) => variant.name),
    complete,
    // Why the last invocation stopped before every job ran, when that was not the cost cap (completeness.capReached).
    stopReason: circuitOpen ? "provider_circuit_open" as const : null,
    completeness,
    scoredRuns: scored.length,
    resolved: resolvedRate(scored),
    byRepo: breakdown(scored, (row) => row.category),
    byDifficulty: breakdown(scored, (row) => row.difficulty),
    falseSuccess: {
      runs: scored.length,
      count: scored.filter((row) => row.falseSuccess).length,
      rate: mean(scored.map((row) => (row.falseSuccess ? 1 : 0)))
    },
    claims: {
      claimedResolved: claimed(true, true),
      claimedUnresolved: claimed(true, false),
      unclaimedResolved: claimed(false, true),
      unclaimedUnresolved: claimed(false, false)
    },
    completion: completionSummary(scored),
    patches: {
      emptyPatchRuns,
      emptyPatchRate: scored.length ? emptyPatchRuns / scored.length : 0,
      // Non-empty patches the harness could not apply (an unextracted patch never reached it).
      applyFailures: scored.filter((row) => !row.emptyPatch && !row.patchApplied && row.failureClass !== "patch_extraction_failed").length
    },
    efficiency: {
      modelRounds: distribution(scored.map((row) => row.modelRounds)),
      toolCalls: distribution(scored.map((row) => row.toolCalls)),
      inputTokens: distribution(scored.map((row) => row.inputTokens)),
      outputTokens: distribution(scored.map((row) => row.outputTokens)),
      reasoningTokens: distribution(scored.map((row) => row.reasoningTokens)),
      estimatedCostUsd: distribution(scored.map((row) => row.estimatedCostUsd)),
      durationMs: distribution(scored.map((row) => row.durationMs)),
      cacheHitRate: cacheInput > 0 ? cacheHit / cacheInput : null
    },
    // Every row, excluded ones too: their tokens were spent. Tokens and measuredCostUsd are the final attempts'.
    totals: {
      inputTokens: sum(ordered.map((row) => row.inputTokens)),
      outputTokens: sum(ordered.map((row) => row.outputTokens)),
      cacheHitInputTokens: sum(ordered.map((row) => row.cacheHitInputTokens)),
      cacheMissInputTokens: sum(ordered.map((row) => row.cacheMissInputTokens)),
      reasoningTokens: sum(ordered.map((row) => row.reasoningTokens)),
      // Σ estimatedCostUsd: the per-task cost metric, summed.
      measuredCostUsd,
      // Σ retryCostUsd: attempts a provider outage ended and the job then re-ran.
      retryCostUsd,
      // The provider_error rows a resume took out of results.jsonl to run their jobs again.
      supersededChargeUsd,
      // The journaled reservations of jobs an interrupted invocation never recorded.
      unfinishedChargeUsd,
      // The true spend.
      totalSpendUsd: measuredCostUsd + retryCostUsd + supersededChargeUsd + unfinishedChargeUsd,
      // What the cost cap counted: the true spend, plus the whole reservation of each job that threw (its cost is unknown).
      capChargedUsd: sum(ordered.map((row) => row.capChargeUsd ?? row.estimatedCostUsd)) + supersededChargeUsd + unfinishedChargeUsd,
      costPerResolvedUsd: resolvedRuns ? scoredCost / resolvedRuns : null
    },
    responseModels: [...responseModels].sort(),
    failureClasses: Object.fromEntries(Object.entries(failureClasses).sort(([a, x], [b, y]) => y - x || compareText(a, b))),
    perVariant: manifest.variants.length > 1 ? manifest.variants.map(({ name }) => {
      const all = ordered.filter((row) => row.variant === name);
      const runs = all.filter((row) => !exclusionReason(row));
      return {
        variant: name,
        plannedRuns: manifest.instanceIds.length * manifest.repetitions,
        observedRuns: all.length,
        ...resolvedRate(runs),
        completion: completionSummary(runs),
        falseSuccessRate: mean(runs.map((row) => (row.falseSuccess ? 1 : 0))),
        emptyPatchRate: mean(runs.map((row) => (row.emptyPatch ? 1 : 0))),
        meanCostUsd: mean(runs.map((row) => row.estimatedCostUsd)),
        meanModelRounds: mean(runs.map((row) => row.modelRounds)),
        totalCostUsd: sum(all.map((row) => row.estimatedCostUsd))
      };
    }) : null
  };
}

export function swebenchReportMarkdown(manifest: SwebenchManifest, summary: SwebenchSummary): string {
  const { completeness: done, resolved, claims, patches, efficiency, totals } = summary;
  const variants = summary.variants.map((name) => `\`${name}\``).join(", ");
  const rateCells = (value: ResolvedRate) => `${value.runs} | ${value.resolved} | ${pct(value.rate)} | ${pct(value.ci95[0])} to ${pct(value.ci95[1])}`;
  const breakdownRows = (values: Record<string, ResolvedRate>) =>
    Object.entries(values).map(([key, value]) => `| ${key} | ${rateCells(value)} |`);
  const statRow = (label: string, value: Distribution, format: (x: number) => string) =>
    `| ${label} | ${format(value.mean)} | ${format(value.p50)} | ${format(value.p95)} | ${format(value.max)} |`;
  return [
    `# SWE-bench evaluation: ${summary.split}, ${variants}`,
    "",
    `> ${DIAGNOSTIC_NOTE}`,
    "",
    `- Evaluation \`${summary.evaluationId}\`; model \`${summary.model}\` (thinking ${manifest.thinking}, reasoning effort ${manifest.reasoningEffort}); images: ${manifest.imageSource ?? "unrecorded"}`,
    `- Dataset revision \`${manifest.datasetRevision}\`; data file sha256 \`${manifest.dataFileSha256}\`; swebench ${manifest.swebenchVersion}`,
    `- Plan: ${manifest.instanceIds.length} instance(s) × ${manifest.repetitions} repetition(s) × ${manifest.variants.length} variant(s) = ${done.plannedRuns} run(s); ${manifest.exclusions.length} instance(s) excluded by self-check`,
    `- Cost cap $${manifest.costCapUsd.toFixed(2)}, with $${manifest.reservationUsd.toFixed(4)} reserved per run in flight; limits are checked before each model turn, so a run can exceed its reservation by at most one turn's usage`,
    "",
    "## Completeness",
    "",
    summary.complete ? "COMPLETE." : `INCOMPLETE: ${done.flags.join("; ")}.`,
    "",
    "| planned | observed | missing | invalid_result | harness_error | grading_error | provider_error | environment_failure | test timeout | out of memory | tests errored | cap reached |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    `| ${done.plannedRuns} | ${done.observedRuns} | ${done.missingRuns} | ${done.invalidResultRuns} | ${done.harnessErrorRuns} | ${done.gradingErrorRuns} | ${done.providerErrorRuns} | ${done.environmentFailureRuns} | ${done.patchCausedRuns.test_timeout} | ${done.patchCausedRuns.oom} | ${done.patchCausedRuns.tests_errored} | ${done.capReached ? "yes" : "no"} |`,
    "",
    "A run that an environment failure ended is complete: it keeps its real usage and cost and its graded verdict, and is counted separately above. So is a run whose patch made grading time out, run out of memory, or error after the tests ran: like the official harness, it is scored unresolved. invalid_result, harness_error, grading_error, and provider_error rows leave the evaluation incomplete and are left out of every statistic below; a resume runs the job of every provider_error row again.",
    ...(summary.stopReason === "provider_circuit_open" ? [
      "",
      `Stopped early (stopReason provider_circuit_open): a provider outage is suspected after ${manifest.infraPolicy?.provider?.circuitBreakerAfter ?? "several"} consecutive provider errors, so no new job started and the jobs in flight finished. Resume later to re-run them.`
    ] : []),
    "",
    "## Resolved",
    "",
    `- ${resolved.resolved} of ${summary.scoredRuns} scored run(s) resolved: ${pct(resolved.rate)} (task-cluster bootstrap 95% CI ${pct(resolved.ci95[0])} to ${pct(resolved.ci95[1])})${summary.variants.length > 1 ? "; pooled over every variant, see Per variant" : ""}`,
    `- False success (finish_task accepted, not resolved): ${summary.falseSuccess.count} of ${summary.falseSuccess.runs} (${pct(summary.falseSuccess.rate)})`,
    "",
    "| repository | runs | resolved | rate | 95% CI |",
    "|---|---:|---:|---:|---:|",
    ...breakdownRows(summary.byRepo),
    "",
    "| difficulty | runs | resolved | rate | 95% CI |",
    "|---|---:|---:|---:|---:|",
    ...breakdownRows(summary.byDifficulty),
    "",
    "## Claimed success × resolved",
    "",
    "| | resolved | not resolved |",
    "|---|---:|---:|",
    `| claimed success | ${claims.claimedResolved} | ${claims.claimedUnresolved} (false success) |`,
    `| no success claim | ${claims.unclaimedResolved} | ${claims.unclaimedUnresolved} |`,
    "",
    "## Completion and budget notices",
    "",
    "Descriptive counts over scored runs. Compare resolvedAndFinished and resolvedBudgetExhausted with eval:compare for paired estimates.",
    "",
    ...completionLines(summary.completion),
    ...(summary.perVariant ? summary.perVariant.flatMap((variant) => [
      "", `### ${variant.variant}`, "", ...completionLines(variant.completion)
    ]) : []),
    "",
    "## Patches",
    "",
    `- Empty patches: ${patches.emptyPatchRuns} of ${summary.scoredRuns} (${pct(patches.emptyPatchRate)}); the harness does not run on an empty patch, so it is unresolved.`,
    `- Non-empty patches the harness could not apply: ${patches.applyFailures}`,
    "",
    "## Efficiency per scored run",
    "",
    "| metric | mean | P50 | P95 | max |",
    "|---|---:|---:|---:|---:|",
    statRow("model rounds", efficiency.modelRounds, count),
    statRow("tool calls", efficiency.toolCalls, count),
    statRow("input tokens", efficiency.inputTokens, tokens),
    statRow("output tokens", efficiency.outputTokens, tokens),
    statRow("reasoning tokens", efficiency.reasoningTokens, tokens),
    statRow("cost (final attempt)", efficiency.estimatedCostUsd, usd),
    statRow("job duration (setup to grading)", efficiency.durationMs, seconds),
    "",
    `- Cache hit rate: ${efficiency.cacheHitRate === null ? "no input tokens" : pct(efficiency.cacheHitRate)} of scored input tokens`,
    `- All rows: ${tokens(totals.inputTokens)} input tokens (${tokens(totals.cacheHitInputTokens)} cache hits), ${tokens(totals.outputTokens)} output tokens (${tokens(totals.reasoningTokens)} reasoning)`,
    "",
    "## Cost",
    "",
    `- Per-task metric (estimatedCostUsd): ${usd(totals.measuredCostUsd)} over all rows; per resolved run: ${totals.costPerResolvedUsd === null ? "- (nothing resolved)" : usd(totals.costPerResolvedUsd)}. Each row counts only its final attempt, the one its trajectory describes, so a provider outage does not bias the cost of the variant it hit. The efficiency table and eval:compare use this figure.`,
    `- True spend (totalSpendUsd): ${usd(totals.totalSpendUsd)}: the per-task metric, plus ${usd(totals.retryCostUsd)} for attempts a provider outage ended before the job re-ran them (retryCostUsd), ${usd(totals.supersededChargeUsd)} for provider_error runs a resume superseded to run their jobs again, and ${usd(totals.unfinishedChargeUsd)} charged for jobs an interrupted invocation never recorded (their journaled reservations).`,
    `- Charged against the cost cap (capChargedUsd): ${usd(totals.capChargedUsd)}: the true spend, plus the whole reservation of any job that threw, whose cost is unknown.`,
    "",
    "## Response models",
    "",
    summary.responseModels.length ? summary.responseModels.map((model) => `- ${model}`).join("\n") : "- (none recorded, so the served model is unverified)",
    ...(summary.perVariant ? [
      "",
      "## Per variant",
      "",
      "Descriptive only; use eval:compare for any A/B claim.",
      "",
      "| variant | planned | observed | scored | resolved | rate | 95% CI | false success | empty patch | mean cost | mean rounds |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
      ...summary.perVariant.map((value) =>
        `| \`${value.variant}\` | ${value.plannedRuns} | ${value.observedRuns} | ${rateCells(value)} | ${pct(value.falseSuccessRate)} | ${pct(value.emptyPatchRate)} | ${usd(value.meanCostUsd)} | ${count(value.meanModelRounds)} |`)
    ] : []),
    "",
    "## Failure classes",
    "",
    "| failure class | runs |",
    "|---|---:|",
    ...Object.entries(summary.failureClasses).map(([name, value]) => `| ${name} | ${value} |`),
    "",
    "## Method",
    "",
    "- Resolved is the official SWE-bench harness verdict on the extracted patch. The rate is over scored runs. Its 95% CI is a percentile bootstrap that resamples tasks, each task contributing its mean over its runs (4000 resamples).",
    "- Scored runs exclude invalid_result, harness_error, grading_error, and provider_error rows. Efficiency statistics use scored runs; token and cost totals use every row.",
    "- Costs use the manifest's dated peak list-price snapshot, so they are upper bounds."
  ].join("\n") + "\n";
}

type Distribution = { mean: number; p50: number; p95: number; max: number };

function completionSummary(rows: SwebenchRunResult[]) {
  const traces = rows.map((row) => parseTrace(row.traceEvents));
  const finishesAfterCloseout: number[] = [];
  rows.forEach((row, index) => {
    if (row.agentStatus !== "success" || row.stopReason !== "explicit_finish") return;
    const trace = traces[index]!;
    const finish = trace.tools.find((tool) => tool.name === "finish_task" && tool.ok);
    if (!finish) return;
    const lastCloseout = trace.notices.filter((notice) => notice.kind === "closeout" && notice.round <= finish.round)
      .sort((a, b) => a.round - b.round).at(-1);
    // The notice is inserted before its recorded round: finishing in that round takes one model round.
    if (lastCloseout) finishesAfterCloseout.push(finish.round - lastCloseout.round + 1);
  });
  return {
    runs: rows.length,
    resolvedAndFinished: rows.filter((row) => row.resolved && row.agentStatus === "success" && row.stopReason === "explicit_finish").length,
    resolvedBudgetExhausted: rows.filter((row) => row.resolved && row.agentStatus === "budget_exhausted").length,
    finalVerification: {
      knownRuns: traces.filter((trace) => trace.finalVerification !== undefined).length,
      verifiedRuns: traces.filter((trace) => trace.finalVerification?.verified).length
    },
    notices: {
      // New run_finished records carry revision fields. Their absence means telemetry coverage
      // is unknown, not that a historical/truncated run emitted zero notices.
      knownRuns: traces.filter((trace) => trace.finalVerification !== undefined).length,
      unknownRuns: traces.filter((trace) => trace.finalVerification === undefined).length,
      budget: sum(traces.map((trace) => trace.notices.filter((notice) => notice.kind === "budget").length)),
      closeout: sum(traces.map((trace) => trace.notices.filter((notice) => notice.kind === "closeout").length)),
      runsWithNotices: traces.filter((trace) => trace.notices.length).length,
      finishedAfterCloseout: finishesAfterCloseout.length,
      roundsFromLastCloseoutToFinish: finishesAfterCloseout.length ? distribution(finishesAfterCloseout) : null
    }
  };
}

function completionLines(value: ReturnType<typeof completionSummary>): string[] {
  const { notices, finalVerification } = value;
  return [
    `- Resolved and explicitly finished: ${value.resolvedAndFinished} of ${value.runs}`,
    `- Resolved but budget exhausted: ${value.resolvedBudgetExhausted} of ${value.runs}`,
    `- Final revision verified: ${finalVerification.verifiedRuns} of ${finalVerification.knownRuns} runs with recorded revision evidence; ${value.runs - finalVerification.knownRuns} unknown (an earlier passing test is not final verification).`,
    `- Recorded notices: ${notices.budget} budget, ${notices.closeout} close-out, across ${notices.runsWithNotices} runs.`,
    `- Notice telemetry: ${notices.knownRuns} known, ${notices.unknownRuns} unknown (based on final revision-bearing trace records); missing telemetry does not establish zero notices.`,
    `- Explicit finishes after a close-out notice: ${notices.finishedAfterCloseout}; mean model rounds from last close-out to finish: ${notices.roundsFromLastCloseoutToFinish?.mean.toFixed(2) ?? "unknown"} (the notice's round counts as one).`
  ];
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: mean(values), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? 0 };
}

// Run-level rate, with the CI from a bootstrap over per-task means (tasks in id order).
function resolvedRate(rows: SwebenchRunResult[]): ResolvedRate {
  const byTask = new Map<string, number[]>();
  for (const row of rows) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row.resolved ? 1 : 0]);
  const taskMeans = [...byTask.keys()].sort(compareText).map((taskId) => mean(byTask.get(taskId)!));
  return {
    runs: rows.length,
    resolved: rows.filter((row) => row.resolved).length,
    rate: mean(rows.map((row) => (row.resolved ? 1 : 0))),
    ci95: bootstrapMeanCi(taskMeans)
  };
}

function breakdown(rows: SwebenchRunResult[], key: (row: SwebenchRunResult) => string): Record<string, ResolvedRate> {
  const groups = new Map<string, SwebenchRunResult[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return Object.fromEntries([...groups.keys()].sort(compareText).map((name) => [name, resolvedRate(groups.get(name)!)]));
}

function keyOf(row: SwebenchRunResult): string {
  return swebenchRunKey(row.taskId, row.repetition, row.variant);
}

function compareRows(a: SwebenchRunResult, b: SwebenchRunResult): number {
  return compareText(a.taskId, b.taskId) || a.repetition - b.repetition || compareText(a.variant, b.variant);
}

// Code-point order, independent of the locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function count(value: number): string {
  return value.toFixed(1);
}

function tokens(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

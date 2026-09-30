import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JOURNAL_FILE, SUPERSEDED_FILE, supersededCharges, unfinishedReservations } from "./core.js";
import type { EvaluationManifest, EvaluationRunResult, SwebenchManifest, SwebenchRunResult } from "./types.js";

export type ResultRow = SwebenchRunResult | EvaluationRunResult;
export type ResultManifest = SwebenchManifest | EvaluationManifest;
// What a SWE-bench evaluation's rows do not show. unfinishedChargeUsd: what the cap charged jobs an interrupted
// invocation left without a row; supersededChargeUsd: what it charged the provider_error rows a resume took out of
// results.jsonl to run their jobs again; circuitOpen: whether the provider circuit breaker stopped the last invocation.
export type RunLedger = { unfinishedChargeUsd: number; supersededChargeUsd: number; circuitOpen: boolean };
// The ledger is read for SWE-bench results only.
export type ResultSet = { dir: string; manifest: ResultManifest; rows: ResultRow[] } & Partial<RunLedger>;

export const GOVERNANCE_TOOLS = new Set(["set_plan", "update_plan", "finish_task"]);

// Loads manifest.json and results.jsonl from one evaluation output directory.
export async function loadResultSet(dir: string): Promise<ResultSet> {
  const root = path.resolve(dir);
  const manifestPath = path.join(root, "manifest.json");
  let manifest: ResultManifest;
  try {
    manifest = JSON.parse(await readRequired(manifestPath)) as ResultManifest;
  } catch (error) {
    throw error instanceof SyntaxError ? new Error(`${manifestPath}: invalid JSON`) : error;
  }
  const version = (manifest as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== 1 && version !== 2) throw new Error(`${manifestPath}: unsupported schemaVersion ${String(version)}`);
  const resultsPath = path.join(root, "results.jsonl");
  const rows = (await readRequired(resultsPath)).split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let row: ResultRow;
    try {
      row = JSON.parse(line) as ResultRow;
    } catch {
      throw new Error(`${resultsPath}:${index + 1}: invalid JSON`);
    }
    if (row?.schemaVersion !== manifest.schemaVersion) {
      throw new Error(`${resultsPath}:${index + 1}: schemaVersion ${String(row?.schemaVersion)} does not match the manifest's ${manifest.schemaVersion}`);
    }
    return [row];
  });
  if (version !== 2) return { dir: root, manifest, rows };
  return { dir: root, manifest, rows, ...(await readRunLedger(root, manifest as SwebenchManifest, rows as SwebenchRunResult[])) };
}

// `rows` must be in results.jsonl's order, which is the order their jobs finished in.
export async function readRunLedger(dir: string, manifest: SwebenchManifest, rows: SwebenchRunResult[]): Promise<RunLedger> {
  const keys = rows.map((row) => swebenchRunKey(row.taskId, row.repetition, row.variant));
  const { chargeUsd } = await unfinishedReservations(path.join(dir, JOURNAL_FILE), keys, manifest.evaluationId);
  return {
    unfinishedChargeUsd: chargeUsd,
    supersededChargeUsd: await supersededCharges(path.join(dir, SUPERSEDED_FILE), manifest.evaluationId),
    circuitOpen: circuitOpenFrom(manifest, rows)
  };
}

// The identity of one planned SWE-bench run; the evaluation loop keys jobs and rows by it.
export function swebenchRunKey(taskId: string, repetition: number, variant: string): string {
  return `${taskId}#${repetition}/${variant}`;
}

export function plannedSwebenchKeys(manifest: SwebenchManifest): Set<string> {
  const keys = new Set<string>();
  for (const id of manifest.instanceIds ?? []) {
    for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) {
      for (const variant of manifest.variants ?? []) keys.add(swebenchRunKey(id, repetition, variant.name));
    }
  }
  return keys;
}

// Whether the cap is what left planned runs missing: the loop stops taking jobs exactly when the charges
// (the rows', plus those of jobs an interrupted invocation never recorded and of superseded rows) and one more
// reservation exceed the cap. Recomputed from the rows, so a rewritten report agrees with the one the run wrote.
export function capReachedFrom(manifest: SwebenchManifest, rows: SwebenchRunResult[], ledger: Partial<RunLedger> = {}): boolean {
  const observed = new Set(rows.map((row) => swebenchRunKey(row.taskId, row.repetition, row.variant)));
  const missing = [...plannedSwebenchKeys(manifest)].some((key) => !observed.has(key));
  const charged = rows.reduce((total, row) => total + (row.capChargeUsd ?? row.estimatedCostUsd),
    (ledger.unfinishedChargeUsd ?? 0) + (ledger.supersededChargeUsd ?? 0));
  return missing && charged + manifest.reservationUsd > manifest.costCapUsd;
}

// Whether the provider circuit breaker opened: the manifest's number of consecutive provider_error rows, in
// results.jsonl's order (the order their jobs finished in). A resume supersedes every provider_error row before it
// runs a job, so such a run of rows can only come from the last invocation that recorded any.
export function circuitOpenFrom(manifest: SwebenchManifest, rows: SwebenchRunResult[]): boolean {
  const after = manifest.infraPolicy?.provider?.circuitBreakerAfter;
  if (!after) return false;
  let consecutive = 0;
  for (const row of rows) {
    consecutive = row.failureClass === "provider_error" ? consecutive + 1 : 0;
    if (consecutive >= after) return true;
  }
  return false;
}

export type Exclusion = "invalid_result" | "harness_error" | "grading_error" | "provider_error";
// Grading failures the patch caused (R1): scored unresolved and complete, but counted separately.
export const PATCH_CAUSED_OUTCOMES = ["test_timeout", "oom", "tests_errored"] as const;

// Rows left out of every statistic, each of which leaves an evaluation incomplete: harness substitutes, runs
// whose verdict is unknown after grading's retries, and runs a provider outage cut short on both attempts.
export function exclusionReason(row: SwebenchRunResult): Exclusion | undefined {
  return invalidMeasurement(row) ?? (row.gradingError ? "grading_error" : row.failureClass === "provider_error" ? "provider_error" : undefined);
}

export type Completeness = {
  complete: boolean;
  flags: string[];
  plannedRuns: number;
  observedRuns: number;
  // Observed rows with no exclusion: the statistics use these.
  scoredRuns: number;
  missingRuns: number;
  unplannedRuns: number;
  capReached: boolean;
  circuitOpen: boolean;
  invalidResultRuns: number;
  harnessErrorRuns: number;
  gradingErrorRuns: number;
  providerErrorRuns: number;
  // Complete, and reported separately: the environment ended the agent run, or the patch broke grading.
  environmentFailureRuns: number;
  patchCausedRuns: Record<typeof PATCH_CAUSED_OUTCOMES[number], number>;
};

// The one definition of a complete SWE-bench measurement, which the evaluation summary and eval:compare
// share: every planned run present, none excluded, and neither the cost cap nor the provider circuit breaker
// stopped it. `rows` pairs each row with its planned key.
export function assessCompleteness(
  planned: Set<string>,
  rows: Array<[string, SwebenchRunResult]>,
  capReached: boolean,
  circuitOpen = false
): Completeness {
  const observed = new Set(rows.map(([key]) => key));
  const reasons = rows.map(([, row]) => exclusionReason(row));
  const count = (reason: Exclusion) => reasons.filter((item) => item === reason).length;
  const missingRuns = [...planned].filter((key) => !observed.has(key)).length;
  const unplannedRuns = rows.filter(([key]) => !planned.has(key)).length;
  const invalidResultRuns = count("invalid_result");
  const gradingErrorRuns = count("grading_error");
  const harnessErrorRuns = count("harness_error");
  const providerErrorRuns = count("provider_error");
  const flags = [
    missingRuns ? `${missingRuns} planned run(s) missing` : "",
    unplannedRuns ? `${unplannedRuns} row(s) outside the plan` : "",
    capReached ? "the cost cap stopped the evaluation" : "",
    circuitOpen ? "the provider circuit breaker stopped the evaluation (a provider outage is suspected; resume later to re-run the provider_error rows)" : "",
    invalidResultRuns ? `${invalidResultRuns} invalid_result row(s)` : "",
    gradingErrorRuns ? `${gradingErrorRuns} grading_error row(s)` : "",
    harnessErrorRuns ? `${harnessErrorRuns} harness_error row(s)` : "",
    providerErrorRuns ? `${providerErrorRuns} provider_error row(s)` : ""
  ].filter(Boolean);
  return {
    complete: flags.length === 0,
    flags,
    plannedRuns: planned.size,
    observedRuns: rows.length,
    scoredRuns: reasons.filter((reason) => !reason).length,
    missingRuns,
    unplannedRuns,
    capReached,
    circuitOpen,
    invalidResultRuns,
    harnessErrorRuns,
    gradingErrorRuns,
    providerErrorRuns,
    environmentFailureRuns: rows.filter(([, row]) => hadEnvironmentFailure(row)).length,
    patchCausedRuns: Object.fromEntries(PATCH_CAUSED_OUTCOMES.map((outcome) =>
      [outcome, rows.filter(([, row]) => row.gradingOutcome === outcome).length])) as Completeness["patchCausedRuns"]
  };
}

export function hadEnvironmentFailure(row: SwebenchRunResult): boolean {
  return row.failureClass === "environment_failure" || parseTrace(row.traceEvents).environmentFailures > 0;
}

async function readRequired(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Missing ${path.basename(file)} in ${path.dirname(file)}`);
    throw error;
  }
}

// A row whose metrics are harness substitutes, not a measurement of the agent.
export function invalidMeasurement(row: ResultRow): "invalid_result" | "harness_error" | undefined {
  if (row.failureClass === "invalid_result") return "invalid_result";
  if (row.failureClass === "harness_error" || row.agentStatus === "harness_error") return "harness_error";
  return undefined;
}

export type TraceTurn = {
  round: number;
  toolCallNames: string[];
  finishReason?: string;
  responseModel?: string;
  latencyMs: number;
  // The full prompt of this round, and this round's output including reasoning.
  inputTokens: number;
  outputTokens: number;
};

export type TraceTool = {
  round: number;
  name: string;
  path?: string;
  ok: boolean;
  passed?: boolean;
  error?: string;
  errorCategory?: string;
  durationMs: number;
  observationBytes: number;
};

export type ParsedTrace = {
  displayRoot?: string;
  // Sorted by round.
  turns: TraceTurn[];
  // In execution order.
  tools: TraceTool[];
  textOnlyTurns: number;
  nudges: number;
  stopReason?: string;
  environmentFailures: number;
  notices: Array<{
    round: number;
    kind: "budget" | "closeout";
    writeRevision: number;
    validatedWriteRevision?: number;
  }>;
  finalVerification?: { writeRevision: number; validatedWriteRevision: number; verified: boolean };
};

export function parseTrace(events: Array<Record<string, unknown>> | undefined): ParsedTrace {
  const trace: ParsedTrace = { turns: [], tools: [], textOnlyTurns: 0, nudges: 0, environmentFailures: 0, notices: [] };
  for (const event of Array.isArray(events) ? events : []) {
    const data = (event?.data ?? {}) as Record<string, any>;
    if (event?.event === "run_started" || event?.event === "run_resumed") {
      trace.displayRoot ??= text(data.displayRoot);
    } else if (event?.event === "model_turn") {
      trace.turns.push({
        round: count(data.round) || trace.turns.length + 1,
        toolCallNames: Array.isArray(data.toolCallNames) ? data.toolCallNames.map(String) : [],
        finishReason: text(data.finishReason),
        responseModel: text(data.responseModel),
        latencyMs: count(data.latencyMs),
        inputTokens: count(data.usage?.inputTokens),
        outputTokens: count(data.usage?.outputTokens)
      });
    } else if (event?.event === "tool_result") {
      trace.tools.push({
        round: count(data.round) || (trace.turns.at(-1)?.round ?? 0),
        name: text(data.name) ?? "unknown",
        path: text(data.arguments?.path),
        ok: data.ok === true,
        passed: typeof data.passed === "boolean" ? data.passed : undefined,
        error: text(data.error),
        errorCategory: text(data.errorCategory),
        durationMs: count(data.durationMs),
        observationBytes: count(data.observationBytes)
      });
    } else if (event?.event === "text_only_turn") {
      trace.textOnlyTurns += 1;
      if (data.nudge === true) trace.nudges += 1;
    } else if (event?.event === "run_finished") {
      trace.stopReason = text(data.stopReason);
      const writeRevision = data.plan?.writeRevision;
      const validatedWriteRevision = data.plan?.validatedWriteRevision;
      trace.finalVerification = Number.isSafeInteger(writeRevision) && writeRevision >= 0 &&
        Number.isSafeInteger(validatedWriteRevision) && validatedWriteRevision >= -1 && validatedWriteRevision <= writeRevision
        ? { writeRevision, validatedWriteRevision, verified: writeRevision === validatedWriteRevision }
        : undefined;
    } else if (event?.event === "budget_notice") {
      if ((data.kind === "budget" || data.kind === "closeout") && Number.isSafeInteger(data.round) && data.round > 0 &&
          Number.isSafeInteger(data.writeRevision) && data.writeRevision >= 0) {
        trace.notices.push({
          round: data.round, kind: data.kind, writeRevision: data.writeRevision,
          ...(Number.isSafeInteger(data.validatedWriteRevision) && data.validatedWriteRevision >= -1 &&
              data.validatedWriteRevision <= data.writeRevision ? { validatedWriteRevision: data.validatedWriteRevision } : {})
        });
      }
    } else if (event?.event === "environment_failure") {
      trace.environmentFailures += 1;
    }
  }
  trace.turns.sort((a, b) => a.round - b.round);
  return trace;
}

// A rejected or errored call, or a command that timed out. A failing test run is an observation.
export function isToolFailure(tool: TraceTool): boolean {
  return !tool.ok || (tool.errorCategory !== undefined && tool.errorCategory !== "test_failed");
}

// True when this module is the script being run (tsx eval/<module>.ts), not an import.
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export async function writeReportFiles(
  output: string,
  markdown: string,
  json: unknown
): Promise<{ markdownPath: string; jsonPath: string }> {
  const base = path.resolve(output.replace(/\.(md|json)$/i, ""));
  await mkdir(path.dirname(base), { recursive: true });
  const markdownPath = `${base}.md`;
  const jsonPath = `${base}.json`;
  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(jsonPath, JSON.stringify(json, null, 2) + "\n", "utf8");
  return { markdownPath, jsonPath };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

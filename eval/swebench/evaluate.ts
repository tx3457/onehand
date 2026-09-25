import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { agentBehaviorFingerprint, fingerprintOf } from "../../src/agent/fingerprint.js";
import { resolveProfile } from "../../src/agent/profile.js";
import type { ModelProvider } from "../../src/providers/types.js";
import { InvalidResultError, JobContext, openResults, readJsonLines, runJobs } from "../core.js";
import { capReachedFrom, readRunLedger, swebenchRunKey } from "../results-io.js";
import { estimateCost, evaluationProvenance, priceSnapshotFor } from "../run.js";
import { mulberry32 } from "../stats.js";
import type { PriceSnapshot, SwebenchManifest, SwebenchRunResult } from "../types.js";
import { CONTAINER_ROOT, DEFAULT_CONTAINER_LIMITS, imageIdOf } from "./container.js";
import { ImageSource, imageFor, LoadedSplit, loadSwebenchSplit, SwebenchRecord, SwebenchSplit, taskHashFor } from "./dataset.js";
import { GRADING_OUTCOMES, harnessVersion } from "./grade.js";
import {
  DEFAULT_PROVIDER_BREAKER, runInstance, SWEBENCH_LIMITS, swebenchFailureRow, swebenchInfraPolicy, SwebenchRunRequest
} from "./runInstance.js";
import { SwebenchSummary, writeSwebenchReport } from "./summary.js";

export const DEFAULT_SCHEDULE_SEED = 20260925;
// Differ between invocations of one evaluation; every other manifest field must match on resume.
const IDENTITY_FIELDS = new Set(["evaluationId", "createdAt", "gitHead", "gitDirty", "holdoutRerunReason"]);

// One line per holdout evaluation ever started, so the holdout is used once.
export type HoldoutLedgerEntry = { evaluationId: string; createdAt: string; variants: string[]; gitHead: string | null; reason?: string };

export function holdoutLedgerPath(): string {
  return process.env.ONEHAND_HOLDOUT_LEDGER ?? path.join(homedir(), ".onehand", "swebench", "holdout-ledger.jsonl");
}

export type SwebenchEvaluationOptions = {
  split: SwebenchSplit;
  // Agent profiles; order does not matter.
  variants: string[];
  repetitions: number;
  concurrency: number;
  costCapUsd: number;
  // Held per run in flight; default: the worst-case cost of one run under SWEBENCH_LIMITS.
  reservationUsd?: number;
  model?: string;
  // Instance ids of the split; default: the whole split minus exclusions.
  taskIds?: string[];
  outputDir: string;
  apiKey: string;
  baseURL: string;
  imageSource?: ImageSource;
  keepWorkspaces?: boolean;
  scheduleSeed?: number;
  // Consecutive provider_error rows after which no new job starts; default DEFAULT_PROVIDER_BREAKER.
  providerBreaker?: number;
  // The holdout split runs only with this set.
  confirmHoldout?: boolean;
  // Why the holdout runs again although the ledger already has an evaluation of it.
  allowHoldoutRerun?: string;
  onRow?: (row: SwebenchRunResult) => void;
  // Test seams.
  files?: { splits?: string; data?: string; exclusions?: string };
  harnessVersion?: () => Promise<string>;
  resolveImageId?: (image: string) => Promise<string | undefined>;
  createProvider?: (request: SwebenchRunRequest) => ModelProvider;
  executeRun?: (request: SwebenchRunRequest, context: JobContext) => Promise<SwebenchRunResult>;
};

export type ScheduledRun = { instanceId: string; repetition: number; variant: string };
// The expected hash and repository of every planned instance.
export type PlannedTasks = Map<string, { hash: string; repo: string }>;
type SwebenchJob = { key: string; record: SwebenchRecord; repetition: number; variant: string };

export async function runSwebenchEvaluation(options: SwebenchEvaluationOptions): Promise<{
  manifest: SwebenchManifest;
  results: SwebenchRunResult[];
  capReached: boolean;
  summary: SwebenchSummary;
}> {
  // The holdout is meant to be run once: without confirmation, not even the output directory is created.
  if (options.split === "holdout" && options.confirmHoldout !== true) {
    throw new Error("The holdout split is reserved for the final evaluation; confirm it explicitly (--confirm-holdout) to run it");
  }
  if (options.allowHoldoutRerun !== undefined && (options.split !== "holdout" || !options.allowHoldoutRerun.trim())) {
    throw new Error("--allow-holdout-rerun takes a reason and applies to the holdout split only");
  }
  const variants = [...new Set(options.variants)].sort(compareText);
  if (!variants.length) throw new Error("Name at least one variant");
  const profiles = variants.map(resolveProfile);
  const providerBreaker = options.providerBreaker ?? DEFAULT_PROVIDER_BREAKER;
  for (const [name, value] of Object.entries({ repetitions: options.repetitions, concurrency: options.concurrency, providerBreaker })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  if (!(Number.isFinite(options.costCapUsd) && options.costCapUsd > 0)) {
    throw new Error(`costCapUsd must be a positive number, got ${options.costCapUsd}`);
  }
  if (options.reservationUsd !== undefined && !(Number.isFinite(options.reservationUsd) && options.reservationUsd > 0)) {
    throw new Error(`reservationUsd must be a positive number, got ${options.reservationUsd}`);
  }
  const scheduleSeed = options.scheduleSeed ?? DEFAULT_SCHEDULE_SEED;
  if (!Number.isSafeInteger(scheduleSeed)) throw new Error(`scheduleSeed must be an integer, got ${scheduleSeed}`);
  const model = options.model ?? "deepseek-flash";
  const priceSnapshot = priceSnapshotFor(model);
  const imageSource = options.imageSource ?? "epoch";
  const loaded = await loadSwebenchSplit(options.split, options.files);
  const instanceIds = selectInstances(loaded, options.taskIds);
  const swebenchVersion = await (options.harnessVersion ?? harnessVersion)();
  // Every run checks its image against these IDs, so a re-pulled tag cannot change the environment mid-evaluation.
  const resolveImageId = options.resolveImageId ?? imageIdOf;
  const imageIds: Record<string, string> = {};
  for (const id of instanceIds) {
    const image = imageFor(loaded.records.get(id)!, imageSource);
    const imageId = await resolveImageId(image);
    if (!imageId) throw new Error(`Docker image ${image} is not available locally; pull it first (OneHand never pulls images)`);
    imageIds[id] = imageId;
  }
  const outputDir = path.resolve(options.outputDir);
  const ledgerPath = holdoutLedgerPath();
  const ledger = options.split === "holdout" ? await readJsonLines<HoldoutLedgerEntry>(ledgerPath) : [];
  if (ledger.length && options.allowHoldoutRerun === undefined) {
    const resumed = await evaluationIdIn(outputDir);
    if (!ledger.some((entry) => entry.evaluationId === resumed)) {
      throw new Error(`The holdout split was already evaluated (${ledger.map((entry) => entry.evaluationId).join(", ")}; ledger ${ledgerPath}); resume that evaluation in its own output directory, or pass --allow-holdout-rerun "<reason>"`);
    }
  }
  await mkdir(outputDir, { recursive: true });
  const provenance = await evaluationProvenance();
  const createdAt = new Date().toISOString();
  const proposed: SwebenchManifest = {
    schemaVersion: 2,
    evaluationId: `swebench-${options.split}-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`,
    createdAt,
    benchmark: "swebench",
    split: options.split,
    datasetRevision: loaded.datasetRevision,
    dataFileSha256: loaded.dataFileSha256,
    swebenchVersion,
    instanceIds,
    exclusions: loaded.exclusions,
    variants: variants.map((name, index) => ({
      name, flags: { ...profiles[index]!.flags }, agentFingerprint: agentBehaviorFingerprint(profiles[index])
    })),
    repetitions: options.repetitions,
    plannedRuns: instanceIds.length * options.repetitions * variants.length,
    scheduleSeed,
    provider: "deepseek",
    model,
    thinking: "enabled",
    reasoningEffort: "high",
    temperature: null,
    limits: { ...SWEBENCH_LIMITS },
    containerLimits: { ...DEFAULT_CONTAINER_LIMITS, network: "none" },
    priceSnapshot,
    reservationUsd: options.reservationUsd ?? worstCaseRunCost(priceSnapshot),
    costCapUsd: options.costCapUsd,
    sourceFingerprint: provenance.sourceFingerprint,
    gitHead: provenance.gitHead,
    gitDirty: provenance.gitDirty,
    imageSource,
    imageIds,
    baseURL: endpointOf(options.baseURL),
    executor: "docker",
    displayRoot: CONTAINER_ROOT,
    allowTargetedVerification: true,
    infraPolicy: swebenchInfraPolicy(providerBreaker),
    holdoutConfirmed: options.split === "holdout",
    ...(options.allowHoldoutRerun === undefined ? {} : { holdoutRerunReason: options.allowHoldoutRerun })
  };
  const { manifest, existing, resultsPath, invalidPath, journalPath, supersededPath } = await openResults<SwebenchManifest, SwebenchRunResult>(
    outputDir, proposed, assertCompatibleSwebenchManifest
  );
  if (options.split === "holdout" && !ledger.some((entry) => entry.evaluationId === manifest.evaluationId)) {
    const entry: HoldoutLedgerEntry = {
      evaluationId: manifest.evaluationId,
      createdAt: manifest.createdAt,
      variants: manifest.variants.map((variant) => variant.name),
      gitHead: manifest.gitHead,
      ...(options.allowHoldoutRerun === undefined ? {} : { reason: options.allowHoldoutRerun })
    };
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await appendFile(ledgerPath, JSON.stringify(entry) + "\n", "utf8");
  }
  const tasks: PlannedTasks = new Map(instanceIds.map((id) => {
    const record = loaded.records.get(id)!;
    return [id, { hash: taskHashFor(record), repo: record.repo }];
  }));
  validateSwebenchRows(existing, manifest, tasks);

  const request = (job: SwebenchJob): SwebenchRunRequest => ({
    evaluationId: manifest.evaluationId,
    record: job.record,
    split: manifest.split,
    repetition: job.repetition,
    variant: job.variant,
    model: manifest.model,
    priceSnapshot: manifest.priceSnapshot,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    imageSource,
    imageId: imageIds[job.record.instance_id]!,
    outputDir,
    keepWorkspaces: options.keepWorkspaces ?? false
  });
  const execute = options.executeRun ?? ((run: SwebenchRunRequest, context: JobContext) => runInstance(run, {
    ...(options.createProvider ? { createProvider: options.createProvider } : {}),
    imageIdOf: resolveImageId,
    reserve: context.reserve
  }));
  const jobs = scheduleRuns(instanceIds, options.repetitions, variants, scheduleSeed).map((run): SwebenchJob => ({
    key: swebenchRunKey(run.instanceId, run.repetition, run.variant),
    record: loaded.records.get(run.instanceId)!,
    repetition: run.repetition,
    variant: run.variant
  }));
  const keyOf = (row: SwebenchRunResult) => swebenchRunKey(row.taskId, row.repetition, row.variant);
  const { rows } = await runJobs<SwebenchJob, SwebenchRunResult>({
    evaluationId: manifest.evaluationId,
    jobs,
    existing,
    concurrency: options.concurrency,
    costCapUsd: manifest.costCapUsd,
    reservationUsd: manifest.reservationUsd,
    resultsPath,
    invalidPath,
    journalPath,
    keyOf,
    execute: (job, context) => execute(request(job), context),
    validate: (results) => validateSwebenchRows(results, manifest, tasks),
    substitute: (job, error, charge) => swebenchFailureRow(request(job), error, error instanceof InvalidResultError
      ? { failureClass: "invalid_result", estimatedCostUsd: charge, capChargeUsd: charge }
      : { capChargeUsd: charge }),
    onRow: (row) => options.onRow?.(row),
    // A provider outage is not a completed job: a resume runs it again.
    rerun: { path: supersededPath, reason: (row) => row.failureClass === "provider_error" ? "provider_error rerun" : undefined },
    breaker: {
      after: providerBreaker,
      trips: (row) => row.failureClass === "provider_error",
      onOpen: () => process.stderr.write(`[swebench] Provider outage suspected after ${providerBreaker} consecutive provider errors: no new job starts, and the jobs in flight finish. Resume later to re-run them.\n`)
    }
  });
  // Derived from the rows (in results.jsonl's order), the journal, and the superseded rows rather than taken from
  // the loop, so `report` rewrites exactly this summary.
  const runLedger = await readRunLedger(outputDir, manifest, rows);
  const results = [...rows].sort((a, b) =>
    compareText(a.taskId, b.taskId) || a.repetition - b.repetition || compareText(a.variant, b.variant));
  const capReached = capReachedFrom(manifest, results, runLedger);
  const summary = await writeSwebenchReport(manifest, results, outputDir, capReached, runLedger);
  return { manifest, results, capReached, summary };
}

// The most one run can cost under SWEBENCH_LIMITS: every input token a cache miss and the whole output budget.
// Limits are checked before each model turn, so a run can exceed it by at most one turn's usage.
export function worstCaseRunCost(price: PriceSnapshot): number {
  return estimateCost({
    cacheHitInputTokens: 0,
    cacheMissInputTokens: SWEBENCH_LIMITS.maxInputTokens,
    outputTokens: SWEBENCH_LIMITS.maxOutputTokens
  }, price);
}

// Jobs in instance-id order, then by repetition. Within one (instance, repetition) the variants run in a
// seeded random order, so no variant systematically runs first (against a warmer cache or a quieter API).
export function scheduleRuns(instanceIds: readonly string[], repetitions: number, variants: readonly string[], seed: number): ScheduledRun[] {
  return [...instanceIds].sort(compareText).flatMap((instanceId) =>
    Array.from({ length: repetitions }, (_, index) => index + 1).flatMap((repetition) => {
      const mix = createHash("sha256").update(`${instanceId}#${repetition}`).digest().readUInt32BE(0);
      const random = mulberry32((seed ^ mix) >>> 0);
      const order = [...variants];
      for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [order[index], order[swap]] = [order[swap]!, order[index]!];
      }
      return order.map((variant) => ({ instanceId, repetition, variant }));
    }));
}

// Every field except the identity and provenance ones must match, whatever its key order.
export function assertCompatibleSwebenchManifest(existing: SwebenchManifest, proposed: SwebenchManifest): void {
  const a = existing as Record<string, unknown>;
  const b = proposed as Record<string, unknown>;
  const differing = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((field) => !IDENTITY_FIELDS.has(field) && fingerprintOf({ value: a[field] }) !== fingerprintOf({ value: b[field] }))
    .sort(compareText);
  if (differing.length) {
    throw new Error(`Existing evaluation manifest is incompatible with the requested run (${differing.join(", ")} differ)`);
  }
}

export function validateSwebenchRows(rows: SwebenchRunResult[], manifest: SwebenchManifest, tasks: PlannedTasks): void {
  const variants = new Set(manifest.variants.map((variant) => variant.name));
  const instances = new Set(manifest.instanceIds);
  const keys = new Set<string>();
  for (const row of rows) {
    const key = swebenchRunKey(row.taskId, row.repetition, row.variant);
    if (keys.has(key)) throw new Error(`Duplicate evaluation result: ${key}`);
    keys.add(key);
    if (row.evaluationId !== manifest.evaluationId) throw new Error(`Evaluation ID mismatch for ${key}`);
    const task = tasks.get(row.taskId);
    if (!instances.has(row.taskId) || !task || row.taskHash !== task.hash) throw new Error(`Task hash mismatch for ${key}`);
    if (row.schemaVersion !== 2 || row.benchmark !== "swebench" || row.category !== task.repo) {
      throw new Error(`Result schema or category mismatch for ${key}`);
    }
    if (!variants.has(row.variant)) throw new Error(`Unplanned variant for ${key}`);
    if (row.split !== manifest.split || row.provider !== manifest.provider || row.model !== manifest.model) {
      throw new Error(`Provider or model configuration mismatch for ${key}`);
    }
    if (row.thinking !== manifest.thinking || row.reasoningEffort !== manifest.reasoningEffort || row.temperature !== manifest.temperature) {
      throw new Error(`Inference configuration mismatch for ${key}`);
    }
    if (!Number.isInteger(row.repetition) || row.repetition < 1 || row.repetition > manifest.repetitions) {
      throw new Error(`Invalid repetition for ${key}`);
    }
    for (const [field, value] of Object.entries({
      durationMs: row.durationMs,
      modelRounds: row.modelRounds,
      toolCalls: row.toolCalls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheHitInputTokens: row.cacheHitInputTokens,
      cacheMissInputTokens: row.cacheMissInputTokens,
      reasoningTokens: row.reasoningTokens,
      estimatedCostUsd: row.estimatedCostUsd,
      retryCostUsd: row.retryCostUsd,
      capChargeUsd: row.capChargeUsd,
      patchBytes: row.patchBytes
    })) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${field} for ${key}`);
    }
    for (const [field, value] of Object.entries({
      attempts: row.attempts,
      "f2p.success": row.f2p?.success,
      "f2p.failure": row.f2p?.failure,
      "p2p.success": row.p2p?.success,
      "p2p.failure": row.p2p?.failure
    })) {
      if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${field} for ${key}`);
    }
    for (const [field, value] of Object.entries({
      resolved: row.resolved,
      falseSuccess: row.falseSuccess,
      agentVerificationPassed: row.agentVerificationPassed,
      emptyPatch: row.emptyPatch,
      patchApplied: row.patchApplied
    })) {
      if (typeof value !== "boolean") throw new Error(`Invalid ${field} for ${key}`);
    }
    for (const [field, value] of Object.entries({
      startedAt: row.startedAt,
      agentStatus: row.agentStatus,
      difficulty: row.difficulty,
      finalMessage: row.finalMessage
    })) {
      if (typeof value !== "string") throw new Error(`Invalid ${field} for ${key}`);
    }
    for (const [field, value] of Object.entries({
      stopReason: row.stopReason, failureClass: row.failureClass, gradingError: row.gradingError, containerName: row.containerName
    })) {
      if (value !== undefined && typeof value !== "string") throw new Error(`Invalid ${field} for ${key}`);
    }
    for (const [field, value] of Object.entries({ responseModels: row.responseModels, patchFiles: row.patchFiles, patchWarnings: row.patchWarnings ?? [] })) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Invalid ${field} for ${key}`);
    }
    // A job is charged at least what it spent, final attempt and discarded ones alike. Rows that never reached the
    // agent hold too: a job that threw is charged its reservation at zero cost.
    if (row.capChargeUsd < row.estimatedCostUsd + row.retryCostUsd - 1e-9) {
      throw new Error(`capChargeUsd is less than estimatedCostUsd + retryCostUsd for ${key}`);
    }
    if (row.gradingOutcome !== undefined && !GRADING_OUTCOMES.includes(row.gradingOutcome)) throw new Error(`Invalid gradingOutcome for ${key}`);
    if (!Array.isArray(row.traceEvents)) throw new Error(`Invalid traceEvents for ${key}`);
    if (row.falseSuccess !== (row.agentStatus === "success" && !row.resolved)) throw new Error(`Inconsistent falseSuccess for ${key}`);
    if (row.gradingError !== undefined && row.resolved) throw new Error(`Resolved despite a grading error: ${key}`);
    if (row.resolved && row.gradingOutcome !== "scored") throw new Error(`Resolved without a harness report: ${key}`);
  }
}

// Named ids must be in the split and not excluded by self-check; the result keeps the split's order.
function selectInstances(loaded: LoadedSplit, taskIds?: string[]): string[] {
  if (taskIds === undefined) return loaded.instanceIds;
  const named = new Set(taskIds);
  const excluded = loaded.exclusions.filter((entry) => named.has(entry.instanceId));
  if (excluded.length) {
    throw new Error(`Excluded from the ${loaded.split} split: ${excluded.map((entry) => `${entry.instanceId} (${entry.reason})`).join("; ")}`);
  }
  const unknown = [...named].filter((id) => !loaded.instanceIds.includes(id));
  if (!named.size || unknown.length) throw new Error(`Not in the ${loaded.split} split: ${unknown.join(", ") || "(no ids)"}`);
  return loaded.instanceIds.filter((id) => named.has(id));
}

// The evaluation already in an output directory, if any.
async function evaluationIdIn(outputDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")) as { evaluationId?: unknown };
    return typeof manifest?.evaluationId === "string" ? manifest.evaluationId : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// The endpoint, never credentials: user info, query, and fragment are dropped.
function endpointOf(baseURL: string): string {
  const url = new URL(baseURL);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

// Code-point order, independent of the locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactDeep } from "../../src/agent/persistence.js";
import { estimateCost, PriceSnapshot, priceSnapshotFor } from "../../src/pricing.js";
import { readJsonLines } from "../core.js";
import { imageIdOf } from "./container.js";
import { imageFor, loadSwebenchSplit, SwebenchSplit, taskHashFor } from "./dataset.js";
import { ExternalSummary, writeExternalReport } from "./external-report.js";
import { GRADING_OUTCOMES, GradeResult, gradeRun, harnessVersion } from "./grade.js";
import { GRADE_TIMEOUT_SEC } from "./runInstance.js";

const HARNESS_VERSION = "5.0.2";
type JsonObject = Record<string, unknown>;
export type MiniMetrics = {
  modelRounds: number;
  apiCalls: number | null;
  inputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  exitStatus: string | null;
  responseModels: string[];
  miniVersion: string | null;
  miniConfig: { stepLimit: number | null; costLimitUsd: number | null; networkDisabled: boolean | null };
};
export type ExternalRow = MiniMetrics & {
  schemaVersion: 1;
  reference: "external";
  taskId: string;
  label: string;
  split: SwebenchSplit;
  model: string;
  priceSnapshot: PriceSnapshot;
  inputFingerprint: string;
  imageSource: "epoch";
  imageId: string | null;
  swebenchVersion: string;
  emptyPatch: boolean;
  resolved: boolean;
  patchApplied: boolean;
  gradingOutcome: GradeResult["outcome"];
  f2p: GradeResult["f2p"];
  p2p: GradeResult["p2p"];
  reportPath: string | null;
};
export type ExternalOptions = {
  preds: string;
  trajectories: string;
  split: SwebenchSplit;
  taskIds?: string[];
  label: string;
  model: string;
  imageSource: "epoch";
  concurrency: number;
  outputDir: string;
  // Local fixture files, as in the existing SWE-bench evaluation tests.
  files?: { splits?: string; data?: string; exclusions?: string };
};
type ExternalManifest = Pick<ExternalRow,
  "schemaVersion" | "reference" | "label" | "split" | "model" | "priceSnapshot" | "imageSource" | "swebenchVersion"
> & { jobs: Record<string, { inputFingerprint: string; imageId: string | null }> };

// Read only the documented telemetry/config fields: prompts, tool outputs, and raw responses never enter rows.
export function readMiniTrajectory(value: unknown, price: PriceSnapshot): MiniMetrics {
  const trajectory = object(value, "trajectory");
  const info = object(trajectory.info, "trajectory.info");
  if (!Array.isArray(trajectory.messages)) throw new Error("trajectory.messages must be an array");
  const usage = { modelRounds: 0, inputTokens: 0, cacheHitInputTokens: 0, cacheMissInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const models = new Set<string>();
  for (const [index, message] of trajectory.messages.entries()) {
    const response = optionalObject(optionalObject(object(message, `messages[${index}]`).extra).response);
    if (typeof response.model === "string") models.add(response.model);
    if (response.usage === undefined || response.usage === null) continue;
    const raw = object(response.usage, `messages[${index}].usage`);
    const count = (key: string) => tokenCount(raw[key], `messages[${index}].usage.${key}`);
    const input = count("prompt_tokens");
    const hit = count("prompt_cache_hit_tokens");
    const miss = count("prompt_cache_miss_tokens");
    const output = count("completion_tokens");
    const reasoning = tokenCount(optionalObject(raw.completion_tokens_details).reasoning_tokens ?? 0, `messages[${index}].usage.reasoning_tokens`);
    if (hit + miss !== input || reasoning > output) throw new Error(`messages[${index}].usage has inconsistent token counts`);
    usage.modelRounds++;
    usage.inputTokens += input;
    usage.cacheHitInputTokens += hit;
    usage.cacheMissInputTokens += miss;
    usage.outputTokens += output;
    usage.reasoningTokens += reasoning;
  }
  // Do not substitute info.model_stats.api_calls: rounds count responses that actually carry usage.
  for (const [key, count] of Object.entries(usage)) tokenCount(count, `aggregate usage.${key}`);
  const config = optionalObject(info.config);
  const agent = optionalObject(config.agent);
  const apiCalls = optionalObject(info.model_stats).api_calls;
  return {
    ...usage,
    apiCalls: apiCalls == null ? null : tokenCount(apiCalls, "info.model_stats.api_calls"),
    estimatedCostUsd: estimateCost(usage, price),
    exitStatus: optionalString(info.exit_status, "info.exit_status"),
    responseModels: [...models].sort(),
    miniVersion: optionalString(info.mini_version, "info.mini_version"),
    miniConfig: {
      stepLimit: optionalLimit(agent.step_limit, "info.config.agent.step_limit", true),
      costLimitUsd: optionalLimit(agent.cost_limit, "info.config.agent.cost_limit"),
      networkDisabled: networkDisabled(optionalObject(config.environment).run_args)
    }
  };
}

export async function gradeExternal(options: ExternalOptions): Promise<{ rows: ExternalRow[]; summary: ExternalSummary }> {
  if (options.split !== "dev" && options.split !== "holdout") throw new Error("Expected dev or holdout split");
  if (!options.label.trim()) throw new Error("External label must not be empty");
  if (options.imageSource !== "epoch") throw new Error("External grading requires --image-source epoch");
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error("concurrency must be a positive integer");
  const priceSnapshot = priceSnapshotFor(options.model);
  const loaded = await loadSwebenchSplit(options.split, options.files);
  const selected = options.taskIds === undefined ? loaded.instanceIds : [...new Set(options.taskIds)];
  if (!selected.length || selected.some(id => !loaded.instanceIds.includes(id))) {
    throw new Error(`Task ids must be non-excluded members of the ${options.split} split`);
  }
  const instanceIds = loaded.instanceIds.filter(id => selected.includes(id));
  const predictions = object(JSON.parse(await readFile(options.preds, "utf8")), "preds.json");
  const reportOptions = { ...options, priceSnapshot, instanceIds };
  const resultsPath = path.join(options.outputDir, "external-results.jsonl");

  // Validate all inputs before any grading. Missing trajectories cannot be priced honestly as zero.
  const jobs = await Promise.all(instanceIds.map(async taskId => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(taskId)) throw new Error(`Invalid split instance id: ${taskId}`);
    const prediction = Object.hasOwn(predictions, taskId) ? object(predictions[taskId], `prediction ${taskId}`) : {};
    if (prediction.instance_id !== undefined && prediction.instance_id !== taskId) throw new Error(`Prediction instance_id does not match ${taskId}`);
    if (prediction.model_patch != null && typeof prediction.model_patch !== "string") throw new Error(`Prediction model_patch must be a string for ${taskId}`);
    const patch = (prediction.model_patch ?? "") as string;
    const raw = await readFile(path.join(options.trajectories, taskId, `${taskId}.traj.json`), "utf8");
    const metrics = readMiniTrajectory(JSON.parse(raw), priceSnapshot);
    const record = loaded.records.get(taskId)!;
    const inputFingerprint = createHash("sha256").update(JSON.stringify({
      label: options.label, split: options.split, model: options.model, priceSnapshot,
      imageSource: options.imageSource, swebenchVersion: HARNESS_VERSION,
      datasetRevision: loaded.datasetRevision, taskHash: taskHashFor(record), patch, trajectory: raw
    })).digest("hex");
    return { taskId, record, patch, metrics, inputFingerprint };
  }));
  const rows = await readJsonLines<ExternalRow>(resultsPath);
  const manifestPath = path.join(options.outputDir, "external-manifest.json");
  const savedManifest = await readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (rows.length && savedManifest === undefined) throw new Error("External resume mismatch: missing external-manifest.json");
  const manifest: ExternalManifest = savedManifest === undefined ? redactDeep({
    schemaVersion: 1, reference: "external", label: options.label, split: options.split, model: options.model,
    priceSnapshot, imageSource: "epoch", swebenchVersion: HARNESS_VERSION, jobs: {}
  }) : JSON.parse(savedManifest);
  if (manifest?.schemaVersion !== 1 || manifest.reference !== "external" || manifest.imageSource !== "epoch" ||
      manifest.swebenchVersion !== HARNESS_VERSION || !manifest.jobs ||
      Object.keys(manifest.jobs).some(id => !instanceIds.includes(id))) {
    throw new Error("External resume manifest mismatch");
  }
  for (const job of jobs) {
    const frozen = manifest.jobs[job.taskId];
    if (frozen && (frozen.inputFingerprint !== job.inputFingerprint ||
        (job.patch.trim() ? !/^sha256:[0-9a-f]{64}$/.test(frozen.imageId ?? "") : frozen.imageId !== null))) {
      throw new Error(`External resume input or image mismatch for ${job.taskId}`);
    }
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const job = jobs.find(job => job.taskId === row?.taskId);
    if (!job || seen.has(row.taskId) || row.schemaVersion !== 1 || row.reference !== "external" || row.inputFingerprint !== job.inputFingerprint ||
        !manifest.jobs[row.taskId] || row.imageId !== manifest.jobs[row.taskId]!.imageId ||
        row.imageSource !== "epoch" || row.swebenchVersion !== HARNESS_VERSION) {
      throw new Error(`External resume input mismatch or duplicate row for ${row?.taskId ?? "unknown task"}`);
    }
    validateVerdict(row);
    // Reconstruct the metadata projection to catch damaged rows, preserving only their graded verdict.
    const metadata = redactDeep({ ...job.metrics, label: options.label, model: options.model, split: options.split, priceSnapshot });
    for (const key of Object.keys(metadata) as Array<keyof typeof metadata>) {
      if (JSON.stringify(row[key]) !== JSON.stringify(metadata[key])) throw new Error(`External resume metadata mismatch for ${row.taskId}: ${key}`);
    }
    seen.add(row.taskId);
  }
  const pending = jobs.filter(job => !seen.has(job.taskId));
  if (pending.some(job => job.patch.trim())) {
    const version = await harnessVersion();
    if (version !== HARNESS_VERSION) throw new Error(`External grading requires swebench ${HARNESS_VERSION}; found ${version}`);
    for (const job of pending.filter(job => job.patch.trim())) {
      if (manifest.jobs[job.taskId]) continue;
      const image = imageFor(job.record, "epoch");
      const imageId = await imageIdOf(image);
      if (!imageId) throw new Error(`Docker image ${image} is not available locally; OneHand never pulls images`);
      if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error(`Invalid local image ID for ${job.taskId}`);
      manifest.jobs[job.taskId] = { inputFingerprint: job.inputFingerprint, imageId };
    }
  }
  for (const job of jobs.filter(job => !job.patch.trim())) {
    manifest.jobs[job.taskId] = { inputFingerprint: job.inputFingerprint, imageId: null };
  }
  await mkdir(options.outputDir, { recursive: true });
  // Freeze every selected image before the first grading, including jobs an interruption might leave pending.
  // Resume uses the stored IDs directly, so a retag cannot silently change a pending job's environment.
  const manifestTemp = `${manifestPath}.${randomUUID()}.tmp`;
  await writeFile(manifestTemp, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(manifestTemp, manifestPath);
  // Serialized appends keep each completed row durable and intact even with concurrent harness processes.
  let writes = Promise.resolve();
  let cursor = 0;
  let failure: unknown;
  let stopped = false;
  async function worker(): Promise<void> {
    while (!stopped) {
      const job = pending[cursor++];
      if (!job) return;
      try {
        const imageId = manifest.jobs[job.taskId]!.imageId ?? undefined;
        const verdict = await gradeRun({
          record: job.record, imageSource: "epoch", patch: job.patch, imageId,
          runId: `external-${randomUUID()}`, modelName: "external-reference",
          workDir: path.join(options.outputDir, "grading"), timeoutSec: GRADE_TIMEOUT_SEC
        });
        const row: ExternalRow = redactDeep({
          ...job.metrics, schemaVersion: 1, reference: "external", taskId: job.taskId,
          label: options.label, split: options.split, model: options.model, priceSnapshot,
          inputFingerprint: job.inputFingerprint, imageSource: "epoch", imageId: imageId ?? null,
          swebenchVersion: HARNESS_VERSION, emptyPatch: !job.patch.trim(), resolved: verdict.resolved,
          patchApplied: verdict.patchApplied, gradingOutcome: verdict.outcome,
          f2p: verdict.f2p, p2p: verdict.p2p, reportPath: verdict.reportPath
        });
        validateVerdict(row);
        writes = writes.then(async () => {
          await appendFile(resultsPath, JSON.stringify(row) + "\n", { encoding: "utf8", mode: 0o600 });
          rows.push(row);
        });
        await writes;
      } catch (error) {
        if (!stopped) failure = error;
        stopped = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, worker));
  // An exhausted infrastructure retry has no verdict: leave that instance pending for the next invocation.
  const summary = await writeExternalReport(reportOptions, rows);
  if (stopped) throw failure;
  return { rows, summary };
}

function validateVerdict(row: ExternalRow): void {
  if (!GRADING_OUTCOMES.includes(row.gradingOutcome) || typeof row.resolved !== "boolean" || typeof row.patchApplied !== "boolean" ||
      typeof row.emptyPatch !== "boolean" || row.emptyPatch !== (row.gradingOutcome === "empty_patch") ||
      (row.resolved && (row.gradingOutcome !== "scored" || !row.patchApplied)) ||
      (!row.emptyPatch && !/^sha256:[0-9a-f]{64}$/.test(row.imageId ?? ""))) {
    throw new Error(`Invalid external grading verdict for ${row.taskId}`);
  }
  for (const counts of [row.f2p, row.p2p]) {
    tokenCount(counts?.success, "grading success count");
    tokenCount(counts?.failure, "grading failure count");
  }
}

function object(value: unknown, where: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as JsonObject;
}
function optionalObject(value: unknown): JsonObject {
  return value == null ? {} : object(value, "trajectory field");
}
function tokenCount(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${where} must be a non-negative integer`);
  return value;
}
function optionalString(value: unknown, where: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  return value;
}
function optionalLimit(value: unknown, where: string, integer = false): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${where} must be a non-negative ${integer ? "integer" : "number"}`);
  }
  return value;
}
function networkDisabled(value: unknown): boolean | null {
  if (value == null) return null;
  const args = typeof value === "string" ? value.trim().split(/\s+/) : value;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("info.config.environment.run_args must be strings");
  let network: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (/^--(?:network|net)=/.test(args[i])) network = args[i].split("=").slice(1).join("=");
    else if (args[i] === "--network" || args[i] === "--net") network = args[++i];
  }
  return network === undefined ? null : network === "none";
}

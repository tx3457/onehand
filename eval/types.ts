import type { ImageSource, SwebenchExclusion, SwebenchSplit } from "./swebench/dataset.js";
import type { GradingOutcome } from "./swebench/grade.js";
import { EvaluationCategory } from "./tasks.js";

export type EvaluationRunResult = {
  schemaVersion: 1;
  evaluationId: string;
  taskId: string;
  taskHash: string;
  category: EvaluationCategory;
  split: "pilot" | "full";
  repetition: number;
  provider: "deepseek";
  model: string;
  thinking: "enabled";
  reasoningEffort: "high";
  temperature: number | null;
  startedAt: string;
  durationMs: number;
  agentStatus: string;
  stopReason?: string;
  hiddenTestPassed: boolean;
  hiddenTestExitCode: number | null;
  publicTestPassed: boolean;
  changedFiles: string[];
  forbiddenChanges: string[];
  outsideMutation: boolean;
  gitHeadChanged: boolean;
  mutationCorrect: boolean;
  resolved: boolean;
  falseSuccess: boolean;
  correctRefusal: boolean;
  agentVerificationPassed: boolean;
  canaryLeak: boolean;
  safetyBehaviorSatisfied: boolean;
  modelRounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  estimatedCostUsd: number;
  // What the cost cap actually charged this run: estimatedCostUsd for a normal row, the audited
  // amount for an invalid-result substitution, or the worst-case run cost for a thrown run.
  // Optional so older rows without it fall back to estimatedCostUsd.
  capChargeUsd?: number;
  finalMessage: string;
  failureClass?: string;
  traceEvents: Array<Record<string, unknown>>;
};

export type EvaluationManifest = {
  schemaVersion: 1;
  evaluationId: string;
  createdAt: string;
  split: "pilot" | "full";
  repetitions: number;
  taskCount: number;
  plannedRuns: number;
  provider: "deepseek";
  model: string;
  thinking: "enabled";
  reasoningEffort: "high";
  temperature: number | null;
  agentFingerprint: string;
  // sha256 over every .ts file under src/, so any code change makes a resumed evaluation incompatible.
  sourceFingerprint: string;
  // Provenance only, not compared for resume compatibility.
  gitHead: string | null;
  gitDirty: boolean | null;
  limits: {
    maxSteps: number;
    maxToolCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWallTimeMs: number;
    commandTimeoutSec: number;
    maxTurnOutputTokens: number;
    maxTextOnlyNudges: number;
    modelTimeoutMs: number;
    maxApiAttempts: number;
    retryDelayMs: number;
    costCapUsd: number;
  };
  priceSnapshot: PriceSnapshot;
  tasks: Array<{ id: string; category: EvaluationCategory; hash: string }>;
};

export type PriceSnapshot = {
  source: string;
  checkedAt: string;
  model: string;
  basis: "peak";
  peakHoursUtc: string;
  inputCacheHitPerMillionUsd: number;
  inputCacheMissPerMillionUsd: number;
  outputPerMillionUsd: number;
};

// Phase 1 Stage B2 (SWE-bench) row: one agent variant on one instance. The common fields keep the
// T1 names and meanings; the rest describe the extracted patch and the official harness verdict.
export type SwebenchRunResult = {
  schemaVersion: 2;
  evaluationId: string;
  benchmark: "swebench";
  variant: string;
  // The SWE-bench instance_id.
  taskId: string;
  taskHash: string;
  // The source repository, e.g. django/django.
  category: string;
  split: SwebenchSplit;
  repetition: number;
  provider: "deepseek" | "openai";
  model: string;
  thinking: "enabled" | "disabled";
  reasoningEffort: "high" | "max";
  temperature: number | null;
  startedAt: string;
  durationMs: number;
  agentStatus: string;
  stopReason?: string;
  resolved: boolean;
  falseSuccess: boolean;
  agentVerificationPassed: boolean;
  modelRounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  reasoningTokens: number;
  // The final attempt's cost: the attempt whose trajectory this row describes, and the per-task cost metric.
  estimatedCostUsd: number;
  // The summed cost of attempts a provider outage ended and the job then re-ran; 0 when there were none.
  retryCostUsd: number;
  // What the job was charged in all: estimatedCostUsd + retryCostUsd, or the held reservation for a job that threw.
  capChargeUsd: number;
  // Model ids the API reported, to catch a silent model substitution.
  responseModels: string[];
  // Fresh workspace-and-container setups the job used, over every attempt.
  attempts: number;
  // The opaque name (onehand-<16 hex>) of the last attempt's container and workspace directory.
  containerName?: string;
  failureClass?: string;
  finalMessage: string;
  traceEvents: Array<Record<string, unknown>>;
  difficulty: string;
  patchBytes: number;
  patchFiles: string[];
  // Files patch extraction could not read, or why extraction failed; the rest of the patch was still graded.
  patchWarnings?: string[];
  emptyPatch: boolean;
  // From the harness log's patch-apply markers.
  patchApplied: boolean;
  // How grading reached its verdict; absent when there is none (the run was not graded, or grading failed).
  gradingOutcome?: GradingOutcome;
  f2p: { success: number; failure: number };
  p2p: { success: number; failure: number };
  // Set when grading still failed after its retries; resolved is then false.
  gradingError?: string;
};

export type SwebenchManifest = {
  schemaVersion: 2;
  evaluationId: string;
  createdAt: string;
  benchmark: "swebench";
  split: SwebenchSplit;
  datasetRevision: string;
  dataFileSha256: string;
  swebenchVersion: string;
  // After exclusions.
  instanceIds: string[];
  exclusions: SwebenchExclusion[];
  variants: Array<{ name: string; flags: Record<string, boolean | number | string>; agentFingerprint: string }>;
  repetitions: number;
  plannedRuns: number;
  scheduleSeed: number;
  provider: "deepseek" | "openai";
  model: string;
  thinking: "enabled" | "disabled";
  reasoningEffort: "high" | "max";
  temperature: number | null;
  limits: Omit<EvaluationManifest["limits"], "costCapUsd">;
  containerLimits: { cpus: number; memory: string; network: "none" };
  priceSnapshot: PriceSnapshot;
  // The worst-case cost held against the cap while a run is in flight.
  reservationUsd: number;
  costCapUsd: number;
  sourceFingerprint: string;
  gitHead: string | null;
  gitDirty: boolean | null;
  // How the agent ran. Every Stage B2 evaluation writes these; they are optional only so that readers
  // (eval:compare, eval:analyze) keep accepting manifests without them.
  imageSource?: ImageSource;
  // The local image ID each instance's image resolved to when the evaluation started; every run checks it.
  imageIds?: Record<string, string>;
  // The model endpoint, without credentials or query.
  baseURL?: string;
  executor?: "docker";
  displayRoot?: string;
  allowTargetedVerification?: boolean;
  infraPolicy?: SwebenchInfraPolicy;
  holdoutConfirmed: boolean;
  // Why a holdout evaluation ran although the holdout ledger already had one (--allow-holdout-rerun).
  holdoutRerunReason?: string;
};

// The pre-registered handling of infrastructure failures, frozen in the manifest.
export type SwebenchInfraPolicy = Record<"images" | "preAgent" | "duringAgent" | "provider" | "patchExtraction" | "grading" | "afterAgent", {
  maxAttempts?: number;
  timeoutSec?: number;
  failureClass?: string;
  // provider: the consecutive provider_error rows after which no new job starts (--provider-breaker).
  circuitBreakerAfter?: number;
  rule: string;
}>;

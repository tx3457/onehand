import { randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactDeep } from "../../src/agent/persistence.js";
import { resolveProfile } from "../../src/agent/profile.js";
import { NETWORK_ERROR_CODES, runAgent } from "../../src/agent/runner.js";
import { DeepSeekChatProvider } from "../../src/providers/deepseek.js";
import type { ModelProvider } from "../../src/providers/types.js";
import { FatalJobError } from "../core.js";
import { estimateCost, readTrace } from "../run.js";
import type { PriceSnapshot, SwebenchInfraPolicy, SwebenchRunResult } from "../types.js";
import { CONTAINER_ROOT, ImageMismatchError, imageIdOf, InfraError, opaqueName, startContainer } from "./container.js";
import { agentTaskFor, ImageSource, imageFor, SwebenchRecord, SwebenchSplit, taskHashFor, testCommandFor } from "./dataset.js";
import { GradeResult, gradeRun, MAX_GRADE_ATTEMPTS } from "./grade.js";
import { ExtractedPatch, extractPatch, PatchExtractionError } from "./patch.js";
import { prepareWorkspace, SwebenchWorkspace } from "./workspace.js";

// Starting budgets for one SWE-bench run, to be adjusted by calibration; the manifest freezes them.
export const SWEBENCH_LIMITS = {
  maxSteps: 80,
  maxToolCalls: 150,
  maxInputTokens: 3_000_000,
  maxOutputTokens: 150_000,
  maxWallTimeMs: 30 * 60_000,
  commandTimeoutSec: 600,
  maxTurnOutputTokens: 16_384,
  maxTextOnlyNudges: 2,
  modelTimeoutMs: 300_000,
  maxApiAttempts: 4,
  retryDelayMs: 2_000
};
export const MAX_SETUP_ATTEMPTS = 3;
// A job whose agent run a provider outage ended runs once more.
export const MAX_JOB_ATTEMPTS = 2;
// Consecutive provider_error rows after which no new job starts (--provider-breaker).
export const DEFAULT_PROVIDER_BREAKER = 3;
// The official harness's default per-instance timeout.
export const GRADE_TIMEOUT_SEC = 1_800;
const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// Statuses no request of this evaluation can get past: authentication, balance, permission, or an unknown model.
const ACCOUNT_ERROR_STATUSES = new Set([401, 402, 403, 404]);

export const INFRA_POLICY: SwebenchInfraPolicy = swebenchInfraPolicy(DEFAULT_PROVIDER_BREAKER);

export function swebenchInfraPolicy(providerBreaker: number): SwebenchInfraPolicy {
  return {
    images: {
      rule: "Before any job runs, every instance image's local ID is resolved and frozen in the manifest (imageIds). A run checks that its image still resolves to that ID before it prepares its workspace, and again right before grading, because the harness grades by tag. A mismatch or a missing image stops the evaluation without a retry; the job keeps its journaled reservation."
    },
    preAgent: {
      maxAttempts: MAX_SETUP_ATTEMPTS,
      failureClass: "harness_error",
      rule: "A failure before any model call (the workspace copy, the container start, the editable-install sanity check) is retried up to 2 more times, each with a fresh workspace and container. If every attempt fails, the run is a harness_error row with zero usage and cost."
    },
    duringAgent: {
      maxAttempts: 1,
      failureClass: "environment_failure",
      rule: "An execution-environment failure during the agent run (stopReason runtime_error with an environment_failure trace event) is not retried, because tokens were spent. The run keeps its real usage and cost, its patch is still extracted and graded, and failureClass is environment_failure. It counts as completed and is reported separately."
    },
    provider: {
      maxAttempts: MAX_JOB_ATTEMPTS,
      failureClass: "provider_error",
      circuitBreakerAfter: providerBreaker,
      rule: `A run that stops with model_error is classified from its last model_attempt_failed trace event. Status 429, a status of 500 or more, a timeout, or a network failure (no response at all, or a socket code such as ECONNRESET, ETIMEDOUT, EAI_AGAIN, or UND_ERR_SOCKET) is a provider outage, not an agent outcome: the job is retried once as a whole, from a fresh workspace and container, when the cost cap can hold the failed attempt's cost on top of the job's reservation. The row describes the final attempt: estimatedCostUsd is that attempt's cost alone, so an outage does not bias the cost of the variant it hit; retryCostUsd is the discarded attempt's cost (0 without a retry); capChargeUsd is what the job cost in all, their sum; attempts counts both attempts' setups. If the retry also ends in an outage, or the cap cannot hold a retry, the graded row has failureClass provider_error: it is excluded from every statistic and leaves the evaluation incomplete, and it does not count as a completed job, so a resume runs the job again: the row moves, redacted, to superseded-results.jsonl, and its capChargeUsd keeps counting against the cap. After ${providerBreaker} consecutive provider_error rows, in the order their jobs finish, a provider outage is suspected: no new job starts, the jobs in flight finish, and the evaluation stops incomplete with stopReason provider_circuit_open, to be resumed later; any other row resets the count. Status 401, 402, 403, or 404 (authentication, balance, permission, unknown model) stops the evaluation at once without a row, since no later run could get past it either; a resume re-runs the job. Any other model_error (e.g. status 400) is the agent's outcome.`
    },
    patchExtraction: {
      failureClass: "patch_extraction_failed",
      rule: "The patch is staged with git add -A --ignore-errors: what git cannot read (the agent can make files unreadable) is left out and listed in patchWarnings, and the rest is graded. If the tree the agent left still keeps git from producing a patch (git add fails outright, or the patch exceeds 256 MiB), the run is not graded: it is scored unresolved with failureClass patch_extraction_failed and counts as complete."
    },
    grading: {
      maxAttempts: MAX_GRADE_ATTEMPTS,
      timeoutSec: GRADE_TIMEOUT_SEC,
      failureClass: "grading_error",
      rule: "The official harness's report is the verdict. Without one, its logs (run_instance.log, test_output.txt) and the report's infra_failure fields decide why, by the harness's own markers. A failure the patch caused is scored unresolved like the official harness scores it, is not retried, and leaves the evaluation complete; gradingOutcome records it: patch_apply_failed, test_timeout, oom (the report flags out_of_memory, or the logs show Killed or Cannot allocate memory), or tests_errored (the harness failed after the tests ran). Only an unavailable environment is retried, up to 3 attempts: the harness's own log shows the container_unavailable signature, a Docker API error, or a host I/O failure (no space, read-only, I/O error), or the harness stopped before the instance's tests started. A report's container_unavailable reason is not such evidence: the harness derives it from test_output.txt alone, which the patched code writes, so that report's verdict stands. If all attempts fail, the run keeps its usage and cost and records gradingError, resolved false, and failureClass grading_error; the evaluation is then incomplete. Each attempt grades in the pinned image ID under a fresh run id. patchApplied follows the log's patch-apply markers."
    },
    afterAgent: {
      failureClass: "harness_error",
      rule: "Any other error after the agent has run (stopping the container, running git to extract the patch, a grading error that is not an infrastructure error) makes the run a harness_error row that keeps its usage and cost. A run that throws with no row at all has an unknown cost: it is recorded as harness_error at zero cost and charged the full reservation against the cap. A job an interrupted invocation left without a row is charged its journaled reservation on resume."
    }
  };
}

export type SwebenchRunRequest = {
  evaluationId: string;
  record: SwebenchRecord;
  split: SwebenchSplit;
  repetition: number;
  variant: string;
  model: string;
  priceSnapshot: PriceSnapshot;
  apiKey: string;
  baseURL: string;
  imageSource: ImageSource;
  // The local ID the manifest pinned for the instance's image.
  imageId: string;
  // Grading writes under <outputDir>/grading.
  outputDir: string;
  keepWorkspaces: boolean;
};

// Everything that touches Docker, the harness, the model, the cost cap, or the clock, so the flow is testable
// without them.
export type RunInstanceDeps = {
  prepareWorkspace: typeof prepareWorkspace;
  startContainer: typeof startContainer;
  extractPatch: typeof extractPatch;
  gradeRun: typeof gradeRun;
  runAgent: typeof runAgent;
  createProvider: (request: SwebenchRunRequest) => ModelProvider;
  imageIdOf: typeof imageIdOf;
  // Asks the evaluation's cost cap to hold more for this job (JobContext.reserve).
  reserve: (amountUsd: number) => Promise<boolean>;
  now: () => number;
};

const DEFAULT_DEPS: RunInstanceDeps = {
  prepareWorkspace,
  startContainer,
  extractPatch,
  gradeRun,
  runAgent,
  createProvider: (request) => new DeepSeekChatProvider({ apiKey: request.apiKey, baseURL: request.baseURL }),
  imageIdOf,
  reserve: async () => true,
  now: () => Date.now()
};

type Outage = { costUsd: number; attempts: number };

// The provider refused the evaluation's credentials, balance, permissions, or model: every later run would fail
// the same way, so the evaluation stops instead of scoring them all as the agent's failures.
export class ProviderAccountError extends FatalJobError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAccountError";
  }
}

// <evaluationId>-<instanceId>-r<repetition>-<variant>: the stem of the grading run id. Only the harness sees it.
export function swebenchRunId(request: Pick<SwebenchRunRequest, "evaluationId" | "record" | "repetition" | "variant">): string {
  return `${request.evaluationId}-${request.record.instance_id}-r${request.repetition}-${request.variant}`;
}

// 24 random ASCII alphanumerics, so no two runs share a provider prompt cache.
export function newCacheIsolationNonce(): string {
  return Array.from({ length: 24 }, () => NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)]).join("");
}

// Whether a provider outage (rate limiting, a server error, a timeout, a dropped or refused connection), not
// the request, failed the model call that ended the run: the last model_attempt_failed event decides.
export function providerOutage(traceEvents: Array<Record<string, unknown>>): boolean {
  const failure = lastModelFailure(traceEvents);
  if (!failure) return false;
  const status = typeof failure.status === "number" ? failure.status : undefined;
  return status === 429 || (status !== undefined && status >= 500) || failure.timedOut === true || failure.connectionError === true ||
    (typeof failure.code === "string" && NETWORK_ERROR_CODES.includes(failure.code));
}

function lastModelFailure(traceEvents: Array<Record<string, unknown>>) {
  return traceEvents.filter((event) => event.event === "model_attempt_failed").at(-1)?.data as
    { status?: unknown; code?: unknown; timedOut?: unknown; connectionError?: unknown } | undefined;
}

// One job: `variant` on one instance for one repetition, from a fresh workspace to a graded row. It returns
// a row for every outcome whose cost it knows, and throws only when it does not (creating the provider or the
// run directory failed, or the agent run itself threw) or when the pinned image changed (ImageMismatchError,
// which stops the evaluation).
export async function runInstance(request: SwebenchRunRequest, overrides: Partial<RunInstanceDeps> = {}): Promise<SwebenchRunResult> {
  const deps: RunInstanceDeps = { ...DEFAULT_DEPS, ...overrides };
  const started = deps.now();
  const timing = () => ({ startedAt: new Date(started).toISOString(), durationMs: Math.max(0, deps.now() - started) });
  const first = await runAttempt(request, deps, timing);
  if (!("outage" in first)) return first;
  // A provider outage is not the agent's doing, so the job runs once more from scratch.
  const second = await runAttempt(request, deps, timing, first.outage);
  if ("outage" in second) throw new Error("A retried SWE-bench job must end in a row");
  return second;
}

// One attempt at the job. The first returns `outage` in place of a row when a provider outage ended its agent
// run and the cap can hold a retry; the retry gets that outage as `retried`, and always returns a row.
async function runAttempt(
  request: SwebenchRunRequest,
  deps: RunInstanceDeps,
  timing: () => { startedAt: string; durationMs: number },
  retried?: Outage
): Promise<SwebenchRunResult | { outage: Outage }> {
  const { record } = request;
  const image = imageFor(record, request.imageSource);
  const checkImage = async () => {
    const actual = await deps.imageIdOf(image);
    if (actual !== request.imageId) {
      throw new ImageMismatchError(`${image} ${actual ? `now resolves to ${actual}` : "is no longer available locally"}, but this evaluation pinned ${request.imageId}; restore that image or start a new evaluation`);
    }
  };
  const discard = async (workspace: SwebenchWorkspace) => {
    if (request.keepWorkspaces) return;
    await workspace.cleanup().catch((error: unknown) => {
      process.stderr.write(`[swebench] could not remove workspace ${workspace.root}: ${errorMessage(error)}\n`);
    });
  };
  let containerName: string | undefined;
  const setUp = async () => {
    await checkImage();
    const profile = resolveProfile(request.variant);
    const command = testCommandFor(record);
    // Opaque, so neither the container nor its bind mount's host path names the instance or the variant.
    const name = opaqueName();
    containerName = name;
    process.stderr.write(`[swebench] ${name}: ${record.instance_id} r${request.repetition} ${request.variant} (${request.evaluationId})\n`);
    const workspace = await deps.prepareWorkspace(record, name, request.imageSource);
    try {
      const container = await deps.startContainer(record, workspace.repo, name, request.imageSource);
      return { profile, command, workspace, container };
    } catch (error) {
      await discard(workspace);
      throw error;
    }
  };

  // Nothing has called the model yet, so a failure costs nothing and gets a fresh workspace and container.
  let setup: Awaited<ReturnType<typeof setUp>> | undefined;
  let setupError: unknown;
  let setups = 0;
  while (!setup && setups < MAX_SETUP_ATTEMPTS) {
    setups += 1;
    try {
      setup = await setUp();
    } catch (error) {
      if (error instanceof FatalJobError) throw error;
      setupError = error;
    }
  }
  // The row describes this attempt; one discarded after an outage is charged, but kept out of estimatedCostUsd.
  const retryCostUsd = retried?.costUsd ?? 0;
  const attempts = (retried?.attempts ?? 0) + setups;
  if (!setup) {
    return swebenchFailureRow(request, setupError, {
      ...timing(), attempts, retryCostUsd, capChargeUsd: retryCostUsd, ...(containerName ? { containerName } : {})
    });
  }

  const { profile, command, workspace, container } = setup;
  let runDir: string | undefined;
  try {
    const provider = deps.createProvider(request);
    runDir = await mkdtemp(path.join(tmpdir(), `onehand-swe-run-${swebenchRunId(request)}-`));
    const report = await deps.runAgent({
      task: agentTaskFor(record),
      repoPath: workspace.repo,
      displayRoot: CONTAINER_ROOT,
      executor: container.executor,
      testCommand: command.base,
      trustedTestCommand: true,
      allowTargetedVerification: true,
      testTargetHint: command.targetHint,
      cacheIsolationNonce: newCacheIsolationNonce(),
      provider,
      model: request.model,
      thinking: "enabled",
      reasoningEffort: "high",
      maxSteps: SWEBENCH_LIMITS.maxSteps,
      maxToolCalls: SWEBENCH_LIMITS.maxToolCalls,
      maxInputTokens: SWEBENCH_LIMITS.maxInputTokens,
      maxOutputTokens: SWEBENCH_LIMITS.maxOutputTokens,
      maxWallTimeMs: SWEBENCH_LIMITS.maxWallTimeMs,
      timeoutSec: SWEBENCH_LIMITS.commandTimeoutSec,
      maxTurnOutputTokens: SWEBENCH_LIMITS.maxTurnOutputTokens,
      maxTextOnlyNudges: SWEBENCH_LIMITS.maxTextOnlyNudges,
      modelTimeoutMs: SWEBENCH_LIMITS.modelTimeoutMs,
      maxApiAttempts: SWEBENCH_LIMITS.maxApiAttempts,
      retryDelayMs: SWEBENCH_LIMITS.retryDelayMs,
      profile,
      enforcePlanning: true,
      persistence: true,
      runDir
    });
    // The model calls happened, so every row from here on keeps their usage and cost.
    const usage = report.usage!;
    const costUsd = estimateCost(usage, request.priceSnapshot);
    const traceEvents = await readTrace(report.tracePath);
    const status = report.stopReason === "model_error" ? lastModelFailure(traceEvents)?.status : undefined;
    if (typeof status === "number" && ACCOUNT_ERROR_STATUSES.has(status)) {
      throw new ProviderAccountError(`The model provider answered ${status} (${redactDeep(report.finalMessage.slice(0, 200))}); fix the account or model, then resume`);
    }
    const providerError = report.stopReason === "model_error" && providerOutage(traceEvents);
    // Retry only while the cap can hold this attempt's cost on top of the job's reservation for the next.
    if (providerError && !retried && await deps.reserve(costUsd)) return { outage: { costUsd, attempts } };
    const measured = {
      modelRounds: usage.modelRounds,
      toolCalls: usage.toolCalls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheHitInputTokens: usage.cacheHitInputTokens,
      cacheMissInputTokens: usage.cacheMissInputTokens,
      reasoningTokens: usage.reasoningTokens ?? 0,
      estimatedCostUsd: costUsd,
      retryCostUsd,
      capChargeUsd: retryCostUsd + costUsd
    };
    const responseModels = [...new Set(traceEvents.flatMap((event) => {
      const model = event.event === "model_turn" ? (event.data as { responseModel?: unknown } | undefined)?.responseModel : undefined;
      return typeof model === "string" && model ? [model] : [];
    }))].sort();
    const environmentFailure = report.stopReason === "runtime_error" && traceEvents.some((event) => event.event === "environment_failure");
    const rowFor = (fields: {
      resolved: boolean;
      patch: ExtractedPatch | { error: string };
      grade?: GradeResult;
      gradingError?: string;
    }): SwebenchRunResult => {
      const extracted = "error" in fields.patch ? undefined : fields.patch;
      const patchWarnings = "error" in fields.patch ? [fields.patch.error.slice(0, 1000)] : fields.patch.warnings;
      const emptyPatch = extracted !== undefined && !extracted.patch.trim();
      const falseSuccess = report.status === "success" && !fields.resolved;
      return redactDeep({
        schemaVersion: 2,
        evaluationId: request.evaluationId,
        benchmark: "swebench",
        variant: request.variant,
        taskId: record.instance_id,
        taskHash: taskHashFor(record),
        category: record.repo,
        split: request.split,
        repetition: request.repetition,
        provider: provider.name,
        model: request.model,
        thinking: "enabled",
        reasoningEffort: "high",
        temperature: null,
        ...timing(),
        agentStatus: report.status,
        stopReason: report.stopReason,
        resolved: fields.resolved,
        falseSuccess,
        agentVerificationPassed: report.tests.some((test) => test.passed),
        ...measured,
        responseModels,
        attempts,
        containerName: container.name,
        failureClass: failureClassOf({
          gradingError: fields.gradingError, providerError, environmentFailure, patchExtractionFailed: !extracted,
          resolved: fields.resolved, emptyPatch, patchApplied: fields.grade?.patchApplied ?? false, falseSuccess, agentStatus: report.status
        }),
        finalMessage: report.finalMessage.slice(0, 1000),
        traceEvents,
        difficulty: record.difficulty,
        patchBytes: extracted?.bytes ?? 0,
        patchFiles: extracted?.files ?? [],
        ...(patchWarnings.length ? { patchWarnings } : {}),
        emptyPatch,
        patchApplied: fields.grade?.patchApplied ?? false,
        ...(fields.grade && fields.gradingError === undefined ? { gradingOutcome: fields.grade.outcome } : {}),
        f2p: fields.grade?.f2p ?? { success: 0, failure: 0 },
        p2p: fields.grade?.p2p ?? { success: 0, failure: 0 },
        ...(fields.gradingError === undefined ? {} : { gradingError: fields.gradingError })
      } satisfies SwebenchRunResult);
    };
    try {
      // The checkout must not change after the patch is taken.
      await container.stop();
      let patch: ExtractedPatch;
      try {
        patch = await deps.extractPatch(workspace.repo, workspace.baseCommit);
      } catch (error) {
        if (!(error instanceof PatchExtractionError)) throw error;
        return rowFor({ resolved: false, patch: { error: `patch extraction failed: ${error.message}` } });
      }
      try {
        // The tag must still name the pinned image; the harness then grades in that image by its ID.
        await checkImage();
        const grade = await deps.gradeRun({
          record,
          imageSource: request.imageSource,
          imageId: request.imageId,
          patch: patch.patch,
          // Fresh per attempt, so no harness left over from an interrupted invocation can write into its logs.
          runId: `${swebenchRunId(request)}.${container.name.replace(/^onehand-/, "")}`,
          modelName: `onehand-${request.variant}`,
          workDir: path.join(request.outputDir, "grading"),
          timeoutSec: GRADE_TIMEOUT_SEC
        });
        return rowFor({ resolved: grade.resolved, patch, grade });
      } catch (error) {
        // gradeRun already retried; anything but an infrastructure failure (or a changed image) is a harness error.
        if (!(error instanceof InfraError)) throw error;
        return rowFor({ resolved: false, patch, gradingError: error.message.slice(0, 1000) });
      }
    } catch (error) {
      if (error instanceof FatalJobError) throw error;
      return swebenchFailureRow(request, error, {
        ...timing(),
        provider: provider.name,
        stopReason: report.stopReason,
        ...measured,
        responseModels,
        attempts,
        containerName: container.name,
        traceEvents
      });
    }
  } finally {
    await container.stop().catch(() => undefined);
    await discard(workspace);
    if (runDir && !request.keepWorkspaces) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// A row the harness writes in place of a measurement: a setup that never reached the model, an error after
// the agent ran (the overrides then keep its usage), or the evaluation loop's substitute for a job that threw
// or produced an invalid row.
export function swebenchFailureRow(
  request: Pick<SwebenchRunRequest, "evaluationId" | "record" | "split" | "repetition" | "variant" | "model">,
  error: unknown,
  overrides: Partial<SwebenchRunResult> = {}
): SwebenchRunResult {
  return redactDeep({
    schemaVersion: 2,
    evaluationId: request.evaluationId,
    benchmark: "swebench",
    variant: request.variant,
    taskId: request.record.instance_id,
    taskHash: taskHashFor(request.record),
    category: request.record.repo,
    split: request.split,
    repetition: request.repetition,
    provider: "deepseek",
    model: request.model,
    thinking: "enabled",
    reasoningEffort: "high",
    temperature: null,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    agentStatus: "harness_error",
    resolved: false,
    falseSuccess: false,
    agentVerificationPassed: false,
    modelRounds: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    retryCostUsd: 0,
    capChargeUsd: 0,
    responseModels: [],
    attempts: 0,
    failureClass: "harness_error",
    finalMessage: errorMessage(error).slice(0, 1000),
    traceEvents: [],
    difficulty: request.record.difficulty,
    patchBytes: 0,
    patchFiles: [],
    emptyPatch: true,
    patchApplied: false,
    f2p: { success: 0, failure: 0 },
    p2p: { success: 0, failure: 0 },
    ...overrides
  } satisfies SwebenchRunResult);
}

// Why a graded run is not resolved, most specific first. An environment failure keeps its label whatever
// the verdict, as the infrastructure policy pre-registers, and so does an unretried provider outage.
function failureClassOf(input: {
  gradingError?: string;
  providerError: boolean;
  environmentFailure: boolean;
  patchExtractionFailed: boolean;
  resolved: boolean;
  emptyPatch: boolean;
  patchApplied: boolean;
  falseSuccess: boolean;
  agentStatus: string;
}): string | undefined {
  if (input.gradingError !== undefined) return "grading_error";
  if (input.providerError) return "provider_error";
  if (input.environmentFailure) return "environment_failure";
  if (input.patchExtractionFailed) return "patch_extraction_failed";
  if (input.resolved) return undefined;
  if (input.emptyPatch) return "empty_patch";
  if (!input.patchApplied) return "patch_apply_failure";
  if (input.falseSuccess) return "false_success";
  return `agent_${input.agentStatus}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

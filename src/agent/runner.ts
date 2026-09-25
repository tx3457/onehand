import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { APIConnectionError } from "openai";
import { PlanController } from "./planning.js";
import { AgentEvent, emitAgentEvent, summarizeEventArguments, summarizeToolOutcome, toolSucceeded } from "./events.js";
import type { AuthorizationRequest, PermissionMode } from "../policy/permissions.js";
import { CheckpointStore } from "../runtime/checkpoints.js";
import { PersistedRunState, RUN_STATE_VERSION, RunStore, summarizeToolArguments } from "./persistence.js";
import { AgentProfile, PROFILES, resolveFeatures } from "./profile.js";
import { buildUserPrompt, effectiveSystemPrompt } from "./prompt.js";
import { REVIEW_CHANGES_TOOL_DEFINITION, runSubagent } from "./subagents.js";
import { createModelProvider } from "../providers/index.js";
import type { ModelProvider, NormalizedToolCall, ResponsesClient } from "../providers/index.js";
import { maskProviderHistory } from "../providers/historyMasking.js";
import { Executor, LocalExecutor, resolveDisplayRoot } from "../runtime/executor.js";
import { PlanSnapshot, RunReport, RunStatus, RunUsage, StopReason, ToolResult } from "../types.js";
import { renderToolResult } from "../tools/render.js";
import { createToolRegistry, EXPLORE_TOOL_DEFINITION, serializeToolResult, type ExtraTools } from "../tools/registry.js";
import { gitDiff, gitStatus, HOST_DIFF_FLAGS, HostGitOptions, runHostGit } from "../tools/git.js";
import { normalizeRepoRoot } from "../tools/pathGuard.js";
import { isProtectedRepoPath, resolveInsideRepo, shouldSkipDir } from "../tools/pathGuard.js";
import { detectTestCommand } from "../tools/testCommand.js";

export type { ResponsesClient } from "../providers/index.js";

export type RunAgentOptions = {
  task: string;
  repoPath: string;
  mode?: PermissionMode;
  authorize?: (request: AuthorizationRequest) => Promise<"allow" | "deny">;
  completion?: "finish_task" | "answer";
  checkpoints?: boolean | CheckpointStore;
  projectInstructions?: string;
  onEvent?: (event: AgentEvent) => void;
  testCommand?: string;
  providerName?: "openai" | "deepseek";
  provider?: ModelProvider;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
  temperature?: number;
  maxSteps?: number;
  maxToolCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTurnOutputTokens?: number;
  maxTextOnlyNudges?: number;
  maxWallTimeMs?: number;
  timeoutSec?: number;
  modelTimeoutMs?: number;
  maxApiAttempts?: number;
  retryDelayMs?: number;
  allowDestructive?: boolean;
  enforcePlanning?: boolean;
  persistence?: boolean;
  runDir?: string;
  resume?: string;
  signal?: AbortSignal;
  client?: ResponsesClient;
  executor?: Executor;
  // The repository root as the model sees it, e.g. /testbed for a container bind mount.
  displayRoot?: string;
  trustedTestCommand?: boolean;
  // Whether a passing run_tests with targets verifies the latest change; SWE-bench runs set it.
  allowTargetedVerification?: boolean;
  testTargetHint?: string;
  // Fills CACHE_ISOLATION_TEMPLATE ahead of the system prompt so runs do not share a provider prompt cache.
  cacheIsolationNonce?: string;
  profile?: AgentProfile;
  extraTools?: ExtraTools;
  interactiveTools?: ("explore" | "review_changes")[];
  // Internal controls used by the depth-one read-only sub-agent runner.
  subagentDepth?: number;
  readOnlyTools?: boolean;
  systemPrompt?: string;
};

const DEFAULT_USAGE: RunUsage = {
  modelRounds: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheHitInputTokens: 0,
  cacheMissInputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  wallTimeMs: 0
};
export const TEXT_ONLY_NUDGE = "A plain assistant message does not complete the task. Call the next tool you need, or call finish_task once every plan step is complete and the latest change is verified.";
export const OUTPUT_LIMIT_NUDGE = "Your previous response hit the output limit before any tool call. Continue by calling the next tool you need; keep reasoning brief.";
// Only the nonce varies between runs; the behavior fingerprint covers this fixed template.
export const CACHE_ISOLATION_TEMPLATE = "Session: <nonce>";
const CACHE_ISOLATION_NONCE = /^[A-Za-z0-9-]{8,64}$/;
const OBSERVATION_MASK_PROMPT_TOKENS = 48_000;
// A dropped, refused, or timed-out connection, as Node's sockets and undici (under fetch) report it.
export const NETWORK_ERROR_CODES: readonly string[] = [
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"
];
const TOOL_FAILURE_CATEGORIES: Array<[string, RegExp]> = [
  ["timeout", /timed out/i],
  ["schema", /not valid JSON|must be (one of|an object|an array|a string|a boolean|a number|an integer|>=|<=)|is required|\.\S+ is not allowed|must contain at (least|most)/],
  ["plan_gate", /Call set_plan before|Repeated failure requires|active plan is blocked|Set a plan before|Replan after|plan steps must be completed|passing verification after|No plan was set/],
  ["policy", /disabled|allowlist|Protected|protected|outside repository|escapes repository|resolves outside|Shell operator|Executable paths|Shell interpreters|Dependency or environment mutation|Git mutation|NUL bytes|dedicated repository tool/],
  ["not_found", /ENOENT|not found|No such file/],
  ["unknown_tool", /Unknown tool/]
];

export class ModelCallError extends Error {
  readonly status?: number;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ModelCallError";
    this.status = statusCode(cause);
  }
}

export class RuntimeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeFailure";
  }
}

export async function runAgent(options: RunAgentOptions): Promise<RunReport> {
  if (options.cacheIsolationNonce !== undefined && !validCacheIsolationNonce(options.cacheIsolationNonce, options.subagentDepth)) {
    throw new Error("cacheIsolationNonce must be 8-64 ASCII letters, digits, or hyphens");
  }
  const profile = options.profile ?? PROFILES.baseline;
  const features = resolveFeatures(profile.flags);
  const repoRoot = await normalizeRepoRoot(options.repoPath);
  const executor = options.executor ?? new LocalExecutor();
  const displayRoot = resolveDisplayRoot(executor, repoRoot, options.displayRoot);
  const providerName = options.provider?.name ?? options.providerName ?? "openai";
  const provider = options.provider ?? createModelProvider({
    provider: providerName,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    responsesClient: options.client
  });
  const model = options.model ?? (provider.name === "deepseek" ? "deepseek-v4-pro" : process.env.OPENAI_MODEL ?? "gpt-5.5");
  const enforcePlanning = options.enforcePlanning ?? (options.client === undefined);
  const persistenceEnabled = options.persistence ?? enforcePlanning;
  const limits = {
    maxSteps: options.maxSteps ?? 20,
    maxToolCalls: options.maxToolCalls ?? 40,
    maxInputTokens: options.maxInputTokens ?? 300_000,
    maxOutputTokens: options.maxOutputTokens ?? 40_000,
    maxTurnOutputTokens: options.maxTurnOutputTokens ?? 8_192,
    maxTextOnlyNudges: options.maxTextOnlyNudges ?? 2,
    maxWallTimeMs: options.maxWallTimeMs ?? 15 * 60_000,
    timeoutSec: options.timeoutSec ?? 120,
    modelTimeoutMs: options.modelTimeoutMs ?? 180_000,
    maxApiAttempts: options.maxApiAttempts ?? 3,
    retryDelayMs: options.retryDelayMs ?? 1_000
  };
  // Commands in a container can write the checkout that host git reads, so no global or system config.
  const git: HostGitOptions = { timeoutSec: limits.timeoutSec, isolatedConfig: executor.kind === "docker" };
  const gitHead = await readGitHead(repoRoot, git);
  const worktreeFingerprint = options.resume
    ? await readWorktreeFingerprint(repoRoot, gitHead, git)
    : null;

  let store: RunStore | undefined;
  let restored: PersistedRunState | undefined;
  if (options.resume) {
    const loaded = await RunStore.load(options.resume);
    store = loaded.store;
    restored = loaded.state;
    validateResume(restored, {
      task: options.task,
      repo: repoRoot,
      provider: provider.name,
      model,
      gitHead,
      worktreeFingerprint
    });
  } else if (persistenceEnabled) {
    store = new RunStore({ runDir: options.runDir });
  }

  const plan = new PlanController(restored?.plan);
  const verificationCommand = options.testCommand ?? await detectTestCommand(repoRoot) ?? "";
  const allowTargetedVerification = options.allowTargetedVerification ?? false;
  const systemPrompt = options.systemPrompt ?? effectiveSystemPrompt(features);
  const instructions = options.cacheIsolationNonce
    ? `${CACHE_ISOLATION_TEMPLATE.replace("<nonce>", options.cacheIsolationNonce)}\n\n${systemPrompt}`
    : systemPrompt;
  let observerTimeMs = 0;
  const emit = (event: AgentEvent) => {
    if (!options.onEvent) return;
    const before = Date.now();
    emitAgentEvent(options.onEvent, event);
    observerTimeMs += Date.now() - before;
  };
  const checkpoints = options.checkpoints === true ? new CheckpointStore(repoRoot) : options.checkpoints || undefined;
  let checkpointTaken = false;
  let checkpointRound = 0;
  const usage: RunUsage = { ...(restored?.usage ?? DEFAULT_USAGE) };
  let subagentIndex = 0;
  const interactiveReview = options.subagentDepth === undefined && options.interactiveTools?.includes("review_changes") === true;
  const interactiveExplore = options.subagentDepth === undefined && options.interactiveTools?.includes("explore") === true;
  const delegatedDefinitions = [
    ...(options.extraTools?.definitions ?? []),
    ...(interactiveExplore && !features.exploreSubagent ? [EXPLORE_TOOL_DEFINITION] : []),
    ...(interactiveReview ? [REVIEW_CHANGES_TOOL_DEFINITION] : [])
  ];
  const supportsSubagents = options.subagentDepth === undefined && (features.exploreSubagent === true || interactiveExplore || interactiveReview);
  const delegatedTools: ExtraTools | undefined = options.extraTools || supportsSubagents ? {
    definitions: delegatedDefinitions,
    execute: async (name, args, context) => {
      if ((name === "explore" && (features.exploreSubagent === true || interactiveExplore)) || (name === "review_changes" && interactiveReview)) {
        subagentIndex += 1;
        usage.wallTimeMs = (restored?.usage.wallTimeMs ?? 0) + (Date.now() - invocationStarted - observerTimeMs);
        const report = await runSubagent({
          preset: name === "explore" ? "explore" : "review",
          ...(name === "explore" ? { question: args.question as string } : {}),
          task: options.task,
          plan: plan.snapshot(),
          parent: {
            ...options,
            repoPath: repoRoot,
            provider,
            model,
            executor,
            displayRoot,
            onEvent: options.onEvent ? emit : undefined
          },
          parentUsage: usage,
          parentLimits: limits,
          subagentIndex,
          trace: store ? (event, data) => store!.trace(event, data) : undefined
        });
        addSubagentUsage(usage, report.usage);
        return report.status === "success"
          ? { ok: true, data: report.finalMessage }
          : { ok: false, error: `Sub-agent stopped (${report.stopReason ?? report.status}): ${report.finalMessage || "no report"}`, recoverable: true };
      }
      if (options.extraTools) return options.extraTools.execute(name, args, context);
      return { ok: false, error: `Unknown tool: ${name}`, recoverable: true };
    }
  } : undefined;
  const registry = createToolRegistry({
    repoRoot,
    features,
    testCommand: verificationCommand,
    timeoutSec: limits.timeoutSec,
    allowDestructive: options.allowDestructive ?? false,
    enforcePlanning,
    plan,
    executor,
    displayRoot,
    trustedTestCommand: options.trustedTestCommand,
    allowTargetedVerification,
    authorize: options.authorize,
    extraTools: delegatedTools,
    readOnly: options.readOnlyTools,
    onEvent: options.onEvent ? emit : undefined,
    signal: options.mode !== undefined ? options.signal : undefined,
    beforeMutation: checkpoints ? async () => {
      if (options.signal?.aborted) throw new Error("Run cancelled before checkpoint");
      if (!checkpointTaken) {
        const checkpoint = await checkpoints.snapshot(`Before round ${checkpointRound}: ${options.task.slice(0, 100)}`);
        checkpointTaken = true;
        emit({ type: "checkpoint_created", id: checkpoint.id, label: checkpoint.label });
      }
      if (options.signal?.aborted) throw new Error("Run cancelled before mutation");
    } : undefined
  });
  if (restored?.records) registry.records.push(...restored.records);
  let userPrompt = buildUserPrompt({
    task: options.task,
    repo: displayRoot,
    testCommand: verificationCommand,
    testTargetHint: options.testTargetHint
  });
  if (options.projectInstructions !== undefined) userPrompt += `\n\nProject instructions (from AGENTS.md):\n${options.projectInstructions}`;
  if (options.completion === "answer") userPrompt += "\n\nFor this run, answer the user's question with a plain assistant message when ready. A text-only answer completes this run; finish_task is not required.";
  const history = restored?.history ?? provider.initialHistory(userPrompt);
  const failureSignatures = new Map(Object.entries(restored?.failureSignatures ?? {}));
  let finalMessage = restored?.finalMessage ?? "";
  let textOnlyNudges = restored?.textOnlyNudges ?? 0;
  let previousPromptTokens = restored?.previousPromptTokens ?? 0;
  let status: RunStatus = "failed";
  let stopReason: StopReason = "step_budget";
  const startedAt = restored?.startedAt ?? new Date().toISOString();
  const invocationStarted = Date.now();

  if (store) {
    await store.trace(options.resume ? "run_resumed" : "run_started", {
      runId: store.runId,
      repo: repoRoot,
      displayRoot,
      executor: executor.kind,
      profile: profile.name,
      profileFlags: profile.flags,
      allowTargetedVerification,
      provider: provider.name,
      model,
      limits
    });
    const redactedReasoning = restored?.history
      .filter((item) => (item as { reasoning_content?: unknown })?.reasoning_content === "[REDACTED]").length ?? 0;
    if (redactedReasoning) await store.trace("reasoning_redacted_on_resume", { count: redactedReasoning });
  }

  let shouldStop = false;
  emit({ type: "run_started", task: options.task, mode: options.mode ?? "auto" });
  try {
    for (; usedRounds(usage) < limits.maxSteps && !shouldStop;) {
      usage.wallTimeMs = (restored?.usage.wallTimeMs ?? 0) + (Date.now() - invocationStarted - observerTimeMs);
      const preflight = budgetReason(usage, limits, options.signal);
      if (preflight) {
        stopReason = preflight;
        status = statusForReason(preflight);
        break;
      }

      if (features.observationMasking && previousPromptTokens > OBSERVATION_MASK_PROMPT_TOKENS) {
        const statusResult = await gitStatus(repoRoot, git.timeoutSec, git.isolatedConfig);
        const masked = maskProviderHistory(
          provider.name,
          history,
          renderContextNote(plan.snapshot(), statusResult.ok ? statusResult.data.changedFiles : [])
        );
        if (masked.maskedItems > 0) {
          history.splice(0, history.length, ...masked.history);
          await store?.trace("context_masked", {
            round: usage.modelRounds,
            promptTokensBefore: previousPromptTokens,
            maskedItems: masked.maskedItems,
            bytesRemoved: masked.bytesRemoved,
            bytesKept: masked.bytesKept,
            keptRounds: masked.keptRounds
          });
          await saveCheckpoint(store, {
            task: options.task,
            repo: repoRoot,
            gitHead,
            provider: provider.name,
            model,
            history,
            plan: plan.snapshot(),
            usage,
            records: registry.records,
            failureSignatures,
            finalMessage,
            status: "stopped",
            textOnlyNudges,
            previousPromptTokens,
            startedAt
          }, git);
        }
      }

      const turnStarted = Date.now();
      const turn = await completeWithRetry(provider, {
        model,
        instructions,
        history,
        tools: registry.definitions,
        reasoningEffort: options.reasoningEffort ?? "high",
        thinking: options.thinking ?? "enabled",
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: Math.max(1, Math.min(limits.maxTurnOutputTokens, limits.maxOutputTokens - usage.outputTokens)),
        signal: options.signal
      }, {
        ...limits,
        modelTimeoutMs: Math.max(1, Math.min(limits.modelTimeoutMs, limits.maxWallTimeMs - usage.wallTimeMs))
      }, store, options.mode !== undefined);
      const latencyMs = Date.now() - turnStarted;
      usage.modelRounds += 1;
      addUsage(usage, turn.usage);
      previousPromptTokens = turn.usage.inputTokens;
      history.push(...turn.historyItems);
      if (turn.message) finalMessage = turn.message;
      checkpointTaken = false;
      checkpointRound = usage.modelRounds;
      if (options.onEvent) emit({
        type: "model_turn", round: usage.modelRounds, usage: turn.usage,
        ...(turn.message ? { text: turn.message } : {}),
        toolCalls: turn.toolCalls.map((call) => ({ name: call.name, argsSummary: summarizeEventArguments(call.arguments) }))
      });
      await store?.trace("model_turn", {
        round: usage.modelRounds,
        toolCallNames: turn.toolCalls.map((call) => call.name),
        finishReason: turn.finishReason,
        latencyMs,
        responseModel: turn.model,
        usage: turn.usage
      });

      const postModelBudget = budgetReason(usage, limits, options.signal);
      if (postModelBudget) {
        appendSkippedToolResults(provider, history, turn.toolCalls, `Run stopped before tool execution: ${postModelBudget}`, features.compactObservations);
        stopReason = postModelBudget;
        status = statusForReason(postModelBudget);
        break;
      }
      if (turn.toolCalls.length === 0) {
        if (options.completion === "answer") {
          status = "success";
          stopReason = "answered";
        } else if (enforcePlanning) {
          const outputLimited = turn.finishReason === "length";
          const nudge = textOnlyNudges < limits.maxTextOnlyNudges;
          await store?.trace("text_only_turn", { round: usage.modelRounds, finishReason: turn.finishReason, nudge });
          if (nudge) {
            textOnlyNudges += 1;
            history.push(...provider.initialHistory(outputLimited ? OUTPUT_LIMIT_NUDGE : TEXT_ONLY_NUDGE));
            continue;
          }
          status = "failed";
          stopReason = outputLimited ? "output_limit" : "model_stopped_without_finish";
        } else {
          const lastTest = registry.records.filter((record) => record.type === "test").at(-1);
          status = lastTest && !lastTest.passed ? "failed" : "success";
          stopReason = lastTest && !lastTest.passed ? "blocked" : "explicit_finish";
        }
        shouldStop = true;
        break;
      }

      for (let callIndex = 0; callIndex < turn.toolCalls.length; callIndex += 1) {
        const call = turn.toolCalls[callIndex]!;
        if (options.mode !== undefined && options.signal?.aborted) {
          appendSkippedToolResults(provider, history, turn.toolCalls.slice(callIndex), "Run cancelled before tool execution", features.compactObservations);
          status = "cancelled";
          stopReason = "cancelled";
          shouldStop = true;
          break;
        }
        if (usage.toolCalls >= limits.maxToolCalls) {
          appendSkippedToolResults(
            provider,
            history,
            turn.toolCalls.slice(callIndex),
            "Run stopped before tool execution: tool budget exhausted",
            features.compactObservations
          );
          status = "budget_exhausted";
          stopReason = "tool_budget";
          shouldStop = true;
          break;
        }
        usage.toolCalls += 1;
        const toolStarted = Date.now();
        const observerTimeAtToolStart = observerTimeMs;
        const previousPlan = options.onEvent ? plan.snapshot() : undefined;
        if (options.onEvent) emit({ type: "tool_started", name: call.name, argsSummary: summarizeEventArguments(call.arguments) });
        const result = await registry.execute(call.name, call.arguments);
        const durationMs = Date.now() - toolStarted - (observerTimeMs - observerTimeAtToolStart);
        if (options.onEvent) emit({
          type: "tool_finished", name: call.name, ok: toolSucceeded(result), durationMs,
          summary: summarizeToolOutcome(call.name, call.arguments, result, durationMs)
        });
        const observation = features.compactObservations ? renderToolResult(call.name, result) : serializeToolResult(result);
        history.push(provider.toolResultItem(call, observation));
        // Hashed so a persisted failureSignatures key never carries raw tool arguments (which can
        // include secrets); only equality is needed for the repeated-failure check below.
        const signature = createHash("sha256").update(stableSignature(call)).digest("hex");
        if (isFailedObservation(call.name, result)) {
          const failures = (failureSignatures.get(signature) ?? 0) + 1;
          failureSignatures.set(signature, failures);
          if (failures >= 2) plan.requireReplan();
        }
        if (previousPlan) {
          const currentPlan = plan.snapshot();
          if (previousPlan.revision !== currentPlan.revision || previousPlan.needsReplan !== currentPlan.needsReplan) {
            emit({ type: "plan_updated", plan: currentPlan });
          }
        }
        await store?.trace("tool_result", {
          round: usage.modelRounds,
          name: call.name,
          arguments: summarizeToolArguments(call.arguments),
          ok: result.ok,
          passed: call.name === "run_tests" && result.ok
            ? (result.data as { passed?: boolean }).passed
            : undefined,
          error: result.ok ? undefined : result.error,
          errorCategory: categorizeToolFailure(call.name, result),
          truncated: result.ok ? result.truncated ?? false : false,
          durationMs,
          observationBytes: Buffer.byteLength(observation),
          planRevision: plan.snapshot().revision
        });
        if (!result.ok && result.code === "environment") {
          // The container or daemon failed, not the agent: stop, so the harness can retry the run as infrastructure.
          status = "failed";
          stopReason = "runtime_error";
          finalMessage = `Execution environment failure: ${result.error}`;
          await store?.trace("environment_failure", { round: usage.modelRounds, name: call.name, error: result.error.slice(0, 500) });
          shouldStop = true;
        }
        if (registry.finishAccepted) {
          status = "success";
          stopReason = "explicit_finish";
          finalMessage = plan.snapshot().summary ?? finalMessage;
          shouldStop = true;
        }
        if (call.name === "update_plan" && result.ok && plan.snapshot().status === "blocked") {
          status = "blocked";
          stopReason = "blocked";
          finalMessage = "The active plan is blocked.";
          shouldStop = true;
        }
        if (options.mode !== undefined && options.signal?.aborted) {
          status = "cancelled";
          stopReason = "cancelled";
          shouldStop = true;
        }
        usage.wallTimeMs = (restored?.usage.wallTimeMs ?? 0) + (Date.now() - invocationStarted - observerTimeMs);
        if (!shouldStop && usage.subagentRounds !== undefined) {
          const sharedBudget = usedRounds(usage) >= limits.maxSteps
            ? "step_budget"
            : budgetReason(usage, limits, options.signal);
          if (sharedBudget) {
            status = statusForReason(sharedBudget);
            stopReason = sharedBudget;
            shouldStop = true;
          }
        }
        const checkpointHistory = [...history];
        appendSkippedToolResults(
          provider,
          checkpointHistory,
          turn.toolCalls.slice(callIndex + 1),
          "Tool call was not executed before this checkpoint",
          features.compactObservations
        );
        await saveCheckpoint(store, {
          task: options.task,
          repo: repoRoot,
          gitHead,
          provider: provider.name,
          model,
          history: checkpointHistory,
          plan: plan.snapshot(),
          usage,
          records: registry.records,
          failureSignatures,
          finalMessage,
          status: shouldStop ? status : "stopped",
          stopReason: shouldStop ? stopReason : undefined,
          textOnlyNudges,
          ...(features.observationMasking ? { previousPromptTokens } : {}),
          startedAt
        }, git);
        if (shouldStop) {
          appendSkippedToolResults(
            provider,
            history,
            turn.toolCalls.slice(callIndex + 1),
            options.mode !== undefined && stopReason === "cancelled"
              ? "Run cancelled before tool execution"
              : status === "budget_exhausted"
                ? `Run stopped before tool execution: ${stopReason}`
                : "Run stopped after explicit finish",
            features.compactObservations
          );
          break;
        }
      }
    }
    if (!shouldStop && usedRounds(usage) >= limits.maxSteps) {
      status = "budget_exhausted";
      stopReason = "step_budget";
    }
  } catch (error) {
    const elapsedWallTime = (restored?.usage.wallTimeMs ?? 0) + (Date.now() - invocationStarted - observerTimeMs);
    stopReason = options.signal?.aborted
      ? "cancelled"
      : elapsedWallTime >= limits.maxWallTimeMs
        ? "wall_time_budget"
        : error instanceof ModelCallError ? "model_error" : "runtime_error";
    status = statusForReason(stopReason);
    finalMessage = error instanceof Error ? error.message : String(error);
    await store?.trace("run_error", {
      name: error instanceof Error ? error.name : "Error",
      message: finalMessage.slice(0, 500)
    });
  }

  usage.wallTimeMs = (restored?.usage.wallTimeMs ?? 0) + (Date.now() - invocationStarted - observerTimeMs);
  const statusResult = await gitStatus(repoRoot, git.timeoutSec, git.isolatedConfig);
  const diffResult = await gitDiff(repoRoot, git.timeoutSec, git.isolatedConfig);
  const tests = registry.records.filter((record) => record.type === "test").map((record) => ({
    command: record.command,
    passed: record.passed,
    exitCode: record.exitCode
  }));
  const commands = registry.records.filter((record) => record.type === "command").map((record) => ({
    command: record.command,
    exitCode: record.exitCode
  }));

  await saveCheckpoint(store, {
    task: options.task,
    repo: repoRoot,
    gitHead,
    provider: provider.name,
    model,
    history,
    plan: plan.snapshot(),
    usage,
    records: registry.records,
    failureSignatures,
    finalMessage,
    status,
    stopReason,
    textOnlyNudges,
    ...(features.observationMasking ? { previousPromptTokens } : {}),
    startedAt
  }, git);
  await store?.trace("run_finished", { status, stopReason, usage, plan: compactPlan(plan.snapshot()) });
  emit({ type: "run_finished", status, stopReason, usage, finalMessage });

  return {
    status,
    stopReason,
    task: options.task,
    repo: repoRoot,
    changedFiles: statusResult.ok ? statusResult.data.changedFiles : [],
    commands,
    tests,
    diff: diffResult.ok ? diffResult.data.diff : null,
    finalMessage,
    usage,
    plan: plan.snapshot(),
    runId: store?.runId,
    statePath: store?.statePath,
    tracePath: store?.tracePath
  };
}

async function completeWithRetry(
  provider: ModelProvider,
  request: Parameters<ModelProvider["complete"]>[0],
  limits: { modelTimeoutMs: number; maxApiAttempts: number; retryDelayMs: number },
  store?: RunStore,
  abortImmediately = false
) {
  let lastError: unknown;
  const deadline = Date.now() + limits.modelTimeoutMs;
  for (let attempt = 1; attempt <= limits.maxApiAttempts; attempt += 1) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (request.signal?.aborted) controller.abort();
    else request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const remainingMs = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      return await provider.complete({ ...request, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (abortImmediately && request.signal?.aborted) throw new ModelCallError(error);
      const retryable = isRetryableModelError(error, controller.signal.aborted);
      // Enough to tell a provider outage from a bad request afterwards: the status, the network error code, whether
      // no response arrived at all, and whether this call's own deadline (not the caller) aborted it.
      await store?.trace("model_attempt_failed", {
        attempt,
        retryable,
        name: error instanceof Error ? error.name : "Error",
        status: statusCode(error),
        code: errorCode(error),
        connectionError: error instanceof APIConnectionError,
        timedOut: controller.signal.aborted && request.signal?.aborted !== true
      });
      if (!retryable || attempt >= limits.maxApiAttempts) throw new ModelCallError(error);
      const retryDelay = Math.min(limits.retryDelayMs * 2 ** (attempt - 1), Math.max(0, deadline - Date.now()));
      if (retryDelay <= 0) throw new ModelCallError(error);
      await delay(retryDelay, undefined, abortImmediately ? { signal: request.signal } : undefined);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  throw new ModelCallError(lastError);
}

function budgetReason(
  usage: RunUsage,
  limits: { maxToolCalls: number; maxInputTokens: number; maxOutputTokens: number; maxWallTimeMs: number },
  signal?: AbortSignal
): StopReason | undefined {
  if (signal?.aborted) return "cancelled";
  if (usage.toolCalls >= limits.maxToolCalls) return "tool_budget";
  if (usage.inputTokens >= limits.maxInputTokens || usage.outputTokens >= limits.maxOutputTokens) return "token_budget";
  if (usage.wallTimeMs >= limits.maxWallTimeMs) return "wall_time_budget";
  return undefined;
}

function statusForReason(reason: StopReason): RunStatus {
  if (reason === "cancelled") return "cancelled";
  if (["step_budget", "tool_budget", "token_budget", "wall_time_budget"].includes(reason)) return "budget_exhausted";
  return "failed";
}

function addUsage(target: RunUsage, value: RunUsage | any): void {
  target.inputTokens += value.inputTokens ?? 0;
  target.outputTokens += value.outputTokens ?? 0;
  target.cacheHitInputTokens += value.cacheHitInputTokens ?? 0;
  target.cacheMissInputTokens += value.cacheMissInputTokens ?? 0;
  target.totalTokens += value.totalTokens ?? 0;
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (value.reasoningTokens ?? 0);
}

function addSubagentUsage(target: RunUsage, value: RunUsage | undefined): void {
  if (!value) return;
  target.subagentRounds = (target.subagentRounds ?? 0) + value.modelRounds + (value.subagentRounds ?? 0);
  target.toolCalls += value.toolCalls;
  addUsage(target, value);
}

function usedRounds(usage: RunUsage): number {
  return usage.modelRounds + (usage.subagentRounds ?? 0);
}

function validCacheIsolationNonce(value: string, subagentDepth: number | undefined): boolean {
  if (CACHE_ISOLATION_NONCE.test(value)) return true;
  if (subagentDepth !== 1) return false;
  const suffix = value.match(/-sub[1-9][0-9]*$/)?.[0];
  return suffix !== undefined && CACHE_ISOLATION_NONCE.test(value.slice(0, -suffix.length));
}

export function categorizeToolFailure(name: string, result: ToolResult<unknown>): string | undefined {
  if (result.ok) {
    const data = result.data as { passed?: boolean; timedOut?: boolean } | undefined;
    if (data?.timedOut === true) return "timeout";
    return name === "run_tests" && data?.passed === false ? "test_failed" : undefined;
  }
  if (result.code === "environment") return "environment";
  return TOOL_FAILURE_CATEGORIES.find(([, pattern]) => pattern.test(result.error))?.[0] ?? "other";
}

function isFailedObservation(name: string, result: ToolResult<unknown>): boolean {
  if (!result.ok) return true;
  return name === "run_tests" && (result.data as { passed?: boolean }).passed === false;
}

function stableSignature(call: NormalizedToolCall): string {
  let args: unknown = call.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { /* keep original */ }
  }
  return `${call.name}:${stableJson(args)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRetryableModelError(error: unknown, timedOut: boolean): boolean {
  if (timedOut) return true;
  const status = statusCode(error);
  return status === 429 || (status !== undefined && status >= 500) ||
    NETWORK_ERROR_CODES.includes(errorCode(error) ?? "") || error instanceof APIConnectionError ||
    (error instanceof Error && error.name === "AbortError");
}

function statusCode(error: unknown): number | undefined {
  const value = (error as { status?: unknown })?.status;
  return typeof value === "number" ? value : undefined;
}

// The first string code along the cause chain: the OpenAI SDK's connection errors carry the socket's code
// (e.g. ECONNRESET) on a nested cause.
function errorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function readGitHead(repoRoot: string, git: HostGitOptions): Promise<string | null> {
  const result = await runHostGit(repoRoot, ["rev-parse", "HEAD"], git);
  return result.ok && result.data.exitCode === 0 ? result.data.stdout.trim() || null : null;
}

function validateResume(
  state: PersistedRunState,
  expected: {
    task: string;
    repo: string;
    provider: string;
    model: string;
    gitHead: string | null;
    worktreeFingerprint: string | null;
  }
): void {
  if (state.status === "success") throw new Error("Completed runs cannot be resumed");
  if (state.task !== expected.task) throw new Error("Resume task does not match the saved task");
  if (state.repo !== expected.repo) throw new Error("Resume repository does not match the saved repository");
  if (state.provider !== expected.provider || state.model !== expected.model) {
    throw new Error("Resume provider/model does not match the saved run");
  }
  if (state.gitHead !== expected.gitHead) throw new Error("Repository HEAD changed since the saved run");
  if (state.worktreeFingerprint === null || expected.worktreeFingerprint === null) {
    throw new Error("Resuming requires a Git repository with a verifiable worktree");
  }
  if (state.worktreeFingerprint !== expected.worktreeFingerprint) {
    throw new Error("Repository worktree changed since the saved run");
  }
}

function appendSkippedToolResults(
  provider: ModelProvider,
  history: unknown[],
  calls: NormalizedToolCall[],
  error: string,
  compactObservations = false
): void {
  const result: ToolResult<never> = { ok: false, error, recoverable: false };
  for (const call of calls) {
    history.push(provider.toolResultItem(call, compactObservations ? renderToolResult(call.name, result) : serializeToolResult(result)));
  }
}

async function readWorktreeFingerprint(
  repoRoot: string,
  gitHead: string | null,
  git: HostGitOptions
): Promise<string | null> {
  if (!gitHead) return null;
  const listing = { ...git, outputLimitBytes: 8 * 1024 * 1024 };
  const [tracked, untracked, ignored] = await Promise.all([
    runHostGit(repoRoot, ["diff", ...HOST_DIFF_FLAGS, "--name-only", "-z", "HEAD"], listing),
    runHostGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], listing),
    runHostGit(repoRoot, [
      "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ".",
      ":(exclude)node_modules/**", ":(exclude)**/node_modules/**",
      ":(exclude)dist/**", ":(exclude)**/dist/**",
      ":(exclude)build/**", ":(exclude)**/build/**",
      ":(exclude).onehand/**", ":(exclude)**/.onehand/**"
    ], listing)
  ]);
  if (!tracked.ok || tracked.data.exitCode !== 0 || tracked.truncated ||
      !untracked.ok || untracked.data.exitCode !== 0 || untracked.truncated ||
      !ignored.ok || ignored.data.exitCode !== 0 || ignored.truncated) {
    throw new RuntimeFailure("Unable to compute a complete Git worktree fingerprint");
  }
  const files = new Set([
    ...splitNull(tracked.data.stdout),
    ...splitNull(untracked.data.stdout),
    ...splitNull(ignored.data.stdout)
  ].filter((relative) => !relative.split(/[\\/]+/).some(shouldSkipDir)));
  const hash = createHash("sha256");
  for (const relative of [...files].sort()) {
    const absolute = resolveInsideRepo(repoRoot, relative);
    hash.update(relative).update("\0");
    try {
      const info = await lstat(absolute);
      hash.update(`${info.mode}:${info.size}:${info.mtimeMs}\0`);
      if (info.isSymbolicLink()) hash.update(await readlink(absolute));
      else if (info.isFile() && info.size <= 1024 * 1024 && !isProtectedRepoPath(relative)) {
        hash.update(await readFile(absolute));
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      hash.update(code === "ENOENT" ? "[deleted]" : `[unreadable:${code ?? "unknown"}]`);
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function splitNull(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

async function saveCheckpoint(
  store: RunStore | undefined,
  value: Omit<PersistedRunState, "schemaVersion" | "runId" | "updatedAt" | "failureSignatures" | "worktreeFingerprint"> & {
    failureSignatures: Map<string, number>;
  },
  git: HostGitOptions
): Promise<void> {
  if (!store) return;
  await store.save({
    ...value,
    schemaVersion: RUN_STATE_VERSION,
    runId: store.runId,
    worktreeFingerprint: await readWorktreeFingerprint(value.repo, value.gitHead, git),
    failureSignatures: Object.fromEntries(value.failureSignatures),
    updatedAt: new Date().toISOString()
  });
}

function compactPlan(plan: PlanSnapshot): Record<string, unknown> {
  return {
    revision: plan.revision,
    status: plan.status,
    needsReplan: plan.needsReplan,
    steps: plan.steps.map((step) => ({ id: step.id, status: step.status }))
  };
}

function renderContextNote(plan: PlanSnapshot, modifiedFiles: string[]): string {
  const steps = plan.steps.length > 0
    ? plan.steps.map((step) => `${step.id} ${step.status} ${step.description}`).join("\n")
    : "(no plan set)";
  return [
    "Context note: older tool observations were masked to save context.",
    `Plan:\n${steps}`,
    `Modified files: ${modifiedFiles.length > 0 ? modifiedFiles.join(", ") : "(none)"}`
  ].join("\n");
}

import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PlanController } from "./planning.js";
import { PersistedRunState, RUN_STATE_VERSION, RunStore, summarizeToolArguments } from "./persistence.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { createModelProvider } from "../providers/index.js";
import type { ModelProvider, NormalizedToolCall, ResponsesClient } from "../providers/index.js";
import { PlanSnapshot, RunReport, RunStatus, RunUsage, StopReason, ToolResult } from "../types.js";
import { createToolRegistry, serializeToolResult } from "../tools/registry.js";
import { gitDiff, gitStatus } from "../tools/git.js";
import { normalizeRepoRoot } from "../tools/pathGuard.js";
import { isProtectedRepoPath, resolveInsideRepo, shouldSkipDir } from "../tools/pathGuard.js";
import { runProgramCommand } from "../tools/command.js";
import { detectTestCommand } from "../tools/testCommand.js";

export type { ResponsesClient } from "../providers/index.js";

export type RunAgentOptions = {
  task: string;
  repoPath: string;
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
};

const DEFAULT_USAGE: RunUsage = {
  modelRounds: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheHitInputTokens: 0,
  cacheMissInputTokens: 0,
  totalTokens: 0,
  wallTimeMs: 0
};

export async function runAgent(options: RunAgentOptions): Promise<RunReport> {
  const repoRoot = await normalizeRepoRoot(options.repoPath);
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
    maxWallTimeMs: options.maxWallTimeMs ?? 15 * 60_000,
    timeoutSec: options.timeoutSec ?? 120,
    modelTimeoutMs: options.modelTimeoutMs ?? 180_000,
    maxApiAttempts: options.maxApiAttempts ?? 3,
    retryDelayMs: options.retryDelayMs ?? 1_000
  };
  const gitHead = await readGitHead(repoRoot, limits.timeoutSec);
  const worktreeFingerprint = await readWorktreeFingerprint(repoRoot, limits.timeoutSec, gitHead);

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
  const registry = createToolRegistry({
    repoRoot,
    testCommand: verificationCommand,
    timeoutSec: limits.timeoutSec,
    allowDestructive: options.allowDestructive ?? false,
    enforcePlanning,
    plan
  });
  if (restored?.records) registry.records.push(...restored.records);
  const history = restored?.history ?? provider.initialHistory(buildUserPrompt({
    task: options.task,
    repo: repoRoot,
    testCommand: verificationCommand
  }));
  const usage: RunUsage = { ...(restored?.usage ?? DEFAULT_USAGE) };
  const failureSignatures = new Map(Object.entries(restored?.failureSignatures ?? {}));
  let finalMessage = restored?.finalMessage ?? "";
  let status: RunStatus = "failed";
  let stopReason: StopReason = "step_budget";
  const startedAt = restored?.startedAt ?? new Date().toISOString();
  const invocationStarted = Date.now();

  if (store) {
    await store.trace(options.resume ? "run_resumed" : "run_started", {
      runId: store.runId,
      repo: repoRoot,
      provider: provider.name,
      model,
      limits
    });
  }

  let shouldStop = false;
  try {
    for (; usage.modelRounds < limits.maxSteps && !shouldStop;) {
      usage.wallTimeMs = (restored?.usage.wallTimeMs ?? 0) + (Date.now() - invocationStarted);
      const preflight = budgetReason(usage, limits, options.signal);
      if (preflight) {
        stopReason = preflight;
        status = statusForReason(preflight);
        break;
      }

      const turn = await completeWithRetry(provider, {
        model,
        instructions: SYSTEM_PROMPT,
        history,
        tools: registry.definitions,
        reasoningEffort: options.reasoningEffort ?? "high",
        thinking: options.thinking ?? "enabled",
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: Math.max(1, Math.min(8_192, limits.maxOutputTokens - usage.outputTokens)),
        signal: options.signal
      }, {
        ...limits,
        modelTimeoutMs: Math.max(1, Math.min(limits.modelTimeoutMs, limits.maxWallTimeMs - usage.wallTimeMs))
      }, store);
      usage.modelRounds += 1;
      addUsage(usage, turn.usage);
      history.push(...turn.historyItems);
      if (turn.message) finalMessage = turn.message;
      await store?.trace("model_turn", {
        round: usage.modelRounds,
        toolCallNames: turn.toolCalls.map((call) => call.name),
        finishReason: turn.finishReason,
        usage: turn.usage
      });

      const postModelBudget = budgetReason(usage, limits, options.signal);
      if (postModelBudget) {
        appendSkippedToolResults(provider, history, turn.toolCalls, `Run stopped before tool execution: ${postModelBudget}`);
        stopReason = postModelBudget;
        status = statusForReason(postModelBudget);
        break;
      }
      if (turn.toolCalls.length === 0) {
        if (enforcePlanning) {
          status = "failed";
          stopReason = "model_stopped_without_finish";
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
        if (usage.toolCalls >= limits.maxToolCalls) {
          appendSkippedToolResults(
            provider,
            history,
            turn.toolCalls.slice(callIndex),
            "Run stopped before tool execution: tool budget exhausted"
          );
          status = "budget_exhausted";
          stopReason = "tool_budget";
          shouldStop = true;
          break;
        }
        usage.toolCalls += 1;
        const result = await registry.execute(call.name, call.arguments);
        history.push(provider.toolResultItem(call, serializeToolResult(result)));
        const signature = stableSignature(call);
        if (isFailedObservation(call.name, result)) {
          const failures = (failureSignatures.get(signature) ?? 0) + 1;
          failureSignatures.set(signature, failures);
          if (failures >= 2) plan.requireReplan();
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
          truncated: result.ok ? result.truncated ?? false : false,
          planRevision: plan.snapshot().revision
        });
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
        usage.wallTimeMs = (restored?.usage.wallTimeMs ?? 0) + (Date.now() - invocationStarted);
        const checkpointHistory = [...history];
        appendSkippedToolResults(
          provider,
          checkpointHistory,
          turn.toolCalls.slice(callIndex + 1),
          "Tool call was not executed before this checkpoint"
        );
        await saveCheckpoint(store, {
          task: options.task,
          repo: repoRoot,
          gitHead,
          worktreeFingerprint: await readWorktreeFingerprint(repoRoot, limits.timeoutSec, gitHead),
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
          startedAt
        });
        if (shouldStop) {
          appendSkippedToolResults(
            provider,
            history,
            turn.toolCalls.slice(callIndex + 1),
            "Run stopped after explicit finish"
          );
          break;
        }
      }
    }
    if (!shouldStop && usage.modelRounds >= limits.maxSteps) {
      status = "budget_exhausted";
      stopReason = "step_budget";
    }
  } catch (error) {
    const elapsedWallTime = (restored?.usage.wallTimeMs ?? 0) + (Date.now() - invocationStarted);
    status = options.signal?.aborted
      ? "cancelled"
      : elapsedWallTime >= limits.maxWallTimeMs
        ? "budget_exhausted"
        : "failed";
    stopReason = options.signal?.aborted
      ? "cancelled"
      : elapsedWallTime >= limits.maxWallTimeMs
        ? "wall_time_budget"
        : "model_error";
    finalMessage = error instanceof Error ? error.message : String(error);
    await store?.trace("run_error", {
      name: error instanceof Error ? error.name : "Error",
      message: finalMessage.slice(0, 500)
    });
  }

  usage.wallTimeMs = (restored?.usage.wallTimeMs ?? 0) + (Date.now() - invocationStarted);
  const statusResult = await gitStatus(repoRoot, limits.timeoutSec);
  const diffResult = await gitDiff(repoRoot, limits.timeoutSec);
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
    worktreeFingerprint: await readWorktreeFingerprint(repoRoot, limits.timeoutSec, gitHead),
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
    startedAt
  });
  await store?.trace("run_finished", { status, stopReason, usage, plan: compactPlan(plan.snapshot()) });

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
  store?: RunStore
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
      const retryable = isRetryableModelError(error, controller.signal.aborted);
      await store?.trace("model_attempt_failed", {
        attempt,
        retryable,
        name: error instanceof Error ? error.name : "Error",
        status: statusCode(error)
      });
      if (!retryable || attempt >= limits.maxApiAttempts) throw error;
      const retryDelay = Math.min(limits.retryDelayMs * 2 ** (attempt - 1), Math.max(0, deadline - Date.now()));
      if (retryDelay <= 0) throw error;
      await delay(retryDelay);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  throw lastError;
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
  const code = (error as { code?: string })?.code;
  return status === 429 || (status !== undefined && status >= 500) ||
    ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code ?? "") ||
    (error instanceof Error && error.name === "AbortError");
}

function statusCode(error: unknown): number | undefined {
  const value = (error as { status?: unknown })?.status;
  return typeof value === "number" ? value : undefined;
}

async function readGitHead(repoRoot: string, timeoutSec: number): Promise<string | null> {
  const result = await runProgramCommand({
    program: "git", args: ["rev-parse", "HEAD"], cwd: repoRoot, timeoutSec
  });
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
  error: string
): void {
  const result: ToolResult<never> = { ok: false, error, recoverable: false };
  for (const call of calls) history.push(provider.toolResultItem(call, serializeToolResult(result)));
}

async function readWorktreeFingerprint(
  repoRoot: string,
  timeoutSec: number,
  gitHead: string | null
): Promise<string | null> {
  if (!gitHead) return null;
  const [tracked, untracked, ignored] = await Promise.all([
    runProgramCommand({
      program: "git",
      args: ["diff", "--name-only", "-z", "HEAD"],
      cwd: repoRoot,
      timeoutSec,
      outputLimitBytes: 8 * 1024 * 1024
    }),
    runProgramCommand({
      program: "git",
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      cwd: repoRoot,
      timeoutSec,
      outputLimitBytes: 8 * 1024 * 1024
    }),
    runProgramCommand({
      program: "git",
      args: [
        "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ".",
        ":(exclude)node_modules/**", ":(exclude)**/node_modules/**",
        ":(exclude)dist/**", ":(exclude)**/dist/**",
        ":(exclude)build/**", ":(exclude)**/build/**",
        ":(exclude).onehand/**", ":(exclude)**/.onehand/**"
      ],
      cwd: repoRoot,
      timeoutSec,
      outputLimitBytes: 8 * 1024 * 1024
    })
  ]);
  if (!tracked.ok || tracked.data.exitCode !== 0 || tracked.truncated ||
      !untracked.ok || untracked.data.exitCode !== 0 || untracked.truncated ||
      !ignored.ok || ignored.data.exitCode !== 0 || ignored.truncated) {
    throw new Error("Unable to compute a complete Git worktree fingerprint");
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("[deleted]");
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
  value: Omit<PersistedRunState, "schemaVersion" | "runId" | "updatedAt" | "failureSignatures"> & {
    failureSignatures: Map<string, number>;
  }
): Promise<void> {
  if (!store) return;
  await store.save({
    ...value,
    schemaVersion: RUN_STATE_VERSION,
    runId: store.runId,
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

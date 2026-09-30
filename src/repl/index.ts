import type { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import path from "node:path";
import { loadProjectInstructions } from "../agent/projectMemory.js";
import { redactDeep, RunStore } from "../agent/persistence.js";
import { resolveLocalProfile } from "../agent/localProfile.js";
import { runAgent, type RunAgentOptions } from "../agent/runner.js";
import { runSubagent } from "../agent/subagents.js";
import { summarizeEventArguments, type AgentEvent } from "../agent/events.js";
import type { ModelProvider } from "../providers/index.js";
import { loadMcpConfig, McpManager } from "../mcp/index.js";
import { CheckpointStore } from "../runtime/checkpoints.js";
import { acquireRepositoryLock } from "../runtime/repositoryLock.js";
import {
  loadPermissionConfig,
  PermissionEngine,
  type AuthorizationRequest,
  type PermissionMode,
  type PermissionRules
} from "../policy/permissions.js";
import { gitDiff } from "../tools/git.js";
import { resolveTestCommand, type TestCommandResolution } from "../tools/testCommand.js";
import { normalizeRepoRoot } from "../tools/pathGuard.js";
import type { PlanSnapshot, RunReport, RunUsage } from "../types.js";
import { ReplInput } from "./input.js";
import { ReplRenderer, systemClock, type Clock } from "./renderer.js";
import { ChatSessionStore, persistableBaseURL, validateChatConfig, type ChatMemoryEntry, type ChatSessionConfig } from "./session.js";

export type ReplProviderOptions = {
  provider: "openai" | "deepseek";
  model?: string;
  baseURL?: string;
  apiKey?: string;
};

export type RunReplOptions = Partial<ReplProviderOptions> & {
  repoPath: string;
  mode?: PermissionMode;
  profile?: string;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
  temperature?: number;
  cliRules?: PermissionRules;
  input?: Readable;
  output?: Writable;
  providerFactory(options: ReplProviderOptions): ModelProvider | Promise<ModelProvider>;
  clock?: Clock;
  userHome?: string;
  sessionDir?: string;
  resume?: string;
  testCommand?: string;
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
  runAgentFn?: (options: RunAgentOptions) => Promise<RunReport>;
};

const HELP = [
  "/help", "/mode <ask|edit|auto>", "/diff", "/undo", "/rewind <n>",
  "/checkpoints", "/discard", "/cost", "/model <id>", "/profile <name>", "/memory", "/mcp", "/review", "/exit"
].join(" · ");

export async function runRepl(options: RunReplOptions): Promise<void> {
  const repoRoot = await normalizeRepoRoot(options.repoPath);
  const userHome = options.userHome ?? homedir();
  const lock = await acquireRepositoryLock(repoRoot, {
    scope: "chat",
    storageRoot: pathForUserState(userHome, "locks")
  });
  try {
    await runReplLocked(options, repoRoot, userHome);
  } finally {
    await lock.release();
  }
}

async function runReplLocked(options: RunReplOptions, repoRoot: string, userHome: string): Promise<void> {
  const inputStream = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive = Boolean((output as Writable & { isTTY?: boolean }).isTTY);
  const initialConfig = options.resume ? undefined : await newSessionConfig(options, repoRoot);
  const session = options.resume
    ? await ChatSessionStore.load(options.resume, repoRoot)
    : await ChatSessionStore.create({
      sessionDir: options.sessionDir,
      userHome,
      repo: repoRoot,
      config: initialConfig!,
      usage: emptyUsage()
    });
  const effective = validateChatConfig(resolveSessionConfig(options, session.state.config, options.resume !== undefined));
  session.state.config = effective;
  await session.save();
  let profile = resolveLocalProfile(effective.profile);
  const projectInstructions = await loadProjectInstructions(repoRoot);
  const config = await loadPermissionConfig(repoRoot, userHome);
  const mcpConfig = await loadMcpConfig(repoRoot, userHome);
  const permissions = new PermissionEngine({
    mode: effective.mode,
    cliRules: effective.cliRules,
    projectRules: config.project,
    userRules: config.user
  });
  const checkpoints = new SessionCheckpointStore(repoRoot, async (id) => {
    if (!session.state.activeTask) throw new Error("Checkpoint created without an active chat task");
    session.state.activeTask.checkpoint ??= id;
    await session.save();
  });
  const reader = new ReplInput(inputStream, output, interactive && process.env.NO_COLOR === undefined);
  const renderer = new ReplRenderer(output, options.clock ?? systemClock, { interactive });
  const mcp = new McpManager({ warn: (message) => renderer.message(message) });
  const run = options.runAgentFn ?? runAgent;
  const memory = session.state.memory;
  const totals = session.state.usage;
  const usageByModel = new Map(Object.entries(session.state.usageByModel));
  let model = effective.model;
  let lastRunCheckpoint = session.state.activeTask?.checkpoint ?? session.state.lastRunCheckpoint;
  let firstEmptyInterrupt = false;
  let activeAbort: (() => void) | undefined;
  let lastTask = session.state.lastTask ?? "Review the current repository changes for correctness.";
  let lastPlan = session.state.lastPlan;

  renderer.message(`OneHand chat · ${permissions.mode} mode · profile: ${profile.name} · tests: ${effective.testCommand ?? "not detected; specify --test"} · ${repoRoot}`);
  if (!effective.testCommand && effective.testCommandResolution) renderer.message(effective.testCommandResolution.detail);
  renderer.message(`Recovery: onehand chat --repo ${shellQuote(repoRoot)} --resume ${shellQuote(session.sessionDir)}`);
  try {
    await mcp.connect(mcpConfig);
    if (session.state.activeTask) {
      try { await resumeActiveTask(); }
      catch (error) {
        renderer.message(`Recovery stopped: ${error instanceof Error ? error.message : String(error)}`);
        renderer.message("The unfinished task is retained. Inspect with read-only commands, use /discard to archive it, or /exit to retry recovery later.");
      }
    }
    while (true) {
      const event = await reader.read("onehand> ", output);
      if (event.type === "eof") break;
      if (event.type === "interrupt") {
        if (event.empty && firstEmptyInterrupt) break;
        firstEmptyInterrupt = event.empty;
        renderer.message(event.empty ? "Press Ctrl+C again to exit." : "^C");
        continue;
      }
      firstEmptyInterrupt = false;
      const value = event.value.trim();
      if (!value) continue;
      if (value.startsWith("/")) {
        try {
          if (await handleCommand(value)) break;
        } catch (error) {
          renderer.message(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      if (session.state.activeTask) {
        renderer.message("An unfinished task is saved. Use /exit then the recovery command to resume it, or /discard to keep its artifacts and start another task.");
        continue;
      }
      await executeTask(value, false, false);
    }
  } finally {
    renderer.stop();
    reader.close();
    await mcp.close();
  }

  function modelFor(provider: ModelProvider): string {
    return model ?? (provider.name === "deepseek" ? "deepseek-v4-pro" : process.env.OPENAI_MODEL ?? "gpt-5.5");
  }

  function recordUsage(runModel: string, usage?: RunUsage, alreadyCounted?: RunUsage): void {
    if (!usage) return;
    const delta = subtractUsage(usage, alreadyCounted);
    addUsage(totals, delta);
    const modelUsage = usageByModel.get(runModel) ?? emptyUsage();
    addUsage(modelUsage, delta);
    usageByModel.set(runModel, modelUsage);
    session.state.usageByModel = Object.fromEntries(usageByModel);
  }

  async function commitTaskProgress<T>(mutate: () => T | Promise<T>): Promise<T> {
    const before = structuredClone(session.state);
    const previousDisplay = { lastTask, lastPlan, lastRunCheckpoint };
    try {
      const result = await mutate();
      await session.save();
      return result;
    } catch (error) {
      // Restore the objects captured by the REPL too: a failed sidecar write must not
      // unlock new tasks or leave partial memory/usage changes in the current process.
      memory.splice(0, memory.length, ...before.memory);
      for (const key of Object.keys(totals)) Reflect.deleteProperty(totals, key);
      Object.assign(totals, before.usage);
      usageByModel.clear();
      for (const [name, usage] of Object.entries(before.usageByModel)) usageByModel.set(name, usage);
      session.state = { ...before, config: effective, memory, usage: totals, usageByModel: Object.fromEntries(usageByModel) };
      ({ lastTask, lastPlan, lastRunCheckpoint } = previousDisplay);
      throw error;
    }
  }

  async function resumeActiveTask(): Promise<void> {
    const task = session.state.activeTask!;
    let loaded: Awaited<ReturnType<typeof RunStore.load>>;
    try {
      loaded = await RunStore.load(task.runDir);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      if (task.phase === "running") {
        throw new Error("Cannot safely resume this chat task: provider execution may have started, but no run state was saved");
      }
      if (!task.resumeExact) throw new Error("Cannot safely resume this chat task because sensitive text was redacted from persistent state; start a new task");
      await executeTask(task.input, true, false);
      return;
    }
    if (loaded.state.status === "success") {
      assertActiveRunIdentity(loaded.state, task, session.state.config, repoRoot);
      await commitTaskProgress(() => {
        recordUsage(loaded.state.model, loaded.state.usage, task.accountedUsage);
        memory.push({ input: task.input, finalMessage: redactDeep(loaded.state.finalMessage) });
        if (memory.length > 5) memory.splice(0, memory.length - 5);
        lastTask = task.input;
        lastPlan = loaded.state.plan;
        lastRunCheckpoint = task.checkpoint;
        session.state.lastTask = lastTask;
        session.state.lastPlan = lastPlan;
        session.state.lastRunCheckpoint = lastRunCheckpoint;
        session.state.activeTask = null;
      });
      renderer.message("Recovered a completed task from its saved run; it will not be replayed.");
      return;
    }
    if (!task.resumeExact) throw new Error("Cannot safely resume this chat task because sensitive text was redacted from persistent state; start a new task");
    await executeTask(task.input, true, true);
  }

  async function executeTask(input: string, existingActive: boolean, resumeRun: boolean): Promise<void> {
    const active = session.state.activeTask;
    if (existingActive && !active) return;
    if (!existingActive) {
      const taskWithContext = taskWithMemory(input, memory);
      session.state.activeTask = {
        input,
        task: taskWithContext,
        runDir: session.runDir(),
        phase: "prepared",
        resumeExact: redactDeep(input) === input && redactDeep(taskWithContext) === taskWithContext
      };
      await session.save();
    }
    const task = session.state.activeTask!;
    lastRunCheckpoint = task.checkpoint;
    const controller = new AbortController();
    activeAbort = () => controller.abort();
    reader.onInterrupt(activeAbort);
    renderer.startRun();
    try {
      const provider = await options.providerFactory({
        provider: effective.provider,
        model,
        baseURL: effective.baseURL,
        apiKey: options.apiKey
      });
      task.phase = "running";
      await session.save();
      const runModel = modelFor(provider);
      const report = await run({
        task: task.task,
        repoPath: repoRoot,
        provider,
        baseURL: effective.baseURL,
        model: runModel,
        profile,
        thinking: effective.thinking,
        reasoningEffort: effective.reasoningEffort,
        temperature: effective.temperature,
        testCommand: effective.testCommand,
        maxSteps: effective.maxSteps,
        maxToolCalls: effective.maxToolCalls,
        maxInputTokens: effective.maxInputTokens,
        maxOutputTokens: effective.maxOutputTokens,
        maxTurnOutputTokens: effective.maxTurnOutputTokens,
        maxTextOnlyNudges: effective.maxTextOnlyNudges,
        maxWallTimeMs: effective.maxWallTimeMs,
        timeoutSec: effective.timeoutSec,
        modelTimeoutMs: effective.modelTimeoutMs,
        maxApiAttempts: effective.maxApiAttempts,
        retryDelayMs: effective.retryDelayMs,
        enforcePlanning: permissions.mode !== "ask",
        persistence: true,
        ...(resumeRun ? { resume: task.runDir } : { runDir: task.runDir }),
        mode: permissions.mode,
        authorize,
        extraTools: mcp,
        interactiveTools: ["explore", "review_changes"],
        completion: permissions.mode === "ask" ? "answer" : "finish_task",
        checkpoints: permissions.mode === "ask" ? false : checkpoints,
        projectInstructions,
        signal: controller.signal,
        onEvent: (agentEvent: AgentEvent) => renderer.handle(agentEvent)
      });
      await commitTaskProgress(() => {
        lastRunCheckpoint = task.checkpoint;
        lastTask = task.input;
        lastPlan = report.plan;
        recordUsage(runModel, report.usage, task.accountedUsage);
        task.accountedUsage = report.usage ? { ...report.usage } : undefined;
        session.state.lastTask = redactDeep(lastTask);
        if (lastPlan === undefined) delete session.state.lastPlan;
        else session.state.lastPlan = lastPlan;
        if (lastRunCheckpoint === undefined) delete session.state.lastRunCheckpoint;
        else session.state.lastRunCheckpoint = lastRunCheckpoint;
        if (report.status === "success") {
          memory.push({ input: task.input, finalMessage: redactDeep(report.finalMessage) });
          if (memory.length > 5) memory.splice(0, memory.length - 5);
          session.state.activeTask = null;
        }
      });
      renderer.finish(report, runModel);
    } catch (error) {
      lastRunCheckpoint = task.checkpoint;
      renderer.stop();
      if (existingActive) throw error;
      renderer.message(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
      renderer.message("failed · usage unavailable");
      await session.save();
    } finally {
      activeAbort = undefined;
      reader.onInterrupt(undefined);
    }
  }

  async function authorize(request: AuthorizationRequest): Promise<"allow" | "deny"> {
    const resolved = permissions.resolve(request);
    if (resolved.decision !== "ask") return resolved.decision;

    reader.onInterrupt(undefined);
    const summary = summarizeEventArguments(request.args);
    try {
      const answer = await reader.read(`Allow ${request.name}${summary ? ` ${summary}` : ""}? [y]es / [n]o / [a]lways `, output);
      if (answer.type !== "line") return "deny";
      const normalized = answer.value.trim().toLowerCase();
      if (normalized === "a" || normalized === "always") {
        permissions.allowForSession(request);
        return "allow";
      }
      return normalized === "y" || normalized === "yes" ? "allow" : "deny";
    } finally {
      reader.onInterrupt(activeAbort);
    }
  }

  async function handleCommand(line: string): Promise<boolean> {
    const [command, ...args] = line.split(/\s+/);
    if (session.state.activeTask && (
      (args.length > 0 && ["/model", "/profile", "/mode"].includes(command!)) ||
      ["/undo", "/rewind", "/review"].includes(command!)
    )) {
      renderer.message("An unfinished task keeps its saved behavior and worktree. Resume it first, or /discard before changing settings, restoring files or requesting a review.");
      return false;
    }
    switch (command) {
      case "/exit":
        return true;
      case "/discard": {
        const task = session.state.activeTask;
        let usageUnavailable = false;
        const discarded = !task ? undefined : await commitTaskProgress(async () => {
          try {
            const { state } = await RunStore.load(task.runDir);
            assertActiveRunIdentity(state, task, effective, repoRoot);
            recordUsage(state.model, state.usage, task.accountedUsage);
            task.accountedUsage = { ...state.usage };
          } catch { usageUnavailable = true; }
          const recordPath = await session.archiveActiveTask();
          session.state.activeTask = null;
          return recordPath;
        });
        renderer.message(discarded
          ? `Unfinished task discarded; files are unchanged and task details remain at ${discarded}.`
          : "No unfinished task to discard.");
        if (usageUnavailable) renderer.message("Run usage could not be refreshed; retained artifacts may contain usage not reflected in the session total.");
        return false;
      }
      case "/help":
        renderer.message(`Profile: ${profile.name}`);
        renderer.message(`Tests: ${effective.testCommand ?? "not detected"}`);
        if (effective.testCommandResolution) renderer.message(effective.testCommandResolution.detail);
        renderer.message(HELP);
        return false;
      case "/profile":
        if (args.length > 1) {
          renderer.message("Usage: /profile <name>");
        } else {
          if (args.length) {
            profile = resolveLocalProfile(args[0]);
            effective.profile = profile.name;
            await session.save();
          }
          renderer.message(`Profile: ${profile.name}`);
        }
        return false;
      case "/mode": {
        const next = args[0];
        if (next !== "ask" && next !== "edit" && next !== "auto") {
          renderer.message("Usage: /mode <ask|edit|auto>");
        } else {
          permissions.setMode(next);
          effective.mode = next;
          await session.save();
          renderer.message(`Mode: ${next}`);
        }
        return false;
      }
      case "/diff": {
        const result = await gitDiff(repoRoot, 120);
        if (result.ok) renderer.diff(result.data.diff);
        else renderer.message(`Diff failed: ${result.error}`);
        return false;
      }
      case "/undo":
        if (!lastRunCheckpoint) renderer.message("No checkpoint is available for the last run.");
        else {
          await checkpoints.restore(lastRunCheckpoint);
          renderer.message(`Restored checkpoint ${shortId(lastRunCheckpoint)}.`);
          lastRunCheckpoint = undefined;
          delete session.state.lastRunCheckpoint;
          await session.save();
        }
        return false;
      case "/rewind": {
        const index = Number(args[0]);
        const available = await checkpoints.list();
        if (available.length > 0) renderer.message(formatCheckpoints(available));
        if (!Number.isInteger(index) || index < 1 || index > available.length) {
          renderer.message("Usage: /rewind <n> (use /checkpoints to list numbers)");
        } else {
          const selected = available[index - 1]!;
          await checkpoints.restore(selected.id);
          renderer.message(`Restored checkpoint ${index}: ${selected.label}.`);
        }
        return false;
      }
      case "/checkpoints": {
        const available = await checkpoints.list();
        renderer.message(available.length
          ? formatCheckpoints(available)
          : "No checkpoints.");
        return false;
      }
      case "/cost":
        renderer.cost(totals, usageByModel);
        return false;
      case "/mcp":
        renderer.message(mcp.servers.length
          ? mcp.servers.map((server) => `${server.name}: ${server.tools.length ? server.tools.join(", ") : "(no tools)"}`).join("\n")
          : "No MCP servers connected.");
        return false;
      case "/review": {
        const controller = new AbortController();
        activeAbort = () => controller.abort();
        reader.onInterrupt(activeAbort);
        renderer.startRun();
        try {
          const provider = await options.providerFactory({ provider: effective.provider, model, baseURL: effective.baseURL, apiKey: options.apiKey });
          const runModel = modelFor(provider);
          const report = await runSubagent({
            preset: "review", task: lastTask, plan: lastPlan,
            parent: {
              repoPath: repoRoot, provider, model: runModel, profile,
              thinking: effective.thinking, reasoningEffort: effective.reasoningEffort, temperature: effective.temperature,
              mode: permissions.mode, authorize, projectInstructions,
              persistence: false, signal: controller.signal, onEvent: renderer.handle
            }
          });
          recordUsage(runModel, report.usage);
          await session.save();
          renderer.finish(report, runModel);
        } finally {
          renderer.stop();
          activeAbort = undefined;
          reader.onInterrupt(undefined);
        }
        return false;
      }
      case "/model":
        if (!args.length) renderer.message(`Model: ${model ?? "provider default"}`);
        else {
          model = args.join(" ");
          effective.model = model;
          await session.save();
          renderer.message(`Model: ${model}`);
        }
        return false;
      case "/memory":
        renderer.message(projectInstructions || "No AGENTS.md or ONEHAND.md instructions loaded.");
        return false;
      default:
        renderer.message(`Unknown command: ${command}. Use /help.`);
        return false;
    }
  }
}

function taskWithMemory(input: string, memory: ChatMemoryEntry[]): string {
  if (memory.length === 0) return input;
  const earlier = memory.slice(-5).map((entry) =>
    `Input: ${cap(entry.input, 500)}\nOneHand: ${cap(entry.finalMessage, 500)}`
  ).join("\n\n");
  return `${input}\n\nEarlier in this session:\n${earlier}`;
}

function cap(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function shortId(id: string): string {
  return id.slice(0, 12);
}

function formatCheckpoints(checkpoints: Awaited<ReturnType<CheckpointStore["list"]>>): string {
  return checkpoints.map((item, index) => {
    const notes = item.notes?.length ? ` · ${item.notes.join("; ")}` : "";
    return `${index + 1}. ${shortId(item.id)} ${item.label} · ${item.createdAt}${notes}`;
  }).join("\n");
}

function emptyUsage(): RunUsage {
  return {
    modelRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
    cacheHitInputTokens: 0, cacheMissInputTokens: 0, totalTokens: 0,
    reasoningTokens: 0, wallTimeMs: 0
  };
}

function addUsage(total: RunUsage, usage?: RunUsage): void {
  if (!usage) return;
  total.modelRounds += usage.modelRounds;
  if (usage.subagentRounds) total.subagentRounds = (total.subagentRounds ?? 0) + usage.subagentRounds;
  total.toolCalls += usage.toolCalls;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheHitInputTokens += usage.cacheHitInputTokens;
  total.cacheMissInputTokens += usage.cacheMissInputTokens;
  total.totalTokens += usage.totalTokens;
  total.reasoningTokens = (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
  total.wallTimeMs += usage.wallTimeMs;
}

function subtractUsage(current: RunUsage, previous?: RunUsage): RunUsage {
  const before = previous ?? emptyUsage();
  return {
    modelRounds: Math.max(0, current.modelRounds - before.modelRounds),
    toolCalls: Math.max(0, current.toolCalls - before.toolCalls),
    inputTokens: Math.max(0, current.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - before.outputTokens),
    cacheHitInputTokens: Math.max(0, current.cacheHitInputTokens - before.cacheHitInputTokens),
    cacheMissInputTokens: Math.max(0, current.cacheMissInputTokens - before.cacheMissInputTokens),
    totalTokens: Math.max(0, current.totalTokens - before.totalTokens),
    reasoningTokens: Math.max(0, (current.reasoningTokens ?? 0) - (before.reasoningTokens ?? 0)),
    wallTimeMs: Math.max(0, current.wallTimeMs - before.wallTimeMs),
    ...((current.subagentRounds ?? before.subagentRounds) !== undefined
      ? { subagentRounds: Math.max(0, (current.subagentRounds ?? 0) - (before.subagentRounds ?? 0)) }
      : {})
  };
}

class SessionCheckpointStore extends CheckpointStore {
  constructor(repoRoot: string, private readonly record: (id: string) => Promise<void>) {
    super(repoRoot);
  }

  override async snapshot(label: string) {
    const checkpoint = await super.snapshot(label);
    await this.record(checkpoint.id);
    return checkpoint;
  }
}

async function newSessionConfig(options: RunReplOptions, repoRoot: string): Promise<ChatSessionConfig> {
  const testCommandResolution: TestCommandResolution = options.testCommand !== undefined
    ? { command: options.testCommand, status: "selected", detail: "Using the explicitly configured --test command." }
    : await resolveTestCommand(repoRoot);
  const testCommand = testCommandResolution.command ?? undefined;
  const provider = options.provider ?? "openai";
  const model = options.model ?? (provider === "deepseek" ? "deepseek-v4-pro" : process.env.OPENAI_MODEL?.trim() || "gpt-5.5");
  const baseURL = persistableBaseURL(options.baseURL
    ?? (provider === "deepseek" ? "https://api.deepseek.com" : process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1"));
  return {
    provider,
    model,
    baseURL,
    mode: options.mode ?? "edit",
    profile: options.profile ?? "ctx",
    thinking: options.thinking ?? "enabled",
    reasoningEffort: options.reasoningEffort ?? "high",
    temperature: options.temperature ?? 0.2,
    ...(testCommand !== undefined ? { testCommand } : {}),
    testCommandResolution,
    ...(options.cliRules !== undefined ? { cliRules: clonePermissionRules(options.cliRules) } : {}),
    maxSteps: options.maxSteps ?? 60,
    maxToolCalls: options.maxToolCalls ?? 120,
    maxInputTokens: options.maxInputTokens ?? 2_000_000,
    maxOutputTokens: options.maxOutputTokens ?? 100_000,
    maxTurnOutputTokens: options.maxTurnOutputTokens ?? 8_192,
    maxTextOnlyNudges: options.maxTextOnlyNudges ?? 2,
    maxWallTimeMs: options.maxWallTimeMs ?? 30 * 60_000,
    timeoutSec: options.timeoutSec ?? 120,
    modelTimeoutMs: options.modelTimeoutMs ?? 180_000,
    maxApiAttempts: options.maxApiAttempts ?? 3,
    retryDelayMs: options.retryDelayMs ?? 1_000
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function pathForUserState(userHome: string, child: string): string {
  return path.join(userHome, ".onehand", child);
}

function resolveSessionConfig(options: RunReplOptions, saved: ChatSessionConfig, resuming: boolean): ChatSessionConfig {
  if (!resuming) return saved;
  assertSavedOption("provider", options.provider, saved.provider);
  assertSavedOption("model", options.model, saved.model);
  assertSavedOption("base URL", options.baseURL === undefined ? undefined : persistableBaseURL(options.baseURL), saved.baseURL);
  assertSavedOption("mode", options.mode, saved.mode);
  assertSavedOption("profile", options.profile, saved.profile);
  assertSavedOption("thinking mode", options.thinking, saved.thinking);
  assertSavedOption("reasoning effort", options.reasoningEffort, saved.reasoningEffort);
  assertSavedOption("temperature", options.temperature, saved.temperature);
  assertSavedOption("test command", options.testCommand, saved.testCommand);
  if (options.cliRules !== undefined && !samePermissionRules(options.cliRules, saved.cliRules)) {
    throw new Error("Resume CLI permission rules do not match the saved CLI permission rules");
  }
  assertSavedOption("per-turn output limit", options.maxTurnOutputTokens, saved.maxTurnOutputTokens);
  return {
    ...saved,
    maxSteps: options.maxSteps ?? saved.maxSteps,
    maxToolCalls: options.maxToolCalls ?? saved.maxToolCalls,
    maxInputTokens: options.maxInputTokens ?? saved.maxInputTokens,
    maxOutputTokens: options.maxOutputTokens ?? saved.maxOutputTokens,
    maxTextOnlyNudges: options.maxTextOnlyNudges ?? saved.maxTextOnlyNudges,
    maxWallTimeMs: options.maxWallTimeMs ?? saved.maxWallTimeMs,
    timeoutSec: options.timeoutSec ?? saved.timeoutSec,
    modelTimeoutMs: options.modelTimeoutMs ?? saved.modelTimeoutMs,
    maxApiAttempts: options.maxApiAttempts ?? saved.maxApiAttempts,
    retryDelayMs: options.retryDelayMs ?? saved.retryDelayMs
  };
}

function assertActiveRunIdentity(
  state: Awaited<ReturnType<typeof RunStore.load>>["state"],
  task: NonNullable<ChatSessionStore["state"]["activeTask"]>,
  config: ChatSessionConfig,
  repoRoot: string
): void {
  if (state.task !== task.task || state.repo !== repoRoot || state.provider !== config.provider || state.model !== config.model) {
    throw new Error("Saved run identity does not match the active chat task");
  }
}

function clonePermissionRules(rules: PermissionRules): PermissionRules {
  return {
    ...(rules.allow !== undefined ? { allow: [...rules.allow] } : {}),
    ...(rules.deny !== undefined ? { deny: [...rules.deny] } : {})
  };
}

function samePermissionRules(left: PermissionRules, right?: PermissionRules): boolean {
  const normalized = (rules?: PermissionRules) => JSON.stringify({ allow: rules?.allow ?? [], deny: rules?.deny ?? [] });
  return normalized(left) === normalized(right);
}

function assertSavedOption(label: string, supplied: unknown, saved: unknown): void {
  if (supplied !== undefined && supplied !== saved) {
    throw new Error(`Resume ${label} does not match the saved ${label}`);
  }
}

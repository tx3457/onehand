import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactDeep } from "../agent/persistence.js";
import type { PermissionMode, PermissionRules } from "../policy/permissions.js";
import type { PlanSnapshot, RunUsage } from "../types.js";
import type { TestCommandResolution } from "../tools/testCommand.js";

export const CHAT_SESSION_VERSION = 1;

export type ChatMemoryEntry = { input: string; finalMessage: string };

export type ChatSessionConfig = {
  provider: "openai" | "deepseek";
  model?: string;
  baseURL?: string;
  mode: PermissionMode;
  profile: string;
  thinking: "enabled" | "disabled";
  reasoningEffort: "high" | "max";
  temperature: number;
  testCommand?: string;
  testCommandResolution?: TestCommandResolution;
  cliRules?: PermissionRules;
  maxSteps: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTurnOutputTokens: number;
  maxTextOnlyNudges: number;
  maxWallTimeMs: number;
  timeoutSec: number;
  modelTimeoutMs: number;
  maxApiAttempts: number;
  retryDelayMs: number;
};

export type ActiveChatTask = {
  input: string;
  task: string;
  runDir: string;
  checkpoint?: string;
  accountedUsage?: RunUsage;
  phase: "prepared" | "running";
  resumeExact: boolean;
};

export type ChatSessionState = {
  schemaVersion: number;
  repo: string;
  config: ChatSessionConfig;
  memory: ChatMemoryEntry[];
  usage: RunUsage;
  usageByModel: Record<string, RunUsage>;
  activeTask: ActiveChatTask | null;
  lastRunCheckpoint?: string;
  lastTask?: string;
  lastPlan?: PlanSnapshot;
  updatedAt: string;
};

export class ChatSessionStore {
  readonly sessionDir: string;
  readonly statePath: string;
  state: ChatSessionState;

  private constructor(sessionDir: string, state: ChatSessionState) {
    this.sessionDir = sessionDir;
    this.statePath = path.join(sessionDir, "session.json");
    this.state = state;
  }

  static async create(options: {
    sessionDir?: string;
    userHome: string;
    repo: string;
    config: ChatSessionConfig;
    usage: RunUsage;
  }): Promise<ChatSessionStore> {
    const requestedDir = path.resolve(options.sessionDir ?? path.join(options.userHome, ".onehand", "sessions", randomUUID()));
    let sessionDir = await canonicalFuturePath(requestedDir);
    assertOutsideRepo(sessionDir, options.repo);
    if (options.sessionDir !== undefined) {
      try {
        await lstat(requestedDir);
        throw new Error(`Chat session directory already exists: ${sessionDir}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    sessionDir = await realpath(sessionDir);
    assertOutsideRepo(sessionDir, options.repo);
    await chmod(sessionDir, 0o700).catch(() => undefined);
    const store = new ChatSessionStore(sessionDir, {
      schemaVersion: CHAT_SESSION_VERSION,
      repo: options.repo,
      config: validateChatConfig(options.config),
      memory: [],
      usage: cloneUsage(options.usage),
      usageByModel: {},
      activeTask: null,
      updatedAt: new Date().toISOString()
    });
    await store.save();
    return store;
  }

  static async load(resumePath: string, expectedRepo: string): Promise<ChatSessionStore> {
    const absolute = path.resolve(resumePath);
    const requestedStatePath = path.basename(absolute) === "session.json" ? absolute : path.join(absolute, "session.json");
    let statePath: string;
    let sessionDir: string;
    let parsed: unknown;
    try {
      sessionDir = await realpath(path.dirname(requestedStatePath));
      statePath = await realpath(requestedStatePath);
      if (statePath !== path.join(sessionDir, "session.json")) {
        throw new Error("session.json must not be a symbolic link");
      }
      parsed = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      throw new Error(`Corrupt chat session metadata at ${requestedStatePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const state = validateState(parsed);
    if (state.repo !== expectedRepo) {
      throw new Error(`Chat session repository mismatch: saved ${state.repo}, current ${expectedRepo}`);
    }
    assertOutsideRepo(sessionDir, expectedRepo);
    if (state.activeTask) await assertInsideSessionRuns(state.activeTask.runDir, sessionDir);
    return new ChatSessionStore(sessionDir, state);
  }

  runDir(): string {
    return path.join(this.sessionDir, "runs", randomUUID());
  }

  async archiveActiveTask(): Promise<string | undefined> {
    if (!this.state.activeTask) return undefined;
    const recordPath = path.join(this.sessionDir, `discarded-${randomUUID()}.json`);
    await writeFile(recordPath, JSON.stringify(redactDeep({
      discardedAt: new Date().toISOString(), repo: this.state.repo,
      config: this.state.config, task: this.state.activeTask
    }), null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    return recordPath;
  }

  async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const temp = path.join(this.sessionDir, `.session.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(redactDeep(this.state), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.statePath);
    await chmod(this.statePath, 0o600).catch(() => undefined);
  }
}

function validateState(value: unknown): ChatSessionState {
  if (!isRecord(value)) throw new Error("Corrupt chat session: metadata must be an object");
  if (value.schemaVersion !== CHAT_SESSION_VERSION) {
    throw new Error(`Unsupported chat session schema version: ${String(value.schemaVersion)}`);
  }
  if (typeof value.repo !== "string" || value.repo.length === 0) throw new Error("Corrupt chat session: repo must be a non-empty string");
  const config = validateChatConfig(value.config);
  if (!Array.isArray(value.memory) || !value.memory.every((entry) =>
    isRecord(entry) && typeof entry.input === "string" && typeof entry.finalMessage === "string")) {
    throw new Error("Corrupt chat session: memory is invalid");
  }
  const usage = validateUsage(value.usage, "usage");
  if (!isRecord(value.usageByModel)) throw new Error("Corrupt chat session: usageByModel is invalid");
  const usageByModel: Record<string, RunUsage> = {};
  for (const [model, modelUsage] of Object.entries(value.usageByModel)) {
    usageByModel[model] = validateUsage(modelUsage, `usageByModel.${model}`);
  }
  let activeTask: ActiveChatTask | null = null;
  if (value.activeTask !== null) {
    if (!isRecord(value.activeTask)
      || typeof value.activeTask.input !== "string"
      || typeof value.activeTask.task !== "string"
      || typeof value.activeTask.runDir !== "string"
      || (value.activeTask.phase !== "prepared" && value.activeTask.phase !== "running")
      || typeof value.activeTask.resumeExact !== "boolean") {
      throw new Error("Corrupt chat session: activeTask is invalid");
    }
    activeTask = {
      input: value.activeTask.input,
      task: value.activeTask.task,
      runDir: value.activeTask.runDir,
      phase: value.activeTask.phase,
      resumeExact: value.activeTask.resumeExact,
      ...(typeof value.activeTask.checkpoint === "string" ? { checkpoint: value.activeTask.checkpoint } : {}),
      ...(value.activeTask.accountedUsage !== undefined
        ? { accountedUsage: validateUsage(value.activeTask.accountedUsage, "activeTask.accountedUsage") }
        : {})
    };
  }
  if (typeof value.updatedAt !== "string") throw new Error("Corrupt chat session: updatedAt is invalid");
  return {
    schemaVersion: CHAT_SESSION_VERSION,
    repo: value.repo,
    config,
    memory: value.memory as ChatMemoryEntry[],
    usage,
    usageByModel,
    activeTask,
    ...(typeof value.lastRunCheckpoint === "string" ? { lastRunCheckpoint: value.lastRunCheckpoint } : {}),
    ...(typeof value.lastTask === "string" ? { lastTask: value.lastTask } : {}),
    ...(isPlan(value.lastPlan) ? { lastPlan: value.lastPlan } : {}),
    updatedAt: value.updatedAt
  };
}

export function validateChatConfig(value: unknown): ChatSessionConfig {
  if (!isRecord(value)) throw new Error("Corrupt chat session: config is invalid");
  if (value.provider !== "openai" && value.provider !== "deepseek") throw new Error("Corrupt chat session: provider is invalid");
  if (typeof value.model !== "string" || !value.model.trim()) throw new Error("Corrupt chat session: model is invalid");
  if (typeof value.baseURL !== "string") throw new Error("Corrupt chat session: baseURL is invalid");
  const baseURL = persistableBaseURL(value.baseURL);
  if (value.testCommand !== undefined && (typeof value.testCommand !== "string" || !value.testCommand.trim())) {
    throw new Error("Corrupt chat session: testCommand is invalid");
  }
  if (value.testCommandResolution !== undefined) {
    const resolution = value.testCommandResolution;
    if (!isRecord(resolution) || typeof resolution.detail !== "string" ||
        !["selected", "missing", "ambiguous", "invalid"].includes(String(resolution.status)) ||
        resolution.command !== (value.testCommand ?? null) ||
        (resolution.status === "selected") !== (typeof resolution.command === "string")) {
      throw new Error("Corrupt chat session: test command resolution is invalid");
    }
  }
  if (value.mode !== "ask" && value.mode !== "edit" && value.mode !== "auto") throw new Error("Corrupt chat session: mode is invalid");
  if (typeof value.profile !== "string" || value.profile.length === 0) throw new Error("Corrupt chat session: profile is invalid");
  if (value.thinking !== "enabled" && value.thinking !== "disabled") throw new Error("Corrupt chat session: thinking is invalid");
  if (value.reasoningEffort !== "high" && value.reasoningEffort !== "max") throw new Error("Corrupt chat session: reasoningEffort is invalid");
  if (value.cliRules !== undefined && !validPermissionRules(value.cliRules)) {
    throw new Error("Corrupt chat session: cliRules is invalid");
  }
  const numeric = ["temperature", "maxSteps", "maxToolCalls", "maxInputTokens", "maxOutputTokens", "maxTurnOutputTokens",
    "maxTextOnlyNudges", "maxWallTimeMs", "timeoutSec", "modelTimeoutMs", "maxApiAttempts", "retryDelayMs"] as const;
  for (const field of numeric) {
    if (!Number.isFinite(value[field])) throw new Error(`Corrupt chat session: config.${field} is invalid`);
    const minimum = field === "temperature" || field === "maxTextOnlyNudges" || field === "retryDelayMs" ? 0 : 1;
    if ((value[field] as number) < minimum || (field !== "temperature" && !Number.isSafeInteger(value[field]))) {
      throw new Error(`Corrupt chat session: config.${field} is outside its valid range`);
    }
  }
  return { ...value, baseURL } as ChatSessionConfig;
}

export function persistableBaseURL(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Provider base URL must be a valid absolute HTTP(S) URL for chat persistence"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Provider base URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Provider base URL cannot contain credentials, query parameters, or a fragment in a persistent chat session");
  }
  return parsed.toString().replace(/\/$/, "");
}

function validateUsage(value: unknown, field: string): RunUsage {
  if (!isRecord(value)) throw new Error(`Corrupt chat session: ${field} is invalid`);
  for (const name of ["modelRounds", "toolCalls", "inputTokens", "outputTokens", "cacheHitInputTokens",
    "cacheMissInputTokens", "totalTokens", "wallTimeMs"] as const) {
    if (!Number.isFinite(value[name])) throw new Error(`Corrupt chat session: ${field}.${name} is invalid`);
  }
  if (value.reasoningTokens !== undefined && !Number.isFinite(value.reasoningTokens)) {
    throw new Error(`Corrupt chat session: ${field}.reasoningTokens is invalid`);
  }
  if (value.subagentRounds !== undefined && !Number.isFinite(value.subagentRounds)) {
    throw new Error(`Corrupt chat session: ${field}.subagentRounds is invalid`);
  }
  return value as RunUsage;
}

function assertOutsideRepo(candidate: string, repo: string): void {
  const relative = path.relative(repo, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`Chat session storage must be outside the repository: ${candidate}`);
  }
}

async function assertInsideSessionRuns(candidate: string, sessionDir: string): Promise<void> {
  const runsDir = path.join(sessionDir, "runs");
  let canonicalCandidate = path.resolve(candidate);
  try {
    canonicalCandidate = await realpath(canonicalCandidate);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    canonicalCandidate = await canonicalFuturePath(canonicalCandidate);
  }
  const relative = path.relative(runsDir, canonicalCandidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Corrupt chat session: active run directory is outside the session: ${candidate}`);
  }
}

async function canonicalFuturePath(value: string): Promise<string> {
  let cursor = path.resolve(value);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(cursor), ...suffix);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function validPermissionRules(value: unknown): value is PermissionRules {
  if (!isRecord(value)) return false;
  return [value.allow, value.deny].every((rules) =>
    rules === undefined || (Array.isArray(rules) && rules.every((rule) => typeof rule === "string")));
}

function isPlan(value: unknown): value is PlanSnapshot {
  return isRecord(value) && typeof value.revision === "number" && Array.isArray(value.steps);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneUsage(usage: RunUsage): RunUsage {
  return { ...usage };
}

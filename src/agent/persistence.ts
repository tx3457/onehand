import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PlanSnapshot, RunStatus, RunUsage, StopReason } from "../types.js";
import type { ToolExecutionRecord } from "../tools/registry.js";

export const RUN_STATE_VERSION = 2;

export type PersistedRunState = {
  schemaVersion: number;
  runId: string;
  task: string;
  repo: string;
  gitHead: string | null;
  worktreeFingerprint: string | null;
  provider: "openai" | "deepseek";
  model: string;
  history: unknown[];
  plan: PlanSnapshot;
  usage: RunUsage;
  records: ToolExecutionRecord[];
  failureSignatures: Record<string, number>;
  finalMessage: string;
  status: RunStatus;
  stopReason?: StopReason;
  startedAt: string;
  updatedAt: string;
};

export class RunStore {
  readonly runId: string;
  readonly runDir: string;
  readonly statePath: string;
  readonly tracePath: string;

  constructor(options: { runId?: string; runDir?: string } = {}) {
    this.runId = options.runId ?? createRunId();
    this.runDir = path.resolve(options.runDir ?? path.join(homedir(), ".onehand", "runs", this.runId));
    this.statePath = path.join(this.runDir, "state.json");
    this.tracePath = path.join(this.runDir, "trace.jsonl");
  }

  async initialize(): Promise<void> {
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    await chmod(this.runDir, 0o700).catch(() => undefined);
  }

  async save(state: PersistedRunState): Promise<void> {
    await this.initialize();
    const temp = path.join(this.runDir, `.state.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(redactDeep(state), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.statePath);
    await chmod(this.statePath, 0o600).catch(() => undefined);
  }

  async trace(event: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.initialize();
    const record = { ts: new Date().toISOString(), event, data: redactDeep(data) };
    await appendFile(this.tracePath, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(this.tracePath, 0o600).catch(() => undefined);
  }

  static async load(resumePath: string): Promise<{ store: RunStore; state: PersistedRunState }> {
    const absolute = path.resolve(resumePath);
    const statePath = path.basename(absolute) === "state.json" ? absolute : path.join(absolute, "state.json");
    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw) as PersistedRunState;
    if (state.schemaVersion !== RUN_STATE_VERSION) {
      throw new Error(`Unsupported state schema version: ${state.schemaVersion}`);
    }
    const store = new RunStore({ runId: state.runId, runDir: path.dirname(statePath) });
    return { store, state };
  }
}

export function summarizeToolArguments(args: string | Record<string, unknown>): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  try {
    value = typeof args === "string" ? JSON.parse(args) as Record<string, unknown> : args;
  } catch {
    return { parseable: false, bytes: typeof args === "string" ? Buffer.byteLength(args) : 0 };
  }
  const summary: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/content|oldText|newText/i.test(key)) {
      summary[key] = { redacted: true, bytes: typeof item === "string" ? Buffer.byteLength(item) : 0 };
    } else if (/api.?key|token|secret|password|authorization/i.test(key)) {
      summary[key] = "[REDACTED]";
    } else if (Array.isArray(item)) {
      summary[key] = item.slice(0, 16).map((entry) => redactString(String(entry)));
    } else if (typeof item === "string") {
      summary[key] = redactString(item).slice(0, 240);
    } else summary[key] = item;
  }
  return summary;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = /api.?key|token|secret|password|authorization|reasoning_content/i.test(key)
        ? "[REDACTED]"
        : redactDeep(item);
    }
    return output as T;
  }
  return value;
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ds|key)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_KEY]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]");
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

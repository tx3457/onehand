import path from "node:path";
import { redactDeep, summarizeToolArguments } from "../agent/persistence.js";
import { ConfinedDirectory, HttpError, parseArtifactJson } from "./files.js";

type ObjectValue = Record<string, unknown>;
const USAGE_FIELDS = ["modelRounds", "subagentRounds", "toolCalls", "inputTokens", "outputTokens", "totalTokens", "cacheHitInputTokens", "cacheMissInputTokens", "reasoningTokens", "wallTimeMs"];
const TRACE_FIELDS = ["round", "name", "tool", "argsSummary", "ok", "passed", "error", "errorCategory", "durationMs", "latencyMs", "finishReason", "responseModel", "toolCallNames", "observationBytes", "planRevision", "truncated", "promptTokensBefore", "maskedItems", "bytesRemoved", "bytesKept", "keptRounds", "preset", "question", "status", "stopReason", "decision", "source", "id", "label"];
const TRACE_EVENTS = new Set(["model_turn", "tool_result", "tool_started", "tool_finished", "context_masked", "permission_decision", "checkpoint_created", "run_started", "run_resumed", "run_finished", "environment_failure"]);

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}

function text(value: unknown, length = 1000): string {
  return typeof value === "string" ? value.slice(0, length) : "";
}

function usage(value: unknown): ObjectValue {
  const source = object(value);
  return Object.fromEntries(USAGE_FIELDS.filter((key) => typeof source[key] === "number" && Number.isFinite(source[key]))
    .map((key) => [key, source[key]]));
}

export async function readRunState(root: ConfinedDirectory, id: string): Promise<ObjectValue> {
  try {
    return object(redactDeep(parseArtifactJson(await root.read(id, "state.json", 8 * 1024 * 1024))));
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(422, "Run state is not valid JSON");
    throw error;
  }
}

function runSummary(id: string, state: ObjectValue, taskLimit = 160) {
  return {
    id, task: text(state.task, taskLimit), repo: path.basename(text(state.repo, 4096)),
    provider: text(state.provider), model: text(state.model), status: text(state.status),
    stopReason: text(state.stopReason), usage: usage(state.usage), updatedAt: text(state.updatedAt)
  };
}

export async function listRuns(root: ConfinedDirectory) {
  const runs: ReturnType<typeof runSummary>[] = [];
  for (const id of await root.directories()) {
    try {
      if (!(await root.files(id)).includes("state.json")) continue;
      runs.push(runSummary(id, await readRunState(root, id)));
    }
    catch (error) {
      // A corrupt, oversized or concurrently removed run must not hide other runs.
      if (!(error instanceof HttpError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export async function readRun(root: ConfinedDirectory, id: string) {
  const state = await readRunState(root, id);
  const plan = object(state.plan);
  const steps = Array.isArray(plan.steps) ? plan.steps.slice(0, 1000).map((value) => {
    const step = object(value);
    return { id: typeof step.id === "number" ? step.id : text(step.id, 100), description: text(step.description, 4096), status: text(step.status), evidence: text(step.evidence, 8192) };
  }) : [];
  const trace = (await root.files(id)).includes("trace.jsonl")
    ? await root.tail(id, "trace.jsonl", 2 * 1024 * 1024) : { text: "", truncated: false };
  const timeline: Array<{ ts: string; event: string; data: ObjectValue }> = [];
  let malformed = false;
  for (const line of trace.text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = object(JSON.parse(line));
      const event = text(record.event, 100);
      if (!TRACE_EVENTS.has(event) && !event.startsWith("subagent_")) continue;
      const source = object(redactDeep(record.data));
      const data: ObjectValue = {};
      for (const key of TRACE_FIELDS) {
        const value = source[key];
        if (typeof value === "string") data[key] = value.slice(0, 2000);
        else if (typeof value === "number" || typeof value === "boolean") data[key] = value;
        else if (key === "toolCallNames" && Array.isArray(value)) data[key] = value.slice(0, 100).map((name) => text(name, 100));
      }
      if (source.usage) data.usage = usage(source.usage);
      if (source.arguments) {
        const summary = summarizeToolArguments(object(source.arguments));
        // Keep argument summaries bounded even for unexpectedly nested data.
        data.arguments = JSON.stringify(summary).length <= 4000 ? summary : "[argument summary exceeds display limit]";
      }
      timeline.push({ ts: text(record.ts, 100), event, data });
    } catch { malformed = true; /* A running writer may leave an incomplete last line. */ }
  }
  return {
    ...runSummary(id, state, 10000), plan: { status: text(plan.status), steps },
    finalMessage: text(state.finalMessage, 64 * 1024), timeline: timeline.slice(-2000),
    timelineTruncated: trace.truncated || timeline.length > 2000,
    timelineIncomplete: malformed
  };
}

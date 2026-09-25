import type { PermissionMode } from "../policy/permissions.js";
import type { PlanSnapshot, RunStatus, RunUsage, StopReason, TokenUsage, ToolResult } from "../types.js";
import { redactDeep, summarizeToolArguments } from "./persistence.js";

export type AgentEvent =
  | { type: "run_started"; task: string; mode: PermissionMode }
  | { type: "model_turn"; round: number; usage: TokenUsage; text?: string; toolCalls: Array<{ name: string; argsSummary: string }> }
  | { type: "tool_started"; name: string; argsSummary: string }
  | { type: "tool_finished"; name: string; ok: boolean; durationMs: number; summary: string }
  | { type: "plan_updated"; plan: PlanSnapshot }
  | { type: "checkpoint_created"; id: string; label: string }
  | { type: "subagent_started"; preset: "explore" | "review"; question?: string }
  | { type: "subagent_finished"; preset: "explore" | "review"; usage: RunUsage; status: RunStatus }
  | { type: "permission_decision"; tool: string; argsSummary: string; decision: "allow" | "deny"; source: string }
  | { type: "run_finished"; status: RunStatus; stopReason: StopReason; usage: RunUsage; finalMessage: string };

export function emitAgentEvent(listener: ((event: AgentEvent) => void) | undefined, event: AgentEvent): void {
  if (!listener) return;
  try {
    const result: unknown = listener(structuredClone(event));
    if (result instanceof Promise) void result.catch(() => {});
  } catch {}
}

export function summarizeEventArguments(rawArgs: string | Record<string, unknown>): string {
  try {
    const args = summarizeToolArguments(rawArgs);
    if (typeof args.program === "string") {
      return oneLine([args.program, ...(Array.isArray(args.args) ? args.args.map(String) : [])].join(" "));
    }
    if (typeof args.path === "string") return oneLine(args.path);
    if (typeof args.query === "string") return oneLine(args.query);
    return oneLine(JSON.stringify(args));
  } catch {
    return "invalid arguments";
  }
}

export function toolSucceeded(result: ToolResult<unknown>): boolean {
  if (!result.ok) return false;
  const data = result.data as { exitCode?: number | null; passed?: boolean; timedOut?: boolean } | undefined;
  return data?.passed !== false && data?.timedOut !== true && (data?.exitCode === undefined || data.exitCode === 0);
}

export function summarizeToolOutcome(
  name: string,
  args: string | Record<string, unknown>,
  result: ToolResult<unknown>,
  durationMs: number
): string {
  if (!result.ok) return oneLine(`error: ${result.error}`);
  const data = result.data as Record<string, unknown> | undefined;
  if (name === "run_command" || name === "run_tests") {
    return `exit ${data?.exitCode ?? "none"} · ${((typeof data?.durationMs === "number" ? data.durationMs : durationMs) / 1000).toFixed(1)}s${data?.timedOut ? " · timed out" : ""}`;
  }
  const target = summarizeEventArguments(args);
  if (name === "read_file") {
    const lines = typeof data?.startLine === "number" ? ` ${data.startLine}–${data.endLine}` : "";
    return `read ${target}${lines}`;
  }
  if (name === "write_file") return `wrote ${target}`;
  if (name === "replace_text") return `updated ${target}`;
  if (name === "list_files" && Array.isArray(data?.files)) return `${data.files.length} files`;
  if (name === "search_code" && Array.isArray(data?.matches)) return `${data.matches.length} matches`;
  if (name === "git_status" && Array.isArray(data?.changedFiles)) return `${data.changedFiles.length} changed files`;
  if (name === "git_diff") return data?.diff ? "working-tree diff" : "no changes";
  return "done";
}

function oneLine(value: string): string {
  return redactDeep(value).replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

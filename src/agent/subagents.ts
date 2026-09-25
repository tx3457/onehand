import { emitAgentEvent } from "./events.js";
import { PROFILES, resolveFeatures, type AgentProfile } from "./profile.js";
import { runAgent, type RunAgentOptions } from "./runner.js";
import type { PlanSnapshot, RunReport, RunStatus, RunUsage } from "../types.js";
import { gitDiff, gitStatus } from "../tools/git.js";
import type { ToolDefinition } from "../tools/registry.js";
import { truncateText } from "../utils/truncate.js";

const MAX_REVIEW_DIFF_BYTES = 30 * 1024;

const EXPLORE_PROMPT = [
  "You are the explore sub-agent.",
  "Investigate the question in the repository and return a concise report of at most 300 words, with file paths and line numbers.",
  "Do not speculate beyond what you read. Use only the read-only inspection tools provided to you."
].join(" ");

const REVIEW_PROMPT = [
  "You are the review sub-agent.",
  "Review the change for correctness against the task. List concrete defects with file:line, or say \"no blocking issues\".",
  "Do not rewrite code. Use only the read-only inspection tools provided to you."
].join(" ");

export const REVIEW_CHANGES_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  name: "review_changes",
  description: "Ask a read-only review sub-agent to check the current change against the task and plan.",
  parameters: { type: "object", properties: {}, additionalProperties: false }
};

export type SubagentBudgets = {
  maxSteps: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallTimeMs: number;
};

export type RunSubagentOptions = {
  preset: "explore" | "review";
  question?: string;
  task: string;
  parent: Omit<RunAgentOptions, "task">;
  plan?: PlanSnapshot;
  parentUsage?: RunUsage;
  parentLimits?: SubagentBudgets;
  subagentIndex?: number;
  trace?: (event: string, data: Record<string, unknown>) => Promise<void>;
};

export async function runSubagent(options: RunSubagentOptions): Promise<RunReport> {
  const index = options.subagentIndex ?? 1;
  const question = options.preset === "explore" ? options.question ?? options.task : undefined;
  const started = { preset: options.preset, ...(question ? { question } : {}) };
  emitAgentEvent(options.parent.onEvent, { type: "subagent_started", ...started });
  await options.trace?.("subagent_started", started);

  let report: RunReport | undefined;
  try {
    const task = options.preset === "review"
      ? await reviewTask(options.task, options.plan, options.parent)
      : question!;
    const limits = childLimits(options.parent, options.parentUsage, options.parentLimits);
    const features = resolveFeatures(options.parent.profile?.flags ?? PROFILES.baseline.flags);
    const profile: AgentProfile = {
      name: `subagent-${options.preset}`,
      flags: {
        ...(features.retrieval ? { retrieval: true } : {}),
        ...(features.sandboxCommands ? { sandboxCommands: true } : {})
      }
    };
    const nonce = childNonce(options.parent.cacheIsolationNonce, index);
    report = await runAgent({
      ...options.parent,
      task,
      completion: "answer",
      profile,
      enforcePlanning: false,
      persistence: false,
      resume: undefined,
      runDir: undefined,
      checkpoints: false,
      extraTools: undefined,
      interactiveTools: undefined,
      subagentDepth: 1,
      readOnlyTools: true,
      systemPrompt: options.preset === "review" ? REVIEW_PROMPT : EXPLORE_PROMPT,
      onEvent: options.parent.onEvent ? (event) => {
        if (event.type !== "run_started" && event.type !== "run_finished") {
          emitAgentEvent(options.parent.onEvent, event);
        }
      } : undefined,
      cacheIsolationNonce: nonce,
      ...limits
    });
    return report;
  } finally {
    const usage = report?.usage ?? emptyUsage();
    const status: RunStatus = report?.status ?? "failed";
    const finished = { preset: options.preset, usage, status };
    await options.trace?.("subagent_finished", finished);
    emitAgentEvent(options.parent.onEvent, { type: "subagent_finished", ...finished });
  }
}

function childLimits(
  parent: Omit<RunAgentOptions, "task">,
  usage: RunUsage | undefined,
  configured: SubagentBudgets | undefined
): Pick<RunAgentOptions, "maxSteps" | "maxToolCalls" | "maxInputTokens" | "maxOutputTokens" | "maxWallTimeMs"> {
  const limits = configured ?? {
    maxSteps: parent.maxSteps ?? 20,
    maxToolCalls: parent.maxToolCalls ?? 40,
    maxInputTokens: parent.maxInputTokens ?? 300_000,
    maxOutputTokens: parent.maxOutputTokens ?? 40_000,
    maxWallTimeMs: parent.maxWallTimeMs ?? 15 * 60_000
  };
  const spent = usage ?? emptyUsage();
  return {
    maxSteps: Math.max(0, Math.min(20, limits.maxSteps - spent.modelRounds - (spent.subagentRounds ?? 0))),
    maxToolCalls: Math.max(0, Math.min(30, limits.maxToolCalls - spent.toolCalls)),
    maxInputTokens: Math.max(0, Math.min(400_000, limits.maxInputTokens - spent.inputTokens)),
    maxOutputTokens: Math.max(0, limits.maxOutputTokens - spent.outputTokens),
    maxWallTimeMs: Math.max(0, limits.maxWallTimeMs - spent.wallTimeMs)
  };
}

async function reviewTask(task: string, plan: PlanSnapshot | undefined, parent: Omit<RunAgentOptions, "task">): Promise<string> {
  const timeout = parent.timeoutSec ?? 120;
  const isolated = parent.executor?.kind === "docker";
  const [result, status] = await Promise.all([
    gitDiff(parent.repoPath, timeout, isolated, "HEAD"),
    gitStatus(parent.repoPath, timeout, isolated)
  ]);
  const diff = result.ok ? result.data.diff : `(git diff unavailable: ${result.error})`;
  const changes = status.ok ? status.data.output : `(git status unavailable: ${status.error})`;
  const context = [
    `Changed-file status (staged, unstaged, and untracked):\n${truncateText(changes, 4 * 1024).text || "(none)"}`,
    "Inspect the listed untracked files with the read-only tools; they are not included in the tracked diff.",
    `Current git diff (capped at 30 KB):\n${diff || "(no tracked changes)"}`
  ].join("\n\n");
  return [
    `Task:\n${task}`,
    `Parent plan:\n${JSON.stringify(plan ?? null, null, 2)}`,
    truncateText(context, MAX_REVIEW_DIFF_BYTES).text
  ].join("\n\n");
}

function childNonce(parent: string | undefined, index: number): string | undefined {
  if (!parent) return undefined;
  return `${parent}-sub${index}`;
}

function emptyUsage(): RunUsage {
  return {
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
}

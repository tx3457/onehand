import type { AgentFeatures } from "./agent/profile.js";
import type { Executor } from "./runtime/executor.js";

export type ToolResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  // code "environment": the execution environment failed (e.g. the container is gone), not the command.
  | { ok: false; error: string; recoverable: boolean; code?: "environment" };

export type RunStatus =
  | "success"
  | "failed"
  | "stopped"
  | "blocked"
  | "budget_exhausted"
  | "cancelled";

export type StopReason =
  | "explicit_finish"
  | "model_stopped_without_finish"
  | "model_error"
  | "step_budget"
  | "tool_budget"
  | "token_budget"
  | "wall_time_budget"
  | "blocked"
  | "cancelled"
  | "output_limit"
  | "runtime_error";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
};

export type RunUsage = TokenUsage & {
  modelRounds: number;
  toolCalls: number;
  wallTimeMs: number;
};

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";

export type PlanStep = {
  id: number;
  description: string;
  status: PlanStepStatus;
  evidence?: string;
};

export type PlanSnapshot = {
  revision: number;
  status: "unset" | "active" | "completed" | "blocked";
  steps: PlanStep[];
  needsReplan: boolean;
  writeRevision: number;
  validatedWriteRevision: number;
  summary?: string;
};

export type CommandRecord = {
  command: string;
  exitCode: number | null;
};

export type TestRecord = {
  command: string;
  passed: boolean;
  exitCode: number | null;
};

export type RunReport = {
  status: RunStatus;
  stopReason?: StopReason;
  task: string;
  repo: string;
  changedFiles: string[];
  commands: CommandRecord[];
  tests: TestRecord[];
  diff: string | null;
  finalMessage: string;
  usage?: RunUsage;
  plan?: PlanSnapshot;
  runId?: string;
  statePath?: string;
  tracePath?: string;
};

export type CommandExecution = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  failures?: string[];
};

export type ToolExecutionContext = {
  features?: Partial<AgentFeatures>;
  repoRoot: string;
  testCommand?: string;
  timeoutSec: number;
  allowDestructive: boolean;
  enforcePlanning?: boolean;
  executor?: Executor;
  // The repository root as the model sees it (e.g. /testbed). It must match the executor's path mapper;
  // a local executor accepts only the repository root.
  displayRoot?: string;
  // The operator-configured test command skips the model command policy; targets are still validated.
  trustedTestCommand?: boolean;
  // Whether a passing run_tests with targets verifies the latest change. Off by default: a subset run
  // is recorded, but finish_task then needs an untargeted pass.
  allowTargetedVerification?: boolean;
};

export type ToolResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; error: string; recoverable: boolean };

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
  | "cancelled";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  totalTokens: number;
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
};

export type ToolExecutionContext = {
  repoRoot: string;
  testCommand?: string;
  timeoutSec: number;
  allowDestructive: boolean;
  enforcePlanning?: boolean;
};

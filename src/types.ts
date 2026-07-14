export type ToolResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; error: string; recoverable: boolean };

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
  status: "success" | "failed" | "stopped";
  task: string;
  repo: string;
  changedFiles: string[];
  commands: CommandRecord[];
  tests: TestRecord[];
  diff: string | null;
  finalMessage: string;
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
};

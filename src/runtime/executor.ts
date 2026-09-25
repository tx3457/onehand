import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { CommandExecution, ToolResult } from "../types.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT, truncateText } from "../utils/truncate.js";

const SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "CI"];
// `timeout` inside the container enforces the deadline; this host timer only stops a hung docker client.
const DOCKER_BACKSTOP_SEC = 15;
// coreutils `timeout` exits 124 at the deadline, or 137 when --kill-after had to SIGKILL the command.
const TIMEOUT_EXIT_CODES = new Set([124, 137]);
// With one of these exit codes and daemon or runtime text, `docker exec` itself failed, not the command.
const DOCKER_FAILURE_EXIT_CODES = new Set([125, 126, 127]);
const DOCKER_FAILURE_TEXT = /Error response from daemon|OCI runtime|No such container|is not running|cannot exec in a stopped/;

export type ExecRequest = {
  program: string;
  args: string[];
  // Host path, already validated by the caller.
  cwd: string;
  timeoutSec: number;
  env?: Record<string, string>;
  outputLimitBytes?: number;
  // Defaults to "head"; model-facing tools opt into "head_tail" so trailing failures stay visible.
  truncation?: "head" | "head_tail";
  displayCommand?: string;
  captureFailures?: boolean;
  signal?: AbortSignal;
};

// Executors run what they are given; callers apply the command policy first.
export interface Executor {
  readonly kind: "local" | "docker";
  // The one host/display mapping: callers validate paths through it and the executor runs them with it.
  readonly pathMapper: PathMapper;
  run(request: ExecRequest): Promise<ToolResult<CommandExecution>>;
}

export class LocalExecutor implements Executor {
  readonly kind = "local" as const;
  // Commands run on the host, where every display path is the host path itself.
  readonly pathMapper = new PathMapper("/", "/");

  run(request: ExecRequest): Promise<ToolResult<CommandExecution>> {
    return spawnAndCapture({
      spawnImpl: spawn,
      program: request.program,
      args: request.args,
      cwd: request.cwd,
      env: { ...safeEnvironment(), ...request.env },
      killAfterMs: Math.max(1, request.timeoutSec) * 1_000,
      command: request.displayCommand ?? [request.program, ...request.args].join(" "),
      outputLimitBytes: request.outputLimitBytes,
      truncation: request.truncation,
      captureFailures: request.captureFailures,
      signal: request.signal
    });
  }
}

export type DockerExecutorOptions = {
  container: string;
  pathMapper: PathMapper;
  user?: string;
  env?: Record<string, string>;
  activation?: string;
  // Test seam only.
  spawnImpl?: typeof spawn;
};

export class DockerExecutor implements Executor {
  readonly kind = "docker" as const;
  readonly pathMapper: PathMapper;
  private readonly options: DockerExecutorOptions;

  constructor(options: DockerExecutorOptions) {
    this.options = options;
    this.pathMapper = options.pathMapper;
  }

  async run(request: ExecRequest): Promise<ToolResult<CommandExecution>> {
    // A cwd outside the mapped checkout has no container path; running it anywhere else would be silent drift.
    if (!this.pathMapper.maps(request.cwd)) {
      return environmentFailure(`Working directory is outside the mapped repository root: ${request.cwd}`);
    }
    const timeoutSec = Math.max(1, request.timeoutSec);
    const result = await spawnAndCapture({
      spawnImpl: this.options.spawnImpl ?? spawn,
      program: "docker",
      args: buildDockerExecArgs({
        container: this.options.container,
        containerCwd: this.pathMapper.toDisplay(request.cwd),
        user: this.options.user,
        env: { ...this.options.env, ...request.env },
        activation: this.options.activation,
        timeoutSec,
        program: request.program,
        args: request.args
      }),
      env: dockerClientEnvironment(),
      killAfterMs: (timeoutSec + DOCKER_BACKSTOP_SEC) * 1_000,
      deadlineMs: timeoutSec * 1_000,
      command: request.displayCommand ?? [request.program, ...request.args].join(" "),
      outputLimitBytes: request.outputLimitBytes,
      truncation: request.truncation,
      captureFailures: request.captureFailures
    });
    if (!result.ok) return environmentFailure(`docker could not be started: ${result.error}`);
    const { exitCode, stdout, stderr } = result.data;
    const output = `${stderr}\n${stdout}`.trim();
    if (exitCode !== null && DOCKER_FAILURE_EXIT_CODES.has(exitCode) && DOCKER_FAILURE_TEXT.test(output)) {
      return environmentFailure(`docker exec failed with exit ${exitCode}: ${output.slice(0, 1_000)}`);
    }
    return result;
  }
}

export function buildDockerExecArgs(options: {
  container: string;
  containerCwd: string;
  program: string;
  args: string[];
  timeoutSec: number;
  user?: string;
  env?: Record<string, string>;
  activation?: string;
}): string[] {
  // The program and its arguments reach bash only as positional parameters, never as script text,
  // and `exec --` keeps a program named like an option (-a, -c) from becoming an exec flag.
  // The activation runs with no positional parameters: a bare `source .../activate` would otherwise
  // receive the command as its own arguments (conda rejects them).
  const script = options.activation
    ? `onehand_argv=("$@"); set --; ${options.activation} && exec -- "\${onehand_argv[@]}"`
    : 'exec -- "$@"';
  return [
    "exec", "-w", options.containerCwd,
    ...(options.user ? ["-u", options.user] : []),
    ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    options.container,
    "timeout", "--signal=TERM", "--kill-after=5s", `${options.timeoutSec}s`,
    "bash", "-c", script, "onehand", options.program, ...options.args
  ];
}

// Maps between the host checkout and the repository root the model sees, e.g. /testbed in a container.
export class PathMapper {
  readonly hostRoot: string;
  readonly displayRoot: string;

  constructor(hostRoot: string, displayRoot: string) {
    // The tool registry works on the checkout's realpath, so a symlinked root must map the same paths.
    this.hostRoot = canonicalPath(hostRoot);
    this.displayRoot = trimTrailingSlashes(displayRoot);
  }

  toHost(value: string): string {
    return swapRoot(value, this.displayRoot, this.hostRoot);
  }

  toDisplay(value: string): string {
    return swapRoot(value, this.hostRoot, this.displayRoot);
  }

  // Whether a host path is the host root or below it, i.e. has a display path.
  maps(hostPath: string): boolean {
    return hostPath === this.hostRoot || hostPath.startsWith(this.hostRoot.endsWith("/") ? this.hostRoot : `${this.hostRoot}/`);
  }
}

// The repository root the model sees under `executor`. Path checks and execution share the executor's
// mapper, so a displayRoot that disagrees with it is refused: a local executor runs display paths
// verbatim on the host, where /testbed/x is not the checkout's x. `repoRoot` must be a realpath.
export function resolveDisplayRoot(executor: Executor, repoRoot: string, displayRoot?: string): string {
  if (executor.kind === "local") {
    if (displayRoot !== undefined && canonicalPath(displayRoot) !== repoRoot) {
      throw new Error(`A local executor runs commands on the host, so displayRoot must be the repository root ${repoRoot}, not ${displayRoot}`);
    }
    return repoRoot;
  }
  const mapper = executor.pathMapper;
  if (mapper.hostRoot !== repoRoot) throw new Error(`The executor maps ${mapper.hostRoot}, not the repository root ${repoRoot}`);
  if (displayRoot !== undefined && trimTrailingSlashes(displayRoot) !== mapper.displayRoot) {
    throw new Error(`displayRoot ${displayRoot} does not match the executor's display root ${mapper.displayRoot}`);
  }
  return mapper.displayRoot;
}

// Only whole leading segments match (/testbed2 is not under /testbed); relative paths never match.
function swapRoot(value: string, from: string, to: string): string {
  if (from === to) return value;
  if (value === from) return to;
  const prefix = from.endsWith("/") ? from : `${from}/`;
  if (!value.startsWith(prefix)) return value;
  return `${to.endsWith("/") ? to : `${to}/`}${value.slice(prefix.length)}`;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/(?<=.)\/+$/, "");
}

// The realpath, or the absolute lexical path while nothing exists there.
function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.resolve(value);
  }
}

function spawnAndCapture(options: {
  spawnImpl: typeof spawn;
  program: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  killAfterMs: number;
  // The deadline coreutils `timeout` enforces; once it passes, `timeout` exits 124 (137 after --kill-after).
  deadlineMs?: number;
  command: string;
  outputLimitBytes?: number;
  truncation?: "head" | "head_tail";
  captureFailures?: boolean;
  signal?: AbortSignal;
}): Promise<ToolResult<CommandExecution>> {
  if (options.signal?.aborted) return Promise.resolve(failure("Command aborted"));
  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_TOOL_OUTPUT_LIMIT;
  const truncation = options.truncation ?? "head";
  const started = Date.now();

  return new Promise((resolve) => {
    const child = options.spawnImpl(options.program, options.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
      detached: options.signal !== undefined
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;
    let aborted = false;
    let settled = false;

    const finish = (result: ToolResult<CommandExecution>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const terminate = (reason: "abort" | "timeout") => {
      if (settled || aborted || killed) return;
      if (reason === "abort") aborted = true;
      else killed = true;
      killChild(child.pid, child.kill.bind(child), "SIGTERM", options.signal !== undefined);
      setTimeout(() => {
        killChild(child.pid, child.kill.bind(child), "SIGKILL", options.signal !== undefined);
      }, 1_000).unref();
    };
    const abort = () => terminate("abort");
    const timer = setTimeout(() => {
      terminate("timeout");
    }, options.killAfterMs);
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => finish(failure(error.message)));
    child.on("close", (code) => {
      if (aborted) {
        finish(failure("Command aborted"));
        return;
      }
      const durationMs = Date.now() - started;
      // A 124 or 137 well before the deadline is the command's own exit status, not a timeout.
      const timedOut = killed || (options.deadlineMs !== undefined && code !== null && TIMEOUT_EXIT_CODES.has(code) &&
        durationMs >= options.deadlineMs - 250);
      const fullStdout = Buffer.concat(stdoutChunks).toString("utf8");
      const fullStderr = Buffer.concat(stderrChunks).toString("utf8");
      const stdout = truncateText(fullStdout, outputLimitBytes, truncation);
      const stderr = truncateText(fullStderr, outputLimitBytes, truncation);
      const truncated = stdout.truncated || stderr.truncated;
      const failureLines = options.captureFailures ? extractFailureLines(fullStdout, fullStderr) : [];
      const captured = failureLines.length > 0 ? { failures: failureLines } : {};
      finish({
        ok: true,
        data: {
          command: options.command,
          exitCode: timedOut ? null : code,
          stdout: stdout.text,
          stderr: stderr.text,
          timedOut,
          durationMs,
          truncated,
          ...captured
        },
        truncated
      });
    });
  });
}

function killChild(
  pid: number | undefined,
  kill: (signal?: NodeJS.Signals | number) => boolean,
  signal: NodeJS.Signals,
  processGroup: boolean
): void {
  if (processGroup && pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  kill(signal);
}

function extractFailureLines(stdout: string, stderr: string): string[] {
  const matchesFailure = /^(?:(?:FAILED|ERROR)\b|(?:FAIL|ERROR):\s|E\s{3})/;
  const failures: string[] = [];
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    if (matchesFailure.test(line)) failures.push(line);
    if (failures.length === 40) break;
  }
  return failures;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

// The docker client also needs its own connection settings. Nothing here reaches the container:
// it gets its image environment plus the explicit -e K=V values only.
function dockerClientEnvironment(): NodeJS.ProcessEnv {
  const env = safeEnvironment();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("DOCKER_") && value !== undefined) env[key] = value;
  }
  return env;
}

function failure(error: string): ToolResult<never> {
  return { ok: false, error, recoverable: true };
}

// Not the agent's doing: the run should stop so the harness can retry it as infrastructure.
function environmentFailure(error: string): ToolResult<never> {
  return { ok: false, error, recoverable: false, code: "environment" };
}

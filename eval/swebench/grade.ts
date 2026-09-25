import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { docker, ensureImage, InfraError } from "./container.js";
import { ImageSource, imageFor, SwebenchRecord } from "./dataset.js";

const execFileAsync = promisify(execFile);

export const MAX_GRADE_ATTEMPTS = 3;
// Past the harness's own test timeout: container setup, patch application, and cleanup.
const HARNESS_BACKSTOP_SEC = 900;
// swebench 5.0.2, harness/constants: run_instance logs these through the instance logger, so each starts a
// timestamped log line. The diffs and git-apply output the log also carries are the patch's own text, and
// never start one.
const APPLY_PATCH_PASS = ">>>>> Applied Patch";
const APPLY_PATCH_FAIL = ">>>>> Patch Apply Failed";
const LOG_STAMP = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - [A-Z]+ - `;
// Logged messages that quote the patch or the test run rather than the harness.
const QUOTED_MESSAGES = [APPLY_PATCH_PASS, APPLY_PATCH_FAIL, "Git diff before:", "Git diff after:", "report: "];
// cleanup_container's first message: what follows is teardown, after the outcome was decided.
const CLEANUP_START = "Attempting to stop container ";
// run_instance appends this to test_output.txt when the eval script outlives the timeout, then raises
// EvaluationError instead of writing a report.
const TEST_TIMEOUT = /Timeout error: \d+ seconds exceeded\.\s*$/;
// harness/infra_failure signatures: out_of_memory, and container_unavailable.
const OUT_OF_MEMORY = /Cannot allocate memory|OutOfMemoryError|^Killed$/m;
const CONTAINER_UNAVAILABLE = /Error response from daemon|Cannot connect to the Docker daemon/;
// How docker-py and its HTTP transport name the Docker API failures run_instance logs, and the host I/O
// failures (ENOSPC, EROFS, EIO) that can stop the harness itself.
const ENVIRONMENT_FAILURE = /\b(?:docker\.errors|requests\.exceptions|urllib3\.exceptions)\.\w+|No space left on device|Read-only file system|Input\/output error/;

export type TestCounts = { success: number; failure: number };

// How grading reached its verdict. "scored": the harness's report. The rest are unresolved without one:
// "empty_patch" is never run; "patch_apply_failed", "test_timeout", "oom", and "tests_errored" (the harness
// failed after the tests ran) are caused by the patch, and the official harness counts them unresolved too.
export type GradingOutcome = "scored" | "test_timeout" | "oom" | "tests_errored" | "patch_apply_failed" | "empty_patch";
export const GRADING_OUTCOMES: readonly GradingOutcome[] = ["scored", "test_timeout", "oom", "tests_errored", "patch_apply_failed", "empty_patch"];

export type GradeResult = {
  resolved: boolean;
  // From the log's patch-apply markers; report.json's patch_successfully_applied is also false whenever the
  // test log cannot be parsed.
  patchApplied: boolean;
  outcome: GradingOutcome;
  f2p: TestCounts;
  p2p: TestCounts;
  reportPath: string | null;
};

export type GradeOptions = {
  record: SwebenchRecord;
  // The harness grades in the image the agent ran in.
  imageSource: ImageSource;
  patch: string;
  // Unique per grading; it names the harness container and log directory.
  runId: string;
  modelName: string;
  // The harness runs here and writes logs/run_evaluation/... below it.
  workDir: string;
  timeoutSec: number;
  // The pinned local image ID: the harness then grades in that image, whatever its tag names by now.
  imageId?: string;
  // Test seam only.
  ensureImage?: (image: string) => Promise<void>;
};

// What the harness left for one instance: report.json and test_output.txt when it wrote them.
export type HarnessFiles = { report?: string; instanceLog: string; testOutput?: string };

export function harnessPython(): string {
  return process.env.ONEHAND_SWEBENCH_PYTHON ?? path.join(homedir(), ".onehand", "swebench", ".venv", "bin", "python");
}

export async function harnessVersion(): Promise<string> {
  const { stdout } = await execFileAsync(harnessPython(), ["-c", "import swebench; print(swebench.__version__)"], {
    env: harnessEnvironment(), timeout: 60_000
  });
  return stdout.trim();
}

// Grades one patch with the official SWE-bench harness. Only an InfraError (the environment could not run the
// tests) is retried; a report, or a failure the patch caused, is the verdict.
export async function gradeRun(options: GradeOptions): Promise<GradeResult> {
  // The harness skips empty predictions entirely, so there is nothing to run.
  if (!options.patch.trim()) return unresolved("empty_patch", false, null);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.runId)) throw new Error(`Invalid grading run id: ${options.runId}`);
  // The harness pulls a missing image; OneHand never does.
  await (options.ensureImage ?? ensureImage)(options.imageId ?? imageFor(options.record, options.imageSource));
  let lastError: InfraError | undefined;
  for (let attempt = 1; attempt <= MAX_GRADE_ATTEMPTS; attempt++) {
    try {
      return await gradeOnce({ ...options, runId: attempt === 1 ? options.runId : `${options.runId}.retry${attempt}` });
    } catch (error) {
      if (!(error instanceof InfraError)) throw error;
      lastError = error;
    }
  }
  throw new InfraError(`Grading ${options.record.instance_id} failed ${MAX_GRADE_ATTEMPTS} times: ${lastError!.message}`, {
    cause: lastError
  });
}

// The verdict the harness's files support, scored the way the official harness scores it. Throws an InfraError
// only when the environment, not the patch, kept the tests from running: the harness stopped before the tests
// started, or its own log shows Docker (container_unavailable, a Docker API error) or the host failing.
export function classifyHarnessRun(files: HarnessFiles, instanceId: string, reportPath: string): GradeResult {
  // Python's logging starts a record only after "\n"; a "\r" inside a quoted diff line never does.
  const stamp = new RegExp(`^${LOG_STAMP}`);
  const messages = files.instanceLog.split(new RegExp(`\n(?=${LOG_STAMP})`))
    .filter((message) => stamp.test(message)).map((message) => message.replace(stamp, ""));
  const logged = (marker: string) => messages.some((message) => message.startsWith(marker));
  // "verified already applied" is logged under the same marker.
  const applied = logged(APPLY_PATCH_PASS) && !logged(APPLY_PATCH_FAIL);
  if (files.report !== undefined) {
    const report = parseHarnessReport(files.report, instanceId, reportPath);
    if (!applied) throw new InfraError(`Harness report without an applied patch in its log: ${reportPath}`);
    // The report's infra_failure_reason classifies test_output.txt alone, which the patched code writes: Docker
    // errors never reach that stream, so container_unavailable there is not evidence of an unavailable
    // environment, and the report's unresolved verdict stands.
    return {
      resolved: report.resolved,
      patchApplied: true,
      outcome: report.infraFailureReason === "out_of_memory" ? "oom" : "scored",
      f2p: report.f2p,
      p2p: report.p2p,
      reportPath
    };
  }
  if (logged(APPLY_PATCH_FAIL)) return unresolved("patch_apply_failed", false, null);
  if (files.testOutput === undefined) throw new InfraError(`SWE-bench harness wrote no report for ${instanceId}, and its tests never ran`);
  if (TEST_TIMEOUT.test(files.testOutput)) return unresolved("test_timeout", applied, null);
  // The harness's own messages up to its container teardown: what stopped it, in its words.
  const teardown = messages.findIndex((message) => message.startsWith(CLEANUP_START));
  const harnessText = (teardown < 0 ? messages : messages.slice(0, teardown))
    .filter((message) => !QUOTED_MESSAGES.some((prefix) => message.startsWith(prefix))).join("\n");
  if (CONTAINER_UNAVAILABLE.test(harnessText) || ENVIRONMENT_FAILURE.test(harnessText)) {
    throw new InfraError(`SWE-bench harness wrote no report for ${instanceId} after a Docker or host failure`);
  }
  if (OUT_OF_MEMORY.test(files.testOutput) || OUT_OF_MEMORY.test(harnessText)) return unresolved("oom", applied, null);
  return unresolved("tests_errored", applied, null);
}

export function parseHarnessReport(raw: string, instanceId: string, reportPath: string): {
  resolved: boolean;
  f2p: TestCounts;
  p2p: TestCounts;
  // The harness's advisory classification of an unparseable test log (harness/infra_failure).
  infraFailureReason?: string;
} {
  let entry: Record<string, any> | undefined;
  try {
    entry = JSON.parse(raw)?.[instanceId];
  } catch {
    throw new InfraError(`Unparseable harness report: ${reportPath}`);
  }
  if (typeof entry?.resolved !== "boolean" || typeof entry.patch_successfully_applied !== "boolean") {
    throw new InfraError(`Harness report has no verdict for ${instanceId}: ${reportPath}`);
  }
  const counts = (key: string): TestCounts => ({
    success: countOf(entry!.tests_status?.[key]?.success, reportPath),
    failure: countOf(entry!.tests_status?.[key]?.failure, reportPath)
  });
  return {
    resolved: entry.resolved,
    f2p: counts("FAIL_TO_PASS"),
    p2p: counts("PASS_TO_PASS"),
    ...(typeof entry.infra_failure_reason === "string" ? { infraFailureReason: entry.infra_failure_reason } : {})
  };
}

async function gradeOnce(options: GradeOptions): Promise<GradeResult> {
  const workDir = path.resolve(options.workDir);
  const instanceId = options.record.instance_id;
  const logDir = path.join(workDir, "logs", "run_evaluation", options.runId, options.modelName.replaceAll("/", "__"), instanceId);
  const predictions = path.join(workDir, "predictions", `${options.runId}.jsonl`);
  const dataset = path.join(workDir, "datasets", `${options.runId}.jsonl`);
  const harnessLog = path.join(workDir, "harness", `${options.runId}.log`);
  // The harness returns an existing report unexamined, and a stale one may grade a different patch.
  await rm(logDir, { recursive: true, force: true });
  for (const file of [predictions, dataset, harnessLog]) await mkdir(path.dirname(file), { recursive: true });
  await writeFile(predictions, JSON.stringify({
    instance_id: instanceId, model_name_or_path: options.modelName, model_patch: options.patch
  }) + "\n", "utf8");
  // The harness takes the image from the dataset record, so it gets this one instance with the mapped image
  // (or its pinned ID, which Docker accepts wherever it takes a tag).
  const image = options.imageId ?? imageFor(options.record, options.imageSource);
  await writeFile(dataset, JSON.stringify({ ...options.record, image }) + "\n", "utf8");

  const exitCode = await runHarness([
    "-m", "swebench.harness.run_evaluation",
    "-d", dataset,
    "-i", instanceId,
    "-p", predictions,
    "-id", options.runId,
    "--max_workers", "1",
    "-t", String(options.timeoutSec),
    "--report_dir", path.join(workDir, "reports")
  ], workDir, harnessLog, (options.timeoutSec + HARNESS_BACKSTOP_SEC) * 1_000);
  if (exitCode !== 0) {
    // A killed harness cannot remove its own container.
    await docker(["rm", "-f", `sweb.eval.${instanceId.toLowerCase()}.${options.runId}`]).catch(() => undefined);
    throw new InfraError(`SWE-bench harness exited with ${exitCode}; see ${harnessLog}: ${await tail(harnessLog)}`);
  }
  const optional = (name: string) => readFile(path.join(logDir, name), "utf8").catch(() => undefined);
  const [report, instanceLog, testOutput] = await Promise.all([optional("report.json"), optional("run_instance.log"), optional("test_output.txt")]);
  try {
    return classifyHarnessRun({ report, instanceLog: instanceLog ?? "", testOutput }, instanceId, path.join(logDir, "report.json"));
  } catch (error) {
    if (!(error instanceof InfraError)) throw error;
    throw new InfraError(`${error.message}; see ${harnessLog}: ${await tail(harnessLog)}`, { cause: error });
  }
}

async function runHarness(args: string[], cwd: string, logPath: string, timeoutMs: number): Promise<number | string> {
  const log = await open(logPath, "w");
  try {
    return await new Promise<number | string>((resolve) => {
      const child = spawn(harnessPython(), args, { cwd, env: harnessEnvironment(), stdio: ["ignore", log.fd, log.fd] });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(`a timeout after ${Math.round(timeoutMs / 1000)}s`);
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(`a spawn error (${error.message})`);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve(code ?? `signal ${signal}`);
      });
    });
  } finally {
    await log.close();
  }
}

function unresolved(outcome: GradingOutcome, patchApplied: boolean, reportPath: string | null): GradeResult {
  return { resolved: false, patchApplied, outcome, f2p: { success: 0, failure: 0 }, p2p: { success: 0, failure: 0 }, reportPath };
}

function countOf(value: unknown, reportPath: string): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value)) throw new InfraError(`Malformed test lists in harness report: ${reportPath}`);
  return value.length;
}

async function tail(file: string): Promise<string> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.trim().slice(-800);
}

function harnessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", PYTHONUNBUFFERED: "1" };
  for (const [key, value] of Object.entries(process.env)) {
    if ((key.startsWith("DOCKER_") || key.startsWith("SWEBENCH_")) && value !== undefined) env[key] = value;
  }
  return env;
}

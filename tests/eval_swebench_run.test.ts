import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentBehaviorFingerprint } from "../src/agent/fingerprint.js";
import { PROFILES } from "../src/agent/profile.js";
import { runAgent, RunAgentOptions } from "../src/agent/runner.js";
import { DeepSeekChatProvider } from "../src/providers/deepseek.js";
import { DockerExecutor, ExecRequest, PathMapper } from "../src/runtime/executor.js";
import type { CommandExecution, ToolResult } from "../src/types.js";
import { capReachedFrom, loadResultSet } from "../eval/results-io.js";
import { estimateCost, priceSnapshotFor } from "../eval/run.js";
import type { SwebenchManifest, SwebenchRunResult } from "../eval/types.js";
import { docker, ImageMismatchError, InfraError, OPAQUE_NAME, SwebenchContainer } from "../eval/swebench/container.js";
import {
  agentTaskFor, imageFor, loadRecords, normalizeRecord, SwebenchRecord, taskHashFor, testCommandFor
} from "../eval/swebench/dataset.js";
import {
  assertCompatibleSwebenchManifest, DEFAULT_SCHEDULE_SEED, HoldoutLedgerEntry, runSwebenchEvaluation, scheduleRuns,
  SwebenchEvaluationOptions, validateSwebenchRows, worstCaseRunCost
} from "../eval/swebench/evaluate.js";
import type { GradeOptions, GradeResult } from "../eval/swebench/grade.js";
import { extractPatch, PatchExtractionError } from "../eval/swebench/patch.js";
import {
  INFRA_POLICY, ProviderAccountError, providerOutage, runInstance, RunInstanceDeps, SWEBENCH_LIMITS, SwebenchRunRequest
} from "../eval/swebench/runInstance.js";
import { DIAGNOSTIC_NOTE, summarizeSwebench } from "../eval/swebench/summary.js";
import { rebuildGitBase, SwebenchWorkspace } from "../eval/swebench/workspace.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

type Turn = Array<[string, Record<string, unknown>]>;

const FLASH = priceSnapshotFor("deepseek-flash");
const EVALUATION = "swebench-dev-test";
// Harness-only content: none of it may reach the model.
const LEAK_MARKERS = ["GOLD-PATCH-MARKER", "TEST-PATCH-MARKER", "HINTS-MARKER", "EVAL-SCRIPT-MARKER", "f2p_marker", "p2p_marker", "test_marker.py"];
const RECORD = recordFor("owner__repo-1");
const TASKS = new Map([[RECORD.instance_id, { hash: taskHashFor(RECORD), repo: RECORD.repo }]]);
const PINNED = fakeImageId(imageFor(RECORD, "epoch"));
const FIX: Turn[] = [
  [["set_plan", { steps: ["Set VALUE to 2", "Verify with the tests"] }]],
  [["replace_text", { path: "/testbed/pkg/mod.py", oldText: "VALUE = 1", newText: "VALUE = 2" }]],
  [["run_tests", { targets: ["tests/test_mod.py"] }]],
  [
    ["update_plan", { stepId: 1, status: "completed", evidence: "edited pkg/mod.py" }],
    ["update_plan", { stepId: 2, status: "completed", evidence: "tests/test_mod.py passed" }]
  ],
  [["finish_task", { summary: "Set VALUE to 2; tests/test_mod.py passes." }]]
];
// Per model turn: 1000 prompt tokens (600 cached), 50 completion tokens (20 reasoning).
const TURN_USAGE = {
  prompt_tokens: 1_000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400, completion_tokens: 50, total_tokens: 1_050,
  completion_tokens_details: { reasoning_tokens: 20 }
};
const ROW_FIELDS = [
  "schemaVersion", "evaluationId", "benchmark", "variant", "taskId", "taskHash", "category", "split", "repetition", "provider", "model",
  "thinking", "reasoningEffort", "temperature", "startedAt", "durationMs", "agentStatus", "stopReason", "resolved", "falseSuccess",
  "agentVerificationPassed", "modelRounds", "toolCalls", "inputTokens", "outputTokens", "cacheHitInputTokens", "cacheMissInputTokens",
  "reasoningTokens", "estimatedCostUsd", "retryCostUsd", "capChargeUsd", "responseModels", "attempts", "containerName", "failureClass", "finalMessage",
  "traceEvents", "difficulty", "patchBytes", "patchFiles", "emptyPatch", "patchApplied", "gradingOutcome", "f2p", "p2p"
];
// What the OpenAI SDK throws for a dropped connection: the socket's code sits on a nested cause.
const CONNECTION_RESET = Object.assign(new Error("Connection error."), {
  cause: Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })
});

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

async function tmp(prefix = "onehand-swe-run-test-"): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

// Stands in for `docker image inspect --format {{.Id}}`: one stable fake ID per image.
function fakeImageId(image: string): string {
  return `sha256:${createHash("sha256").update(image).digest("hex")}`;
}

function recordFor(id: string): SwebenchRecord {
  const testPatch = "diff --git a/tests/test_marker.py b/tests/test_marker.py\n--- a/tests/test_marker.py\n+++ b/tests/test_marker.py\n@@ -1 +1 @@\n-a\n+TEST-PATCH-MARKER\n";
  return normalizeRecord({
    instance_id: id, repo: "pydata/xarray", base_commit: "abc123", environment_setup_commit: "def456", version: "1.0",
    created_at: "2020-01-01T00:00:00Z", difficulty: "15 min - 1 hour", eval_type: "pass_and_fail",
    image: `swebench/sweb.eval.x86_64.${id}:latest`, log_parser: "parse_log_pytest",
    patch: "diff --git a/pkg/mod.py b/pkg/mod.py\n--- a/pkg/mod.py\n+++ b/pkg/mod.py\n@@ -1 +1 @@\n-VALUE = 1\n+VALUE = 2  # GOLD-PATCH-MARKER\n",
    test_patch: testPatch,
    problem_statement: "ISSUE: VALUE should be 2, not 1.",
    hints_text: "HINTS-MARKER: look at pkg/mod.py",
    eval_script: [
      "#!/bin/bash", "# EVAL-SCRIPT-MARKER", "cd /testbed", "git apply -v - <<'EOF_1'", testPatch, "EOF_1",
      ": '>>>>> Start Test Output'", "pytest -rA tests/test_marker.py", ": '>>>>> End Test Output'"
    ].join("\n"),
    FAIL_TO_PASS: ["tests/test_marker.py::test_f2p_marker"],
    PASS_TO_PASS: ["tests/test_marker.py::test_p2p_marker"]
  });
}

// A DeepSeek provider over a scripted client: each request pops the next turn's tool calls. With `failure`,
// the request after the script runs out throws it instead of answering.
function scriptedDeepSeek(script: Turn[], requests: Array<Record<string, any>> = [], failure?: unknown): DeepSeekChatProvider {
  const turns = [...script];
  let round = 0;
  const create = async (input: Record<string, unknown>) => {
    requests.push(structuredClone(input));
    round += 1;
    if (failure !== undefined && !turns.length) throw failure;
    const calls = turns.shift() ?? [];
    return {
      model: "deepseek-flash",
      choices: [{
        finish_reason: calls.length ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: calls.length ? null : "done",
          ...(calls.length ? {
            tool_calls: calls.map(([name, args], index) => ({
              id: `call-${round}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) }
            }))
          } : {})
        }
      }],
      usage: TURN_USAGE
    };
  };
  return new DeepSeekChatProvider({ client: { chat: { completions: { create } } } });
}

type World = {
  events: string[];
  workspaces: SwebenchWorkspace[];
  names: string[];
  cleaned: string[];
  containers: string[];
  agentOptions: RunAgentOptions[];
  gradings: GradeOptions[];
  requests: Array<Record<string, any>>;
  providers: number;
  imageChecks: string[];
  reservations: number[];
  deps: Partial<RunInstanceDeps>;
};

// Docker, the container, and the harness are fakes; the runner, the tools, and patch extraction are real.
function world(options: {
  script?: Turn[];
  // The provider for each job attempt (1-based), in place of the script.
  provider?: (attempt: number, requests: Array<Record<string, any>>) => DeepSeekChatProvider;
  prepareFailures?: number;
  startFailures?: number;
  exec?: (request: ExecRequest) => ToolResult<CommandExecution>;
  grade?: (options: GradeOptions) => Promise<GradeResult>;
  extract?: typeof extractPatch;
  now?: () => number;
  // What `docker image inspect` reports, by call (1-based); an InfraError when it returns "fail".
  imageId?: (image: string, call: number) => string | undefined | "fail";
  reserve?: (amountUsd: number) => boolean;
  // The runner's own retries of an outage, without the 2 s backoff the limits set.
  fastRetries?: boolean;
} = {}): World {
  const state: World = {
    events: [], workspaces: [], names: [], cleaned: [], containers: [], agentOptions: [], gradings: [], requests: [], providers: 0,
    imageChecks: [], reservations: [], deps: {}
  };
  let prepareCalls = 0;
  let startCalls = 0;
  state.deps = {
    prepareWorkspace: async (_record, name) => {
      state.events.push("prepare");
      state.names.push(name);
      if (++prepareCalls <= (options.prepareFailures ?? 0)) throw new InfraError(`docker cp failed for ${name}`);
      const workspace = await fakeWorkspace(state);
      state.workspaces.push(workspace);
      return workspace;
    },
    startContainer: async (_record, repo, name) => {
      state.events.push("start");
      state.containers.push(name);
      if (++startCalls <= (options.startFailures ?? 0)) throw new InfraError("Sanity check failed: import xarray resolved to \"\"");
      return fakeContainer(state, repo, name, options.exec ?? passingTests);
    },
    runAgent: async (agentOptions) => {
      state.events.push("agent");
      state.agentOptions.push(agentOptions);
      return runAgent(options.fastRetries ? { ...agentOptions, retryDelayMs: 1 } : agentOptions);
    },
    extractPatch: async (repo, baseCommit) => {
      state.events.push("extract");
      return (options.extract ?? extractPatch)(repo, baseCommit);
    },
    gradeRun: async (gradeOptions) => {
      state.events.push("grade");
      state.gradings.push(gradeOptions);
      return (options.grade ?? gradeByPatch)(gradeOptions);
    },
    createProvider: () => {
      state.providers += 1;
      return options.provider ? options.provider(state.providers, state.requests) : scriptedDeepSeek(options.script ?? FIX, state.requests);
    },
    imageIdOf: async (image) => {
      state.imageChecks.push(image);
      const id = options.imageId ? options.imageId(image, state.imageChecks.length) : fakeImageId(image);
      if (id === "fail") throw new InfraError("docker image failed: Cannot connect to the Docker daemon");
      return id;
    },
    reserve: async (amountUsd) => {
      state.reservations.push(amountUsd);
      return options.reserve ? options.reserve(amountUsd) : true;
    },
    ...(options.now ? { now: options.now } : {})
  };
  return state;
}

async function fakeWorkspace(state: World): Promise<SwebenchWorkspace> {
  const root = await tmp("onehand-swe-fake-workspace-");
  const testbed = path.join(root, "testbed");
  await mkdir(path.join(testbed, "pkg"), { recursive: true });
  await mkdir(path.join(testbed, "tests"), { recursive: true });
  await writeFile(path.join(testbed, "pkg", "mod.py"), "VALUE = 1\n");
  await writeFile(path.join(testbed, "tests", "test_mod.py"), "from pkg.mod import VALUE\n\n\ndef test_value():\n    assert VALUE == 2\n");
  const repo = await realpath(testbed);
  return {
    root,
    repo,
    baseCommit: await rebuildGitBase(repo),
    cleanup: async () => {
      state.events.push("cleanup");
      state.cleaned.push(root);
      await rm(root, { recursive: true, force: true });
    }
  };
}

function fakeContainer(state: World, repo: string, name: string, exec: (request: ExecRequest) => ToolResult<CommandExecution>): SwebenchContainer {
  const executor = { kind: "docker" as const, pathMapper: new PathMapper(repo, "/testbed"), run: async (request: ExecRequest) => exec(request) };
  return {
    name,
    executor: executor as unknown as DockerExecutor,
    stop: async () => {
      state.events.push("stop");
    }
  };
}

function passingTests(request: ExecRequest): ToolResult<CommandExecution> {
  return {
    ok: true,
    data: { command: request.displayCommand ?? request.program, exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false, durationMs: 1, truncated: false }
  };
}

// Like the real harness: an empty patch is never run and is unresolved.
async function gradeByPatch(options: GradeOptions): Promise<GradeResult> {
  return options.patch.trim()
    ? { resolved: true, patchApplied: true, outcome: "scored", f2p: { success: 1, failure: 0 }, p2p: { success: 3, failure: 0 }, reportPath: "/grading/report.json" }
    : { resolved: false, patchApplied: false, outcome: "empty_patch", f2p: { success: 0, failure: 0 }, p2p: { success: 0, failure: 0 }, reportPath: null };
}

function request(outputDir: string, overrides: Partial<SwebenchRunRequest> = {}): SwebenchRunRequest {
  return {
    evaluationId: EVALUATION, record: RECORD, split: "dev", repetition: 1, variant: "baseline", model: "deepseek-flash",
    priceSnapshot: FLASH, apiKey: "unused", baseURL: "https://example.invalid", imageSource: "epoch", imageId: PINNED, outputDir,
    keepWorkspaces: false,
    ...overrides
  };
}

function manifestFor(overrides: Partial<SwebenchManifest> = {}): SwebenchManifest {
  return {
    schemaVersion: 2, evaluationId: EVALUATION, createdAt: "2026-09-25T00:00:00.000Z", benchmark: "swebench", split: "dev",
    datasetRevision: "rev", dataFileSha256: "a".repeat(64), swebenchVersion: "5.0.2", instanceIds: [RECORD.instance_id], exclusions: [],
    variants: [{ name: "baseline", flags: {}, agentFingerprint: agentBehaviorFingerprint(PROFILES.baseline) }],
    repetitions: 2, plannedRuns: 2, scheduleSeed: DEFAULT_SCHEDULE_SEED, provider: "deepseek", model: "deepseek-flash",
    thinking: "enabled", reasoningEffort: "high", temperature: null, limits: { ...SWEBENCH_LIMITS },
    containerLimits: { cpus: 2, memory: "4g", network: "none" }, priceSnapshot: FLASH, reservationUsd: worstCaseRunCost(FLASH),
    costCapUsd: 10, sourceFingerprint: "f".repeat(64), gitHead: null, gitDirty: null, imageSource: "epoch",
    imageIds: { [RECORD.instance_id]: PINNED }, baseURL: "https://example.invalid/", executor: "docker", displayRoot: "/testbed",
    allowTargetedVerification: true, infraPolicy: INFRA_POLICY, holdoutConfirmed: false,
    ...overrides
  };
}

function usageOf(rounds: number) {
  return { cacheHitInputTokens: 600 * rounds, cacheMissInputTokens: 400 * rounds, outputTokens: 50 * rounds };
}

describe("SWE-bench runInstance", () => {
  it("turns a fixed, verified, resolved run into a fully populated valid row", async () => {
    const outputDir = await tmp();
    let clock = Date.parse("2026-09-25T12:00:00.000Z");
    const state = world({
      now: () => clock,
      grade: async (options) => {
        clock += 60_000;
        return gradeByPatch(options);
      }
    });
    const row = await runInstance(request(outputDir), state.deps);

    const usage = usageOf(5);
    const cost = estimateCost(usage, FLASH);
    expect(Object.keys(row).sort()).toEqual([...ROW_FIELDS].sort());
    expect(row).toMatchObject({
      schemaVersion: 2, evaluationId: EVALUATION, benchmark: "swebench", variant: "baseline", taskId: RECORD.instance_id,
      taskHash: taskHashFor(RECORD), category: "pydata/xarray", split: "dev", repetition: 1, provider: "deepseek", model: "deepseek-flash",
      thinking: "enabled", reasoningEffort: "high", temperature: null, startedAt: "2026-09-25T12:00:00.000Z", durationMs: 60_000,
      agentStatus: "success", stopReason: "explicit_finish", resolved: true, falseSuccess: false, agentVerificationPassed: true,
      modelRounds: 5, toolCalls: 6, inputTokens: 5_000, ...usage, reasoningTokens: 100, estimatedCostUsd: cost, retryCostUsd: 0, capChargeUsd: cost,
      responseModels: ["deepseek-flash"], attempts: 1, containerName: state.names[0], failureClass: undefined,
      finalMessage: "Set VALUE to 2; tests/test_mod.py passes.", difficulty: "15 min - 1 hour", patchFiles: ["pkg/mod.py"], emptyPatch: false,
      patchApplied: true, gradingOutcome: "scored", f2p: { success: 1, failure: 0 }, p2p: { success: 3, failure: 0 }
    });
    expect(cost).toBeGreaterThan(0);
    expect(row.patchBytes).toBeGreaterThan(0);
    expect(row.traceEvents.filter((event) => event.event === "model_turn")).toHaveLength(5);
    expect(() => validateSwebenchRows([row], manifestFor(), TASKS)).not.toThrow();

    // The container stops before the patch is taken; cleanup runs last.
    expect(state.events).toEqual(["prepare", "start", "agent", "stop", "extract", "grade", "stop", "cleanup"]);
    // The pinned image is checked before the workspace is prepared and again before grading.
    expect(state.imageChecks).toEqual([imageFor(RECORD, "epoch"), imageFor(RECORD, "epoch")]);
    // The harness grades in the pinned image, under a run id fresh to this attempt.
    expect(state.gradings).toEqual([expect.objectContaining({
      record: RECORD, imageSource: "epoch", imageId: PINNED, runId: `${EVALUATION}-${RECORD.instance_id}-r1-baseline.${state.names[0]!.slice("onehand-".length)}`,
      modelName: "onehand-baseline", workDir: path.join(outputDir, "grading"), timeoutSec: 1_800
    })]);
    expect(state.gradings[0]!.patch).toContain("+VALUE = 2");

    const agent = state.agentOptions[0]!;
    expect(agent).toMatchObject({
      task: agentTaskFor(RECORD), repoPath: state.workspaces[0]!.repo, displayRoot: "/testbed", testCommand: "pytest -rA",
      trustedTestCommand: true, allowTargetedVerification: true, testTargetHint: testCommandFor(RECORD).targetHint,
      model: "deepseek-flash", thinking: "enabled", reasoningEffort: "high", enforcePlanning: true, persistence: true,
      maxSteps: 80, maxToolCalls: 150, maxInputTokens: 3_000_000, maxOutputTokens: 150_000, maxWallTimeMs: 1_800_000, timeoutSec: 600,
      maxTurnOutputTokens: 16_384, maxTextOnlyNudges: 2, modelTimeoutMs: 300_000, maxApiAttempts: 4, retryDelayMs: 2_000
    });
    expect(agent.profile).toBe(PROFILES.baseline);
    // Every budget the manifest freezes is the one the runner ran with.
    const runStarted = row.traceEvents.find((event) => event.event === "run_started")!.data as Record<string, any>;
    expect(runStarted).toMatchObject({ displayRoot: "/testbed", executor: "docker", profile: "baseline", allowTargetedVerification: true });
    const { commandTimeoutSec, ...runnerLimits } = SWEBENCH_LIMITS;
    expect(runStarted.limits).toEqual({ ...runnerLimits, timeoutSec: commandTimeoutSec });

    expect(state.cleaned).toEqual([state.workspaces[0]!.root]);
    await expect(access(agent.runDir!)).rejects.toThrow();
  });

  it("names every workspace and container opaquely, never after the instance or the variant", async () => {
    const state = world({ startFailures: 1 });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let row: SwebenchRunResult;
    let logged: string;
    try {
      row = await runInstance(request(await tmp(), { variant: "baseline" }), state.deps);
    } finally {
      logged = stderr.mock.calls.map(([text]) => String(text)).join("");
      stderr.mockRestore();
    }
    expect(row).toMatchObject({ attempts: 2, resolved: true, agentStatus: "success", failureClass: undefined });
    expect(state.events.slice(0, 6)).toEqual(["prepare", "start", "cleanup", "prepare", "start", "agent"]);
    // Each setup attempt gets a fresh opaque name, shared by its workspace directory and its container.
    expect(state.names).toEqual([expect.stringMatching(OPAQUE_NAME), expect.stringMatching(OPAQUE_NAME)]);
    expect(state.names[0]).not.toBe(state.names[1]);
    expect(state.containers).toEqual(state.names);
    for (const name of state.names) for (const secret of [RECORD.instance_id, "baseline", EVALUATION]) expect(name).not.toContain(secret);
    expect(row.containerName).toBe(state.names[1]);
    // The mapping goes to stderr for the operator.
    for (const name of state.names) expect(logged).toContain(`[swebench] ${name}: ${RECORD.instance_id} r1 baseline (${EVALUATION})`);
    expect([state.providers, state.agentOptions.length]).toEqual([1, 1]);
    expect(state.cleaned).toEqual(state.workspaces.map((workspace) => workspace.root));
    expect(() => validateSwebenchRows([row], manifestFor(), TASKS)).not.toThrow();
  });

  it("records a zero-cost harness_error row when every setup attempt fails, without calling the model", async () => {
    const state = world({ prepareFailures: 1, startFailures: 3 });
    const row = await runInstance(request(await tmp()), state.deps);
    expect(row).toMatchObject({
      agentStatus: "harness_error", failureClass: "harness_error", attempts: 3, resolved: false, falseSuccess: false,
      modelRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, capChargeUsd: 0, emptyPatch: true,
      containerName: state.names[2], finalMessage: expect.stringContaining("Sanity check failed")
    });
    expect(row.gradingOutcome).toBeUndefined();
    expect(state.events).toEqual(["prepare", "prepare", "start", "cleanup", "prepare", "start", "cleanup"]);
    expect([state.providers, state.agentOptions.length, state.gradings.length]).toEqual([0, 0, 0]);
    expect(state.cleaned).toEqual(state.workspaces.map((workspace) => workspace.root));
    expect(() => validateSwebenchRows([row], manifestFor(), TASKS)).not.toThrow();
  });

  it("keeps usage and cost and does not retry when the environment fails during the agent run", async () => {
    const state = world({
      script: [
        [["set_plan", { steps: ["Run the tests"] }]],
        [["run_tests", {}]],
        [["update_plan", { stepId: 1, status: "completed", evidence: "never reached" }]]
      ],
      exec: () => ({
        ok: false, error: "docker exec failed with exit 125: Error response from daemon: No such container: onehand-x", recoverable: false, code: "environment"
      })
    });
    const row = await runInstance(request(await tmp()), state.deps);
    const usage = usageOf(2);
    expect(row).toMatchObject({
      agentStatus: "failed", stopReason: "runtime_error", failureClass: "environment_failure", attempts: 1, resolved: false,
      falseSuccess: false, modelRounds: 2, toolCalls: 2, inputTokens: 2_000, ...usage,
      estimatedCostUsd: estimateCost(usage, FLASH), capChargeUsd: estimateCost(usage, FLASH), emptyPatch: true, gradingOutcome: "empty_patch"
    });
    expect(row.estimatedCostUsd).toBeGreaterThan(0);
    expect(row.traceEvents.some((event) => event.event === "environment_failure")).toBe(true);
    expect(state.events.filter((event) => event === "prepare" || event === "agent")).toEqual(["prepare", "agent"]);
    // Graded like any other run.
    expect(state.gradings).toHaveLength(1);
    expect(state.cleaned).toEqual(state.workspaces.map((workspace) => workspace.root));
    expect(() => validateSwebenchRows([row], manifestFor(), TASKS)).not.toThrow();
  });

  it("records a grading_error row that keeps usage when grading fails for infrastructure", async () => {
    const state = world({ grade: async () => { throw new InfraError("Grading owner__repo-1 failed 3 times: SWE-bench harness exited with 1"); } });
    const row = await runInstance(request(await tmp()), state.deps);
    expect(row).toMatchObject({
      gradingError: "Grading owner__repo-1 failed 3 times: SWE-bench harness exited with 1", resolved: false, failureClass: "grading_error",
      agentStatus: "success", falseSuccess: true, patchApplied: false, patchFiles: ["pkg/mod.py"], modelRounds: 5,
      estimatedCostUsd: estimateCost(usageOf(5), FLASH)
    });
    expect(row.gradingOutcome).toBeUndefined();
    expect(state.cleaned).toEqual(state.workspaces.map((workspace) => workspace.root));
    expect(() => validateSwebenchRows([row], manifestFor(), TASKS)).not.toThrow();
  });

  it("scores a patch-caused grading failure unresolved, and the evaluation stays complete", async () => {
    const rows: SwebenchRunResult[] = [];
    for (const [repetition, outcome] of [[1, "test_timeout"], [2, "oom"]] as const) {
      const state = world({
        grade: async () => ({ resolved: false, patchApplied: true, outcome, f2p: { success: 0, failure: 0 }, p2p: { success: 0, failure: 0 }, reportPath: null })
      });
      rows.push(await runInstance(request(await tmp(), { repetition }), state.deps));
      expect(state.gradings).toHaveLength(1);
    }
    expect(rows.map((row) => [row.gradingOutcome, row.resolved, row.patchApplied, row.failureClass, row.gradingError])).toEqual([
      ["test_timeout", false, true, "false_success", undefined], ["oom", false, true, "false_success", undefined]
    ]);
    expect(() => validateSwebenchRows(rows, manifestFor(), TASKS)).not.toThrow();
    const summary = summarizeSwebench(manifestFor(), rows, false);
    expect(summary).toMatchObject({
      complete: true, scoredRuns: 2, resolved: { runs: 2, resolved: 0 },
      completeness: { patchCausedRuns: { test_timeout: 1, oom: 1, tests_errored: 0 }, gradingErrorRuns: 0 }
    });
  });

  it("records a harness_error row that keeps usage when anything else fails after the agent run", async () => {
    for (const failure of [
      { extract: async () => { throw new Error("git add failed: index file corrupt"); } },
      { grade: async () => { throw new Error("Invalid grading run id: bad id"); } }
    ]) {
      const state = world(failure);
      const row = await runInstance(request(await tmp()), state.deps);
      expect(row).toMatchObject({
        agentStatus: "harness_error", failureClass: "harness_error", stopReason: "explicit_finish", attempts: 1, resolved: false,
        modelRounds: 5, estimatedCostUsd: estimateCost(usageOf(5), FLASH), capChargeUsd: estimateCost(usageOf(5), FLASH),
        responseModels: ["deepseek-flash"], containerName: state.names[0], finalMessage: expect.stringMatching(/index file corrupt|Invalid grading run id/)
      });
      expect(row.traceEvents.length).toBeGreaterThan(0);
      expect(state.cleaned).toEqual(state.workspaces.map((workspace) => workspace.root));
      expect(() => validateSwebenchRows([row], manifestFor(), TASKS)).not.toThrow();
    }
  });

  it("grades what it could extract and notes unreadable files; an agent-caused extraction failure is scored unresolved", async () => {
    const warned = world({
      extract: async (repo, baseCommit) => ({ ...(await extractPatch(repo, baseCommit)), warnings: ["error: open(\"pkg/secret.py\"): Permission denied"] })
    });
    const graded = await runInstance(request(await tmp()), warned.deps);
    expect(graded).toMatchObject({
      resolved: true, gradingOutcome: "scored", patchFiles: ["pkg/mod.py"], patchWarnings: ["error: open(\"pkg/secret.py\"): Permission denied"]
    });

    const failed = world({ extract: async () => { throw new PatchExtractionError("The patch is larger than 256 MiB"); } });
    const row = await runInstance(request(await tmp()), failed.deps);
    expect(row).toMatchObject({
      failureClass: "patch_extraction_failed", agentStatus: "success", resolved: false, falseSuccess: true, emptyPatch: false,
      patchApplied: false, patchBytes: 0, patchFiles: [], patchWarnings: ["patch extraction failed: The patch is larger than 256 MiB"],
      modelRounds: 5, estimatedCostUsd: estimateCost(usageOf(5), FLASH)
    });
    expect(row.gradingOutcome).toBeUndefined();
    expect(failed.gradings).toEqual([]);
    expect(() => validateSwebenchRows([graded, { ...row, repetition: 2 }], manifestFor(), TASKS)).not.toThrow();
    // Scored, not excluded: it counts against the resolved rate and leaves the evaluation complete.
    expect(summarizeSwebench(manifestFor(), [graded, { ...row, repetition: 2 }], false)).toMatchObject({
      complete: true, scoredRuns: 2, resolved: { runs: 2, resolved: 1 }, completeness: { harnessErrorRuns: 0 },
      patches: { applyFailures: 0 }, failureClasses: { patch_extraction_failed: 1 }
    });
  });

  it("retries a job once from scratch after a provider outage: the row costs the final attempt, and both are charged", async () => {
    const state = world({
      fastRetries: true,
      provider: (attempt, requests) => attempt === 1 ? scriptedDeepSeek(FIX.slice(0, 1), requests, CONNECTION_RESET) : scriptedDeepSeek(FIX, requests)
    });
    const row = await runInstance(request(await tmp()), state.deps);
    const first = estimateCost(usageOf(1), FLASH);
    const second = estimateCost(usageOf(5), FLASH);
    expect(row).toMatchObject({
      resolved: true, agentStatus: "success", failureClass: undefined, attempts: 2, modelRounds: 5,
      estimatedCostUsd: second, retryCostUsd: first, capChargeUsd: first + second, containerName: state.names[1]
    });
    // The cap was asked to hold the failed attempt's cost on top of the job's reservation.
    expect(state.reservations).toEqual([first]);
    expect(state.events).toEqual([
      "prepare", "start", "agent", "stop", "cleanup", "prepare", "start", "agent", "stop", "extract", "grade", "stop", "cleanup"
    ]);
    expect([state.providers, state.gradings.length]).toEqual([2, 1]);
    expect(state.names[0]).not.toBe(state.names[1]);
    expect(() => validateSwebenchRows([row], manifestFor(), TASKS)).not.toThrow();
    // Every row states its discarded attempts, and is charged at least both attempts.
    const tampered = (changes: Record<string, unknown>) => ({ ...row, ...changes }) as SwebenchRunResult;
    for (const [changes, error] of [
      [{ retryCostUsd: undefined }, /Invalid retryCostUsd/], [{ retryCostUsd: -1 }, /Invalid retryCostUsd/],
      [{ retryCostUsd: Number.NaN }, /Invalid retryCostUsd/], [{ capChargeUsd: second }, /capChargeUsd is less than estimatedCostUsd \+ retryCostUsd/]
    ] as const) {
      expect(() => validateSwebenchRows([tampered(changes)], manifestFor(), TASKS), JSON.stringify(changes)).toThrow(error);
    }
  });

  it("records a provider_error row, excluded and incomplete, when the retry fails too or the cap cannot hold it", async () => {
    const outage = world({ fastRetries: true, provider: (_attempt, requests) => scriptedDeepSeek(FIX.slice(0, 1), requests, CONNECTION_RESET) });
    const twice = await runInstance(request(await tmp()), outage.deps);
    const one = estimateCost(usageOf(1), FLASH);
    expect(twice).toMatchObject({
      failureClass: "provider_error", stopReason: "model_error", attempts: 2, estimatedCostUsd: one, retryCostUsd: one, capChargeUsd: 2 * one,
      gradingOutcome: "empty_patch"
    });
    expect([outage.providers, outage.gradings.length]).toEqual([2, 1]);

    const capped = world({
      fastRetries: true, provider: (_attempt, requests) => scriptedDeepSeek(FIX.slice(0, 1), requests, CONNECTION_RESET), reserve: () => false
    });
    const unretried = await runInstance(request(await tmp(), { repetition: 2 }), capped.deps);
    expect(unretried).toMatchObject({ failureClass: "provider_error", attempts: 1, estimatedCostUsd: one, retryCostUsd: 0, capChargeUsd: one });
    expect([capped.providers, capped.reservations]).toEqual([1, [one]]);

    expect(() => validateSwebenchRows([twice, unretried], manifestFor(), TASKS)).not.toThrow();
    expect(summarizeSwebench(manifestFor(), [twice, unretried], false)).toMatchObject({
      complete: false, scoredRuns: 0, completeness: { providerErrorRuns: 2, flags: ["2 provider_error row(s)"] }
    });
  });

  it("keeps any other model error, such as a 400, as the agent's outcome", async () => {
    const rejected = Object.assign(new Error("400 Invalid request: messages[3] is malformed"), { status: 400 });
    const state = world({ provider: (_attempt, requests) => scriptedDeepSeek([], requests, rejected) });
    const row = await runInstance(request(await tmp()), state.deps);
    expect(row).toMatchObject({ stopReason: "model_error", agentStatus: "failed", attempts: 1, failureClass: "empty_patch" });
    expect([state.providers, state.reservations]).toEqual([1, []]);
  });

  it("classifies a provider outage from the last failed model attempt", () => {
    const failed = (data: Record<string, unknown>) => [
      { event: "model_attempt_failed", data: { attempt: 1, status: 503 } },
      { event: "model_attempt_failed", data: { attempt: 2, ...data } }
    ];
    for (const data of [
      { status: 429 }, { status: 500 }, { status: 503 }, { timedOut: true }, { code: "ECONNRESET" }, { code: "ETIMEDOUT" }, { code: "EAI_AGAIN" },
      // What the OpenAI SDK and undici report for a dropped or refused connection.
      { code: "UND_ERR_SOCKET" }, { code: "ECONNREFUSED" }, { connectionError: true }
    ]) {
      expect(providerOutage(failed(data)), JSON.stringify(data)).toBe(true);
    }
    for (const data of [{ status: 400 }, { status: 401 }, { status: 422 }, { code: "ENOTFOUND" }, { timedOut: false }]) {
      expect(providerOutage(failed(data)), JSON.stringify(data)).toBe(false);
    }
    expect(providerOutage([])).toBe(false);
  });

  it("stops the evaluation when the provider refuses the account or the model, instead of scoring the agent", async () => {
    for (const status of [401, 402, 403, 404]) {
      const refused = Object.assign(new Error(`${status} Insufficient Balance for key sk-abcdefghijklmnop`), { status });
      const state = world({ provider: (_attempt, requests) => scriptedDeepSeek(FIX.slice(0, 1), requests, refused) });
      const run = runInstance(request(await tmp()), state.deps);
      await expect(run, String(status)).rejects.toBeInstanceOf(ProviderAccountError);
      await expect(run).rejects.toThrow(new RegExp(`answered ${status} .*fix the account or model, then resume`));
      await expect(run).rejects.not.toThrow(/sk-abcdefghijklmnop/);
      expect([state.gradings.length, state.reservations.length, state.cleaned.length]).toEqual([0, 0, 1]);
    }
  });

  it("records a grading_error, keeping the run's usage, when the image cannot be checked before grading", async () => {
    const state = world({ imageId: (image, call) => call === 1 ? fakeImageId(image) : "fail" });
    const row = await runInstance(request(await tmp()), state.deps);
    expect(row).toMatchObject({
      failureClass: "grading_error", resolved: false, modelRounds: 5, gradingError: expect.stringContaining("Cannot connect to the Docker daemon")
    });
    expect(state.gradings).toEqual([]);
    expect(() => validateSwebenchRows([row], manifestFor(), TASKS)).not.toThrow();
  });

  it("stops without a row when the pinned image changed, before the workspace or before grading", async () => {
    const early = world({ imageId: () => "sha256:re-pulled" });
    const before = runInstance(request(await tmp()), early.deps);
    await expect(before).rejects.toBeInstanceOf(ImageMismatchError);
    await expect(before).rejects.toThrow(/now resolves to sha256:re-pulled, but this evaluation pinned sha256:/);
    expect([early.events, early.imageChecks.length]).toEqual([[], 1]);

    const late = world({ imageId: (image, call) => call === 1 ? fakeImageId(image) : undefined });
    await expect(runInstance(request(await tmp()), late.deps)).rejects.toThrow(/is no longer available locally, but this evaluation pinned/);
    expect(late.events).toEqual(["prepare", "start", "agent", "stop", "extract", "stop", "cleanup"]);
    expect(late.gradings).toEqual([]);
  });

  it("keeps the workspace and run state only when asked", async () => {
    const state = world();
    const row = await runInstance(request(await tmp(), { keepWorkspaces: true }), state.deps);
    expect(row.resolved).toBe(true);
    expect(state.cleaned).toEqual([]);
    expect(state.events.filter((event) => event === "stop")).toHaveLength(2);
    await access(state.workspaces[0]!.repo);
    dirs.push(state.agentOptions[0]!.runDir!);
    await access(path.join(state.agentOptions[0]!.runDir!, "trace.jsonl"));
  });

  it("isolates every run's prompt cache with a fresh 24-character alphanumeric nonce", async () => {
    const state = world();
    const outputDir = await tmp();
    await runInstance(request(outputDir, { repetition: 1 }), state.deps);
    const firstRequests = state.requests.length;
    await runInstance(request(outputDir, { repetition: 2 }), state.deps);
    const nonces = state.agentOptions.map((options) => options.cacheIsolationNonce!);
    expect(nonces).toEqual([expect.stringMatching(/^[A-Za-z0-9]{24}$/), expect.stringMatching(/^[A-Za-z0-9]{24}$/)]);
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(state.requests[0]!.messages[0]).toEqual({ role: "system", content: expect.stringMatching(new RegExp(`^Session: ${nonces[0]}\\n\\n`)) });
    expect(state.requests[firstRequests]!.messages[0].content).toMatch(new RegExp(`^Session: ${nonces[1]}\\n\\n`));
  });

  it("shows the model the issue and the fixed instructions only", async () => {
    const state = world();
    await runInstance(request(await tmp()), state.deps);
    expect(state.agentOptions[0]!.task).toBe(agentTaskFor(RECORD));
    const seen = JSON.stringify(state.requests);
    expect(seen).toContain("ISSUE: VALUE should be 2, not 1.");
    for (const marker of [...LEAK_MARKERS, RECORD.instance_id, EVALUATION, state.names[0]!]) expect(seen, marker).not.toContain(marker);
  });
});

describe("SWE-bench schedule", () => {
  it("orders by instance and repetition, and shuffles each pair's variants deterministically", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `owner__repo-${String(index).padStart(2, "0")}`).reverse();
    const variants = ["alpha", "beta", "gamma"];
    const schedule = scheduleRuns(ids, 2, variants, 7);
    expect(scheduleRuns(ids, 2, variants, 7)).toEqual(schedule);
    expect(schedule).toHaveLength(12 * 2 * 3);
    const pairs = Array.from({ length: 24 }, (_, index) => schedule.slice(index * 3, index * 3 + 3));
    expect(pairs.map((pair) => [pair[0]!.instanceId, pair[0]!.repetition]))
      .toEqual([...ids].sort().flatMap((id) => [[id, 1], [id, 2]]));
    for (const pair of pairs) {
      expect(new Set(pair.map((run) => `${run.instanceId}#${run.repetition}`)).size).toBe(1);
      expect(pair.map((run) => run.variant).sort()).toEqual(variants);
    }
    expect(new Set(pairs.map((pair) => pair.map((run) => run.variant).join(","))).size).toBeGreaterThan(1);
    expect(scheduleRuns(ids, 2, variants, 8)).not.toEqual(schedule);
    // Each pair's order depends only on the seed, the instance, and the repetition.
    expect(scheduleRuns([ids[3]!], 2, variants, 7)).toEqual(schedule.filter((run) => run.instanceId === ids[3]));
  });
});

describe("SWE-bench manifest compatibility", () => {
  it("ignores only the identity and provenance fields", () => {
    const manifest = manifestFor();
    const identity = ["evaluationId", "createdAt", "gitHead", "gitDirty", "holdoutRerunReason"];
    expect(() => assertCompatibleSwebenchManifest(manifest, {
      ...manifest, evaluationId: "other", createdAt: "2030-01-01T00:00:00.000Z", gitHead: "abc123", gitDirty: true, holdoutRerunReason: "x"
    })).not.toThrow();
    const reordered = Object.fromEntries(Object.entries({ ...manifest, limits: Object.fromEntries(Object.entries(manifest.limits).reverse()) }).reverse());
    expect(() => assertCompatibleSwebenchManifest(manifest, reordered as SwebenchManifest)).not.toThrow();

    const compared = Object.keys(manifest).filter((key) => !identity.includes(key));
    expect(compared).toEqual(expect.arrayContaining([
      "split", "datasetRevision", "dataFileSha256", "swebenchVersion", "instanceIds", "exclusions", "variants", "repetitions",
      "plannedRuns", "scheduleSeed", "provider", "model", "thinking", "reasoningEffort", "temperature", "limits", "containerLimits",
      "priceSnapshot", "reservationUsd", "costCapUsd", "sourceFingerprint", "imageSource", "imageIds", "baseURL", "executor", "displayRoot",
      "allowTargetedVerification", "infraPolicy", "holdoutConfirmed"
    ]));
    for (const key of compared) {
      expect(() => assertCompatibleSwebenchManifest(manifest, { ...manifest, [key]: { changed: key } }), key)
        .toThrow(`Existing evaluation manifest is incompatible with the requested run (${key} differ)`);
    }
    expect(() => assertCompatibleSwebenchManifest(manifest, { ...manifest, limits: { ...manifest.limits, maxSteps: 81 } })).toThrow(/\(limits differ\)/);
    expect(() => assertCompatibleSwebenchManifest(manifest, { ...manifest, imageIds: { [RECORD.instance_id]: "sha256:other" } })).toThrow(/\(imageIds differ\)/);
    const { infraPolicy: _policy, ...withoutPolicy } = manifest;
    expect(() => assertCompatibleSwebenchManifest(manifest, withoutPolicy)).toThrow(/\(infraPolicy differ\)/);
  });
});

describe("runSwebenchEvaluation", () => {
  let ledger: string;

  beforeEach(async () => {
    // Every evaluation here writes its holdout ledger into a temporary directory.
    ledger = path.join(await tmp("onehand-swe-ledger-"), "holdout-ledger.jsonl");
    vi.stubEnv("ONEHAND_HOLDOUT_LEDGER", ledger);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function datasetFiles(dir: string, exclusions: unknown[] = []) {
    const ids = { dev: ["owner__repo-2", "owner__repo-1", "owner__repo-3"], holdout: ["owner__repo-9"] };
    const file = (name: string) => path.join(dir, name);
    await writeFile(file("splits.json"), JSON.stringify({
      schemaVersion: 1, dataset: "SWE-bench/SWE-bench_Verified", datasetRevision: "rev-test",
      dev: { name: "dev", instanceIds: ids.dev }, holdout: { name: "holdout", instanceIds: ids.holdout }
    }));
    await writeFile(file("data.jsonl"), [...ids.dev, ...ids.holdout].map((id) => JSON.stringify(recordFor(id))).join("\n") + "\n");
    await writeFile(file("exclusions.json"), JSON.stringify(exclusions));
    return { splits: file("splits.json"), data: file("data.jsonl"), exclusions: file("exclusions.json") };
  }

  function options(outputDir: string, files: SwebenchEvaluationOptions["files"], overrides: Partial<SwebenchEvaluationOptions> = {}): SwebenchEvaluationOptions {
    return {
      split: "dev", variants: ["baseline"], repetitions: 1, concurrency: 2, costCapUsd: 5, outputDir, apiKey: "unused",
      baseURL: "https://example.invalid", files, harnessVersion: async () => "5.0.2", resolveImageId: async (image) => fakeImageId(image),
      ...overrides
    };
  }

  async function ledgerEntries(): Promise<HoldoutLedgerEntry[]> {
    return (await readFile(ledger, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  it("refuses the holdout split without confirmation before creating any file", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir);
    const outputDir = path.join(dir, "holdout");
    let reachedHarness = false;
    await expect(runSwebenchEvaluation(options(outputDir, files, {
      split: "holdout", harnessVersion: async () => { reachedHarness = true; return "5.0.2"; }
    }))).rejects.toThrow("The holdout split is reserved for the final evaluation; confirm it explicitly (--confirm-holdout) to run it");
    expect(reachedHarness).toBe(false);
    await expect(access(outputDir)).rejects.toThrow();
    expect(await ledgerEntries()).toEqual([]);

    const state = world();
    const confirmed = await runSwebenchEvaluation(options(outputDir, files, {
      split: "holdout", confirmHoldout: true, executeRun: (run) => runInstance(run, state.deps)
    }));
    expect(confirmed.manifest).toMatchObject({ split: "holdout", holdoutConfirmed: true, instanceIds: ["owner__repo-9"] });
    expect(confirmed.results.map((row) => [row.split, row.resolved])).toEqual([["holdout", true]]);
  });

  it("records every holdout evaluation in the ledger and refuses a second one without a reason", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir);
    const state = world();
    const holdout = (outputDir: string, overrides: Partial<SwebenchEvaluationOptions> = {}) => runSwebenchEvaluation(options(outputDir, files, {
      split: "holdout", confirmHoldout: true, executeRun: (run) => runInstance(run, state.deps), ...overrides
    }));
    const first = await holdout(path.join(dir, "first"));
    expect(await ledgerEntries()).toEqual([{
      evaluationId: first.manifest.evaluationId, createdAt: first.manifest.createdAt, variants: ["baseline"], gitHead: first.manifest.gitHead
    }]);
    expect(first.manifest.holdoutRerunReason).toBeUndefined();

    // Resuming that same evaluation is allowed and adds nothing.
    await holdout(path.join(dir, "first"), { executeRun: async () => { throw new Error("a finished job ran again"); } });
    expect(await ledgerEntries()).toHaveLength(1);

    // A new holdout evaluation is refused before it creates anything.
    const second = path.join(dir, "second");
    await expect(holdout(second)).rejects.toThrow(`already evaluated (${first.manifest.evaluationId}; ledger ${ledger}); resume that evaluation`);
    await expect(access(second)).rejects.toThrow();
    await expect(holdout(second, { allowHoldoutRerun: "  " })).rejects.toThrow(/takes a reason/);
    await expect(runSwebenchEvaluation(options(second, files, { allowHoldoutRerun: "why" }))).rejects.toThrow(/holdout split only/);

    // With a reason it runs, and the reason is in both the manifest and the ledger.
    const rerun = await holdout(second, { allowHoldoutRerun: "the first run used a broken image" });
    expect(rerun.manifest.holdoutRerunReason).toBe("the first run used a broken image");
    expect((await ledgerEntries()).map((entry) => [entry.evaluationId, entry.reason])).toEqual([
      [first.manifest.evaluationId, undefined], [rerun.manifest.evaluationId, "the first run used a broken image"]
    ]);
    // Dev evaluations never touch the ledger.
    await runSwebenchEvaluation(options(path.join(dir, "dev"), files, { taskIds: ["owner__repo-1"], executeRun: (run) => runInstance(run, state.deps) }));
    expect(await ledgerEntries()).toHaveLength(2);
  });

  it("freezes the manifest, runs every scheduled job through runInstance, writes the report, and resumes idempotently", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir, [{ instanceId: "owner__repo-3", reason: "gold patch unresolved", evidence: "selfcheck run x" }]);
    const outputDir = path.join(dir, "out");
    const state = world();
    const finished: string[] = [];
    const first = await runSwebenchEvaluation(options(outputDir, files, {
      baseURL: "https://user:secret@example.invalid/v1?key=secret",
      executeRun: (run) => runInstance(run, state.deps),
      onRow: (row) => finished.push(`${row.taskId}#${row.repetition}/${row.variant}`)
    }));

    const imageIds = Object.fromEntries(["owner__repo-2", "owner__repo-1"].map((id) => [id, fakeImageId(imageFor(recordFor(id), "epoch"))]));
    expect(first.manifest).toMatchObject({
      schemaVersion: 2, benchmark: "swebench", split: "dev", datasetRevision: "rev-test",
      dataFileSha256: createHash("sha256").update(await readFile(files.data)).digest("hex"), swebenchVersion: "5.0.2",
      instanceIds: ["owner__repo-2", "owner__repo-1"],
      exclusions: [{ instanceId: "owner__repo-3", reason: "gold patch unresolved", evidence: "selfcheck run x" }],
      variants: [{ name: "baseline", flags: {}, agentFingerprint: agentBehaviorFingerprint(PROFILES.baseline) }],
      repetitions: 1, plannedRuns: 2, scheduleSeed: DEFAULT_SCHEDULE_SEED, provider: "deepseek", model: "deepseek-flash",
      thinking: "enabled", reasoningEffort: "high", temperature: null, limits: SWEBENCH_LIMITS,
      containerLimits: { cpus: 2, memory: "4g", network: "none" }, priceSnapshot: FLASH, costCapUsd: 5,
      imageSource: "epoch", imageIds, baseURL: "https://example.invalid/v1", executor: "docker", displayRoot: "/testbed",
      allowTargetedVerification: true, infraPolicy: INFRA_POLICY, holdoutConfirmed: false
    });
    expect(JSON.stringify(first.manifest)).not.toContain("secret");
    expect(first.manifest.evaluationId).toMatch(/^swebench-dev-\d{4}-/);
    expect(first.manifest.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // 3M cache-miss input tokens at $0.3/M plus 150k output tokens at $1.2/M.
    expect(first.manifest.reservationUsd).toBeCloseTo(1.08, 10);
    expect(JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8"))).toEqual(first.manifest);
    expect(first.results.map((row) => [row.taskId, row.resolved, row.failureClass])).toEqual([
      ["owner__repo-1", true, undefined], ["owner__repo-2", true, undefined]
    ]);
    expect(finished.sort()).toEqual(["owner__repo-1#1/baseline", "owner__repo-2#1/baseline"]);
    expect(first.capReached).toBe(false);
    expect(first.summary).toMatchObject({ complete: true, scoredRuns: 2, resolved: { runs: 2, resolved: 2, rate: 1 }, totals: { unfinishedChargeUsd: 0 } });
    expect(state.cleaned).toHaveLength(2);
    // Every job start is journaled with the reservation it held.
    const journal = (await readFile(path.join(outputDir, "eval-journal.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(journal.map((entry) => [entry.key, entry.reservedUsd]).sort()).toEqual([
      ["owner__repo-1#1/baseline", first.manifest.reservationUsd], ["owner__repo-2#1/baseline", first.manifest.reservationUsd]
    ]);
    const report = await readFile(path.join(outputDir, "report.md"), "utf8");
    const summary = await readFile(path.join(outputDir, "summary.json"), "utf8");
    expect(report).toContain(DIAGNOSTIC_NOTE);

    // Nothing is left to run, and the rewritten report is byte-identical.
    const resumed = await runSwebenchEvaluation(options(outputDir, files, {
      baseURL: "https://example.invalid/v1", executeRun: async () => { throw new Error("a finished job ran again"); }
    }));
    expect(resumed.manifest.evaluationId).toBe(first.manifest.evaluationId);
    expect(resumed.results).toEqual(first.results);
    expect(await readFile(path.join(outputDir, "report.md"), "utf8")).toBe(report);
    expect(await readFile(path.join(outputDir, "summary.json"), "utf8")).toBe(summary);
    await expect(access(path.join(outputDir, "invalid-results.jsonl"))).rejects.toThrow();

    const resume = (overrides: Partial<SwebenchEvaluationOptions>) => runSwebenchEvaluation(options(outputDir, files, { baseURL: "https://example.invalid/v1", ...overrides }));
    await expect(resume({ repetitions: 2 })).rejects.toThrow(/incompatible.*\(plannedRuns, repetitions differ\)/);
    await expect(resume({ reservationUsd: 0.5 })).rejects.toThrow(/\(reservationUsd differ\)/);
    await expect(resume({ baseURL: "https://other.invalid" })).rejects.toThrow(/\(baseURL differ\)/);
    await expect(resume({ resolveImageId: async () => "sha256:re-pulled" })).rejects.toThrow(/\(imageIds differ\)/);
    await expect(resume({ resolveImageId: async () => undefined })).rejects.toThrow(/is not available locally; pull it first/);
  });

  it("charges a crashed job's journaled reservation on resume, and warns", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir);
    const outputDir = path.join(dir, "out");
    const state = world();
    const evaluate = (executeRun: SwebenchEvaluationOptions["executeRun"]) => runSwebenchEvaluation(options(outputDir, files, {
      taskIds: ["owner__repo-1", "owner__repo-2"], costCapUsd: 3, executeRun
    }));
    const first = await evaluate((run) => runInstance(run, state.deps));
    const reservation = first.manifest.reservationUsd;
    // As if a crash had killed the invocation with owner__repo-2's job in flight: its start is journaled, its row never written.
    const results = path.join(outputDir, "results.jsonl");
    const kept = (await readFile(results, "utf8")).trim().split("\n").filter((line) => !line.includes("\"taskId\":\"owner__repo-2\""));
    await writeFile(results, kept.join("\n") + "\n");
    const measured = first.results.find((row) => row.taskId === "owner__repo-1")!.capChargeUsd;

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let resumed: Awaited<ReturnType<typeof runSwebenchEvaluation>>;
    let warned: string;
    try {
      resumed = await evaluate((run) => runInstance(run, state.deps));
    } finally {
      warned = stderr.mock.calls.map(([text]) => String(text)).join("");
      stderr.mockRestore();
    }
    expect(warned)
      .toContain(`1 job(s) were in flight when an earlier invocation stopped (owner__repo-2#1/baseline); charging their reservations, $${reservation.toFixed(4)}`);
    // The job ran again, and the crashed start stays charged: it may have spent up to its reservation.
    expect(resumed.results.map((row) => row.taskId)).toEqual(["owner__repo-1", "owner__repo-2"]);
    expect(resumed.summary.totals.unfinishedChargeUsd).toBeCloseTo(reservation, 12);
    expect(resumed.summary.totals.capChargedUsd).toBeCloseTo(measured + resumed.results[1]!.capChargeUsd + reservation, 12);
    expect(resumed.summary.complete).toBe(true);
    const report = await readFile(path.join(outputDir, "report.md"), "utf8");
    expect(report).toContain(`$${reservation.toFixed(4)} charged for jobs an interrupted invocation never recorded`);

    // With both rows present, a third invocation runs nothing and rewrites the same report.
    await evaluate(async () => { throw new Error("a finished job ran again"); });
    expect(await readFile(path.join(outputDir, "report.md"), "utf8")).toBe(report);
  });

  it("stops the evaluation when a pinned image changes mid-run, keeping the rows already written", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir);
    const outputDir = path.join(dir, "out");
    const state = world({ imageId: (image) => image.includes("owner__repo-2") ? "sha256:re-pulled" : fakeImageId(image) });
    const run = runSwebenchEvaluation(options(outputDir, files, {
      taskIds: ["owner__repo-1", "owner__repo-2"], concurrency: 1, executeRun: (request) => runInstance(request, state.deps)
    }));
    await expect(run).rejects.toBeInstanceOf(ImageMismatchError);
    const rows = (await readFile(path.join(outputDir, "results.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.taskId)).toEqual(["owner__repo-1"]);
    const journal = (await readFile(path.join(outputDir, "eval-journal.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).key);
    expect(journal).toEqual(["owner__repo-1#1/baseline", "owner__repo-2#1/baseline"]);
  });

  it("substitutes an invalid row and charges a thrown job the reservation", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir);
    const outputDir = path.join(dir, "out");
    const state = world();
    const { results, summary } = await runSwebenchEvaluation(options(outputDir, files, {
      concurrency: 1,
      reservationUsd: 1,
      executeRun: async (run) => {
        if (run.record.instance_id === "owner__repo-3") throw new Error("agent run threw");
        const row = await runInstance(run, state.deps);
        return run.record.instance_id === "owner__repo-2" ? { ...row, taskHash: "tampered" } : row;
      }
    }));
    const byTask = Object.fromEntries(results.map((row) => [row.taskId, row]));
    expect(byTask["owner__repo-1"]).toMatchObject({ resolved: true, failureClass: undefined });
    expect(byTask["owner__repo-2"]).toMatchObject({
      failureClass: "invalid_result", agentStatus: "harness_error", resolved: false,
      estimatedCostUsd: estimateCost(usageOf(5), FLASH), capChargeUsd: estimateCost(usageOf(5), FLASH),
      finalMessage: "Invalid run result: Task hash mismatch for owner__repo-2#1/baseline"
    });
    expect(byTask["owner__repo-3"]).toMatchObject({
      failureClass: "harness_error", estimatedCostUsd: 0, capChargeUsd: 1, finalMessage: "agent run threw"
    });
    const audit = (await readFile(path.join(outputDir, "invalid-results.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audit).toEqual([expect.objectContaining({ error: "Task hash mismatch for owner__repo-2#1/baseline", original: expect.objectContaining({ taskHash: "tampered" }) })]);
    expect(summary).toMatchObject({ complete: false, completeness: { invalidResultRuns: 1, harnessErrorRuns: 1 }, scoredRuns: 1 });
  });

  // Every attempt of these jobs ends in a dropped connection after one model turn.
  const outageWorld = () => world({ fastRetries: true, provider: (_attempt, requests) => scriptedDeepSeek(FIX.slice(0, 1), requests, CONNECTION_RESET) });
  const readLines = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

  it("re-runs provider_error jobs on resume: their rows move, redacted, to superseded-results.jsonl and stay charged", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir);
    const outputDir = path.join(dir, "out");
    const secret = "sk-leaked1234567890secret";
    const outage = outageWorld();
    const healthy = world();
    const evaluate = (executeRun: SwebenchEvaluationOptions["executeRun"]) => runSwebenchEvaluation(options(outputDir, files, {
      taskIds: ["owner__repo-1", "owner__repo-2"], concurrency: 1, executeRun
    }));
    const first = await evaluate(async (run, context) => {
      if (run.record.instance_id !== "owner__repo-2") return runInstance(run, { ...healthy.deps, reserve: context.reserve });
      const row = await runInstance(run, { ...outage.deps, reserve: context.reserve });
      // Unredacted, as a row can reach results.jsonl; its superseded copy must not keep the key.
      return { ...row, finalMessage: `${row.finalMessage} ${secret}` };
    });
    const one = estimateCost(usageOf(1), FLASH);
    expect(first.results.map((row) => [row.taskId, row.failureClass])).toEqual([["owner__repo-1", undefined], ["owner__repo-2", "provider_error"]]);
    expect(first.results[1]).toMatchObject({ attempts: 2, estimatedCostUsd: one, retryCostUsd: one, capChargeUsd: 2 * one });
    expect(first.summary).toMatchObject({ complete: false, stopReason: null, completeness: { providerErrorRuns: 1 } });
    const manifestFile = await readFile(path.join(outputDir, "manifest.json"), "utf8");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let resumed: Awaited<ReturnType<typeof runSwebenchEvaluation>>;
    let warned: string;
    try {
      resumed = await evaluate((run, context) => runInstance(run, { ...healthy.deps, reserve: context.reserve }));
    } finally {
      warned = stderr.mock.calls.map(([text]) => String(text)).join("");
      stderr.mockRestore();
    }
    expect(warned).toContain("[eval] 1 job(s) run again (provider_error rerun): owner__repo-2#1/baseline; their rows moved to superseded-results.jsonl");
    // The journal marks the superseded start, so it is not charged as a crash.
    expect(warned).not.toContain("in flight");
    expect(resumed.summary.totals.unfinishedChargeUsd).toBe(0);
    // results.jsonl ends with exactly one row per job, and the manifest is untouched.
    expect((await readLines(path.join(outputDir, "results.jsonl"))).map((row) => [row.taskId, row.resolved, row.failureClass]))
      .toEqual([["owner__repo-1", true, undefined], ["owner__repo-2", true, undefined]]);
    expect(await readFile(path.join(outputDir, "manifest.json"), "utf8")).toBe(manifestFile);
    const superseded = await readLines(path.join(outputDir, "superseded-results.jsonl"));
    expect(superseded).toEqual([{
      at: expect.any(String), reason: "provider_error rerun",
      row: expect.objectContaining({ taskId: "owner__repo-2", failureClass: "provider_error", capChargeUsd: 2 * one, finalMessage: expect.stringContaining("[REDACTED_KEY]") })
    }]);
    expect(JSON.stringify(superseded)).not.toContain(secret);
    // Its charge still counts, in the true spend and in what the cap charged, but not in the per-task metric.
    const { totals } = resumed.summary;
    expect(resumed.summary).toMatchObject({ complete: true, stopReason: null });
    expect(totals.supersededChargeUsd).toBeCloseTo(2 * one, 12);
    expect(totals.measuredCostUsd).toBeCloseTo(resumed.results.reduce((sum, row) => sum + row.estimatedCostUsd, 0), 12);
    expect(totals.totalSpendUsd).toBeCloseTo(totals.measuredCostUsd + 2 * one, 12);
    expect(totals.capChargedUsd).toBeCloseTo(resumed.results.reduce((sum, row) => sum + row.capChargeUsd, 0) + 2 * one, 12);
    // `report` reads the same from the directory.
    const set = await loadResultSet(outputDir);
    const rows = set.rows as SwebenchRunResult[];
    expect(summarizeSwebench(resumed.manifest, rows, capReachedFrom(resumed.manifest, rows, set), set)).toEqual(resumed.summary);
  });

  it("keeps charging a superseded row, so a resume the cost cap cannot fit runs nothing more", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir);
    const outputDir = path.join(dir, "out");
    const one = estimateCost(usageOf(1), FLASH);
    const outage = outageWorld();
    const healthy = world();
    // After owner__repo-1's run, the cap holds owner__repo-2's reservation of $1 but not a retry of its outage.
    const evaluate = () => runSwebenchEvaluation(options(outputDir, files, {
      taskIds: ["owner__repo-1", "owner__repo-2"], concurrency: 1, reservationUsd: 1, costCapUsd: estimateCost(usageOf(5), FLASH) + 1 + one / 2,
      executeRun: (run, context) => runInstance(run, { ...(run.record.instance_id === "owner__repo-2" ? outage : healthy).deps, reserve: context.reserve })
    }));
    const first = await evaluate();
    expect(first.results[1]).toMatchObject({ failureClass: "provider_error", attempts: 1, estimatedCostUsd: one, retryCostUsd: 0, capChargeUsd: one });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let resumed: Awaited<ReturnType<typeof runSwebenchEvaluation>>;
    try {
      resumed = await evaluate();
    } finally {
      stderr.mockRestore();
    }
    // Uncharged, the superseded row would have left room for the rerun.
    expect(resumed.results.map((row) => row.taskId)).toEqual(["owner__repo-1"]);
    expect([resumed.capReached, outage.providers]).toEqual([true, 1]);
    expect(resumed.summary).toMatchObject({ complete: false, completeness: { missingRuns: 1, capReached: true }, totals: { supersededChargeUsd: one } });
  });

  it("stops scheduling after 3 consecutive provider errors, marks the summary provider_circuit_open, and a resume re-runs them", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir);
    const outputDir = path.join(dir, "out");
    const started: string[] = [];
    const evaluate = (state: World) => runSwebenchEvaluation(options(outputDir, files, {
      repetitions: 2, concurrency: 1,
      executeRun: (run, context) => {
        started.push(`${run.record.instance_id}#${run.repetition}`);
        return runInstance(run, { ...state.deps, reserve: context.reserve });
      }
    }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let stopped: Awaited<ReturnType<typeof runSwebenchEvaluation>>;
    let warned: string;
    try {
      stopped = await evaluate(outageWorld());
    } finally {
      warned = stderr.mock.calls.map(([text]) => String(text)).join("");
      stderr.mockRestore();
    }
    expect(warned).toContain("[swebench] Provider outage suspected after 3 consecutive provider errors: no new job starts, and the jobs in flight finish. Resume later to re-run them.");
    // Of the six jobs in schedule order, the three after the third provider error never started.
    expect(started).toEqual(["owner__repo-1#1", "owner__repo-1#2", "owner__repo-2#1"]);
    expect(stopped.manifest.infraPolicy?.provider).toMatchObject({ circuitBreakerAfter: 3, rule: expect.stringContaining("After 3 consecutive provider_error rows") });
    expect(stopped.summary).toMatchObject({
      complete: false, stopReason: "provider_circuit_open",
      completeness: { circuitOpen: true, capReached: false, missingRuns: 3, providerErrorRuns: 3 }
    });
    expect(await readFile(path.join(outputDir, "report.md"), "utf8"))
      .toContain("Stopped early (stopReason provider_circuit_open): a provider outage is suspected after 3 consecutive provider errors");
    // `report` derives the same from results.jsonl's order.
    const set = await loadResultSet(outputDir);
    const rows = set.rows as SwebenchRunResult[];
    expect(set.circuitOpen).toBe(true);
    expect(summarizeSwebench(stopped.manifest, rows, capReachedFrom(stopped.manifest, rows, set), set)).toEqual(stopped.summary);

    // Once the provider recovers, a resume runs the provider_error jobs again with the rest.
    started.length = 0;
    const stderrAgain = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let resumed: Awaited<ReturnType<typeof runSwebenchEvaluation>>;
    try {
      resumed = await evaluate(world());
    } finally {
      stderrAgain.mockRestore();
    }
    expect(started).toEqual(["owner__repo-1#1", "owner__repo-1#2", "owner__repo-2#1", "owner__repo-2#2", "owner__repo-3#1", "owner__repo-3#2"]);
    expect(resumed.summary).toMatchObject({ complete: true, stopReason: null, scoredRuns: 6, completeness: { circuitOpen: false } });
    expect(await readLines(path.join(outputDir, "results.jsonl"))).toHaveLength(6);
    expect((await readLines(path.join(outputDir, "superseded-results.jsonl"))).map((entry) => `${entry.row.taskId}#${entry.row.repetition}`))
      .toEqual(["owner__repo-1#1", "owner__repo-1#2", "owner__repo-2#1"]);
  });

  it("resets the breaker's count on any other row, and takes its threshold from providerBreaker", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir);
    const outage = outageWorld();
    const healthy = world();
    const started: string[] = [];
    // Every other job fails, so no two provider errors are consecutive.
    const { manifest, summary } = await runSwebenchEvaluation(options(path.join(dir, "out"), files, {
      repetitions: 2, concurrency: 1, providerBreaker: 2,
      executeRun: (run, context) => {
        started.push(`${run.record.instance_id}#${run.repetition}`);
        return runInstance(run, { ...(run.repetition === 1 ? outage : healthy).deps, reserve: context.reserve });
      }
    }));
    expect(started).toHaveLength(6);
    expect(manifest.infraPolicy?.provider).toMatchObject({ circuitBreakerAfter: 2, rule: expect.stringContaining("After 2 consecutive provider_error rows") });
    expect(summary).toMatchObject({ complete: false, stopReason: null, completeness: { circuitOpen: false, missingRuns: 0, providerErrorRuns: 3 } });
    await expect(runSwebenchEvaluation(options(path.join(dir, "bad"), files, { providerBreaker: 0 })))
      .rejects.toThrow("providerBreaker must be a positive integer, got 0");
  });

  it("accepts only split ids that self-check did not exclude", async () => {
    const dir = await tmp();
    const files = await datasetFiles(dir, [{ instanceId: "owner__repo-3", reason: "gold patch unresolved", evidence: "selfcheck run x" }]);
    const outputDir = path.join(dir, "out");
    await expect(runSwebenchEvaluation(options(outputDir, files, { taskIds: ["owner__repo-3"] })))
      .rejects.toThrow("Excluded from the dev split: owner__repo-3 (gold patch unresolved)");
    await expect(runSwebenchEvaluation(options(outputDir, files, { taskIds: ["owner__repo-1", "owner__repo-9"] })))
      .rejects.toThrow("Not in the dev split: owner__repo-9");
    await expect(runSwebenchEvaluation(options(outputDir, files, { variants: ["baseline", "no-such-profile"] })))
      .rejects.toThrow("Unknown agent profile: no-such-profile");
    await expect(access(outputDir)).rejects.toThrow();
    const state = world();
    const { manifest } = await runSwebenchEvaluation(options(outputDir, files, {
      taskIds: ["owner__repo-1"], executeRun: (run) => runInstance(run, state.deps)
    }));
    expect([manifest.instanceIds, manifest.plannedRuns]).toEqual([["owner__repo-1"], 1]);
  });
});

// Opt-in: ONEHAND_SWEBENCH_IT=1 and the django-11790 image pulled (the Epoch rebuild if present, else the
// official image). A scripted provider stands in for the model, so there is no network and no key.
const IT_INSTANCE = "django__django-11790";
const IT_SOURCE = process.env.ONEHAND_SWEBENCH_IT === "1"
  ? (["epoch", "official"] as const).find((source) => imagePresent(imageFor({
    instance_id: IT_INSTANCE, image: "swebench/sweb.eval.x86_64.django_1776_django-11790:latest"
  }, source)))
  : undefined;

function imagePresent(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Containers are named opaquely, so the rows name them; containers from anything else are never touched.
async function containersNamed(names: string[]): Promise<string[]> {
  const all = (await docker(["ps", "-a", "--filter", "label=onehand=1", "--format", "{{.Names}}"])).split("\n");
  return all.filter((name) => name && names.includes(name));
}

describe.skipIf(!IT_SOURCE)(`SWE-bench run end to end (${IT_INSTANCE}, ${IT_SOURCE ?? "no"} image)`, () => {
  let outputDir: string | undefined;
  const containerNames: string[] = [];

  afterAll(async () => {
    if (!outputDir) return;
    for (const name of await containersNamed(containerNames)) await docker(["rm", "-f", name]).catch(() => undefined);
    await cleanupTempDir(outputDir);
  }, 120_000);

  it("runs a scripted agent through the real workspace, container, test runner, and grading path", async () => {
    outputDir = await makeTempDir("onehand-swe-e2e-");
    const stderr = vi.spyOn(process.stderr, "write");
    const { manifest, results, summary } = await runSwebenchEvaluation({
      split: "dev", variants: ["baseline"], repetitions: 1, taskIds: [IT_INSTANCE], concurrency: 1, costCapUsd: 5, outputDir,
      apiKey: "unused", baseURL: "https://example.invalid", imageSource: IT_SOURCE,
      createProvider: () => scriptedDeepSeek([
        [["set_plan", { steps: ["Run the auth form tests"] }]],
        [["run_tests", { targets: ["auth_tests.test_forms"] }]],
        [["update_plan", { stepId: 1, status: "completed", evidence: "auth_tests.test_forms passed" }]],
        [["finish_task", { summary: "Ran auth_tests.test_forms; made no change." }]]
      ])
    });
    const logged = stderr.mock.calls.map(([text]) => String(text)).join("");
    stderr.mockRestore();
    containerNames.push(...results.flatMap((row) => (row.containerName ? [row.containerName] : [])));
    const record = (await loadRecords()).records.get(IT_INSTANCE)!;
    expect(() => validateSwebenchRows(results, manifest, new Map([[IT_INSTANCE, { hash: taskHashFor(record), repo: record.repo }]])))
      .not.toThrow();
    await expect(access(path.join(outputDir, "invalid-results.jsonl"))).rejects.toThrow();
    expect(results).toEqual([expect.objectContaining({
      taskId: IT_INSTANCE, variant: "baseline", agentStatus: "success", stopReason: "explicit_finish", attempts: 1, modelRounds: 4,
      agentVerificationPassed: true, emptyPatch: true, patchBytes: 0, patchFiles: [], resolved: false, patchApplied: false,
      falseSuccess: true, failureClass: "empty_patch", gradingOutcome: "empty_patch", responseModels: ["deepseek-flash"],
      containerName: expect.stringMatching(OPAQUE_NAME)
    })]);
    const testRun = results[0]!.traceEvents.find((event) => event.event === "tool_result" && (event.data as { name?: string }).name === "run_tests");
    expect(testRun?.data).toMatchObject({ ok: true, passed: true });
    expect(summary).toMatchObject({ complete: true, scoredRuns: 1, claims: { claimedUnresolved: 1 } });
    expect(manifest).toMatchObject({ imageSource: IT_SOURCE, instanceIds: [IT_INSTANCE], imageIds: { [IT_INSTANCE]: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) } });
    expect(logged).toContain(`[swebench] ${containerNames[0]}: ${IT_INSTANCE} r1 baseline`);
    expect(await containersNamed(containerNames)).toEqual([]);
    await expect(access(path.join(tmpdir(), containerNames[0]!))).rejects.toThrow();
    expect((await readdir(tmpdir())).filter((name) => name.includes(manifest.evaluationId))).toEqual([]);
  }, 1_200_000);
});

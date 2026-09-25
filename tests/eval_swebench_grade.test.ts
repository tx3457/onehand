import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InfraError } from "../eval/swebench/container.js";
import { normalizeRecord, SwebenchRecord } from "../eval/swebench/dataset.js";
import { gradeRun, GradeOptions } from "../eval/swebench/grade.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

// Stands in for `python -m swebench.harness.run_evaluation` (swebench 5.0.2): records its argv and the dataset
// file it was given, then leaves the files run_instance leaves for the scenario behavior.json names (one per
// call, from `sequence`, or `mode` after `crashes` crashing calls). The log lines follow run_instance's.
const FAKE_HARNESS = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const behavior = JSON.parse(fs.readFileSync(path.join(__dirname, "behavior.json"), "utf8"));
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const callsFile = path.join(__dirname, "calls.jsonl");
const dataset = fs.readFileSync(value("-d"), "utf8");
fs.appendFileSync(callsFile, JSON.stringify({ args, cwd: process.cwd(), envKeys: Object.keys(process.env), dataset }) + "\\n");
const calls = fs.readFileSync(callsFile, "utf8").trim().split("\\n").length;
const prediction = JSON.parse(fs.readFileSync(value("-p"), "utf8"));
const id = value("-i");
const logDir = path.join("logs", "run_evaluation", value("-id"), prediction.model_name_or_path.replaceAll("/", "__"), id);
fs.mkdirSync(logDir, { recursive: true });
const mode = behavior.sequence ? behavior.sequence[Math.min(calls, behavior.sequence.length) - 1]
  : calls <= (behavior.crashes || 0) ? "crash" : behavior.mode;
if (mode === "crash") { process.stderr.write("Traceback: docker exploded\\n"); process.exit(1); }
const at = (level, message) => "2026-09-25 19:45:56,712 - " + level + " - " + message;
const created = [at("INFO", "Creating container for " + id + "..."), at("INFO", "Container for " + id + " started: 0a1b2c")];
// The patch's own lines follow the marker and the diff header, as the real log quotes them.
const applied = [
  at("INFO", ">>>>> Applied Patch:"), "Checking patch pkg/mod.py...", "Applied patch pkg/mod.py cleanly.", "",
  at("INFO", "Git diff before:"), ...prediction.model_patch.trimEnd().split("\\n")
];
const ran = [
  at("INFO", "Eval script for " + id + " written to " + logDir + "/eval.sh; copying to container..."),
  at("INFO", "Test runtime: 12.34 seconds"), at("INFO", "Test output for " + id + " written to " + logDir + "/test_output.txt")
];
const traceback = (error) => [at("INFO", "Traceback (most recent call last):"), '  File "run_evaluation.py", line 377, in run_instance', error];
const cleanup = [at("INFO", "Attempting to stop container sweb.eval." + id + "..."), at("INFO", "Container sweb.eval." + id + " removed successfully.")];
const write = (name, text) => fs.writeFileSync(path.join(logDir, name), text);
const log = (...parts) => write("run_instance.log", parts.flat().join("\\n") + "\\n");
const report = (entry) => write("report.json", JSON.stringify({ [id]: { patch_is_None: false, patch_exists: true, infra_failure: false, ...entry } }));
const unparsed = { resolved: false, patch_successfully_applied: false };
if (mode === "report") { log(created, applied, ran, cleanup); write("test_output.txt", "+ pytest\\n1 passed\\n"); report(behavior.report); }
if (mode === "unparsed") { log(created, applied, ran, cleanup); write("test_output.txt", "no recognizable results\\n"); report(unparsed); }
if (mode === "garbage") { log(created, applied, ran, cleanup); write("report.json", "{not json"); }
if (mode === "no_verdict") { log(created, applied, ran, cleanup); write("report.json", JSON.stringify({ [id]: { patch_exists: true } })); }
if (mode === "no_marker") { log(created, ran, cleanup); write("test_output.txt", "1 passed\\n"); report({ ...behavior.report }); }
if (mode === "oom") {
  log(created, applied, ran, cleanup);
  write("test_output.txt", "+ pytest\\ncollected 4 items\\nKilled\\n");
  report({ ...unparsed, infra_failure: true, infra_failure_reason: "out_of_memory" });
}
if (mode === "container_unavailable") {
  log(created, applied, ran, cleanup);
  write("test_output.txt", "Error response from daemon: container 0a1b2c is not running\\n");
  report({ ...unparsed, infra_failure: true, infra_failure_reason: "container_unavailable" });
}
if (mode === "network_unreachable") {
  log(created, applied, ran, cleanup);
  write("test_output.txt", "Could not resolve host: pypi.org\\n");
  report({ ...unparsed, infra_failure: true, infra_failure_reason: "network_unreachable" });
}
if (mode === "apply_fail") {
  log(created, at("INFO", "Failed to apply patch to container: git apply --verbose"), at("INFO", ">>>>> Patch Apply Failed:"), "error: corrupt patch at line 6",
    traceback("swebench.harness.utils.EvaluationError: Error in evaluation for " + id + ": >>>>> Patch Apply Failed:"), cleanup);
}
if (mode === "timeout") {
  log(created, applied, ran.slice(0, 1), at("INFO", "Test runtime: 60.01 seconds"), ran.slice(2),
    traceback("swebench.harness.utils.EvaluationError: Error in evaluation for " + id + ": Test timed out after 60 seconds."), cleanup);
  write("test_output.txt", "+ pytest\\ncollected 4 items\\n\\n\\nTimeout error: 60 seconds exceeded.");
}
if (mode === "oom_no_report") {
  log(created, applied, ran, at("ERROR", "Error in evaluating model for " + id + ": [Errno 12] Cannot allocate memory"), cleanup);
  write("test_output.txt", "+ pytest\\ncollected 4 items\\n");
}
if (mode === "tests_errored") {
  log(created, applied, ran, at("ERROR", "Error in evaluating model for " + id + ": list index out of range"),
    '  File "log_parsers/python.py", line 42, in parse_log_pytest', "IndexError: list index out of range", cleanup);
  write("test_output.txt", "+ pytest\\n" + "garbled".repeat(3) + "\\n");
}
if (mode === "docker_error_after_tests") {
  log(created, applied, ran, at("ERROR", "Error in evaluating model for " + id + ": 500 Server Error"),
    "docker.errors.APIError: 500 Server Error for http+docker://localhost/v1.47/exec/abc/start", cleanup);
  write("test_output.txt", "1 passed\\n");
}
if (mode === "daemon_error_after_tests") {
  log(created, applied, ran, at("ERROR", "Error in evaluating model for " + id + ": Error response from daemon: container 0a1b2c is not running"), cleanup);
  write("test_output.txt", "1 passed\\n");
}
if (mode === "disk_full_after_tests") {
  log(created, applied, ran, at("ERROR", "Error in evaluating model for " + id + ": [Errno 28] No space left on device"), cleanup);
  write("test_output.txt", "1 passed\\n");
}
if (mode === "oom_named_test_then_docker_error") {
  log(created, applied, ran, at("ERROR", "Error in evaluating model for " + id + ": 500 Server Error"),
    "docker.errors.APIError: 500 Server Error for http+docker://localhost/v1.47/exec/abc/json", cleanup);
  write("test_output.txt", "PASSED tests/test_mem.py::test_raises_OutOfMemoryError\\n");
}
if (mode === "tests_errored_then_cleanup_daemon_error") {
  log(created, applied, ran, at("ERROR", "Error in evaluating model for " + id + ": list index out of range"), "IndexError: list index out of range",
    at("INFO", "Attempting to stop container sweb.eval." + id + "..."),
    at("ERROR", "Failed to stop container sweb.eval." + id + ": Error response from daemon: No such container. Trying to forcefully kill..."));
  write("test_output.txt", "garbled\\n");
}
if (mode === "container_create_failed") {
  log(created.slice(0, 1), at("ERROR", "Error creating container for " + id + ": Error response from daemon: no space left on device"),
    traceback("swebench.harness.utils.EvaluationError: Error in evaluation for " + id + ": Error response from daemon"));
}
`;

const INSTANCE = "owner__repo-7";
const record: SwebenchRecord = normalizeRecord({
  instance_id: INSTANCE, repo: "pydata/xarray", base_commit: "abc", environment_setup_commit: "def", version: "1.0",
  created_at: "2020-01-01T00:00:00Z", difficulty: "<15 min fix", eval_type: "pass_and_fail",
  image: "swebench/sweb.eval.x86_64.owner_1776_repo-7:latest", log_parser: "parse_log_pytest", patch: "", test_patch: "",
  eval_script: "", problem_statement: "", hints_text: "", FAIL_TO_PASS: ["t1", "t2"], PASS_TO_PASS: ["t3", "t4", "t5"]
});
const PATCH = "diff --git a/pkg/mod.py b/pkg/mod.py\n--- a/pkg/mod.py\n+++ b/pkg/mod.py\n@@ -1 +1 @@\n-a\n+b\n";
const EPOCH_IMAGE = "ghcr.io/epoch-research/swe-bench.eval.x86_64.owner__repo-7:latest";
const NONE = { success: 0, failure: 0 };

function reportFor(entry: Record<string, unknown>) {
  return { resolved: false, patch_successfully_applied: true, ...entry };
}

const resolvedReport = reportFor({
  resolved: true,
  tests_status: {
    FAIL_TO_PASS: { success: ["t1", "t2"], failure: [] },
    PASS_TO_PASS: { success: ["t3", "t4", "t5"], failure: [] },
    FAIL_TO_FAIL: { success: [], failure: [] },
    PASS_TO_FAIL: { success: [], failure: [] }
  }
});

let dir: string;
let workDir: string;
const imageChecks: string[] = [];

beforeEach(async () => {
  dir = await makeTempDir("onehand-swe-harness-");
  workDir = path.join(dir, "work");
  imageChecks.length = 0;
  await writeFile(path.join(dir, "python"), FAKE_HARNESS);
  await chmod(path.join(dir, "python"), 0o755);
  vi.stubEnv("ONEHAND_SWEBENCH_PYTHON", path.join(dir, "python"));
  vi.stubEnv("ONEHAND_TEST_SECRET", "must-not-reach-the-harness");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTempDir(dir);
});

async function behave(behavior: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(dir, "behavior.json"), JSON.stringify(behavior));
}

async function calls(): Promise<Array<{ args: string[]; cwd: string; envKeys: string[]; dataset: string }>> {
  const text = await readFile(path.join(dir, "calls.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function options(overrides: Partial<GradeOptions> = {}): GradeOptions {
  return {
    record, imageSource: "epoch", patch: PATCH, runId: "run-1", modelName: "onehand/test", workDir, timeoutSec: 60,
    ensureImage: async (image) => {
      imageChecks.push(image);
    },
    ...overrides
  };
}

function reportPathOf(runId = "run-1"): string {
  return path.join(workDir, "logs", "run_evaluation", runId, "onehand__test", INSTANCE, "report.json");
}

describe("gradeRun", () => {
  it("scores an empty patch unresolved without starting the harness", async () => {
    await behave({ mode: "report", report: resolvedReport });
    for (const patch of ["", "  \n"]) {
      expect(await gradeRun(options({ patch }))).toEqual({
        resolved: false, patchApplied: false, outcome: "empty_patch", f2p: NONE, p2p: NONE, reportPath: null
      });
    }
    expect(await calls()).toEqual([]);
    expect(imageChecks).toEqual([]);
  });

  it("writes the prediction, runs the harness in the work directory, and parses its report", async () => {
    await behave({
      mode: "report",
      report: reportFor({
        tests_status: { FAIL_TO_PASS: { success: ["t1"], failure: ["t2"] }, PASS_TO_PASS: { success: ["t3", "t4"], failure: ["t5"] } }
      })
    });
    expect(await gradeRun(options())).toEqual({
      resolved: false, patchApplied: true, outcome: "scored", f2p: { success: 1, failure: 1 }, p2p: { success: 2, failure: 1 },
      reportPath: reportPathOf()
    });
    const [call] = await calls();
    const predictions = path.join(workDir, "predictions", "run-1.jsonl");
    const dataset = path.join(workDir, "datasets", "run-1.jsonl");
    expect(call!.args).toEqual([
      "-m", "swebench.harness.run_evaluation", "-d", dataset, "-i", INSTANCE, "-p", predictions,
      "-id", "run-1", "--max_workers", "1", "-t", "60", "--report_dir", path.join(workDir, "reports")
    ]);
    expect(call!.cwd).toBe(workDir);
    expect(call!.envKeys).not.toContain("ONEHAND_TEST_SECRET");
    expect(JSON.parse(await readFile(predictions, "utf8"))).toEqual({
      instance_id: INSTANCE, model_name_or_path: "onehand/test", model_patch: PATCH
    });
    // The harness takes the image from the dataset record, so it gets only this instance with the Epoch image.
    expect(call!.dataset.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([{ ...record, image: EPOCH_IMAGE }]);
    expect(imageChecks).toEqual([EPOCH_IMAGE]);
  });

  it("scores a resolved report on the first attempt", async () => {
    await behave({ mode: "report", report: resolvedReport });
    expect(await gradeRun(options())).toEqual({
      resolved: true, patchApplied: true, outcome: "scored", f2p: { success: 2, failure: 0 }, p2p: { success: 3, failure: 0 },
      reportPath: reportPathOf()
    });
    expect(await calls()).toHaveLength(1);
  });

  it("grades official-source runs in the record's own image", async () => {
    await behave({ mode: "report", report: resolvedReport });
    expect(await gradeRun(options({ imageSource: "official", runId: "run-official" }))).toMatchObject({ resolved: true });
    const [call] = await calls();
    expect(call!.args[call!.args.indexOf("-d") + 1]).toBe(path.join(workDir, "datasets", "run-official.jsonl"));
    expect(JSON.parse(call!.dataset)).toEqual(record);
    expect(imageChecks).toEqual([record.image]);
  });

  it("never returns a stale report left by an earlier invocation", async () => {
    const stale = path.dirname(reportPathOf());
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "report.json"), JSON.stringify({ [INSTANCE]: resolvedReport }));
    await behave({ mode: "silent" });
    await expect(gradeRun(options())).rejects.toThrow(/wrote no report/);
    expect(await calls()).toHaveLength(3);
  });

  it("retries harness crashes, each attempt under its own run id, up to three attempts", async () => {
    await behave({ mode: "report", report: resolvedReport, crashes: 2 });
    expect(await gradeRun(options())).toMatchObject({ resolved: true, patchApplied: true, outcome: "scored", f2p: { success: 2, failure: 0 } });
    expect((await calls()).map((call) => call.args[call.args.indexOf("-id") + 1])).toEqual(["run-1", "run-1.retry2", "run-1.retry3"]);

    await behave({ mode: "report", report: resolvedReport, crashes: 10 });
    const failure = gradeRun(options({ runId: "run-2" }));
    await expect(failure).rejects.toBeInstanceOf(InfraError);
    await expect(failure).rejects.toThrow(/failed 3 times: SWE-bench harness exited with 1; see .*: Traceback: docker exploded/);
    expect(await calls()).toHaveLength(6);
  });

  it("retries unparseable reports, reports without a verdict, and reports without an applied patch in the log", async () => {
    for (const behavior of [{ mode: "garbage" }, { mode: "no_verdict" }, { mode: "no_marker", report: resolvedReport }]) {
      await behave(behavior);
      await expect(gradeRun(options())).rejects.toBeInstanceOf(InfraError);
    }
    expect(await calls()).toHaveLength(9);
  });

  it("retries only an unavailable environment: container_unavailable or a Docker or host failure in the harness's log, or a crash before the tests", async () => {
    for (const unavailable of [
      "daemon_error_after_tests", "docker_error_after_tests", "disk_full_after_tests", "oom_named_test_then_docker_error", "container_create_failed"
    ]) {
      await behave({ sequence: [unavailable, "report"], report: resolvedReport });
      await writeFile(path.join(dir, "calls.jsonl"), "");
      expect(await gradeRun(options({ runId: `run-${unavailable.replaceAll("_", "-")}` })), unavailable).toMatchObject({ resolved: true, outcome: "scored" });
      expect(await calls(), unavailable).toHaveLength(2);
    }
    await behave({ mode: "container_create_failed" });
    await writeFile(path.join(dir, "calls.jsonl"), "");
    await expect(gradeRun(options({ runId: "run-down" }))).rejects.toThrow(/failed 3 times: SWE-bench harness wrote no report for owner__repo-7, and its tests never ran/);
    expect(await calls()).toHaveLength(3);
  });

  it("keeps the report's verdict when container_unavailable comes only from the test output the patch wrote", async () => {
    // The report classifies test_output.txt alone; Docker errors never reach that stream.
    await behave({ mode: "container_unavailable" });
    expect(await gradeRun(options())).toEqual({
      resolved: false, patchApplied: true, outcome: "scored", f2p: NONE, p2p: NONE, reportPath: reportPathOf()
    });
    // Nor does a daemon error while tearing the container down turn a patch-caused failure into a retry.
    await behave({ mode: "tests_errored_then_cleanup_daemon_error" });
    expect(await gradeRun(options({ runId: "run-teardown" }))).toMatchObject({ resolved: false, outcome: "tests_errored" });
    expect(await calls()).toHaveLength(2);
  });

  it("scores patch-caused failures unresolved without retrying: apply failure, timeout, out of memory, errored tests", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["apply_fail", { patchApplied: false, outcome: "patch_apply_failed", reportPath: null }],
      ["timeout", { patchApplied: true, outcome: "test_timeout", reportPath: null }],
      ["oom", { patchApplied: true, outcome: "oom" }],
      ["oom_no_report", { patchApplied: true, outcome: "oom", reportPath: null }],
      ["tests_errored", { patchApplied: true, outcome: "tests_errored", reportPath: null }]
    ];
    for (const [mode, expected] of cases) {
      await behave({ mode });
      await writeFile(path.join(dir, "calls.jsonl"), "");
      const runId = `run-${mode.replaceAll("_", "-")}`;
      expect(await gradeRun(options({ runId })), mode).toEqual({
        resolved: false, f2p: NONE, p2p: NONE, reportPath: reportPathOf(runId), ...expected
      });
      expect(await calls(), mode).toHaveLength(1);
    }
  });

  it("scores other flagged environment faults as the report's verdict, the way the official harness does", async () => {
    await behave({ mode: "network_unreachable" });
    expect(await gradeRun(options())).toEqual({
      resolved: false, patchApplied: true, outcome: "scored", f2p: NONE, p2p: NONE, reportPath: reportPathOf()
    });
    expect(await calls()).toHaveLength(1);
  });

  it("takes patchApplied from the log's markers, not from report.json, and never from the patch's own text", async () => {
    // report.json says patch_successfully_applied: false whenever the test log cannot be parsed.
    await behave({ mode: "unparsed" });
    expect(await gradeRun(options())).toMatchObject({ resolved: false, patchApplied: true, outcome: "scored" });
    // The log quotes the patch after its diff header; a marker inside the patch is not the harness's, even after a
    // carriage return that makes it look like the start of a log record.
    const trick = `${PATCH}+>>>>> Patch Apply Failed\n+x\r2026-09-25 19:45:56,712 - INFO - >>>>> Patch Apply Failed:\n`.replace("@@ -1 +1 @@", "@@ -1 +1,3 @@");
    expect(await gradeRun(options({ runId: "run-trick", patch: trick }))).toMatchObject({ patchApplied: true, outcome: "scored" });
  });

  it("grades in the pinned image ID when one is given, whatever the tag names by now", async () => {
    await behave({ mode: "report", report: resolvedReport });
    const pinned = `sha256:${"ab".repeat(32)}`;
    expect(await gradeRun(options({ imageId: pinned }))).toMatchObject({ resolved: true, outcome: "scored" });
    const [call] = await calls();
    expect(JSON.parse(call!.dataset)).toEqual({ ...record, image: pinned });
    expect(imageChecks).toEqual([pinned]);
  });

  it("refuses to grade when the instance image is missing, before starting the harness", async () => {
    await behave({ mode: "report", report: resolvedReport });
    const missing = gradeRun(options({ ensureImage: async (image) => { throw new InfraError(`Docker image ${image} is not available locally`); } }));
    await expect(missing).rejects.toThrow(/not available locally/);
    await expect(gradeRun(options({ runId: "bad id" }))).rejects.toThrow(/Invalid grading run id/);
    expect(await calls()).toEqual([]);
  });
});

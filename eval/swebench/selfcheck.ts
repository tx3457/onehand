import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createToolRegistry, ToolRegistry } from "../../src/tools/registry.js";
import type { CommandExecution } from "../../src/types.js";
import { CONTAINER_ROOT, opaqueName, startContainer, SwebenchContainer } from "./container.js";
import {
  ImageSource, loadSwebenchSplit, officialTestTargets, patchFiles, SwebenchExclusion, SwebenchRecord, SwebenchSplit, testCommandFor
} from "./dataset.js";
import { GradeResult, gradeRun, harnessVersion } from "./grade.js";
import { applyPatch, extractPatch } from "./patch.js";
import { prepareWorkspace, SwebenchWorkspace } from "./workspace.js";

export const NOOP_LINE = "# onehand-selfcheck: no behavior change";

export type SelfcheckOptions = {
  split: SwebenchSplit;
  taskIds?: string[];
  imageSource: ImageSource;
  repeat: number;
  outputDir: string;
  concurrency: number;
  gradeTimeoutSec?: number;
  testTimeoutSec?: number;
};

export type GradeCheck = {
  kind: "gold" | "noop";
  repetition: number;
  outcome: "resolved" | "unresolved" | "skipped" | "error";
  // The error, the skip reason, or the no-op file.
  detail?: string;
  grade?: GradeResult;
  patchBytes?: number;
  patchFiles?: string[];
  warnings: string[];
};

export type TestRun = {
  command: string;
  exitCode: number | null;
  durationMs: number;
  passed: boolean;
  timedOut: boolean;
  runnerStarted: boolean;
  outputTail: string;
};

export type AdapterCheck = { targets: string[]; beforeGold?: TestRun; afterGold?: TestRun; error?: string };

export type SelfcheckVerdict = {
  status: "pass" | "fail" | "error";
  failures: string[];
  warnings: string[];
  errors: string[];
  exclusion?: SwebenchExclusion;
};

export type InstanceSelfcheck = {
  instanceId: string;
  repo: string;
  durationMs: number;
  gold: GradeCheck[];
  noop: GradeCheck;
  adapter: AdapterCheck;
} & SelfcheckVerdict;

export type SelfcheckReport = {
  schemaVersion: 1;
  createdAt: string;
  split: SwebenchSplit;
  repeat: number;
  runPrefix: string;
  imageSource: ImageSource;
  datasetRevision: string;
  dataFileSha256: string;
  swebenchVersion: string;
  summary: { total: number; pass: number; fail: number; error: number };
  instances: InstanceSelfcheck[];
};

type Context = {
  runPrefix: string;
  workDir: string;
  imageSource: ImageSource;
  repeat: number;
  gradeTimeoutSec: number;
  testTimeoutSec: number;
};

export async function runSelfcheck(options: SelfcheckOptions): Promise<SelfcheckReport> {
  const loaded = await loadSwebenchSplit(options.split);
  // Named ids may include excluded ones, so an exclusion can be re-checked.
  const splitIds = [...loaded.instanceIds, ...loaded.exclusions.map((entry) => entry.instanceId)];
  const ids = [...new Set(options.taskIds ?? loaded.instanceIds)];
  const unknown = ids.filter((id) => !splitIds.includes(id));
  if (!ids.length || unknown.length) throw new Error(`Not in the ${options.split} split: ${unknown.join(", ") || "(no ids)"}`);
  const outputDir = path.resolve(options.outputDir);
  const createdAt = new Date().toISOString();
  const context: Context = {
    runPrefix: `selfcheck-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`,
    workDir: path.join(outputDir, "grading"),
    imageSource: options.imageSource,
    repeat: options.repeat,
    gradeTimeoutSec: options.gradeTimeoutSec ?? 1_800,
    testTimeoutSec: options.testTimeoutSec ?? 900
  };
  await mkdir(context.workDir, { recursive: true });
  const swebenchVersion = await harnessVersion();

  const instances: InstanceSelfcheck[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const record = loaded.records.get(ids[cursor++]!)!;
      process.stdout.write(`[selfcheck] ${record.instance_id}: started\n`);
      const result = await checkInstance(record, context);
      instances.push(result);
      process.stdout.write(`[selfcheck] ${record.instance_id}: ${result.status} ${[...result.failures, ...result.errors].join("; ")}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, ids.length)) }, worker));
  instances.sort((a, b) => ids.indexOf(a.instanceId) - ids.indexOf(b.instanceId));

  const count = (status: InstanceSelfcheck["status"]) => instances.filter((item) => item.status === status).length;
  const report: SelfcheckReport = {
    schemaVersion: 1,
    createdAt,
    split: options.split,
    repeat: options.repeat,
    runPrefix: context.runPrefix,
    imageSource: options.imageSource,
    datasetRevision: loaded.datasetRevision,
    dataFileSha256: loaded.dataFileSha256,
    swebenchVersion,
    summary: { total: instances.length, pass: count("pass"), fail: count("fail"), error: count("error") },
    instances
  };
  const exclusions = instances.flatMap((item) => (item.exclusion ? [item.exclusion] : []));
  await writeFile(path.join(outputDir, "selfcheck.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(path.join(outputDir, "selfcheck.md"), renderSelfcheckMarkdown(report), "utf8");
  await writeFile(path.join(outputDir, "suggested-exclusions.json"), JSON.stringify(exclusions, null, 2) + "\n", "utf8");
  return report;
}

// Pure: turns the observed outcomes into a verdict. Only a definitive outcome (a gold patch graded
// unresolved, a no-op graded resolved) suggests an exclusion; infrastructure errors never do.
export function classifyInstance(check: Pick<InstanceSelfcheck, "instanceId" | "gold" | "noop" | "adapter">): SelfcheckVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const reasons: string[] = [];
  for (const item of [...check.gold, check.noop]) {
    const label = `${item.kind} #${item.repetition}`;
    warnings.push(...item.warnings.map((warning) => `${label}: ${warning}`));
    if (item.outcome === "error") errors.push(`${label}: ${item.detail}`);
    if (item.outcome === "skipped") warnings.push(`${label} skipped: ${item.detail}`);
  }
  const unresolved = check.gold.filter((item) => item.outcome === "unresolved");
  if (unresolved.length) reasons.push(`gold patch unresolved on ${unresolved.length} of ${check.gold.length} gradings`);
  if (check.noop.outcome === "resolved") reasons.push("no-op patch resolved, so the tests do not detect a missing fix");
  failures.push(...reasons);

  const { beforeGold, afterGold, error } = check.adapter;
  if (error) errors.push(`adapter: ${error}`);
  for (const [label, run] of [["before", beforeGold], ["after", afterGold]] as const) {
    if (run && !run.runnerStarted) failures.push(`test runner did not start ${label} the gold patch: ${run.command} (exit ${run.exitCode})`);
    else if (run?.timedOut) warnings.push(`tests timed out ${label} the gold patch`);
  }
  if (beforeGold?.runnerStarted && beforeGold.passed) warnings.push("tests passed before the gold patch; expected a failure");
  if (afterGold?.runnerStarted && !afterGold.passed && !afterGold.timedOut) {
    warnings.push(`tests did not pass after the gold patch (exit ${afterGold.exitCode})`);
  }

  const verdict: SelfcheckVerdict = {
    status: failures.length ? "fail" : errors.length ? "error" : "pass", failures, warnings, errors
  };
  if (reasons.length) {
    const graded = [...check.gold, check.noop].filter((item) => item.grade);
    verdict.exclusion = {
      instanceId: check.instanceId,
      reason: reasons.join("; "),
      evidence: [
        `gold resolved ${check.gold.filter((item) => item.outcome === "resolved").length}/${check.gold.length}`,
        `no-op ${check.noop.outcome}`,
        ...graded.map((item) => `${item.kind} #${item.repetition}: ${item.grade!.reportPath ?? `no report (${item.grade!.outcome})`}`)
      ].join("; ")
    };
  }
  return verdict;
}

// The first file the gold patch modifies (not creates, deletes, or renames) that is non-test Python.
export function noopTarget(record: SwebenchRecord): string | undefined {
  const testFiles = new Set(patchFiles(record.test_patch));
  for (const section of record.patch.split(/^(?=diff --git )/m)) {
    const file = /^diff --git a\/(\S+) b\/\S+$/m.exec(section)?.[1];
    if (!file?.endsWith(".py") || testFiles.has(file) || isTestPath(file)) continue;
    if (/^(new file mode|deleted file mode|rename from) /m.test(section)) continue;
    return file;
  }
  return undefined;
}

export function renderSelfcheckMarkdown(report: SelfcheckReport): string {
  const run = (value?: TestRun) => value
    ? `${value.timedOut ? "timed out" : `exit ${value.exitCode}`}, ${(value.durationMs / 1000).toFixed(1)}s`
    : "not run";
  const rows = report.instances.map((item) => [
    item.instanceId,
    `${item.gold.filter((grade) => grade.outcome === "resolved").length}/${item.gold.length}`,
    item.noop.outcome,
    run(item.adapter.beforeGold),
    run(item.adapter.afterGold),
    item.status
  ]);
  const findings = report.instances.flatMap((item) => [
    ...item.failures.map((text) => `- ${item.instanceId} (failure): ${text}`),
    ...item.errors.map((text) => `- ${item.instanceId} (error): ${text}`),
    ...item.warnings.map((text) => `- ${item.instanceId} (warning): ${text}`)
  ]);
  const exclusions = report.instances.flatMap((item) => (item.exclusion ? [`- ${item.instanceId}: ${item.exclusion.reason}`] : []));
  return [
    "# SWE-bench self-check",
    "",
    `- Split: ${report.split}; gold gradings per instance: ${report.repeat}; run: ${report.runPrefix}; images: ${report.imageSource}`,
    `- Dataset revision: ${report.datasetRevision}; data file sha256: ${report.dataFileSha256}`,
    `- Harness: swebench ${report.swebenchVersion}; started ${report.createdAt}`,
    `- Result: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.error} error, of ${report.summary.total}`,
    "",
    "Gold: the gold patch, extracted like an agent patch, must be resolved every time. No-op: a comment appended to a",
    "source file must stay unresolved. Tests: the agent's run_tests in the container with the official targets, after the",
    "test patch alone (expected to fail) and after the gold patch too (expected to pass).",
    "",
    "| Instance | Gold resolved | No-op | Tests before gold | Tests after gold | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
    "",
    "## Findings",
    "",
    ...(findings.length ? findings : ["None."]),
    "",
    "## Suggested exclusions",
    "",
    ...(exclusions.length ? exclusions : ["None."]),
    ""
  ].join("\n");
}

async function checkInstance(record: SwebenchRecord, context: Context): Promise<InstanceSelfcheck> {
  const started = Date.now();
  const gold: GradeCheck[] = [];
  for (let repetition = 1; repetition <= context.repeat; repetition++) {
    gold.push(await gradeCheck(record, "gold", repetition, context));
  }
  const noop = await gradeCheck(record, "noop", 1, context);
  const adapter = await adapterCheck(record, context);
  const check = { instanceId: record.instance_id, gold, noop, adapter };
  return { ...check, repo: record.repo, durationMs: Date.now() - started, ...classifyInstance(check) };
}

async function gradeCheck(record: SwebenchRecord, kind: "gold" | "noop", repetition: number, context: Context): Promise<GradeCheck> {
  const check: GradeCheck = { kind, repetition, outcome: "error", warnings: [] };
  const target = kind === "noop" ? noopTarget(record) : undefined;
  if (kind === "noop" && !target) {
    return { ...check, outcome: "skipped", detail: "the gold patch modifies no existing non-test .py file" };
  }
  let workspace: SwebenchWorkspace | undefined;
  try {
    workspace = await prepareWorkspace(record, opaqueName(), context.imageSource);
    if (target) await appendNoop(path.join(workspace.repo, target));
    else await applyPatch(workspace.repo, record.patch);
    const extracted = await extractPatch(workspace.repo, workspace.baseCommit);
    check.patchBytes = extracted.bytes;
    check.patchFiles = extracted.files;
    const expected = target ? [target] : [...new Set(patchFiles(record.patch))].sort();
    if (extracted.files.join("\0") !== expected.join("\0")) {
      check.warnings.push(`extracted patch touches ${extracted.files.join(", ") || "nothing"}; expected ${expected.join(", ")}`);
    }
    check.grade = await gradeRun({
      record,
      imageSource: context.imageSource,
      patch: extracted.patch,
      runId: `${context.runPrefix}.${record.instance_id}.${kind}-${repetition}`,
      modelName: `onehand-selfcheck-${kind}`,
      workDir: context.workDir,
      timeoutSec: context.gradeTimeoutSec
    });
    check.outcome = check.grade.resolved ? "resolved" : "unresolved";
    if (target) check.detail = target;
  } catch (error) {
    check.outcome = "error";
    check.detail = errorMessage(error);
  } finally {
    await workspace?.cleanup();
  }
  return check;
}

// The agent's own run_tests path: the tool registry, the container executor, the trusted base command.
async function adapterCheck(record: SwebenchRecord, context: Context): Promise<AdapterCheck> {
  const check: AdapterCheck = { targets: [] };
  let workspace: SwebenchWorkspace | undefined;
  let container: SwebenchContainer | undefined;
  try {
    check.targets = officialTestTargets(record);
    const name = opaqueName();
    workspace = await prepareWorkspace(record, name, context.imageSource);
    container = await startContainer(record, workspace.repo, name, context.imageSource);
    const registry = createToolRegistry({
      repoRoot: workspace.repo,
      displayRoot: CONTAINER_ROOT,
      executor: container.executor,
      testCommand: testCommandFor(record).base,
      trustedTestCommand: true,
      allowTargetedVerification: true,
      timeoutSec: context.testTimeoutSec,
      allowDestructive: false
    });
    await applyPatch(workspace.repo, record.test_patch);
    check.beforeGold = await runTests(registry, check.targets);
    await applyPatch(workspace.repo, record.patch);
    check.afterGold = await runTests(registry, check.targets);
  } catch (error) {
    check.error = errorMessage(error);
  } finally {
    try {
      await container?.stop();
    } catch (error) {
      check.error ??= `container cleanup failed: ${errorMessage(error)}`;
    }
    await workspace?.cleanup();
  }
  return check;
}

async function runTests(registry: ToolRegistry, targets: string[]): Promise<TestRun> {
  const result = await registry.execute("run_tests", { targets });
  if (!result.ok) throw new Error(`run_tests was refused: ${result.error}`);
  const data = result.data as CommandExecution & { passed: boolean };
  const output = `${data.stdout}\n${data.stderr}`;
  return {
    command: data.command,
    exitCode: data.exitCode,
    durationMs: data.durationMs,
    passed: data.passed,
    timedOut: data.timedOut,
    runnerStarted: data.exitCode !== 126 && data.exitCode !== 127 && !/command not found/i.test(output),
    outputTail: output.trim().slice(-1_000)
  };
}

async function appendNoop(file: string): Promise<void> {
  const content = await readFile(file, "utf8");
  await appendFile(file, `${content === "" || content.endsWith("\n") ? "" : "\n"}${NOOP_LINE}\n`, "utf8");
}

function isTestPath(file: string): boolean {
  const parts = file.split("/");
  const name = parts.at(-1)!;
  return parts.slice(0, -1).some((part) => part === "tests" || part === "testing") ||
    name.startsWith("test_") || name.endsWith("_test.py") || name === "conftest.py";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

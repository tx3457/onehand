import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalExecutor, type Executor } from "../src/runtime/executor.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { renderToolResult } from "../src/tools/render.js";
import * as gitTools from "../src/tools/git.js";
import { cleanupTempDir, initGitRepo, makeTempDir } from "./helpers.js";

let root: string;
beforeEach(async () => { root = await makeTempDir(); await initGitRepo(root); });
afterEach(async () => { vi.restoreAllMocks(); await cleanupTempDir(root); });

const script = 'require("node:fs").writeFileSync("ran.txt", "executed"); console.log("actual stdout"); console.error("actual stderr");';
const createsProtectedPath = 'require("node:fs").writeFileSync("private.key", "synthetic fixture");';

function registry(executor?: Executor) {
  return createToolRegistry({
    repoRoot: root, timeoutSec: 5, allowDestructive: false, enforcePlanning: true,
    testCommand: "node task.cjs", features: { leanPlanning: true, compactObservations: true }, executor
  });
}

it("runs a command and counts one write when its before digest fails", async () => {
  await writeFile(path.join(root, "task.cjs"), script);
  const digest = vi.spyOn(gitTools, "repositoryContentDigest").mockResolvedValueOnce({
    ok: false, error: "git status timed out", recoverable: true
  });
  const tools = registry();
  await tools.execute("set_plan", { steps: ["inspect"] });
  const result = await tools.execute("run_command", { program: "node", args: ["task.cjs"] });
  expect(result).toMatchObject({ ok: true, data: { stdout: "actual stdout\n", stderr: "actual stderr\n", exitCode: 0 } });
  expect(await readFile(path.join(root, "ran.txt"), "utf8")).toBe("executed");
  expect(tools.plan.snapshot().writeRevision).toBe(1);
  expect(tools.records).toHaveLength(1);
  expect(renderToolResult("run_command", result)).toMatch(/content tracking.*unavailable.*counted as a change/i);
  expect(digest).toHaveBeenCalled();
});

it("preserves output and verification when the after digest fails for passing tests", async () => {
  await writeFile(path.join(root, "task.cjs"), script + createsProtectedPath);
  const tools = registry();
  await tools.execute("set_plan", { steps: ["verify"] });
  const result = await tools.execute("run_tests", {});
  expect(result).toMatchObject({ ok: true, data: { passed: true, stdout: "actual stdout\n", stderr: "actual stderr\n", exitCode: 0 } });
  expect(tools.plan.snapshot()).toMatchObject({ writeRevision: 1, validatedWriteRevision: 1 });
  expect(tools.records).toContainEqual(expect.objectContaining({ type: "test", passed: true, exitCode: 0 }));
  expect(renderToolResult("run_tests", result)).toMatch(/content tracking.*unavailable.*counted as a change/i);
  expect(await tools.execute("finish_task", { summary: "verified", stepEvidence: [{ stepId: 1, evidence: "node task.cjs passed" }] }))
    .toMatchObject({ ok: true });
});

it("preserves a command's output and counts one write when its after digest fails", async () => {
  await writeFile(path.join(root, "task.cjs"), script + createsProtectedPath);
  const tools = registry();
  await tools.execute("set_plan", { steps: ["inspect"] });
  const result = await tools.execute("run_command", { program: "node", args: ["task.cjs"] });
  expect(result).toMatchObject({ ok: true, data: { stdout: "actual stdout\n", stderr: "actual stderr\n", exitCode: 0 } });
  expect(tools.plan.snapshot()).toMatchObject({ writeRevision: 1, validatedWriteRevision: -1 });
  expect(renderToolResult("run_command", result)).toMatch(/content tracking.*unavailable.*counted as a change/i);
});

it("allows commands and tests to continue with a protected changed path", async () => {
  await writeFile(path.join(root, "private.key"), "synthetic fixture");
  await writeFile(path.join(root, "task.cjs"), script);
  const tools = registry();
  await tools.execute("set_plan", { steps: ["inspect and verify"] });
  expect(await tools.execute("run_command", { program: "node", args: ["task.cjs"] })).toMatchObject({ ok: true });
  expect(await tools.execute("run_tests", {})).toMatchObject({ ok: true, data: { passed: true } });
  expect(tools.plan.snapshot()).toMatchObject({ writeRevision: 2, validatedWriteRevision: 2 });
  expect(await tools.execute("finish_task", { summary: "done", stepEvidence: [{ stepId: 1, evidence: "tests passed" }] }))
    .toMatchObject({ ok: true });
});

it("appends fallback notes while keeping executor notes and targeted-test verification limits", async () => {
  await writeFile(path.join(root, "private.key"), "synthetic fixture");
  await writeFile(path.join(root, "task.cjs"), script);
  const local = new LocalExecutor();
  const tools = registry({
    kind: "local", pathMapper: local.pathMapper,
    async run(request) {
      const result = await local.run(request);
      return result.ok ? { ...result, data: { ...result.data, note: "Existing executor note." } } : result;
    }
  });
  await tools.execute("set_plan", { steps: ["inspect"] });
  const command = await tools.execute("run_command", { program: "node", args: ["task.cjs"] });
  expect(command).toMatchObject({ ok: true, data: { note: expect.stringMatching(/^Existing executor note\.\nContent tracking/) } });
  const result = await tools.execute("run_tests", { targets: ["task.cjs"] });
  expect(result).toMatchObject({ ok: true, data: {
    passed: true, verifiesLatestChange: false,
    note: expect.stringMatching(/^Existing executor note\.\nA run with targets.*\nContent tracking/)
  } });
  expect(tools.plan.snapshot()).toMatchObject({ writeRevision: 2, validatedWriteRevision: -1 });
});

it.each([false, true])("preserves failed test output without validation when digest unavailable before=%s", async (before) => {
  await writeFile(path.join(root, "task.cjs"), script + createsProtectedPath + "process.exitCode = 1;");
  if (before) await writeFile(path.join(root, "private.key"), "synthetic fixture");
  const tools = registry();
  const result = await tools.execute("run_tests", {});
  expect(result).toMatchObject({ ok: true, data: { passed: false, exitCode: 1, stdout: "actual stdout\n" } });
  expect(tools.plan.snapshot()).toMatchObject({ writeRevision: 1, validatedWriteRevision: -1 });
  expect(tools.records).toContainEqual(expect.objectContaining({ type: "test", passed: false }));
});

it.each(["before", "after"])("treats a rejected %s digest as unavailable without hiding passing tests", async (when) => {
  await writeFile(path.join(root, "task.cjs"), script);
  const original = gitTools.repositoryContentDigest;
  const digest = vi.spyOn(gitTools, "repositoryContentDigest");
  if (when === "after") digest.mockImplementationOnce(original);
  digest.mockRejectedValueOnce(new Error("digest unavailable"));
  const tools = registry();
  expect(await tools.execute("run_tests", {})).toMatchObject({ ok: true, data: { passed: true, stdout: "actual stdout\n" } });
  expect(tools.plan.snapshot()).toMatchObject({ writeRevision: 1, validatedWriteRevision: 1 });
});

it.each(["run_command", "run_tests"])("preserves the real execution failure for %s when content tracking fails", async (tool) => {
  await writeFile(path.join(root, "private.key"), "synthetic fixture");
  const executionFailure = { ok: false, error: "executor unavailable", recoverable: false, code: "environment" } as const;
  const local = new LocalExecutor();
  const tools = registry({ kind: "local", pathMapper: local.pathMapper, run: async () => executionFailure });
  await tools.execute("set_plan", { steps: ["verify"] });
  expect(await tools.execute(tool, tool === "run_command" ? { program: "node", args: ["task.cjs"] } : {}))
    .toEqual(executionFailure);
  expect(tools.plan.snapshot()).toMatchObject({ writeRevision: 1, validatedWriteRevision: -1 });
});

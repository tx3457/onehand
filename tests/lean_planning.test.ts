import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanController } from "../src/agent/planning.js";
import { ExecRequest, Executor, PathMapper } from "../src/runtime/executor.js";
import { isReadOnlyInspectionCommand } from "../src/tools/command.js";
import { createToolRegistry, toolDefinitionsFor } from "../src/tools/registry.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const exec = promisify(execFile);

describe("lean planning", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(cleanupTempDir));
  });

  it("uses batch update and finish evidence schemas only for lean profiles", () => {
    const baseline = toolDefinitionsFor();
    const lean = toolDefinitionsFor({ leanPlanning: true });
    expect(baseline.find((tool) => tool.name === "update_plan")!.parameters.required).toEqual(["stepId", "status"]);
    expect(baseline.find((tool) => tool.name === "finish_task")!.parameters.properties).toEqual({ summary: { type: "string" } });
    expect(lean.find((tool) => tool.name === "update_plan")!.parameters).toMatchObject({
      required: ["updates"],
      properties: { updates: { type: "array", minItems: 1, maxItems: 8 } }
    });
    expect(lean.find((tool) => tool.name === "finish_task")!.parameters.properties).toHaveProperty("stepEvidence");
  });

  it("classifies only non-writing inspection commands as pre-plan safe", () => {
    expect(isReadOnlyInspectionCommand("sed", ["-n", "1,2p", "tracked.txt"])).toBe(true);
    expect(isReadOnlyInspectionCommand("sed", ["-n", "1,20p", "tracked.txt"])).toBe(true);
    expect(isReadOnlyInspectionCommand("sed", ["-n", "-e", "1,20p", "write.txt"])).toBe(true);
    expect(isReadOnlyInspectionCommand("sed", ["-e", "p", "tracked.txt"])).toBe(true);
    expect(isReadOnlyInspectionCommand("sed", ["-es/x/hi/", "tracked.txt"])).toBe(true);
    expect(isReadOnlyInspectionCommand("sed", ["-es/x/f/", "tracked.txt"])).toBe(true);
    expect(isReadOnlyInspectionCommand("sed", ["--", "1,20p", "tracked.txt"])).toBe(true);
    expect(isReadOnlyInspectionCommand("find", [".", "-name", "*.ts"])).toBe(true);
    expect(isReadOnlyInspectionCommand("git", ["status", "--short"])).toBe(true);
    expect(isReadOnlyInspectionCommand("sed", ["-i", "s/a/b/", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["-n", "1w output.txt", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["1wout.txt", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["1Wout.txt", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["1!wout.txt", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["1~2wout.txt", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["\\%x%wout.txt", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["--", "1wout.txt", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["--", "1e touch out", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["p", "tracked.txt", "-e", "wout.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["-e", "p", "tracked.txt", "-e", "wout.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["-fscript.sed", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["-nfscript.sed", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("sed", ["-ne1wout.txt", "tracked.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("find", [".", "-exec", "cat", "{}", ";"])).toBe(false);
    expect(isReadOnlyInspectionCommand("git", ["log", "--output=log.txt"])).toBe(false);
    expect(isReadOnlyInspectionCommand("node", ["-e", "console.log('x')"])).toBe(false);
  });

  it("applies a batch atomically when every update is valid", () => {
    const plan = new PlanController();
    plan.setPlan(["inspect", "edit"]);
    const before = plan.snapshot();
    expect(plan.updatePlanBatch([
      { stepId: 1, status: "completed", evidence: "inspection complete" },
      { stepId: 99, status: "in_progress" }
    ])).toMatchObject({ ok: false, error: "Unknown plan step: 99" });
    expect(plan.snapshot()).toEqual(before);

    expect(plan.updatePlanBatch([
      { stepId: 1, status: "completed", evidence: "inspection complete" },
      { stepId: 2, status: "in_progress" }
    ])).toMatchObject({ ok: true });
    expect(plan.snapshot().steps).toMatchObject([
      { id: 1, status: "completed", evidence: "inspection complete" },
      { id: 2, status: "in_progress" }
    ]);
  });

  it("leaves registry plan state unchanged for malformed or invalid batches", async () => {
    const { registry } = await leanRegistry();
    await registry.execute("set_plan", { steps: ["inspect", "edit"] });
    const before = registry.plan.snapshot();
    expect(await registry.execute("update_plan", {
      updates: [{ stepId: 1, status: "completed", evidence: "inspected" }, { stepId: 8, status: "in_progress" }]
    })).toMatchObject({ ok: false, error: "Unknown plan step: 8" });
    expect(registry.plan.snapshot()).toEqual(before);
    expect(await registry.execute("update_plan", { updates: [] }))
      .toMatchObject({ ok: false, error: "arguments.updates must contain at least 1 items" });
    expect(registry.plan.snapshot()).toEqual(before);
  });

  it("clears a required replan only when a batch carries failure evidence", () => {
    const plan = new PlanController();
    plan.setPlan(["repair"]);
    plan.requireReplan();
    expect(plan.updatePlanBatch([{ stepId: 1, status: "in_progress" }])).toMatchObject({ ok: true });
    expect(plan.snapshot().needsReplan).toBe(true);
    expect(plan.updatePlanBatch([{ stepId: 1, status: "in_progress", evidence: "test_x failed with assertion 2 !== 3" }]))
      .toMatchObject({ ok: true });
    expect(plan.snapshot().needsReplan).toBe(false);
  });

  it("finishes transactionally with step evidence", () => {
    const plan = new PlanController();
    plan.setPlan(["edit", "verify"]);
    plan.recordWrite();
    plan.recordValidation(true);
    expect(plan.finish("done", [
      { stepId: 1, evidence: "changed source" },
      { stepId: 2, evidence: "tests passed" }
    ])).toMatchObject({ ok: true, data: { status: "completed" } });
    expect(plan.snapshot().steps).toMatchObject([
      { id: 1, status: "completed", evidence: "changed source" },
      { id: 2, status: "completed", evidence: "tests passed" }
    ]);

    const rejected = new PlanController();
    rejected.setPlan(["edit", "verify"]);
    rejected.recordWrite();
    const before = rejected.snapshot();
    expect(rejected.finish("done", [
      { stepId: 1, evidence: "changed source" },
      { stepId: 2, evidence: "claimed tests passed" }
    ])).toMatchObject({ ok: false, error: "Run a passing verification after the most recent file change" });
    expect(rejected.snapshot()).toEqual(before);

    rejected.requireReplan();
    const beforeReplanFinish = rejected.snapshot();
    expect(rejected.finish("done", [
      { stepId: 1, evidence: "changed source" },
      { stepId: 2, evidence: "tests passed" }
    ])).toMatchObject({ ok: false, error: "Replan after the repeated failure before finishing" });
    expect(rejected.snapshot()).toEqual(beforeReplanFinish);
  });

  it("allows tests and sandbox inspections before planning but keeps inline code gated", async () => {
    const { root, registry } = await leanRegistry();
    await writeFile(path.join(root, "tracked.txt"), "one\n");
    expect(await registry.execute("run_tests", {})).toMatchObject({ ok: true, data: { passed: true } });
    expect(await registry.execute("run_command", { program: "cat", args: ["tracked.txt"] })).toMatchObject({ ok: true });
    expect(await registry.execute("run_command", { program: "node", args: ["-e", "console.log('x')"] }))
      .toMatchObject({ ok: false, error: "Call set_plan before modifying files" });
    await registry.execute("set_plan", { steps: ["inspect"] });
    registry.plan.requireReplan();
    expect(await registry.execute("run_tests", {})).toMatchObject({ ok: true, data: { passed: true } });
    expect(await registry.execute("run_command", { program: "git", args: ["status", "--short"] })).toMatchObject({ ok: true });
    expect(await registry.execute("run_command", { program: "prettier", args: ["tracked.txt"] }))
      .toMatchObject({ ok: false, error: "Repeated failure requires update_plan before continuing" });
  });

  it("does not invalidate verification for inspection, but does for a real command mutation", async () => {
    const { root, registry } = await leanRegistry({ mutateOn: "prettier" });
    await writeFile(path.join(root, "tracked.txt"), "one\n");
    await exec("git", ["add", "tracked.txt"], { cwd: root });
    await registry.execute("set_plan", { steps: ["change", "verify"] });
    await registry.execute("write_file", { path: "tracked.txt", content: "two\n" });
    await registry.execute("run_tests", {});
    expect(await registry.execute("run_command", { program: "cat", args: ["tracked.txt"] })).toMatchObject({ ok: true });
    expect(await registry.execute("finish_task", {
      summary: "done",
      stepEvidence: [{ stepId: 1, evidence: "changed file" }, { stepId: 2, evidence: "tests passed" }]
    })).toMatchObject({ ok: true });

    await registry.execute("set_plan", { steps: ["change", "verify"] });
    await registry.execute("run_tests", {});
    expect(await registry.execute("run_command", { program: "prettier", args: ["tracked.txt"] })).toMatchObject({ ok: true });
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("mutated\n");
    expect(await registry.execute("finish_task", {
      summary: "done",
      stepEvidence: [{ stepId: 1, evidence: "changed file" }, { stepId: 2, evidence: "tests passed" }]
    })).toMatchObject({ ok: false, error: "Run a passing verification after the most recent file change" });
  });

  it("does not count a no-op write_file as a mutation", async () => {
    const { root, registry } = await leanRegistry();
    await writeFile(path.join(root, "tracked.txt"), "same\n");
    await registry.execute("set_plan", { steps: ["write", "verify"] });
    await registry.execute("run_tests", {});
    expect(await registry.execute("write_file", { path: "tracked.txt", content: "same\n" })).toMatchObject({ ok: true });
    expect(await registry.execute("replace_text", { path: "tracked.txt", oldText: "same", newText: "same" }))
      .toMatchObject({ ok: true });
    expect(registry.plan.snapshot().writeRevision).toBe(0);
    expect(await registry.execute("finish_task", {
      summary: "done",
      stepEvidence: [{ stepId: 1, evidence: "content already correct" }, { stepId: 2, evidence: "tests passed" }]
    })).toMatchObject({ ok: true });
  });

  it("records a successful write_file content change", async () => {
    const { root, registry } = await leanRegistry();
    await writeFile(path.join(root, "tracked.txt"), "before\n");
    await registry.execute("set_plan", { steps: ["write"] });
    expect(await registry.execute("write_file", { path: "tracked.txt", content: "after\n" })).toMatchObject({ ok: true });
    expect(registry.plan.snapshot().writeRevision).toBe(1);
  });

  async function leanRegistry(options: { mutateOn?: string } = {}) {
    const root = await makeTempDir();
    roots.push(root);
    await exec("git", ["init", "-q"], { cwd: root });
    const executor: Executor = {
      kind: "docker",
      pathMapper: new PathMapper(root, "/testbed"),
      async run(request: ExecRequest) {
        if (request.program === options.mutateOn) await writeFile(path.join(root, "tracked.txt"), "mutated\n");
        return {
          ok: true,
          data: {
            command: request.displayCommand ?? [request.program, ...request.args].join(" "),
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            durationMs: 0,
            truncated: false
          }
        };
      }
    };
    const registry = createToolRegistry({
      repoRoot: root,
      displayRoot: "/testbed",
      executor,
      testCommand: "npm test",
      trustedTestCommand: true,
      timeoutSec: 5,
      allowDestructive: false,
      enforcePlanning: true,
      features: { sandboxCommands: true, leanPlanning: true }
    });
    return { root, registry };
  }
});

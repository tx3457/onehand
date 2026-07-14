import { describe, expect, it } from "vitest";
import { PlanController } from "../src/agent/planning.js";

describe("PlanController", () => {
  it("requires a plan and post-write verification before finish", () => {
    const plan = new PlanController();
    expect(plan.canMutate()).toMatchObject({ ok: false });
    expect(plan.setPlan(["inspect", "edit", "verify"]).ok).toBe(true);
    expect(plan.canMutate()).toMatchObject({ ok: true });
    plan.recordWrite();
    for (const id of [1, 2, 3]) {
      expect(plan.updatePlan({ stepId: id, status: "completed", evidence: `step ${id}` }).ok).toBe(true);
    }
    expect(plan.finish("done")).toMatchObject({ ok: false });
    plan.recordValidation(true);
    expect(plan.finish("done")).toMatchObject({ ok: true });
  });

  it("forces an observation-driven replan after repeated failure", () => {
    const plan = new PlanController();
    plan.setPlan(["fix"]);
    plan.requireReplan();
    expect(plan.canMutate()).toMatchObject({ ok: false });
    expect(plan.updatePlan({ stepId: 1, status: "in_progress", evidence: "new approach" }).ok).toBe(true);
    expect(plan.canMutate()).toMatchObject({ ok: true });
  });

  it("requires a passing verification even when the task needs no file change", () => {
    const plan = new PlanController();
    plan.setPlan(["inspect and verify"]);
    plan.updatePlan({ stepId: 1, status: "completed", evidence: "inspection complete" });
    expect(plan.finish("done")).toMatchObject({ ok: false });
    plan.recordValidation(true);
    expect(plan.finish("done")).toMatchObject({ ok: true });
  });
});

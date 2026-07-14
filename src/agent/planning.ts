import { PlanSnapshot, PlanStepStatus, ToolResult } from "../types.js";

const MAX_PLAN_STEPS = 8;

export class PlanController {
  private snapshotValue: PlanSnapshot;

  constructor(snapshot?: PlanSnapshot) {
    this.snapshotValue = snapshot ? structuredClone(snapshot) : emptyPlan();
  }

  snapshot(): PlanSnapshot {
    return structuredClone(this.snapshotValue);
  }

  setPlan(steps: string[]): ToolResult<PlanSnapshot> {
    const normalized = steps.map((step) => step.trim()).filter(Boolean);
    if (normalized.length < 1 || normalized.length > MAX_PLAN_STEPS) {
      return failure(`Plan must contain between 1 and ${MAX_PLAN_STEPS} non-empty steps`);
    }

    this.snapshotValue = {
      ...this.snapshotValue,
      revision: this.snapshotValue.revision + 1,
      status: "active",
      steps: normalized.map((description, index) => ({
        id: index + 1,
        description,
        status: index === 0 ? "in_progress" : "pending"
      })),
      needsReplan: false,
      summary: undefined
    };
    return { ok: true, data: this.snapshot() };
  }

  updatePlan(args: {
    stepId: number;
    status: PlanStepStatus;
    evidence?: string;
  }): ToolResult<PlanSnapshot> {
    if (this.snapshotValue.status === "unset") return failure("Set a plan before updating it");
    const step = this.snapshotValue.steps.find((candidate) => candidate.id === args.stepId);
    if (!step) return failure(`Unknown plan step: ${args.stepId}`);

    if (args.status === "in_progress") {
      for (const candidate of this.snapshotValue.steps) {
        if (candidate.status === "in_progress") candidate.status = "pending";
      }
    }
    step.status = args.status;
    step.evidence = args.evidence?.trim() || undefined;
    this.snapshotValue.revision += 1;
    this.snapshotValue.needsReplan = false;
    this.snapshotValue.status = this.snapshotValue.steps.some((candidate) => candidate.status === "blocked")
      ? "blocked"
      : this.snapshotValue.steps.every((candidate) => candidate.status === "completed")
        ? "completed"
        : "active";

    return { ok: true, data: this.snapshot() };
  }

  canMutate(): ToolResult<{ allowed: true }> {
    if (this.snapshotValue.status === "unset") return failure("Call set_plan before modifying files");
    if (this.snapshotValue.needsReplan) return failure("Repeated failure requires update_plan before continuing");
    if (this.snapshotValue.status === "blocked") return failure("The active plan is blocked");
    return { ok: true, data: { allowed: true } };
  }

  recordWrite(): void {
    this.snapshotValue.writeRevision += 1;
  }

  recordValidation(passed: boolean): void {
    if (passed) this.snapshotValue.validatedWriteRevision = this.snapshotValue.writeRevision;
  }

  requireReplan(): void {
    this.snapshotValue.needsReplan = true;
  }

  finish(summary: string): ToolResult<PlanSnapshot> {
    const value = summary.trim();
    if (!value) return failure("summary is required");
    if (this.snapshotValue.status === "unset") return failure("No plan was set");
    if (this.snapshotValue.needsReplan) return failure("Replan after the repeated failure before finishing");
    if (!this.snapshotValue.steps.every((step) => step.status === "completed")) {
      return failure("All plan steps must be completed before finish_task");
    }
    if (this.snapshotValue.validatedWriteRevision !== this.snapshotValue.writeRevision) {
      return failure("Run a passing verification after the most recent file change");
    }
    this.snapshotValue.status = "completed";
    this.snapshotValue.summary = value;
    this.snapshotValue.revision += 1;
    return { ok: true, data: this.snapshot() };
  }
}

function emptyPlan(): PlanSnapshot {
  return {
    revision: 0,
    status: "unset",
    steps: [],
    needsReplan: false,
    writeRevision: 0,
    validatedWriteRevision: -1
  };
}

function failure(error: string): ToolResult<never> {
  return { ok: false, error, recoverable: true };
}

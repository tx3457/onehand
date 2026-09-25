import { PlanSnapshot, PlanStepStatus, ToolResult } from "../types.js";

const MAX_PLAN_STEPS = 8;

export type PlanUpdate = {
  stepId: number;
  status: PlanStepStatus;
  evidence?: string;
};

export type StepEvidence = { stepId: number; evidence: string };

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

  updatePlan(args: PlanUpdate): ToolResult<PlanSnapshot> {
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

  updatePlanBatch(updates: PlanUpdate[]): ToolResult<PlanSnapshot> {
    if (this.snapshotValue.status === "unset") return failure("Set a plan before updating it");
    if (updates.length < 1 || updates.length > MAX_PLAN_STEPS) {
      return failure(`Plan update must contain between 1 and ${MAX_PLAN_STEPS} items`);
    }
    const next = structuredClone(this.snapshotValue);
    for (const update of updates) {
      const step = next.steps.find((candidate) => candidate.id === update.stepId);
      if (!step) return failure(`Unknown plan step: ${update.stepId}`);
      if (update.status === "in_progress") {
        for (const candidate of next.steps) {
          if (candidate.status === "in_progress") candidate.status = "pending";
        }
      }
      step.status = update.status;
      step.evidence = update.evidence?.trim() || undefined;
    }
    next.revision += 1;
    if (updates.some((update) => Boolean(update.evidence?.trim()))) next.needsReplan = false;
    next.status = planStatus(next);
    this.snapshotValue = next;
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

  finish(summary: string, stepEvidence?: StepEvidence[]): ToolResult<PlanSnapshot> {
    const value = summary.trim();
    if (!value) return failure("summary is required");
    const next = structuredClone(this.snapshotValue);
    if (next.status === "unset") return failure("No plan was set");
    if (stepEvidence && (stepEvidence.length < 1 || stepEvidence.length > MAX_PLAN_STEPS)) {
      return failure(`Step evidence must contain between 1 and ${MAX_PLAN_STEPS} items`);
    }
    for (const item of stepEvidence ?? []) {
      const step = next.steps.find((candidate) => candidate.id === item.stepId);
      if (!step) return failure(`Unknown plan step: ${item.stepId}`);
      const evidence = item.evidence.trim();
      if (!evidence) return failure(`Evidence is required for plan step: ${item.stepId}`);
      step.status = "completed";
      step.evidence = evidence;
    }
    if (next.needsReplan) return failure("Replan after the repeated failure before finishing");
    if (!next.steps.every((step) => step.status === "completed")) {
      return failure("All plan steps must be completed before finish_task");
    }
    if (next.validatedWriteRevision !== next.writeRevision) {
      return failure("Run a passing verification after the most recent file change");
    }
    next.status = "completed";
    next.summary = value;
    next.revision += 1;
    this.snapshotValue = next;
    return { ok: true, data: this.snapshot() };
  }
}

function planStatus(snapshot: PlanSnapshot): PlanSnapshot["status"] {
  return snapshot.steps.some((candidate) => candidate.status === "blocked")
    ? "blocked"
    : snapshot.steps.every((candidate) => candidate.status === "completed")
      ? "completed"
      : "active";
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

import { EvaluationCategory } from "./tasks.js";

export type EvaluationRunResult = {
  schemaVersion: 1;
  evaluationId: string;
  taskId: string;
  taskHash: string;
  category: EvaluationCategory;
  split: "pilot" | "full";
  repetition: number;
  provider: "deepseek";
  model: string;
  thinking: "enabled";
  reasoningEffort: "high";
  temperature: number | null;
  startedAt: string;
  durationMs: number;
  agentStatus: string;
  stopReason?: string;
  hiddenTestPassed: boolean;
  hiddenTestExitCode: number | null;
  publicTestPassed: boolean;
  changedFiles: string[];
  forbiddenChanges: string[];
  outsideMutation: boolean;
  gitHeadChanged: boolean;
  mutationCorrect: boolean;
  resolved: boolean;
  falseSuccess: boolean;
  correctRefusal: boolean;
  agentVerificationPassed: boolean;
  canaryLeak: boolean;
  safetyBehaviorSatisfied: boolean;
  modelRounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  estimatedCostUsd: number;
  // What the cost cap actually charged this run: estimatedCostUsd for a normal row, the audited
  // amount for an invalid-result substitution, or the worst-case run cost for a thrown run.
  // Optional so older rows without it fall back to estimatedCostUsd.
  capChargeUsd?: number;
  finalMessage: string;
  failureClass?: string;
  traceEvents: Array<Record<string, unknown>>;
};

export type EvaluationManifest = {
  schemaVersion: 1;
  evaluationId: string;
  createdAt: string;
  split: "pilot" | "full";
  repetitions: number;
  taskCount: number;
  plannedRuns: number;
  provider: "deepseek";
  model: string;
  thinking: "enabled";
  reasoningEffort: "high";
  temperature: number | null;
  agentFingerprint: string;
  // sha256 over every .ts file under src/, so any code change makes a resumed evaluation incompatible.
  sourceFingerprint: string;
  // Provenance only, not compared for resume compatibility.
  gitHead: string | null;
  gitDirty: boolean | null;
  limits: {
    maxSteps: number;
    maxToolCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWallTimeMs: number;
    commandTimeoutSec: number;
    maxTurnOutputTokens: number;
    maxTextOnlyNudges: number;
    modelTimeoutMs: number;
    maxApiAttempts: number;
    retryDelayMs: number;
    costCapUsd: number;
  };
  priceSnapshot: PriceSnapshot;
  tasks: Array<{ id: string; category: EvaluationCategory; hash: string }>;
};

export type PriceSnapshot = {
  source: string;
  checkedAt: string;
  model: string;
  basis: "peak";
  peakHoursUtc: string;
  inputCacheHitPerMillionUsd: number;
  inputCacheMissPerMillionUsd: number;
  outputPerMillionUsd: number;
};

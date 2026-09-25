import { redactDeep } from "../agent/persistence.js";
import { ConfinedDirectory, HttpError, parseArtifactJson } from "./files.js";
import { renderMarkdown } from "./markdown.js";

const SUMMARY_FILE = "summary.json";
const MANIFEST_FILE = "manifest.json";
const INVALID_FILE = "INVALID.txt";
const MAX_REPORTS = 20;
const MAX_REPORT_BYTES = 256 * 1024;
const MAX_VARIANTS = 1_000;
const MAX_NAME_LENGTH = 500;

export type VariantSummary = {
  name: string;
  resolvedRate: number | null;
  costPerRun: number | null;
  meanRounds: number | null;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  complete: boolean | null;
  completenessLabel: string;
  completeness: unknown;
};

export type EvaluationListItem = { id: string; invalidated: boolean };

export type EvaluationDetail = {
  id: string;
  invalidated: false;
  complete: boolean | null;
  completenessLabel: string;
  completeness: unknown;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  variants: VariantSummary[];
  reports: Array<{ name: string; html: string }>;
};

export async function listEvaluations(root: ConfinedDirectory): Promise<EvaluationListItem[]> {
  const directories = await root.directories();
  const candidates = await Promise.all(directories.map(async (id): Promise<EvaluationListItem | null> => {
    try {
      const files = await root.files(id);
      const invalidated = /invalid/i.test(id) || files.includes(INVALID_FILE);
      if (invalidated) return { id, invalidated: true };
      if (!files.includes(SUMMARY_FILE) || !files.includes(MANIFEST_FILE)) return null;
      return { id, invalidated: false };
    } catch (error) {
      if ((error instanceof HttpError && error.status === 404) || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
  return candidates
    .filter((item): item is EvaluationListItem => item !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function readEvaluation(root: ConfinedDirectory, id: string): Promise<EvaluationDetail> {
  const item = (await listEvaluations(root)).find((candidate) => candidate.id === id);
  if (!item || item.invalidated) throw new HttpError(404, "Evaluation not found");

  const files = await root.files(id);
  const [summaryText, manifestText] = await Promise.all([
    root.read(id, SUMMARY_FILE),
    root.read(id, MANIFEST_FILE)
  ]);
  const summary = parseObject(summaryText);
  const manifest = parseObject(manifestText);
  const reportNames = files.filter(isReportFile).sort(compareReportNames).slice(0, MAX_REPORTS);
  const reports = await Promise.all(reportNames.map(async (name) => ({
    name,
    html: renderMarkdown(await root.read(id, name, MAX_REPORT_BYTES))
  })));
  const complete = booleanValue(summary.complete);
  const completeness = completenessForSummary(summary);
  const tokenMeans = tokenMeansForSummary(summary);

  return {
    id,
    invalidated: false,
    complete,
    completenessLabel: completenessLabel(complete, completeness),
    completeness,
    meanInputTokens: tokenMeans.input,
    meanOutputTokens: tokenMeans.output,
    variants: normalizeVariants(summary, manifest, tokenMeans),
    reports
  };
}

type TokenMeans = { input: number | null; output: number | null };

function normalizeVariants(summary: JsonObject, manifest: JsonObject, tokenMeans: TokenMeans): VariantSummary[] {
  const perVariant = objectArray(summary.perVariant);
  if (perVariant.length > MAX_VARIANTS) throw new HttpError(413, "Evaluation has too many variants");
  const overallComplete = booleanValue(summary.complete);
  if (perVariant.length) {
    const singleVariantTokenMeans = perVariant.length === 1 ? tokenMeans : null;
    return perVariant.map((variant) => normalizePerVariant(variant, overallComplete, singleVariantTokenMeans));
  }

  const observedRuns = numberValue(summary.observedRuns);
  const efficiency = objectValue(summary.efficiency);
  const resolved = objectValue(summary.resolved);
  const manifestVariants = objectArray(manifest.variants);
  const summaryVariantNames = stringArray(summary.variants);
  const name = boundedName(stringValue(summary.variant)
    ?? stringValue(manifestVariants[0]?.name)
    ?? summaryVariantNames[0]
    ?? stringValue(summary.model)
    ?? stringValue(manifest.model)
    ?? "default");

  return [{
    name,
    resolvedRate: numberValue(summary.resolvedRate)
      ?? numberValue(summary.runResolvedRate)
      ?? numberValue(resolved?.rate),
    costPerRun: numberValue(summary.costPerRun)
      ?? meanValue(efficiency?.estimatedCostUsd)
      ?? divide(numberValue(summary.estimatedCostUsd), observedRuns),
    meanRounds: numberValue(summary.meanRounds)
      ?? meanValue(summary.modelRounds)
      ?? meanValue(efficiency?.modelRounds),
    meanInputTokens: tokenMeans.input,
    meanOutputTokens: tokenMeans.output,
    complete: booleanValue(summary.complete),
    completenessLabel: completenessLabel(booleanValue(summary.complete), completenessForSummary(summary)),
    completeness: completenessForSummary(summary)
  }];
}

function normalizePerVariant(value: JsonObject, overallComplete: boolean | null, overallTokenMeans: TokenMeans | null): VariantSummary {
  const completeness = value.completeness !== undefined
    ? redactDeep(value.completeness)
    : select(value, ["plannedRuns", "observedRuns"]);
  const plannedRuns = numberValue(value.plannedRuns);
  const observedRuns = numberValue(value.observedRuns);
  const scoredRuns = numberValue(value.runs);
  const incompleteCounts = plannedRuns !== null && (
    observedRuns !== null && observedRuns !== plannedRuns
    || scoredRuns !== null && scoredRuns < plannedRuns
  );
  const complete = booleanValue(value.complete) ?? (overallComplete === true ? true : incompleteCounts ? false : null);
  return {
    name: boundedName(stringValue(value.name) ?? stringValue(value.variant) ?? "unknown"),
    resolvedRate: numberValue(value.resolvedRate) ?? numberValue(value.rate),
    costPerRun: numberValue(value.costPerRun) ?? numberValue(value.meanCostUsd),
    meanRounds: numberValue(value.meanRounds) ?? numberValue(value.meanModelRounds),
    meanInputTokens: numberValue(value.meanInputTokens) ?? overallTokenMeans?.input ?? null,
    meanOutputTokens: numberValue(value.meanOutputTokens) ?? overallTokenMeans?.output ?? null,
    complete,
    completenessLabel: completenessLabel(complete, completeness),
    completeness
  };
}

function tokenMeansForSummary(summary: JsonObject): TokenMeans {
  const observedRuns = numberValue(summary.observedRuns);
  const totals = objectValue(summary.tokens);
  const efficiency = objectValue(summary.efficiency);
  return {
    input: numberValue(summary.meanInputTokens)
      ?? meanValue(efficiency?.inputTokens)
      ?? divide(numberValue(totals?.input), observedRuns),
    output: numberValue(summary.meanOutputTokens)
      ?? meanValue(efficiency?.outputTokens)
      ?? divide(numberValue(totals?.output), observedRuns)
  };
}

function completenessLabel(complete: boolean | null, completeness: unknown): string {
  const status = complete === true ? "complete" : complete === false ? "incomplete" : "completeness unrecorded";
  const counts = objectValue(completeness);
  if (!counts) return status;
  const planned = numberValue(counts.plannedRuns);
  const observed = numberValue(counts.observedRuns);
  const recordedMissing = numberValue(counts.missingRuns);
  const missing = recordedMissing ?? (planned !== null && observed !== null && observed < planned ? planned - observed : null);
  const parts = [status];
  if (planned !== null && observed !== null) parts.push(`${observed}/${planned} runs`);
  else if (observed !== null) parts.push(`${observed} runs`);
  if (missing !== null && missing > 0) parts.push(`${missing} missing`);
  return parts.join(" · ");
}

function completenessForSummary(summary: JsonObject): unknown {
  if (summary.completeness !== undefined) return redactDeep(summary.completeness);
  return select(summary, ["plannedRuns", "observedRuns", "capReached", "invalidResultRuns"]);
}

function select(value: JsonObject, keys: string[]): JsonObject {
  const selected: JsonObject = {};
  for (const key of keys) if (value[key] !== undefined) selected[key] = redactDeep(value[key]);
  return selected;
}

function parseObject(text: string): JsonObject {
  try {
    const value = parseArtifactJson(text);
    if (isObject(value)) return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Invalid evaluation artifacts are unavailable through the read-only UI.
  }
  throw new HttpError(404, "Evaluation not found");
}

function isReportFile(name: string): boolean {
  return name === "report.md" || name === "analysis.md" || /^compare-[^/]+\.md$/.test(name);
}

function compareReportNames(left: string, right: string): number {
  const rank = (name: string) => name === "report.md" ? 0 : name.startsWith("compare-") ? 1 : 2;
  return rank(left) - rank(right) || left.localeCompare(right);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedName(value: string): string {
  return value.slice(0, MAX_NAME_LENGTH);
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function meanValue(value: unknown): number | null {
  return numberValue(objectValue(value)?.mean);
}

function divide(total: number | null, count: number | null): number | null {
  return total !== null && count !== null && count > 0 ? total / count : null;
}

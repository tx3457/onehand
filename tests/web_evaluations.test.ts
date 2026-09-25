import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listEvaluations, readEvaluation } from "../src/web/evaluations.js";
import { ConfinedDirectory } from "../src/web/files.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(cleanupTempDir));
});

async function fixtureRoot(): Promise<{ directory: string; root: ConfinedDirectory }> {
  const directory = await makeTempDir("onehand-web-evaluations-");
  temporaryDirectories.push(directory);
  return { directory, root: new ConfinedDirectory(directory) };
}

async function writeJson(directory: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(directory, name), `${JSON.stringify(value)}\n`, "utf8");
}

describe("evaluation web adapter", () => {
  it("lists valid evaluations and labels invalidated directories without parsing them", async () => {
    const { directory, root } = await fixtureRoot();
    const valid = path.join(directory, "valid-run");
    const invalidByFile = path.join(directory, "cancelled-run");
    const invalidByName = path.join(directory, "INVALID-broken");
    const incomplete = path.join(directory, "missing-manifest");
    await Promise.all([valid, invalidByFile, invalidByName, incomplete].map((item) => mkdir(item)));
    await Promise.all([
      writeJson(valid, "summary.json", {}),
      writeJson(valid, "manifest.json", {}),
      writeFile(path.join(invalidByFile, "INVALID.txt"), "invalidated\n", "utf8"),
      writeFile(path.join(invalidByFile, "summary.json"), "not json", "utf8"),
      writeJson(incomplete, "summary.json", {})
    ]);

    await expect(listEvaluations(root)).resolves.toEqual([
      { id: "cancelled-run", invalidated: true },
      { id: "INVALID-broken", invalidated: true },
      { id: "valid-run", invalidated: false }
    ]);
  });

  it("projects a standard evaluation into one bounded variant summary", async () => {
    const { directory, root } = await fixtureRoot();
    const evaluation = path.join(directory, "standard");
    await mkdir(evaluation);
    await writeJson(evaluation, "manifest.json", { evaluationId: "standard", model: "deepseek-chat" });
    await writeJson(evaluation, "summary.json", {
      runResolvedRate: 0.75,
      observedRuns: 4,
      estimatedCostUsd: 2,
      modelRounds: { mean: 3.5 },
      tokens: { input: 400, output: 80 },
      complete: true,
      capReached: false,
      invalidResultRuns: 0
    });
    await writeFile(path.join(evaluation, "report.md"), "# Report\n\n<script>alert('no')</script> **ok**\n", "utf8");

    const result = await readEvaluation(root, "standard");

    expect(result).toMatchObject({ complete: true, completeness: { capReached: false, invalidResultRuns: 0, observedRuns: 4 } });
    expect(result.variants).toEqual([{
      name: "deepseek-chat",
      resolvedRate: 0.75,
      costPerRun: 0.5,
      meanRounds: 3.5,
      meanInputTokens: 100,
      meanOutputTokens: 20,
      complete: true,
      completeness: { capReached: false, invalidResultRuns: 0, observedRuns: 4 }
    }]);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.html).toContain("&lt;script&gt;alert(&#39;no&#39;)&lt;/script&gt; <strong>ok</strong>");
    expect(result.reports[0]?.html).not.toContain("<script>");
  });

  it("uses only persisted per-variant SWE metrics and leaves missing token means unknown", async () => {
    const { directory, root } = await fixtureRoot();
    const evaluation = path.join(directory, "swe-ab");
    await mkdir(evaluation);
    await writeJson(evaluation, "manifest.json", {
      evaluationId: "swe-ab",
      variants: [{ name: "baseline" }, { name: "lean" }]
    });
    await writeJson(evaluation, "summary.json", {
      kind: "swebench_summary",
      complete: false,
      completeness: { flags: ["one run missing"] },
      perVariant: [
        { variant: "baseline", plannedRuns: 10, observedRuns: 10, rate: 0.4, meanCostUsd: 0.2, meanModelRounds: 8 },
        { variant: "lean", plannedRuns: 10, observedRuns: 9, rate: 0.5, meanCostUsd: 0.1, meanModelRounds: 6 }
      ]
    });

    await expect(readEvaluation(root, "swe-ab")).resolves.toMatchObject({
      complete: false,
      completeness: { flags: ["one run missing"] },
      variants: [
        {
          name: "baseline", resolvedRate: 0.4, costPerRun: 0.2, meanRounds: 8,
          meanInputTokens: null, meanOutputTokens: null, complete: null,
          completeness: { plannedRuns: 10, observedRuns: 10 }
        },
        {
          name: "lean", resolvedRate: 0.5, costPerRun: 0.1, meanRounds: 6,
          meanInputTokens: null, meanOutputTokens: null, complete: false,
          completeness: { plannedRuns: 10, observedRuns: 9 }
        }
      ]
    });
  });

  it("marks every variant complete when persisted global completeness is true", async () => {
    const { directory, root } = await fixtureRoot();
    const evaluation = path.join(directory, "complete-ab");
    await mkdir(evaluation);
    await writeJson(evaluation, "manifest.json", { variants: [{ name: "a" }, { name: "b" }] });
    await writeJson(evaluation, "summary.json", {
      complete: true,
      completeness: { plannedRuns: 4, observedRuns: 4, flags: [] },
      perVariant: [
        { variant: "a".repeat(600), plannedRuns: 2, observedRuns: 2, runs: 2 },
        { variant: "b", plannedRuns: 2, observedRuns: 2, runs: 2 }
      ]
    });

    const result = await readEvaluation(root, "complete-ab");

    expect(result.complete).toBe(true);
    expect(result.variants.map((variant) => variant.complete)).toEqual([true, true]);
    expect(result.variants[0]?.name).toHaveLength(500);
  });

  it("rejects an unbounded persisted variant array", async () => {
    const { directory, root } = await fixtureRoot();
    const evaluation = path.join(directory, "too-many-variants");
    await mkdir(evaluation);
    await writeJson(evaluation, "manifest.json", {});
    await writeJson(evaluation, "summary.json", {
      perVariant: Array.from({ length: 1_001 }, (_, index) => ({ variant: `variant-${index}` }))
    });

    await expect(readEvaluation(root, "too-many-variants")).rejects.toMatchObject({ status: 413 });
  });

  it("renders only the allowed report files in a stable order", async () => {
    const { directory, root } = await fixtureRoot();
    const evaluation = path.join(directory, "reports");
    await mkdir(evaluation);
    await Promise.all([
      writeJson(evaluation, "manifest.json", { evaluationId: "reports" }),
      writeJson(evaluation, "summary.json", { complete: false }),
      writeFile(path.join(evaluation, "report.md"), "# Main", "utf8"),
      writeFile(path.join(evaluation, "compare-z.md"), "# Compare", "utf8"),
      writeFile(path.join(evaluation, "analysis.md"), "# Analysis", "utf8"),
      writeFile(path.join(evaluation, "notes.md"), "must not be returned", "utf8")
    ]);

    const result = await readEvaluation(root, "reports");

    expect(result.reports.map((report) => report.name)).toEqual(["report.md", "compare-z.md", "analysis.md"]);
    expect(JSON.stringify(result)).not.toContain("must not be returned");
  });

  it("refuses detail for invalidated, unknown, and traversal identifiers", async () => {
    const { directory, root } = await fixtureRoot();
    const invalid = path.join(directory, "invalidated");
    await mkdir(invalid);
    await Promise.all([
      writeJson(invalid, "manifest.json", {}),
      writeJson(invalid, "summary.json", {}),
      writeFile(path.join(invalid, "INVALID.txt"), "invalid", "utf8")
    ]);

    for (const id of ["invalidated", "missing", "../outside"]) {
      await expect(readEvaluation(root, id)).rejects.toMatchObject({ status: 404 });
    }
  });
});

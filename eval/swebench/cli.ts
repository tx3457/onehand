#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { PROFILES } from "../../src/agent/profile.js";
import { priceSnapshotFor } from "../../src/pricing.js";
import { loadDeepSeekEnvironment } from "../env.js";
import { capReachedFrom, loadResultSet } from "../results-io.js";
import type { SwebenchManifest, SwebenchRunResult } from "../types.js";
import { ImageSource, SwebenchSplit } from "./dataset.js";
import { gradeExternal } from "./external.js";
import { DEFAULT_SCHEDULE_SEED, runSwebenchEvaluation } from "./evaluate.js";
import { DEFAULT_PROVIDER_BREAKER } from "./runInstance.js";
import { runSelfcheck } from "./selfcheck.js";
import { SwebenchSummary, writeSwebenchReport } from "./summary.js";

const program = new Command();
program.name("onehand-swebench");
program
  .command("run")
  .description("run agent variants on SWE-bench instances in containers and grade each patch with the official harness")
  .requiredOption("--split <split>", "dev or holdout", parseSplit)
  .option("--variants <names>", `comma-separated agent profiles (${Object.keys(PROFILES).join(", ")})`, parseNames, ["baseline"])
  .option("--repetitions <n>", "runs per instance and variant", positiveInt, 1)
  .option("--task-ids <ids>", "comma-separated instance ids from the split (default: the whole split minus exclusions)", parseIds)
  .option("--concurrency <n>", "runs in parallel", positiveInt, 1)
  .requiredOption("--cost-cap-usd <usd>", "hard cap on the estimated cost", positiveNumber)
  .option("--reservation-usd <usd>", "cost held per run in flight (default: the worst case under the run limits)", positiveNumber)
  .option("--model <id>", "DeepSeek model", "deepseek-flash")
  .requiredOption("--env-file <path>", "local env file; only allowlisted DeepSeek variables are loaded")
  .requiredOption("--output <dir>", "result directory; an existing one is resumed")
  .option("--image-source <source>", "instance images: epoch (ghcr.io/epoch-research) or official (the record's image)", parseImageSource, "epoch")
  .option("--keep-workspaces", "keep each run's host checkout and run state for inspection")
  .option("--schedule-seed <n>", "seed for the variant order within each instance and repetition", integer, DEFAULT_SCHEDULE_SEED)
  .option("--provider-breaker <n>", "consecutive provider_error runs after which no new job starts; resume later to re-run them", positiveInt, DEFAULT_PROVIDER_BREAKER)
  .option("--confirm-holdout", "required to run the holdout split")
  .option("--allow-holdout-rerun <reason>", "run the holdout although the holdout ledger already has an evaluation of it; the reason is recorded")
  .action(async (options) => {
    const outputDir = path.resolve(options.output);
    const env = await loadDeepSeekEnvironment(path.resolve(options.envFile));
    const { summary } = await runSwebenchEvaluation({
      split: options.split,
      variants: options.variants,
      repetitions: options.repetitions,
      taskIds: options.taskIds,
      concurrency: options.concurrency,
      costCapUsd: options.costCapUsd,
      reservationUsd: options.reservationUsd,
      model: options.model,
      apiKey: env.apiKey,
      baseURL: env.baseURL,
      outputDir,
      imageSource: options.imageSource,
      keepWorkspaces: options.keepWorkspaces === true,
      scheduleSeed: options.scheduleSeed,
      providerBreaker: options.providerBreaker,
      confirmHoldout: options.confirmHoldout === true,
      allowHoldoutRerun: options.allowHoldoutRerun,
      onRow: (row) => process.stdout.write(`[swebench] ${row.taskId} r${row.repetition} ${row.variant}: ${row.resolved ? "resolved" : row.failureClass ?? "unresolved"} cost=$${row.estimatedCostUsd.toFixed(4)}${row.retryCostUsd ? ` (+$${row.retryCostUsd.toFixed(4)} on an attempt a provider outage ended)` : ""} duration=${(row.durationMs / 1000).toFixed(1)}s\n`)
    });
    finish(outputDir, summary);
  });
program
  .command("report")
  .description("rewrite summary.json and report.md from an evaluation's manifest.json and results.jsonl")
  .requiredOption("--output <dir>", "result directory")
  .action(async (options) => {
    const outputDir = path.resolve(options.output);
    const set = await loadResultSet(outputDir);
    if (set.manifest.schemaVersion !== 2) throw new Error(`${outputDir} holds T1 results, not a SWE-bench evaluation`);
    const manifest = set.manifest as SwebenchManifest;
    const rows = set.rows as SwebenchRunResult[];
    finish(outputDir, await writeSwebenchReport(manifest, rows, outputDir, capReachedFrom(manifest, rows, set), set));
  });
program
  .command("selfcheck")
  .description("grade gold and no-op patches and run the in-container test adapter for SWE-bench instances")
  .requiredOption("--split <split>", "dev or holdout", parseSplit)
  .requiredOption("--output <dir>", "result directory")
  .option("--task-ids <ids>", "comma-separated instance ids from the split (default: the whole split minus exclusions)", parseIds)
  .option("--image-source <source>", "instance images: epoch (ghcr.io/epoch-research) or official (the record's image)", parseImageSource, "epoch")
  .option("--repeat <n>", "gold-patch gradings per instance", positiveInt, 2)
  .option("--concurrency <n>", "instances checked in parallel", positiveInt, 1)
  .action(async (options) => {
    const outputDir = path.resolve(options.output);
    const report = await runSelfcheck({
      split: options.split,
      taskIds: options.taskIds,
      imageSource: options.imageSource,
      repeat: options.repeat,
      outputDir,
      concurrency: options.concurrency
    });
    const { pass, fail, error, total } = report.summary;
    process.stdout.write(`[selfcheck] report=${path.join(outputDir, "selfcheck.md")} pass=${pass} fail=${fail} error=${error} total=${total}\n`);
    if (pass !== total) process.exitCode = 2;
  });

program
  .command("grade-external")
  .description("grade external mini-swe-agent predictions as a descriptive reference")
  .requiredOption("--preds <path>", "mini-swe-agent preds.json")
  .requiredOption("--trajectories <dir>", "directory containing <instance>/<instance>.traj.json")
  .requiredOption("--split <split>", "dev or holdout", parseSplit)
  .option("--task-ids <ids>", "comma-separated instance ids (default: the split minus exclusions)", parseIds)
  .requiredOption("--label <name>", "external agent label", (value: string) => {
    if (!value.trim()) throw new Error("External label must not be empty");
    return value;
  })
  .option("--model <id>", "model for the shared price snapshot", (value: string) => {
    priceSnapshotFor(value);
    return value;
  }, "deepseek-flash")
  .option("--image-source <source>", "locally available Epoch images", (value: string) => {
    if (value !== "epoch") throw new Error("External grading requires --image-source epoch");
    return value;
  }, "epoch")
  .option("--concurrency <n>", "gradings in parallel", positiveInt, 1)
  .requiredOption("--output <dir>", "external results directory; existing rows are resumed")
  .action(async (options) => {
    const outputDir = path.resolve(options.output);
    const { summary } = await gradeExternal({
      preds: path.resolve(options.preds), trajectories: path.resolve(options.trajectories),
      split: options.split, taskIds: options.taskIds, label: options.label, model: options.model,
      imageSource: options.imageSource, concurrency: options.concurrency, outputDir
    });
    process.stdout.write(`[external] report=${path.join(outputDir, "external-report.md")} runs=${summary.observedRuns}/${summary.plannedRuns} resolved=${summary.resolved.count}/${summary.observedRuns}\n`);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function finish(outputDir: string, summary: SwebenchSummary): void {
  const { completeness, resolved, totals } = summary;
  process.stdout.write(`[swebench] report=${path.join(outputDir, "report.md")} runs=${completeness.observedRuns}/${completeness.plannedRuns} resolved=${resolved.resolved}/${summary.scoredRuns} (${(resolved.rate * 100).toFixed(1)}%) cost=$${totals.measuredCostUsd.toFixed(4)} spend=$${totals.totalSpendUsd.toFixed(4)} complete=${summary.complete ? "yes" : `no (${completeness.flags.join("; ")})`}\n`);
  if (!summary.complete) process.exitCode = 2;
}

function parseSplit(value: string): SwebenchSplit {
  if (value !== "dev" && value !== "holdout") throw new Error(`Expected dev or holdout, got ${value}`);
  return value;
}

function parseImageSource(value: string): ImageSource {
  if (value !== "epoch" && value !== "official") throw new Error(`Expected epoch or official, got ${value}`);
  return value;
}

function parseIds(value: string): string[] {
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  if (!ids.length) throw new Error(`Expected comma-separated instance ids, got ${value}`);
  return ids;
}

function parseNames(value: string): string[] {
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) throw new Error(`Expected comma-separated profile names, got ${value}`);
  return names;
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected positive integer, got ${value}`);
  return parsed;
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!value.trim() || !Number.isSafeInteger(parsed)) throw new Error(`Expected integer, got ${value}`);
  return parsed;
}

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected positive number, got ${value}`);
  return parsed;
}

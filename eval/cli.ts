#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { loadDeepSeekEnvironment } from "./env.js";
import { writeEvaluationReport } from "./report.js";
import { runEvaluation } from "./run.js";

const program = new Command();
program
  .name("onehand-eval")
  .requiredOption("--mode <mode>", "pilot or full", parseMode)
  .requiredOption("--env-file <path>", "local env file; only allowlisted DeepSeek variables are loaded")
  .option("--output <path>", "result directory")
  .option("--repetitions <n>", "independent repetitions", positiveInt)
  .option("--concurrency <n>", "parallel runs", positiveInt, 2)
  .option("--cost-cap-usd <n>", "hard estimated cost cap", positiveNumber, 20)
  .option("--model <id>", "DeepSeek model", "deepseek-v4-pro")
  .action(async (options) => {
    const mode = options.mode as "pilot" | "full";
    const repetitions = options.repetitions ?? (mode === "pilot" ? 1 : 3);
    const outputDir = path.resolve(options.output ?? path.join("eval", "results", mode));
    const env = await loadDeepSeekEnvironment(path.resolve(options.envFile));
    const { manifest, results, capReached } = await runEvaluation({
      split: mode,
      repetitions,
      concurrency: options.concurrency,
      outputDir,
      apiKey: env.apiKey,
      baseURL: env.baseURL,
      model: options.model,
      costCapUsd: options.costCapUsd
    });
    const summary = await writeEvaluationReport(manifest, results, outputDir, capReached);
    process.stdout.write(`[eval] report=${path.join(outputDir, "report.md")} runs=${summary.observedRuns}/${summary.plannedRuns} resolved=${(summary.runResolvedRate * 100).toFixed(1)}% cost=$${summary.estimatedCostUsd.toFixed(4)}\n`);
    if (!summary.complete) process.exitCode = 2;
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function parseMode(value: string): "pilot" | "full" {
  if (value !== "pilot" && value !== "full") throw new Error(`Expected pilot or full, got ${value}`);
  return value;
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected positive integer, got ${value}`);
  return parsed;
}

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected positive number, got ${value}`);
  return parsed;
}

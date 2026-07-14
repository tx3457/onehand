#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { runAgent } from "./agent/runner.js";
import { gitDiff } from "./tools/git.js";
import { normalizeRepoRoot } from "./tools/pathGuard.js";
import { runShellCommand } from "./tools/command.js";
import { RunReport } from "./types.js";

const program = new Command();

program
  .name("onehand")
  .description("A lightweight local repository coding-agent CLI.")
  .version("0.1.0");

program
  .command("run")
  .argument("<task>", "task to complete")
  .requiredOption("--repo <path>", "target repository path")
  .option("--test <cmd>", "test command to run")
  .option("--model <id>", "OpenAI model id")
  .option("--max-steps <n>", "maximum model/tool loop steps", parsePositiveInt, 20)
  .option("--timeout-sec <n>", "command timeout in seconds", parsePositiveInt, 120)
  .option("--json", "print JSON report")
  .option("--report <path>", "write JSON report to a file")
  .option("--dangerously-allow-destructive", "allow commands that are refused by default")
  .action(async (task: string, options) => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for onehand run");
    }

    const report = await runAgent({
      task,
      repoPath: options.repo,
      testCommand: options.test,
      model: options.model,
      maxSteps: options.maxSteps,
      timeoutSec: options.timeoutSec,
      allowDestructive: options.dangerouslyAllowDestructive
    });

    if (options.report) {
      await writeFile(options.report, JSON.stringify(report, null, 2) + "\n", "utf8");
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }

    process.exitCode = report.status === "success" ? 0 : 1;
  });

program
  .command("diff")
  .requiredOption("--repo <path>", "target repository path")
  .action(async (options) => {
    const repoRoot = await normalizeRepoRoot(options.repo);
    const result = await gitDiff(repoRoot, 120);
    if (!result.ok) {
      throw new Error(result.error);
    }
    process.stdout.write(result.data.diff);
  });

program.command("doctor").action(async () => {
  const checks = [
    ["OPENAI_API_KEY", process.env.OPENAI_API_KEY ? "ok" : "missing"],
    ["git", (await commandOk("git --version")) ? "ok" : "missing"],
    ["rg", (await commandOk("rg --version")) ? "ok" : "missing (Node fallback will be used)"],
    ["node", process.version]
  ];

  for (const [name, status] of checks) {
    console.log(`${name}: ${status}`);
  }
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function printHumanReport(report: RunReport): void {
  console.log(`Status: ${report.status}`);
  console.log(`Repo: ${report.repo}`);
  console.log(`Task: ${report.task}`);
  console.log(`Changed files: ${report.changedFiles.length ? report.changedFiles.join(", ") : "(none)"}`);

  if (report.commands.length > 0) {
    console.log("Commands:");
    for (const command of report.commands) {
      console.log(`- ${command.command} (exit ${command.exitCode ?? "null"})`);
    }
  }

  if (report.tests.length > 0) {
    console.log("Tests:");
    for (const test of report.tests) {
      console.log(`- ${test.command}: ${test.passed ? "passed" : "failed"} (exit ${test.exitCode ?? "null"})`);
    }
  }

  if (report.finalMessage) {
    console.log("\nFinal message:");
    console.log(report.finalMessage);
  }

  if (report.diff) {
    console.log("\nDiff:");
    console.log(report.diff);
  }
}

async function commandOk(command: string): Promise<boolean> {
  const result = await runShellCommand({
    command,
    cwd: process.cwd(),
    timeoutSec: 10,
    allowDestructive: false
  });
  return result.ok && result.data.exitCode === 0;
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { runAgent } from "./agent/runner.js";
import { createModelProvider } from "./providers/index.js";
import { runRepl } from "./repl/index.js";
import { gitDiff } from "./tools/git.js";
import { normalizeRepoRoot } from "./tools/pathGuard.js";
import { runShellCommand } from "./tools/command.js";
import { RunReport } from "./types.js";
import { startWebUi } from "./web/server.js";

const program = new Command();

program
  .name("onehand")
  .description("A lightweight local repository coding-agent CLI.")
  .version("0.2.0");

program
  .command("run")
  .argument("<task>", "task to complete")
  .requiredOption("--repo <path>", "target repository path")
  .option("--test <cmd>", "test command to run")
  .option("--provider <name>", "model provider: openai or deepseek", parseProvider, "openai")
  .option("--model <id>", "model id")
  .option("--base-url <url>", "provider-compatible API base URL")
  .option("--thinking <mode>", "DeepSeek thinking mode: enabled or disabled", parseThinking, "enabled")
  .option("--reasoning-effort <level>", "reasoning effort: high or max", parseReasoningEffort, "high")
  .option("--temperature <n>", "sampling temperature", parseNonNegativeNumber, 0.2)
  .option("--max-steps <n>", "maximum model/tool loop steps", parsePositiveInt, 20)
  .option("--max-tool-calls <n>", "maximum total tool calls", parsePositiveInt, 40)
  .option("--max-input-tokens <n>", "maximum cumulative input tokens", parsePositiveInt, 300000)
  .option("--max-output-tokens <n>", "maximum cumulative output tokens", parsePositiveInt, 40000)
  .option("--max-turn-output-tokens <n>", "maximum output tokens for one model turn", parsePositiveInt, 8192)
  .option("--max-wall-sec <n>", "maximum wall time in seconds", parsePositiveInt, 900)
  .option("--timeout-sec <n>", "command timeout in seconds", parsePositiveInt, 120)
  .option("--model-timeout-sec <n>", "timeout for one model request", parsePositiveInt, 180)
  .option("--run-dir <path>", "directory for state.json and trace.jsonl")
  .option("--resume <path>", "resume a run directory or state.json")
  .option("--json", "print JSON report")
  .option("--report <path>", "write JSON report to a file")
  .option("--dangerously-allow-destructive", "allow commands that are refused by default")
  .action(async (task: string, options) => {
    const apiKey = options.provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error(`${options.provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY"} is required for onehand run`);

    const report = await runAgent({
      task,
      repoPath: options.repo,
      testCommand: options.test,
      providerName: options.provider,
      apiKey,
      baseURL: options.baseUrl,
      model: options.model,
      thinking: options.thinking,
      reasoningEffort: options.reasoningEffort,
      temperature: options.temperature,
      maxSteps: options.maxSteps,
      maxToolCalls: options.maxToolCalls,
      maxInputTokens: options.maxInputTokens,
      maxOutputTokens: options.maxOutputTokens,
      maxTurnOutputTokens: options.maxTurnOutputTokens,
      maxWallTimeMs: options.maxWallSec * 1000,
      timeoutSec: options.timeoutSec,
      modelTimeoutMs: options.modelTimeoutSec * 1000,
      runDir: options.runDir,
      resume: options.resume,
      enforcePlanning: true,
      persistence: true,
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
  .command("chat")
  .requiredOption("--repo <path>", "target repository path")
  .option("--mode <mode>", "permission mode: ask, edit, or auto", parseMode, "edit")
  .option("--provider <name>", "model provider: openai or deepseek", parseProvider, "openai")
  .option("--model <id>", "model id")
  .option("--base-url <url>", "provider-compatible API base URL")
  .option("--thinking <mode>", "DeepSeek thinking mode: enabled or disabled", parseThinking, "enabled")
  .option("--reasoning-effort <level>", "reasoning effort: high or max", parseReasoningEffort, "high")
  .option("--temperature <n>", "sampling temperature", parseNonNegativeNumber, 0.2)
  .option("--allow <pattern>", "allow a tool or command pattern", collect, [])
  .option("--deny <pattern>", "deny a tool or command pattern", collect, [])
  .action(async (options) => {
    const apiKey = options.provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error(`${options.provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY"} is required for onehand chat`);

    await runRepl({
      repoPath: options.repo,
      mode: options.mode,
      provider: options.provider,
      model: options.model,
      baseURL: options.baseUrl,
      apiKey,
      thinking: options.thinking,
      reasoningEffort: options.reasoningEffort,
      temperature: options.temperature,
      cliRules: { allow: options.allow, deny: options.deny },
      providerFactory: (providerOptions) => createModelProvider({
        provider: providerOptions.provider,
        apiKey: providerOptions.apiKey,
        baseURL: providerOptions.baseURL
      })
    });
  });

program
  .command("ui")
  .description("Browse local runs, checkpoints and evaluations (read-only)")
  .option("--port <number>", "loopback port (0 selects a free port)", parsePort, 0)
  .option("--runs-dir <path>", "run artifacts directory (default: ~/.onehand/runs)")
  .option("--results-dir <path>", "evaluation results directory (default: ./eval/results)")
  .option("--open", "open the one-time URL in the default browser")
  .action(async (options) => {
    const ui = await startWebUi({ port: options.port, runsDir: options.runsDir, resultsDir: options.resultsDir });
    console.log(`OneHand read-only Web UI: ${ui.url}`);
    console.log("The URL can be used once. Keep it private; Ctrl-C stops the server.");
    const stop = () => { void ui.close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (options.open) {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
      const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", ui.url] : [ui.url];
      const browser = spawn(command, args, { stdio: "ignore", detached: true });
      browser.once("error", () => console.error("Could not open the browser; use the printed URL."));
      browser.unref();
    }
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
    ["DEEPSEEK_API_KEY", process.env.DEEPSEEK_API_KEY ? "ok" : "missing"],
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

  if (report.usage) {
    console.log(`Usage: ${report.usage.modelRounds} model rounds, ${report.usage.toolCalls} tool calls, ${report.usage.totalTokens} tokens, ${report.usage.wallTimeMs} ms`);
  }

  if (report.stopReason) console.log(`Stop reason: ${report.stopReason}`);

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

function parsePort(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error(`Expected a port between 0 and 65535, got ${value}`);
  return Number(value);
}

function parseNonNegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Expected a non-negative number, got ${value}`);
  return parsed;
}

function parseProvider(value: string): "openai" | "deepseek" {
  if (value !== "openai" && value !== "deepseek") throw new Error(`Expected openai or deepseek, got ${value}`);
  return value;
}

function parseThinking(value: string): "enabled" | "disabled" {
  if (value !== "enabled" && value !== "disabled") throw new Error(`Expected enabled or disabled, got ${value}`);
  return value;
}

function parseReasoningEffort(value: string): "high" | "max" {
  if (value !== "high" && value !== "max") throw new Error(`Expected high or max, got ${value}`);
  return value;
}

function parseMode(value: string): "ask" | "edit" | "auto" {
  if (value !== "ask" && value !== "edit" && value !== "auto") {
    throw new Error(`Expected ask, edit, or auto, got ${value}`);
  }
  return value;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

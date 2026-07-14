import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runAgent } from "../src/agent/runner.js";
import type { ModelProvider, ProviderTurn } from "../src/providers/index.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "onehand-demo-"));
const repo = path.join(root, "repo");
const runDir = path.join(root, "run");

try {
  await mkdir(repo);
  await writeFile(path.join(repo, "answer.cjs"), "exports.answer = () => 41;\n", "utf8");
  await writeFile(
    path.join(repo, "test.cjs"),
    "const assert=require('node:assert/strict');assert.equal(require('./answer.cjs').answer(),42);\n",
    "utf8"
  );
  await git(["init", "-q"], repo);
  await git(["config", "user.name", "OneHand Demo"], repo);
  await git(["config", "user.email", "demo@example.invalid"], repo);
  await git(["add", "."], repo);
  await git(["commit", "-qm", "demo fixture"], repo);

  const provider = scriptedProvider([
    toolTurn("set_plan", { steps: ["inspect the failure", "apply the minimal fix", "verify and finish"] }, "1"),
    toolTurn("read_file", { path: "answer.cjs" }, "2"),
    toolTurn("update_plan", { stepId: 1, status: "completed", evidence: "answer returns 41" }, "3"),
    toolTurn("update_plan", { stepId: 2, status: "in_progress" }, "4"),
    toolTurn("replace_text", { path: "answer.cjs", oldText: "41", newText: "42" }, "5"),
    toolTurn("update_plan", { stepId: 2, status: "completed", evidence: "changed the return value" }, "6"),
    toolTurn("update_plan", { stepId: 3, status: "in_progress" }, "7"),
    toolTurn("run_tests", {}, "8"),
    toolTurn("update_plan", { stepId: 3, status: "completed", evidence: "node test.cjs passed" }, "9"),
    toolTurn("finish_task", { summary: "Corrected answer() and verified the regression test." }, "10")
  ]);

  process.stdout.write("OneHand offline deterministic demo\n");
  process.stdout.write("Provider decisions are scripted; repository tools and tests execute for real.\n\n");
  const report = await runAgent({
    task: "Fix answer() so the failing test passes.",
    repoPath: repo,
    testCommand: "node test.cjs",
    provider,
    enforcePlanning: true,
    persistence: true,
    runDir,
    timeoutSec: 10,
    retryDelayMs: 1
  });

  const answer = await readFile(path.join(repo, "answer.cjs"), "utf8");
  process.stdout.write(`\nstatus: ${report.status}\n`);
  process.stdout.write(`stop reason: ${report.stopReason}\n`);
  process.stdout.write(`changed files: ${report.changedFiles.join(", ")}\n`);
  process.stdout.write(`test passed: ${report.tests.at(-1)?.passed === true}\n`);
  process.stdout.write(`plan: ${report.plan?.steps.map((step) => `${step.id}:${step.status}`).join(", ")}\n`);
  process.stdout.write(`result: ${answer.trim()}\n`);
  if (report.status !== "success" || !report.tests.at(-1)?.passed || !answer.includes("42")) {
    process.exitCode = 1;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

function scriptedProvider(turns: ProviderTurn[]): ModelProvider {
  return {
    name: "openai",
    initialHistory: (content) => [{ role: "user", content }],
    complete: async () => {
      const turn = turns.shift();
      if (!turn) throw new Error("Demo script exhausted its provider turns");
      process.stdout.write(`action: ${turn.toolCalls[0]?.name ?? "stop"}\n`);
      return turn;
    },
    toolResultItem: (call, output) => ({ type: "function_call_output", call_id: call.id, output })
  };
}

function toolTurn(name: string, args: Record<string, unknown>, id: string): ProviderTurn {
  return {
    historyItems: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: id }],
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    message: "",
    finishReason: "tool_calls",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 1,
      totalTokens: 2
    }
  };
}

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
}

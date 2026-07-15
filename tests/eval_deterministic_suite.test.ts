import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/runner.js";
import type {
  ModelProvider,
  ProviderRequest,
  ProviderTurn
} from "../src/providers/types.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

type Observation = { tool: string; output: string };
type CheckValue = boolean | number | string | string[];
type Checks = Record<string, CheckValue>;

type Fixture = {
  root: string;
  repo: string;
  outside: string;
  cleanup(): Promise<void>;
};

const usage = (inputTokens = 1, outputTokens = 1) => ({
  inputTokens,
  outputTokens,
  cacheHitInputTokens: 0,
  cacheMissInputTokens: inputTokens,
  totalTokens: inputTokens + outputTokens
});

const call = (
  name: string,
  args: Record<string, unknown>,
  id: string,
  tokenUsage = usage()
): ProviderTurn => ({
  historyItems: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: id }],
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  message: "",
  finishReason: "tool_calls",
  usage: tokenUsage
});

const calls = (
  items: Array<{ name: string; args: Record<string, unknown>; id: string }>,
  tokenUsage = usage()
): ProviderTurn => ({
  historyItems: [{ type: "function_call_batch", call_ids: items.map((item) => item.id) }],
  toolCalls: items.map((item) => ({
    id: item.id,
    name: item.name,
    arguments: JSON.stringify(item.args)
  })),
  message: "",
  finishReason: "tool_calls",
  usage: tokenUsage
});

const message = (text: string): ProviderTurn => ({
  historyItems: [{ role: "assistant", content: text }],
  toolCalls: [],
  message: text,
  finishReason: "stop",
  usage: usage()
});

function providerFrom(
  complete: (request: ProviderRequest) => Promise<ProviderTurn>,
  observations: Observation[] = []
): ModelProvider {
  return {
    name: "openai",
    initialHistory: (content) => [{ role: "user", content }],
    complete,
    toolResultItem: (toolCall, output) => {
      observations.push({ tool: toolCall.name, output });
      return { type: "function_call_output", call_id: toolCall.id, output };
    }
  };
}

function scriptedProvider(turns: ProviderTurn[], observations: Observation[] = []): ModelProvider {
  return providerFrom(async () => turns.shift() ?? message("unexpected scripted stop"), observations);
}

async function makeFixture(files: Record<string, string>): Promise<Fixture> {
  const root = await makeTempDir("onehand-deterministic-");
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  await mkdir(repo);
  await mkdir(outside);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(repo, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  await initGitRepo(repo);
  await git(["config", "commit.gpgsign", "false"], repo);
  await git(["add", "."], repo);
  await git(["commit", "-m", "fixture"], repo);
  return { root, repo, outside, cleanup: () => cleanupTempDir(root) };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function observation(observations: Observation[], tool: string, occurrence = -1): string {
  const matches = observations.filter((item) => item.tool === tool);
  const index = occurrence < 0 ? matches.length + occurrence : occurrence;
  return matches[index]?.output ?? "";
}

function expectChecks(checks: Checks): void {
  for (const [name, value] of Object.entries(checks)) {
    if (name.startsWith("observed_") || name.startsWith("count_")) continue;
    expect(value, name).toBe(true);
  }
}

async function happyPath(): Promise<Checks> {
  const fixture = await makeFixture({
    "answer.cjs": "exports.answer=()=>41;\n",
    "test.cjs": "const assert=require('node:assert/strict');assert.equal(require('./answer.cjs').answer(),42);\n"
  });
  try {
    const turns = [
      call("set_plan", { steps: ["inspect", "fix", "verify"] }, "h1"),
      call("read_file", { path: "answer.cjs" }, "h2"),
      call("update_plan", { stepId: 1, status: "completed", evidence: "read answer.cjs" }, "h3"),
      call("update_plan", { stepId: 2, status: "in_progress" }, "h4"),
      call("replace_text", { path: "answer.cjs", oldText: "41", newText: "42" }, "h5"),
      call("update_plan", { stepId: 2, status: "completed", evidence: "changed 41 to 42" }, "h6"),
      call("update_plan", { stepId: 3, status: "in_progress" }, "h7"),
      call("run_tests", {}, "h8"),
      call("update_plan", { stepId: 3, status: "completed", evidence: "test passed" }, "h9"),
      call("finish_task", { summary: "fixed and verified" }, "h10")
    ];
    const report = await runAgent({
      task: "fix answer",
      repoPath: fixture.repo,
      testCommand: "node test.cjs",
      provider: scriptedProvider(turns),
      model: "deterministic-script",
      enforcePlanning: true,
      persistence: false,
      retryDelayMs: 1,
      timeoutSec: 10
    });
    return {
      explicit_finish_success: report.status === "success" && report.stopReason === "explicit_finish",
      final_code_correct: (await readFile(path.join(fixture.repo, "answer.cjs"), "utf8")).includes("42"),
      post_write_test_passed: report.tests.at(-1)?.passed === true,
      plan_completed: report.plan?.status === "completed",
      observed_model_rounds: report.usage?.modelRounds ?? -1,
      observed_tool_calls: report.usage?.toolCalls ?? -1
    };
  } finally {
    await fixture.cleanup();
  }
}

async function observationDrivenRecovery(): Promise<Checks> {
  const fixture = await makeFixture({
    "answer.cjs": "exports.answer=()=>40;\n",
    "test.cjs": "const assert=require('node:assert/strict');assert.equal(require('./answer.cjs').answer(),42);\n"
  });
  const observations: Observation[] = [];
  let round = 0;
  let branch = "not_taken";
  const provider = providerFrom(async () => {
    const sequence: ProviderTurn[] = [
      call("set_plan", { steps: ["inspect", "fix", "verify"] }, "o1"),
      call("read_file", { path: "answer.cjs" }, "o2"),
      call("update_plan", { stepId: 1, status: "completed", evidence: "read code" }, "o3"),
      call("update_plan", { stepId: 2, status: "in_progress" }, "o4"),
      call("replace_text", { path: "answer.cjs", oldText: "40", newText: "41" }, "o5"),
      call("update_plan", { stepId: 2, status: "completed", evidence: "first repair" }, "o6"),
      call("update_plan", { stepId: 3, status: "in_progress" }, "o7"),
      call("run_tests", {}, "o8")
    ];
    if (round < sequence.length) return sequence[round++]!;
    if (round === 8) {
      round += 1;
      const failed = observation(observations, "run_tests").includes('"passed": false');
      if (!failed) return message("did not receive a failed-test observation");
      branch = "repair_after_failed_observation";
      return call("read_file", { path: "answer.cjs" }, "o9");
    }
    if (round === 9) {
      round += 1;
      const sawIntermediate = observation(observations, "read_file").includes("41");
      if (!sawIntermediate) return message("intermediate state was not observed");
      return call("replace_text", { path: "answer.cjs", oldText: "41", newText: "42" }, "o10");
    }
    if (round++ === 10) return call("run_tests", {}, "o11");
    if (round === 12) {
      const passed = observation(observations, "run_tests").includes('"passed": true');
      if (!passed) return message("second test did not pass");
      return call("update_plan", { stepId: 3, status: "completed", evidence: "repaired after failed observation" }, "o12");
    }
    return call("finish_task", { summary: "recovered from failed test and verified" }, "o13");
  }, observations);
  try {
    const report = await runAgent({
      task: "repair after observing the test result",
      repoPath: fixture.repo,
      testCommand: "node test.cjs",
      provider,
      model: "deterministic-observation-policy",
      enforcePlanning: true,
      persistence: false,
      maxSteps: 20,
      retryDelayMs: 1,
      timeoutSec: 10
    });
    return {
      failed_observation_reentered_context: observations.some((item) => item.tool === "run_tests" && item.output.includes('"passed": false')),
      policy_took_observation_branch: branch === "repair_after_failed_observation",
      later_action_changed_repository: (await readFile(path.join(fixture.repo, "answer.cjs"), "utf8")).includes("42"),
      fail_then_pass_recorded: report.tests.length === 2 && report.tests[0]?.passed === false && report.tests[1]?.passed === true,
      explicit_finish_success: report.status === "success" && report.stopReason === "explicit_finish",
      observed_branch: branch,
      observed_tool_calls: report.usage?.toolCalls ?? -1
    };
  } finally {
    await fixture.cleanup();
  }
}

async function repeatedToolFailureRecovery(): Promise<Checks> {
  const fixture = await makeFixture({
    "safe.cjs": "exports.ok=true;\n",
    "test.cjs": "const assert=require('node:assert/strict');assert.equal(require('./safe.cjs').ok,true);\n"
  });
  const observations: Observation[] = [];
  const turns = [
    call("set_plan", { steps: ["inspect safely", "verify"] }, "r1"),
    call("read_file", { path: "missing.cjs" }, "r2"),
    call("read_file", { path: "missing.cjs" }, "r3"),
    call("write_file", { path: "should-not-exist.txt", content: "blocked" }, "r4"),
    call("update_plan", { stepId: 1, status: "in_progress", evidence: "missing path; use safe.cjs" }, "r5"),
    call("read_file", { path: "safe.cjs" }, "r6"),
    call("update_plan", { stepId: 1, status: "completed", evidence: "safe.cjs inspected" }, "r7"),
    call("update_plan", { stepId: 2, status: "in_progress" }, "r8"),
    call("run_tests", {}, "r9"),
    call("update_plan", { stepId: 2, status: "completed", evidence: "test passed" }, "r10"),
    call("finish_task", { summary: "replanned after repeated failure" }, "r11")
  ];
  try {
    const report = await runAgent({
      task: "recover from a repeated bad path",
      repoPath: fixture.repo,
      testCommand: "node test.cjs",
      provider: scriptedProvider(turns, observations),
      model: "deterministic-script",
      enforcePlanning: true,
      persistence: false,
      retryDelayMs: 1,
      timeoutSec: 10
    });
    const writeBlock = observation(observations, "write_file");
    return {
      repeated_failure_forced_replan: writeBlock.includes("Repeated failure requires update_plan"),
      blocked_write_not_created: !(await exists(path.join(fixture.repo, "should-not-exist.txt"))),
      recovery_read_succeeded: observations.some((item) => item.tool === "read_file" && item.output.includes('"ok": true')),
      replan_cleared_failure_state: report.plan?.needsReplan === false,
      explicit_finish_success: report.status === "success" && report.stopReason === "explicit_finish",
      observed_failed_tool_results: observations.filter((item) => item.output.includes('"ok": false')).length,
      observed_tool_calls: report.usage?.toolCalls ?? -1
    };
  } finally {
    await fixture.cleanup();
  }
}

async function falseSuccessPlainStop(): Promise<Checks> {
  const fixture = await makeFixture({ "safe.cjs": "exports.ok=true;\n" });
  try {
    const report = await runAgent({
      task: "claim completion without evidence",
      repoPath: fixture.repo,
      provider: scriptedProvider([message("done")]),
      model: "deterministic-script",
      enforcePlanning: true,
      persistence: false
    });
    return {
      natural_language_claim_not_success: report.status === "failed",
      correct_stop_reason: report.stopReason === "model_stopped_without_finish",
      no_tool_evidence: (report.usage?.toolCalls ?? -1) === 0,
      observed_status: report.status,
      observed_stop_reason: report.stopReason ?? "none"
    };
  } finally {
    await fixture.cleanup();
  }
}

async function falseSuccessFailedVerification(): Promise<Checks> {
  const fixture = await makeFixture({
    "bad.cjs": "process.exit(1);\n",
    "test.cjs": "process.exit(1);\n"
  });
  const observations: Observation[] = [];
  const turns = [
    call("set_plan", { steps: ["verify"] }, "f1"),
    call("run_tests", {}, "f2"),
    call("update_plan", { stepId: 1, status: "completed", evidence: "claimed done" }, "f3"),
    call("finish_task", { summary: "unsupported success" }, "f4"),
    message("done anyway")
  ];
  try {
    const report = await runAgent({
      task: "do not accept a failed verification",
      repoPath: fixture.repo,
      testCommand: "node test.cjs",
      provider: scriptedProvider(turns, observations),
      model: "deterministic-script",
      enforcePlanning: true,
      persistence: false,
      retryDelayMs: 1
    });
    return {
      failed_test_recorded: report.tests.length === 1 && report.tests[0]?.passed === false,
      finish_rejected_after_failed_test: observation(observations, "finish_task").includes("Run a passing verification"),
      false_success_prevented: report.status === "failed" && report.stopReason === "model_stopped_without_finish",
      observed_status: report.status,
      observed_stop_reason: report.stopReason ?? "none"
    };
  } finally {
    await fixture.cleanup();
  }
}

async function stepBudget(): Promise<Checks> {
  const fixture = await makeFixture({ "safe.cjs": "exports.ok=true;\n" });
  try {
    const report = await runAgent({
      task: "stop at the step budget",
      repoPath: fixture.repo,
      provider: scriptedProvider([call("set_plan", { steps: ["inspect"] }, "b1")]),
      model: "deterministic-script",
      enforcePlanning: true,
      persistence: false,
      maxSteps: 1
    });
    return {
      budget_status: report.status === "budget_exhausted",
      step_budget_reason: report.stopReason === "step_budget",
      exact_model_round_limit: report.usage?.modelRounds === 1,
      observed_model_rounds: report.usage?.modelRounds ?? -1
    };
  } finally {
    await fixture.cleanup();
  }
}

async function toolBudget(): Promise<Checks> {
  const fixture = await makeFixture({ "safe.cjs": "exports.ok=true;\n" });
  const observations: Observation[] = [];
  try {
    const report = await runAgent({
      task: "stop before the second tool call",
      repoPath: fixture.repo,
      provider: scriptedProvider([
        calls([
          { name: "set_plan", args: { steps: ["inspect"] }, id: "tb1" },
          { name: "read_file", args: { path: "safe.cjs" }, id: "tb2" }
        ])
      ], observations),
      model: "deterministic-script",
      enforcePlanning: true,
      persistence: false,
      maxToolCalls: 1
    });
    return {
      budget_status: report.status === "budget_exhausted",
      tool_budget_reason: report.stopReason === "tool_budget",
      exact_tool_limit: report.usage?.toolCalls === 1,
      skipped_call_paired: observation(observations, "read_file").includes("tool budget exhausted"),
      observed_tool_calls: report.usage?.toolCalls ?? -1
    };
  } finally {
    await fixture.cleanup();
  }
}

async function tokenBudget(): Promise<Checks> {
  const fixture = await makeFixture({ "safe.cjs": "exports.ok=true;\n" });
  const observations: Observation[] = [];
  try {
    const report = await runAgent({
      task: "stop before tools when token budget is exhausted",
      repoPath: fixture.repo,
      provider: scriptedProvider([call("set_plan", { steps: ["inspect"] }, "tok1", usage(10, 1))], observations),
      model: "deterministic-script",
      enforcePlanning: true,
      persistence: false,
      maxInputTokens: 5
    });
    return {
      budget_status: report.status === "budget_exhausted",
      token_budget_reason: report.stopReason === "token_budget",
      tool_not_executed: report.usage?.toolCalls === 0,
      skipped_call_paired: observation(observations, "set_plan").includes("token_budget"),
      observed_input_tokens: report.usage?.inputTokens ?? -1
    };
  } finally {
    await fixture.cleanup();
  }
}

async function safetyBoundaries(): Promise<Checks> {
  const fixture = await makeFixture({
    "safe.cjs": "exports.ok=true;\n",
    "test.cjs": "const assert=require('node:assert/strict');assert.equal(require('./safe.cjs').ok,true);\n"
  });
  await symlink(fixture.outside, path.join(fixture.repo, "escape"));
  const observations: Observation[] = [];
  const turns = [
    call("set_plan", { steps: ["validate safety boundaries"] }, "s1"),
    call("read_file", { path: ".env" }, "s2"),
    call("write_file", { path: "../outside-write.txt", content: "blocked" }, "s3"),
    call("write_file", { path: "escape/proof.txt", content: "blocked" }, "s4"),
    call("run_command", { program: "git", args: ["push", "origin", "main"] }, "s5"),
    call("run_command", { program: "node", args: ["-e", "console.log(process.env)"] }, "s6"),
    call("run_tests", {}, "s7"),
    call("update_plan", { stepId: 1, status: "completed", evidence: "unsafe actions blocked; tests passed" }, "s8"),
    call("finish_task", { summary: "safety checks blocked and baseline verified" }, "s9")
  ];
  try {
    const report = await runAgent({
      task: "verify guarded tool behavior",
      repoPath: fixture.repo,
      testCommand: "node test.cjs",
      provider: scriptedProvider(turns, observations),
      model: "deterministic-script",
      enforcePlanning: true,
      persistence: false,
      retryDelayMs: 1,
      timeoutSec: 10
    });
    const readBlock = observation(observations, "read_file");
    const writeBlocks = observations.filter((item) => item.tool === "write_file").map((item) => item.output);
    const commandBlocks = observations.filter((item) => item.tool === "run_command").map((item) => item.output);
    return {
      protected_env_path_blocked: readBlock.includes("Protected repository path"),
      lexical_traversal_blocked: writeBlocks.some((output) => output.includes("escapes repository root")),
      symlink_escape_blocked: writeBlocks.some((output) => output.includes("outside repository root")),
      git_network_mutation_blocked: commandBlocks.some((output) =>
        output.includes("Git mutation or network operation") || output.includes("dedicated repository tool")
      ),
      inline_code_execution_blocked: commandBlocks.some((output) => output.includes("Inline code execution is disabled")),
      no_parent_write: !(await exists(path.join(fixture.root, "outside-write.txt"))),
      no_symlink_target_write: !(await exists(path.join(fixture.outside, "proof.txt"))),
      safe_verification_and_finish: report.status === "success" && report.tests.at(-1)?.passed === true,
      observed_blocked_calls: observations.filter((item) => item.output.includes('"ok": false')).length,
      observed_status: report.status
    };
  } finally {
    await fixture.cleanup();
  }
}

async function modelRetry(): Promise<Checks> {
  const fixture = await makeFixture({
    "safe.cjs": "exports.ok=true;\n",
    "test.cjs": "const assert=require('node:assert/strict');assert.equal(require('./safe.cjs').ok,true);\n"
  });
  let attempts = 0;
  let successfulRounds = 0;
  const provider = providerFrom(async () => {
    attempts += 1;
    if (attempts <= 2) throw Object.assign(new Error("synthetic rate limit"), { status: 429 });
    successfulRounds += 1;
    if (successfulRounds === 1) return call("set_plan", { steps: ["verify"] }, "m1");
    if (successfulRounds === 2) return call("run_tests", {}, "m2");
    if (successfulRounds === 3) return call("update_plan", { stepId: 1, status: "completed", evidence: "test passed" }, "m3");
    return call("finish_task", { summary: "recovered from retryable provider errors" }, "m4");
  });
  try {
    const report = await runAgent({
      task: "recover from retryable provider errors",
      repoPath: fixture.repo,
      testCommand: "node test.cjs",
      provider,
      model: "deterministic-script",
      enforcePlanning: true,
      persistence: false,
      maxApiAttempts: 3,
      retryDelayMs: 1,
      timeoutSec: 10
    });
    return {
      retried_twice: attempts === 6 && successfulRounds === 4,
      completed_after_retry: report.status === "success" && report.stopReason === "explicit_finish",
      verification_passed: report.tests.at(-1)?.passed === true,
      observed_provider_attempts: attempts,
      observed_successful_model_rounds: successfulRounds
    };
  } finally {
    await fixture.cleanup();
  }
}

describe("deterministic Agent scenarios", () => {
  it("completes a multi-step task through explicit finish", async () => {
    expectChecks(await happyPath());
  });

  it("changes its later action after a failed-test observation", async () => {
    expectChecks(await observationDrivenRecovery());
  });

  it("requires replanning after repeated tool failures and then recovers", async () => {
    expectChecks(await repeatedToolFailureRecovery());
  });

  it("does not count a plain natural-language stop as success", async () => {
    expectChecks(await falseSuccessPlainStop());
  });

  it("rejects explicit finish after failed verification", async () => {
    expectChecks(await falseSuccessFailedVerification());
  });

  it("stops at the model-round budget", async () => {
    expectChecks(await stepBudget());
  });

  it("stops at the tool-call budget and pairs skipped calls", async () => {
    expectChecks(await toolBudget());
  });

  it("stops at the token budget before executing a tool", async () => {
    expectChecks(await tokenBudget());
  });

  it("enforces repository path, symlink, command, and network boundaries", async () => {
    expectChecks(await safetyBoundaries());
  });

  it("retries transient provider failures within a bound", async () => {
    expectChecks(await modelRetry());
  });
});

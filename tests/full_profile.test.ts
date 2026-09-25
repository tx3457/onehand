import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PROFILES } from "../src/agent/profile.js";
import { runAgent } from "../src/agent/runner.js";
import { DeepSeekChatProvider } from "../src/providers/deepseek.js";
import { LocalExecutor, PathMapper, type Executor } from "../src/runtime/executor.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

let root: string;
let runDir: string;
beforeEach(async () => {
  root = await makeTempDir("onehand-full-repo-");
  runDir = await makeTempDir("onehand-full-run-");
  await initGitRepo(root);
  await writeFile(path.join(root, "answer.txt"), `before\n${Array.from({ length: 300 }, () => "x".repeat(66)).join("\n")}\n`);
  await writeFile(path.join(root, "test.cjs"), 'require("node:assert/strict").ok(require("node:fs").readFileSync("answer.txt", "utf8").trim());');
  await git(["add", "answer.txt", "test.cjs"], root);
  await git(["commit", "-qm", "fixture"], root);
});
afterEach(async () => { await cleanupTempDir(root); await cleanupTempDir(runDir); });

it("combines masking and lean completion with host-visible container edits", async () => {
  const actions: Array<[string, Record<string, unknown>]> = [
    ["run_tests", {}],
    ...Array.from({ length: 10 }, (): [string, Record<string, unknown>] => ["read_file", { path: "answer.txt" }]),
    ["set_plan", { steps: ["change the answer and verify"] }],
    ["write_file", { path: "answer.txt", content: "after\n" }],
    ["run_tests", {}],
    ["run_command", { program: "cat", args: ["answer.txt"] }],
    ["finish_task", { summary: "Changed and verified", stepEvidence: [{ stepId: 1, evidence: "answer.txt changed; node test.cjs passed" }] }]
  ];
  const requests: Record<string, any>[] = [];
  const provider = new DeepSeekChatProvider({ client: { chat: { completions: {
    async create(request) {
      requests.push(structuredClone(request));
      const round = requests.length;
      const [name, args] = actions[round - 1]!;
      return {
        choices: [{ finish_reason: "tool_calls", message: {
          role: "assistant", content: null, reasoning_content: `reasoning ${round}`,
          tool_calls: [{ id: `call-${round}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        } }],
        usage: { prompt_tokens: round === 12 ? 48_001 : 100, completion_tokens: 10 }
      };
    }
  } } } });
  const local = new LocalExecutor();
  const executor: Executor = {
    kind: "docker", pathMapper: new PathMapper(root, "/testbed"),
    run: (request) => local.run(request)
  };
  const report = await runAgent({
    task: "change the answer and verify", repoPath: root, runDir, provider, executor,
    profile: PROFILES.full, testCommand: "node test.cjs", maxSteps: 16, maxToolCalls: 20,
    maxInputTokens: 100_000, enforcePlanning: true, persistence: true
  });
  expect(report.status).toBe("success");
  expect(report.changedFiles).toEqual(["answer.txt"]);
  expect(report.plan?.writeRevision).toBe(1);
  expect(report.plan?.validatedWriteRevision).toBe(1);
  expect(report.tests).toHaveLength(2);
  expect(report.tests.every((test) => test.passed)).toBe(true);
  expect(report.usage?.inputTokens).toBe(49_501);
  expect(requests[0]!.messages[0].content).toContain("finish_task stepEvidence");
  expect(requests[12]!.messages).toContainEqual(expect.objectContaining({
    role: "tool", tool_call_id: "call-1", content: expect.stringContaining("masked to save context; call the tool again if needed")
  }));
  const trace = (await readFile(path.join(runDir, "trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const masked = trace.filter((event) => event.event === "context_masked");
  expect(masked).toHaveLength(1);
  expect(masked[0]!.data).toMatchObject({ bytesRemoved: expect.any(Number), bytesKept: expect.any(Number), keptRounds: expect.any(Number) });
  expect(masked[0]!.data.bytesRemoved).toBeGreaterThanOrEqual(32 * 1024);
  const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
  expect(state.history).toContainEqual(expect.objectContaining({ role: "assistant", reasoning_content: "[elided]" }));
});

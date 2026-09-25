import { PassThrough } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRepl } from "../src/repl/index.js";
import type { ModelProvider, ProviderRequest, ProviderTurn } from "../src/providers/index.js";
import { emptyTokenUsage } from "../src/providers/types.js";
import type { RunAgentOptions } from "../src/agent/runner.js";
import type { RunReport } from "../src/types.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

describe("terminal REPL", () => {
  let repo: string;
  let stateDir: string;
  let previousCheckpointDir: string | undefined;

  beforeEach(async () => {
    repo = await makeTempDir("onehand-repl-repo-");
    stateDir = await makeTempDir("onehand-repl-state-");
    activeRepo = repo;
    activeUserHome = stateDir;
    await initGitRepo(repo);
    await writeFile(path.join(repo, "tracked.txt"), "before\n");
    await git(["add", "tracked.txt"], repo);
    await git(["commit", "-m", "initial"], repo);
    previousCheckpointDir = process.env.ONEHAND_CHECKPOINT_DIR;
    process.env.ONEHAND_CHECKPOINT_DIR = path.join(stateDir, "checkpoints");
  });

  afterEach(async () => {
    if (previousCheckpointDir === undefined) delete process.env.ONEHAND_CHECKPOINT_DIR;
    else process.env.ONEHAND_CHECKPOINT_DIR = previousCheckpointDir;
    delete process.env.NO_COLOR;
    await cleanupTempDir(repo);
    await cleanupTempDir(stateDir);
  });

  it("handles edit approvals yes, no, and always for the session", async () => {
    const providers = [
      mutationProvider([["yes.txt", "yes\n"]]),
      mutationProvider([["no.txt", "no\n"]]),
      mutationProvider([["always-1.txt", "one\n"], ["always-2.txt", "two\n"]]),
      mutationProvider([["always-next.txt", "next\n"]])
    ];
    const { input, output, text } = streams();
    input.end("first\ny\nsecond\nn\nthird\na\nfourth\n/exit\n");

    await runRepl(baseOptions(input, output, { providerFactory: () => providers.shift()! }));

    expect(await readFile(path.join(repo, "yes.txt"), "utf8")).toBe("yes\n");
    await expect(readFile(path.join(repo, "no.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(repo, "always-1.txt"), "utf8")).toBe("one\n");
    expect(await readFile(path.join(repo, "always-2.txt"), "utf8")).toBe("two\n");
    expect(await readFile(path.join(repo, "always-next.txt"), "utf8")).toBe("next\n");
    expect(text()).toContain("Allow write_file yes.txt? [y]es / [n]o / [a]lways");
    expect(text().match(/Allow write_file/g)).toHaveLength(3);
  });

  it("uses answer completion in ask mode with a real scripted provider", async () => {
    const { input, output, text } = streams();
    input.end("What does this repository contain?\n/exit\n");

    await runRepl(baseOptions(input, output, {
      mode: "ask",
      providerFactory: () => scriptedProvider([messageTurn("It contains one tracked text file.")])
    }));

    expect(text()).toContain("It contains one tracked text file.");
    expect(text()).toContain("success · 1 rounds · 2 tokens");
  });

  it("restores the checkpoint from the last mutating run with /undo", async () => {
    const { input, output, text } = streams();
    input.end("change it\na\n/undo\n/exit\n");

    await runRepl(baseOptions(input, output, {
      providerFactory: () => mutationProvider([["tracked.txt", "after\n"], ["created.txt", "created\n"]])
    }));

    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("before\n");
    await expect(readFile(path.join(repo, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(text()).toContain("Restored checkpoint");
  });

  it("switches modes and carries short earlier-session memory", async () => {
    const calls: RunAgentOptions[] = [];
    const runAgentFn = async (options: RunAgentOptions): Promise<RunReport> => {
      calls.push(options);
      return report(calls.length === 1 ? "first answer" : "second answer");
    };
    const { input, output, text } = streams();
    input.end("first question\n/mode ask\nsecond question\n/exit\n");

    await runRepl(baseOptions(input, output, { runAgentFn }));

    expect(calls[0]?.mode).toBe("edit");
    expect(calls[1]?.mode).toBe("ask");
    expect(calls[1]?.completion).toBe("answer");
    expect(calls[1]?.checkpoints).toBe(false);
    expect(calls[1]?.task).toContain("Earlier in this session:\nInput: first question\nOneHand: first answer");
    expect(text()).toContain("Mode: ask");
  });

  it("aborts a slow real provider turn on Ctrl+C and returns to the prompt", async () => {
    const { input, output, text } = streams();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const provider: ModelProvider = {
      name: "openai",
      initialHistory: (content) => [{ role: "user", content }],
      toolResultItem: () => ({}),
      complete: (request) => new Promise<ProviderTurn>((_resolve, reject) => {
        markStarted();
        request.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      })
    };
    const running = runRepl(baseOptions(input, output, { mode: "ask", providerFactory: () => provider }));
    input.write("wait forever\n");
    await started;
    input.write("\u0003");
    input.end("/exit\n");

    await running;

    expect(text()).toContain("cancelled");
    expect(text().match(/onehand> /g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("emits no ANSI escapes when NO_COLOR is set", async () => {
    process.env.NO_COLOR = "1";
    const runAgentFn = async (options: RunAgentOptions): Promise<RunReport> => {
      options.onEvent?.({ type: "tool_finished", name: "read_file", ok: true, durationMs: 1, summary: "read tracked.txt 1–1" });
      return report("done");
    };
    const { input, output, text } = streams(true);
    input.end("inspect\n/exit\n");

    await runRepl(baseOptions(input, output, { runAgentFn }));

    expect(text()).toContain("✓ read_file read tracked.txt 1–1");
    expect(text()).not.toContain("\u001b[");
  });

  it("supports the remaining slash commands and exposes loaded project memory", async () => {
    await writeFile(path.join(repo, "AGENTS.md"), "Keep changes focused.\n");
    const models: Array<string | undefined> = [];
    let runs = 0;
    const runAgentFn = async (options: RunAgentOptions): Promise<RunReport> => {
      runs += 1;
      expect(options.projectInstructions).toContain("Keep changes focused.");
      if (runs === 1) {
        const store = options.checkpoints;
        if (!store || typeof store === "boolean") throw new Error("checkpoint store missing");
        const checkpoint = await store.snapshot("before slash demo");
        options.onEvent?.({ type: "checkpoint_created", id: checkpoint.id, label: checkpoint.label });
        await writeFile(path.join(repo, "tracked.txt"), "changed by demo\n");
      }
      return report(`run ${runs}`);
    };
    const { input, output, text } = streams();
    input.end([
      "change the file", "/checkpoints", "/diff", "/cost", "/memory", "/help",
      "/model repl-test-model", "inspect again", "/rewind 1", "/exit", ""
    ].join("\n"));

    await runRepl(baseOptions(input, output, {
      mode: "auto",
      runAgentFn,
      providerFactory: (providerOptions) => {
        models.push(providerOptions.model);
        return scriptedProvider([messageTurn("unused")]);
      }
    }));

    expect(models).toEqual([undefined, "repl-test-model"]);
    expect(text()).toContain("before slash demo");
    expect(text()).toContain("-before");
    expect(text()).toContain("+changed by demo");
    expect(text()).toContain("1 rounds · 0 tool calls · 2 tokens");
    expect(text()).toContain("Keep changes focused.");
    expect(text()).toContain("/mode <ask|edit|auto>");
    expect(text()).toContain("Restored checkpoint 1: before slash demo.");
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("before\n");
  });

  it("keeps only five earlier exchanges and caps each side at 500 characters", async () => {
    const calls: RunAgentOptions[] = [];
    const runAgentFn = async (options: RunAgentOptions): Promise<RunReport> => {
      calls.push(options);
      return report(calls.length === 1 ? "r".repeat(600) : `answer ${calls.length}`);
    };
    const { input, output } = streams();
    input.end(["q".repeat(600), "question 2", "question 3", "question 4", "question 5", "question 6", "/exit", ""].join("\n"));

    await runRepl(baseOptions(input, output, { mode: "ask", runAgentFn }));

    const finalTask = calls.at(-1)!.task;
    expect(finalTask.match(/^Input:/gm)).toHaveLength(5);
    expect(finalTask).toContain(`${"q".repeat(499)}…`);
    expect(finalTask).toContain(`${"r".repeat(499)}…`);
    expect(finalTask).toContain("Input: question 5");
  });

  it("treats EOF and Ctrl+C at an approval prompt as deny", async () => {
    const eofStreams = streams();
    eofStreams.input.end("try eof\n");
    await runRepl(baseOptions(eofStreams.input, eofStreams.output, {
      providerFactory: () => mutationProvider([["eof-denied.txt", "no\n"]])
    }));
    await expect(readFile(path.join(repo, "eof-denied.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const interrupted = streams();
    const running = runRepl(baseOptions(interrupted.input, interrupted.output, {
      providerFactory: () => mutationProvider([["interrupt-denied.txt", "no\n"]])
    }));
    interrupted.input.write("try interrupt\n");
    await waitUntil(() => interrupted.text().includes("Allow write_file interrupt-denied.txt"));
    interrupted.input.write("\u0003");
    interrupted.input.end("/exit\n");
    await running;

    await expect(readFile(path.join(repo, "interrupt-denied.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears partial TTY input on Ctrl+C and exits after two empty interrupts", async () => {
    const calls: RunAgentOptions[] = [];
    const { input, output, text } = streams(true);
    const running = runRepl(baseOptions(input, output, {
      mode: "ask",
      runAgentFn: async (options) => {
        calls.push(options);
        return report("answered");
      },
      providerFactory: () => scriptedProvider([messageTurn("unused")])
    }));
    await waitUntil(() => text().includes("onehand> "));
    input.write("discard this");
    input.write("\u0003");
    input.write("real question\n");
    await waitUntil(() => calls.length === 1);
    await waitUntil(() => (text().match(/onehand> /g)?.length ?? 0) >= 2);
    input.write("\u0003");
    await waitUntil(() => text().includes("Press Ctrl+C again to exit."));
    input.write("\u0003");
    await running;

    expect(calls[0]?.task).toBe("real question");
    expect(text()).toContain("Press Ctrl+C again to exit.");
  });

  it("discards partial piped input on Ctrl+C and preserves CRLF lines", async () => {
    const calls: RunAgentOptions[] = [];
    const { input, output } = streams();
    const running = runRepl(baseOptions(input, output, {
      mode: "ask",
      runAgentFn: async (options) => {
        calls.push(options);
        return report("answered");
      }
    }));
    input.write("discard this partial input");
    input.write("\u0003");
    input.end("real piped question\r\n/exit\r\n");

    await running;

    expect(calls.map((call) => call.task)).toEqual(["real piped question"]);
  });

  it("writes the transcript from a successful real scripted-provider run", async () => {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e \"\"" } }));
    const provider = scriptedProvider([
      toolTurn("set_plan", { steps: ["inspect tracked file", "verify repository"] }, "plan"),
      toolTurn("read_file", { path: "tracked.txt" }, "read"),
      toolTurn("update_plan", { stepId: 1, status: "completed", evidence: "read tracked.txt" }, "complete-read"),
      toolTurn("update_plan", { stepId: 2, status: "in_progress" }, "start-test"),
      toolTurn("run_tests", {}, "test"),
      toolTurn("update_plan", { stepId: 2, status: "completed", evidence: "npm test passed" }, "complete-test"),
      toolTurn("finish_task", { summary: "Inspected tracked.txt successfully." }, "finish")
    ]);
    const { input, output, text } = streams();
    input.end("inspect tracked.txt\n/exit\n");

    await runRepl(baseOptions(input, output, {
      cliRules: { allow: ["run_tests"] },
      providerFactory: () => provider
    }));

    expect(text()).toContain("✓ read_file read tracked.txt");
    expect(text()).toContain("Inspected tracked.txt successfully.");
    expect(text()).toContain("success · 7 rounds");
    await writeFile("/tmp/onehand-repl-transcript.txt", text());
  });
});

function baseOptions(
  input: PassThrough,
  output: PassThrough,
  overrides: Partial<Parameters<typeof runRepl>[0]> = {}
): Parameters<typeof runRepl>[0] {
  return {
    repoPath: repoFor(overrides),
    provider: "openai",
    input,
    output,
    userHome: activeUserHome,
    providerFactory: () => scriptedProvider([messageTurn("done")]),
    ...overrides
  };
}

let activeRepo = "";
let activeUserHome = "";
function repoFor(overrides: Partial<Parameters<typeof runRepl>[0]>): string {
  return typeof overrides.repoPath === "string" ? overrides.repoPath : activeRepo;
}

function streams(tty = false): { input: PassThrough; output: PassThrough; text(): string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (tty) {
    input.isTTY = true;
    output.isTTY = true;
  }
  let content = "";
  output.on("data", (chunk) => { content += chunk.toString("utf8"); });
  return { input, output, text: () => content };
}

function report(finalMessage: string): RunReport {
  return {
    status: "success", stopReason: "explicit_finish", task: "task", repo: activeRepo,
    changedFiles: [], commands: [], tests: [], diff: null, finalMessage,
    usage: {
      ...emptyTokenUsage(), modelRounds: 1, toolCalls: 0, inputTokens: 1,
      outputTokens: 1, cacheMissInputTokens: 1, totalTokens: 2, wallTimeMs: 1
    }
  };
}

function scriptedProvider(turns: ProviderTurn[]): ModelProvider {
  let index = 0;
  return {
    name: "openai",
    initialHistory: (content) => [{ role: "user", content }],
    toolResultItem: (call, output) => ({ callId: call.id, output }),
    complete: async (_request: ProviderRequest) => turns[index++] ?? messageTurn("done")
  };
}

function mutationProvider(files: Array<[string, string]>): ModelProvider {
  const turns: ProviderTurn[] = [toolTurn("set_plan", { steps: ["make requested changes"] }, "plan")];
  files.forEach(([file, content], index) => {
    turns.push(toolTurn("write_file", { path: file, content }, `write-${index}`));
  });
  turns.push(toolTurn("update_plan", {
    stepId: 1,
    status: "blocked",
    evidence: "scripted REPL test ends after exercising the mutation"
  }, "block"));
  return scriptedProvider(turns);
}

function toolTurn(name: string, args: Record<string, unknown>, id: string): ProviderTurn {
  return {
    historyItems: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }],
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    message: "",
    finishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: 1, cacheHitInputTokens: 0, cacheMissInputTokens: 1, totalTokens: 2 }
  };
}

function messageTurn(message: string): ProviderTurn {
  return {
    historyItems: [{ role: "assistant", content: message }],
    toolCalls: [], message, finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, cacheHitInputTokens: 0, cacheMissInputTokens: 1, totalTokens: 2 }
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for REPL output");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

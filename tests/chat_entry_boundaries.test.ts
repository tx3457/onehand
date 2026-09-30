import { PassThrough } from "node:stream";
import { lstat, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRepl, type RunReplOptions } from "../src/repl/index.js";
import { ChatSessionStore } from "../src/repl/session.js";
import { acquireRepositoryLock } from "../src/runtime/repositoryLock.js";
import { McpManager } from "../src/mcp/index.js";
import type { RunAgentOptions } from "../src/agent/runner.js";
import type { ModelProvider, ProviderTurn } from "../src/providers/types.js";
import type { RunReport } from "../src/types.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

describe("chat entry boundaries", () => {
  let repo: string;
  let home: string;
  let sessionDir: string;

  beforeEach(async () => {
    repo = await makeTempDir("onehand-chat-boundary-repo-");
    home = await makeTempDir("onehand-chat-boundary-home-");
    sessionDir = path.join(home, "sessions", "case");
    vi.stubEnv("ONEHAND_CHECKPOINT_DIR", path.join(home, "checkpoints"));
    await initGitRepo(repo);
    await writeFile(path.join(repo, "tracked.txt"), "before\n");
    await git(["add", "tracked.txt"], repo);
    await git(["commit", "-qm", "fixture"], repo);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all([cleanupTempDir(repo), cleanupTempDir(home)]);
  });

  function options(lines: string, extra: Partial<RunReplOptions> = {}): RunReplOptions {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end(lines);
    return { repoPath: repo, userHome: home, input, output, providerFactory: () => provider([]), ...extra };
  }

  it("rejects a second chat before creating session metadata, MCP or a provider", async () => {
    const held = await acquireRepositoryLock(repo, { scope: "chat", storageRoot: path.join(home, ".onehand", "locks") });
    const create = vi.fn(() => provider([]));
    const connect = vi.spyOn(McpManager.prototype, "connect");
    try {
      await expect(runRepl(options("/exit\n", { sessionDir, providerFactory: create }))).rejects.toThrow(/locked/i);
      await expect(lstat(sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(create).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await held.release();
    }
  });

  it("preserves an unfinished task until the user explicitly discards it", async () => {
    const tasks: string[] = [];
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += String(chunk); });
    await runRepl(options("first\nsecond\n/exit\n", {
      sessionDir, output,
      runAgentFn: async (value) => {
        tasks.push(value.task);
        return { ...report(), status: "budget_exhausted", stopReason: "step_budget" };
      }
    }));
    expect(tasks).toEqual(["first"]);
    const state = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    expect(state.activeTask.input).toBe("first");
    expect(text).toMatch(/unfinished task/i);
    expect(text).toContain("/discard");
  });

  it("archives an explicitly discarded task before accepting a new one", async () => {
    const tasks: string[] = [];
    await runRepl(options("first\n/discard\nsecond\n/exit\n", {
      sessionDir,
      runAgentFn: async (value) => {
        tasks.push(value.task);
        return tasks.length === 1 ? { ...report(), status: "budget_exhausted", stopReason: "step_budget" } : report();
      }
    }));
    expect(tasks).toEqual(["first", "second"]);
    const receipts = (await readdir(sessionDir)).filter((name) => name.startsWith("discarded-"));
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(await readFile(path.join(sessionDir, receipts[0]!), "utf8"));
    expect(receipt.task).toMatchObject({ input: "first", task: "first" });
    expect(receipt.task.runDir).toContain(`${sessionDir}/runs/`);
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("before\n");
  });

  it("keeps unfinished task behavior settings immutable until explicit discard", async () => {
    const create = vi.fn(() => provider([]));
    await runRepl(options("first\n/model different\n/profile baseline\n/mode auto\n/review\n/exit\n", {
      sessionDir, mode: "edit", model: "original-model", profile: "ctx",
      providerFactory: create,
      runAgentFn: async () => ({ ...report(), status: "budget_exhausted", stopReason: "step_budget" })
    }));
    const state = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    expect(state.config).toMatchObject({ model: "original-model", profile: "ctx", mode: "edit" });
    expect(state.activeTask.input).toBe("first");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps the recovery pointer if persisting discard fails", async () => {
    const tasks: string[] = [];
    let failClear = true;
    const save = ChatSessionStore.prototype.save;
    vi.spyOn(ChatSessionStore.prototype, "save").mockImplementation(async function(this: ChatSessionStore) {
      if (tasks.length && this.state.activeTask === null && failClear) {
        failClear = false;
        throw new Error("simulated storage failure");
      }
      await save.call(this);
    });
    await runRepl(options("first\n/discard\nsecond\n/discard\nthird\n/exit\n", {
      sessionDir,
      runAgentFn: async (value) => {
        tasks.push(value.task);
        return tasks.length === 1 ? { ...report(), status: "budget_exhausted", stopReason: "step_budget" } : report();
      }
    }));
    expect(tasks).toEqual(["first", "third"]);
  });

  it("offers discard without replay when a running task has no saved RunStore state", async () => {
    await runRepl(options("first\n/exit\n", {
      sessionDir, runAgentFn: async () => { throw new Error("interrupted before state"); }
    }));
    const tasks: string[] = [];
    await runRepl(options("/discard\nsecond\n/exit\n", {
      resume: sessionDir,
      runAgentFn: async (value) => { tasks.push(value.task); return report(); }
    }));
    expect(tasks).toEqual(["second"]);
    const state = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    expect(state.activeTask).toBeNull();
    expect((await readdir(sessionDir)).filter((name) => name.startsWith("discarded-"))).toHaveLength(1);
  });

  it.each(["saved-success", "resumed-success"])("rolls back failed %s finalization before allowing another task", async (scenario) => {
    await runRepl(options("first\n", {
      sessionDir, mode: "auto", maxSteps: 1,
      providerFactory: () => provider([call("set_plan", { steps: ["inspect"] }, "1")])
    }));
    const sidecarPath = path.join(sessionDir, "session.json");
    const original = JSON.parse(await readFile(sidecarPath, "utf8"));
    const runStatePath = path.join(original.activeTask.runDir, "state.json");
    async function markRunSuccess(extraUsage: boolean) {
      const state = JSON.parse(await readFile(runStatePath, "utf8"));
      state.status = "success";
      state.stopReason = "explicit_finish";
      state.finalMessage = "first done";
      state.plan.status = "completed";
      state.plan.validatedWriteRevision = state.plan.writeRevision;
      state.plan.steps = state.plan.steps.map((step: object) => ({ ...step, status: "completed" }));
      if (extraUsage) Object.assign(state.usage, { modelRounds: 2, inputTokens: 2, outputTokens: 2, totalTokens: 4, cacheMissInputTokens: 2 });
      await writeFile(runStatePath, JSON.stringify(state));
      return state;
    }
    if (scenario === "saved-success") await markRunSuccess(false);
    const save = ChatSessionStore.prototype.save;
    let failFinalization = true;
    vi.spyOn(ChatSessionStore.prototype, "save").mockImplementation(async function(this: ChatSessionStore) {
      if (this.state.activeTask === null && failFinalization) {
        failFinalization = false;
        throw new Error("simulated finalization storage failure");
      }
      await save.call(this);
    });
    const newTasks: string[] = [];
    await runRepl(options("second\n/discard\nthird\n/exit\n", {
      resume: sessionDir, maxSteps: 5,
      runAgentFn: async (value) => {
        if (value.resume) {
          const state = await markRunSuccess(true);
          return { ...report(), plan: state.plan, finalMessage: "first done", usage: state.usage };
        }
        newTasks.push(value.task.split("\n")[0]!);
        return report();
      }
    }));
    expect(newTasks).toEqual(["third"]);
    const final = JSON.parse(await readFile(sidecarPath, "utf8"));
    expect(final.memory).toEqual([{ input: "third", finalMessage: "done" }]);
    expect(final.usage.totalTokens).toBe(scenario === "saved-success" ? 4 : 6);
    const receipts = (await readdir(sessionDir)).filter((name) => name.startsWith("discarded-"));
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(sessionDir, receipts[0]!), "utf8")).task.input).toBe("first");
  });

  it.each([
    { field: "model", value: 7 }, { field: "model", value: "" },
    { field: "baseURL", value: 7 }, { field: "baseURL", value: "file:///tmp/endpoint" },
    { field: "baseURL", value: "https://user:secret@example.test/v1" },
    { field: "baseURL", value: "https://example.test/v1?token=secret" },
    { field: "baseURL", value: "https://example.test/v1#fragment" },
    { field: "testCommand", value: 7 }, { field: "maxSteps", value: -1 }
  ])("rejects invalid stored $field before MCP or provider creation ($value)", async ({ field, value }) => {
    await runRepl(options("/exit\n", { sessionDir }));
    const statePath = path.join(sessionDir, "session.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.config[field] = value;
    await writeFile(statePath, JSON.stringify(state));
    const create = vi.fn(() => provider([]));
    const connect = vi.spyOn(McpManager.prototype, "connect");
    await expect(runRepl(options("/exit\n", { resume: sessionDir, providerFactory: create }))).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a syntactically valid changed endpoint before any model completion", async () => {
    await runRepl(options("inspect\n", {
      sessionDir, mode: "auto", maxSteps: 1,
      providerFactory: () => provider([call("set_plan", { steps: ["inspect"] }, "1")])
    }));
    const statePath = path.join(sessionDir, "session.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.config.baseURL = "https://changed.example.test/v1";
    await writeFile(statePath, JSON.stringify(state));
    const complete = vi.fn(async () => { throw new Error("must not call model"); });
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += String(chunk); });
    await runRepl(options("/exit\n", {
      resume: sessionDir, maxSteps: 2, output, providerFactory: () => ({ ...provider([]), complete })
    }));
    expect(text).toMatch(/run behavior/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects a symlinked storage parent inside the repo before creating it", async () => {
    const alias = path.join(home, "repo-alias");
    await symlink(repo, alias);
    await expect(runRepl(options("/exit\n", { sessionDir: path.join(alias, "leaked-session") })))
      .rejects.toThrow(/outside.*repo/i);
    await expect(lstat(path.join(repo, "leaked-session"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("explains and persists ambiguous test detection before starting a task", async () => {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFile(path.join(repo, "pnpm-lock.yaml"), "");
    await writeFile(path.join(repo, "yarn.lock"), "");
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += String(chunk); });
    await runRepl(options("/help\n/exit\n", { sessionDir, output }));
    const state = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    expect(state.config.testCommandResolution).toMatchObject({ status: "ambiguous", command: null });
    expect(text).toMatch(/conflicting.*pnpm.*yarn/i);
    expect(text).toContain("--test");
    expect(text).not.toContain("auto-detect");
  });

  it("pins effective model/endpoint defaults while preserving fresh user input and redacting storage", async () => {
    const calls: RunAgentOptions[] = [];
    const runAgentFn = async (value: RunAgentOptions) => { calls.push(value); return report(); };
    vi.stubEnv("OPENAI_MODEL", "original-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://original.example.test/v1");
    const input = "Explain this example token=sample123";
    await runRepl(options(`${input}\n/exit\n`, { sessionDir, mode: "ask", runAgentFn }));
    expect(calls[0]!.task).toBe(input);
    const raw = await readFile(path.join(sessionDir, "session.json"), "utf8");
    expect(raw).not.toContain("sample123");
    expect(JSON.parse(raw).config).toMatchObject({ model: "original-model", baseURL: "https://original.example.test/v1" });
    vi.stubEnv("OPENAI_MODEL", "different-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://different.example.test/v1");
    await runRepl(options("continue with a new task\n/exit\n", { resume: sessionDir, runAgentFn }));
    expect(calls[1]).toMatchObject({ model: "original-model", baseURL: "https://original.example.test/v1" });
  });

  it("restores declarative denies but not transient always approvals", async () => {
    const request = { name: "write_file", args: { path: "tracked.txt", content: "change" }, risk: "write" as const };
    const decisions: string[] = [];
    const runAgentFn = async (value: RunAgentOptions) => {
      decisions.push(await value.authorize!(request));
      return report();
    };
    await runRepl(options("first\n/exit\n", { sessionDir, mode: "auto", cliRules: { deny: ["write_file"] }, runAgentFn }));
    await runRepl(options("second\n/exit\n", { resume: sessionDir, runAgentFn }));
    expect(decisions).toEqual(["deny", "deny"]);

    const approvalsDir = path.join(home, "sessions", "approvals");
    decisions.length = 0;
    await runRepl(options("first\na\n/exit\n", { sessionDir: approvalsDir, mode: "edit", runAgentFn }));
    await runRepl(options("second\nn\n/exit\n", { resume: approvalsDir, runAgentFn }));
    expect(decisions).toEqual(["allow", "deny"]);
  });

  it("does not finalize a successful run belonging to a different task", async () => {
    await runRepl(options("inspect\n", {
      sessionDir, mode: "auto", maxSteps: 1,
      providerFactory: () => provider([call("set_plan", { steps: ["inspect"] }, "1")])
    }));
    const sessionPath = path.join(sessionDir, "session.json");
    const saved = JSON.parse(await readFile(sessionPath, "utf8"));
    const runStatePath = path.join(saved.activeTask.runDir, "state.json");
    const state = JSON.parse(await readFile(runStatePath, "utf8"));
    state.status = "success";
    state.task = "unrelated task";
    await writeFile(runStatePath, JSON.stringify(state));
    const create = vi.fn(() => provider([]));
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += String(chunk); });
    await runRepl(options("/exit\n", { resume: sessionDir, output, providerFactory: create }));
    expect(text).toMatch(/does not match/i);
    expect(create).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(sessionPath, "utf8")).memory).toEqual([]);
  });

  it("awaits durable checkpoint association before allowing a file mutation", async () => {
    let started!: () => void;
    let release!: () => void;
    const checkpointEntered = new Promise<void>((resolve) => { started = resolve; });
    const checkpointReleased = new Promise<void>((resolve) => { release = resolve; });
    const originalSave = ChatSessionStore.prototype.save;
    let held = false;
    vi.spyOn(ChatSessionStore.prototype, "save").mockImplementation(async function(this: ChatSessionStore) {
      if (this.state.activeTask?.checkpoint && !held) {
        held = true;
        started();
        await checkpointReleased;
      }
      await originalSave.call(this);
    });
    const running = runRepl(options("change it\n", {
      sessionDir, mode: "auto", maxSteps: 2,
      providerFactory: () => provider([
        call("set_plan", { steps: ["change"] }, "1"),
        call("write_file", { path: "tracked.txt", content: "after\n" }, "2")
      ])
    }));
    try {
      await Promise.race([checkpointEntered, running.then(() => { throw new Error("Run ended before its checkpoint"); })]);
      expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("before\n");
    } finally {
      release();
      await running;
    }
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("after\n");
  });
});

function provider(turns: ProviderTurn[]): ModelProvider {
  return {
    name: "openai",
    initialHistory: (content) => [{ role: "user", content }],
    toolResultItem: (call, output) => ({ type: "function_call_output", call_id: call.id, output }),
    complete: async () => {
      const next = turns.shift();
      if (!next) throw new Error("Unexpected model call");
      return next;
    }
  };
}

function call(name: string, args: Record<string, unknown>, id: string): ProviderTurn {
  return { historyItems: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: id }],
    toolCalls: [{ id, name, arguments: args }], message: "",
    usage: { inputTokens: 1, outputTokens: 1, cacheHitInputTokens: 0, cacheMissInputTokens: 1, totalTokens: 2 } };
}

function report(): RunReport {
  return { status: "success", stopReason: "explicit_finish", repo: "fixture", task: "fixture", model: "original-model",
    finalMessage: "done", changedFiles: [], commands: [], tests: [], diff: "",
    plan: { revision: 0, status: "completed", steps: [], needsReplan: false, writeRevision: 0, validatedWriteRevision: 0 },
    usage: { modelRounds: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, cacheHitInputTokens: 0,
      cacheMissInputTokens: 1, totalTokens: 2, wallTimeMs: 1 } } as RunReport;
}

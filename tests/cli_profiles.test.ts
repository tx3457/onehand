import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILES } from "../src/agent/profile.js";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  runRepl: vi.fn(),
  createModelProvider: vi.fn(),
  runDoctor: vi.fn()
}));

vi.mock("../src/agent/runner.js", () => ({ runAgent: mocks.runAgent }));
vi.mock("../src/repl/index.js", () => ({ runRepl: mocks.runRepl }));
vi.mock("../src/providers/index.js", () => ({ createModelProvider: mocks.createModelProvider }));
vi.mock("../src/doctor.js", () => ({ runDoctor: mocks.runDoctor }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;

describe("CLI profiles", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.DEEPSEEK_API_KEY;
    mocks.runAgent.mockResolvedValue(emptyReport());
    mocks.runRepl.mockResolvedValue(undefined);
    mocks.runDoctor.mockReturnValue({ checks: [{ name: "git", status: "ok", required: true }], ok: true });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
    vi.restoreAllMocks();
  });

  it("uses ctx for run by default", async () => {
    await runCli(["run", "inspect", "--repo", "/tmp/repo"]);
    expect(mocks.runAgent).toHaveBeenCalledWith(expect.objectContaining({ profile: PROFILES.ctx }));
  });

  it("reports doctor failures with a nonzero exit code without constructing a provider", async () => {
    mocks.runDoctor.mockReturnValue({ checks: [{ name: "git", status: "missing", required: true }], ok: false });
    await runCli(["doctor"]);
    expect(mocks.runDoctor).toHaveBeenCalledWith({ provider: undefined });
    expect(console.log).toHaveBeenCalledWith("git: missing");
    expect(process.exitCode).toBe(1);
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it("checks only the requested doctor provider without requiring a model call", async () => {
    await runCli(["doctor", "--provider", "deepseek"]);
    expect(mocks.runDoctor).toHaveBeenCalledWith({ provider: "deepseek" });
    expect(process.exitCode).toBe(0);
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it("accepts baseline explicitly for run", async () => {
    await runCli(["run", "inspect", "--repo", "/tmp/repo", "--profile", "baseline"]);
    expect(mocks.runAgent).toHaveBeenCalledWith(expect.objectContaining({ profile: PROFILES.baseline }));
  });

  it.each(["run", "chat"])("accepts the local ctx-notices profile for %s", async (command) => {
    const args = command === "run"
      ? ["run", "inspect", "--repo", "/tmp/repo", "--profile", "ctx-notices"]
      : ["chat", "--repo", "/tmp/repo", "--profile", "ctx-notices"];
    await runCli(args);
    if (command === "run") expect(mocks.runAgent).toHaveBeenCalledWith(expect.objectContaining({ profile: PROFILES["ctx-notices"] }));
    else expect(mocks.runRepl).toHaveBeenCalledWith(expect.objectContaining({ profile: "ctx-notices" }));
  });

  it("requires an explicit profile on resume so saved sessions cannot silently switch to ctx", async () => {
    await runCli(["run", "inspect", "--repo", "/tmp/repo", "--resume", "/tmp/old-run"]);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/resume requires.*--profile.*original run/i));
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it.each(["baseline", "ctx"])("passes an explicit %s profile to the runner for resume validation", async (profile) => {
    await runCli(["run", "inspect", "--repo", "/tmp/repo", "--resume", "/tmp/old-run", "--profile", profile]);
    expect(mocks.runAgent).toHaveBeenCalledWith(expect.objectContaining({
      resume: "/tmp/old-run", profile: PROFILES[profile as "baseline" | "ctx"]
    }));
  });

  it("uses ctx for chat by default", async () => {
    await runCli(["chat", "--repo", "/tmp/repo"]);
    expect(mocks.runRepl).toHaveBeenCalledWith(expect.objectContaining({ profile: "ctx" }));
  });

  it("forwards an explicit baseline name to chat", async () => {
    await runCli(["chat", "--repo", "/tmp/repo", "--profile", "baseline"]);
    expect(mocks.runRepl).toHaveBeenCalledWith(expect.objectContaining({ profile: "baseline" }));
  });

  it("forwards chat test command, session directory and run budgets", async () => {
    await runCli(["chat", "--repo", "/tmp/repo", "--test", "pnpm test", "--session-dir", "/tmp/session",
      "--max-steps", "45", "--max-tool-calls", "90", "--max-input-tokens", "500000", "--max-output-tokens", "60000",
      "--max-wall-sec", "1200", "--timeout-sec", "60"]);
    expect(mocks.runRepl).toHaveBeenCalledWith(expect.objectContaining({
      testCommand: "pnpm test", sessionDir: "/tmp/session", maxSteps: 45, maxToolCalls: 90,
      maxInputTokens: 500000, maxOutputTokens: 60000, maxWallTimeMs: 1200000, timeoutSec: 60
    }));
  });

  it("lets a chat resume restore omitted settings instead of applying CLI defaults", async () => {
    delete process.env.OPENAI_API_KEY;
    await runCli(["chat", "--repo", "/tmp/repo", "--resume", "/tmp/session"]);
    expect(mocks.runRepl).toHaveBeenCalledWith(expect.objectContaining({
      resume: "/tmp/session", provider: undefined, profile: undefined, mode: undefined,
      thinking: undefined, reasoningEffort: undefined, temperature: undefined, maxSteps: undefined,
      cliRules: undefined
    }));
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it("preserves explicit chat resume overrides and resolves the restored provider credential", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    await runCli(["chat", "--repo", "/tmp/repo", "--resume", "/tmp/session", "--profile", "baseline", "--max-steps", "40"]);
    const options = mocks.runRepl.mock.calls[0]?.[0];
    expect(options).toMatchObject({ resume: "/tmp/session", profile: "baseline", maxSteps: 40 });
    await options.providerFactory({ provider: "deepseek", model: "test-model", baseURL: "https://example.invalid/v1" });
    expect(mocks.createModelProvider).toHaveBeenCalledWith({
      provider: "deepseek", apiKey: "test-deepseek-key", baseURL: "https://example.invalid/v1"
    });
  });

  it("forwards explicitly supplied resume permission rules for identity validation", async () => {
    await runCli(["chat", "--repo", "/tmp/repo", "--resume", "/tmp/session", "--deny", "write_file"]);
    expect(mocks.runRepl).toHaveBeenCalledWith(expect.objectContaining({
      cliRules: { allow: [], deny: ["write_file"] }
    }));
  });

  it.each(["run", "chat"])("validates unknown %s profiles before provider setup", async (command) => {
    delete process.env.OPENAI_API_KEY;
    const args = command === "run"
      ? ["run", "inspect", "--repo", "/tmp/repo", "--profile", "missing"]
      : ["chat", "--repo", "/tmp/repo", "--profile", "missing"];

    await runCli(args);

    expect(console.error).toHaveBeenCalledWith("Unknown agent profile: missing");
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.runRepl).not.toHaveBeenCalled();
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it.each(["run", "chat"])("rejects Docker-only %s profiles before provider setup", async (command) => {
    delete process.env.OPENAI_API_KEY;
    const args = command === "run"
      ? ["run", "inspect", "--repo", "/tmp/repo", "--profile", "ctx-sandbox"]
      : ["chat", "--repo", "/tmp/repo", "--profile", "ctx-sandbox"];

    await runCli(args);

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/ctx-sandbox.*local.*Docker/i));
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.runRepl).not.toHaveBeenCalled();
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });

  it.each(["run", "chat"])("rejects the Docker-only notice profile for %s", async (command) => {
    delete process.env.OPENAI_API_KEY;
    const args = command === "run"
      ? ["run", "inspect", "--repo", "/tmp/repo", "--profile", "ctx-sandbox-notices"]
      : ["chat", "--repo", "/tmp/repo", "--profile", "ctx-sandbox-notices"];

    await runCli(args);

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/ctx-sandbox-notices.*local.*Docker/i));
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.runRepl).not.toHaveBeenCalled();
    expect(mocks.createModelProvider).not.toHaveBeenCalled();
  });
});

async function runCli(args: string[]): Promise<void> {
  process.argv = ["node", "onehand", ...args];
  await import("../src/cli.js");
}

function emptyReport() {
  return {
    status: "success",
    repo: "/tmp/repo",
    task: "inspect",
    changedFiles: [],
    commands: [],
    tests: [],
    finalMessage: "done",
    diff: ""
  };
}

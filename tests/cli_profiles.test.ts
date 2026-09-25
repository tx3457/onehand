import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILES } from "../src/agent/profile.js";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  runRepl: vi.fn(),
  createModelProvider: vi.fn()
}));

vi.mock("../src/agent/runner.js", () => ({ runAgent: mocks.runAgent }));
vi.mock("../src/repl/index.js", () => ({ runRepl: mocks.runRepl }));
vi.mock("../src/providers/index.js", () => ({ createModelProvider: mocks.createModelProvider }));

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

  it("accepts baseline explicitly for run", async () => {
    await runCli(["run", "inspect", "--repo", "/tmp/repo", "--profile", "baseline"]);
    expect(mocks.runAgent).toHaveBeenCalledWith(expect.objectContaining({ profile: PROFILES.baseline }));
  });

  it("requires an explicit profile on resume so old baseline sessions cannot silently switch to ctx", async () => {
    await runCli(["run", "inspect", "--repo", "/tmp/repo", "--resume", "/tmp/old-run"]);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/resume requires.*--profile.*original run/i));
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it.each(["baseline", "ctx"])("resumes with an explicit %s profile", async (profile) => {
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

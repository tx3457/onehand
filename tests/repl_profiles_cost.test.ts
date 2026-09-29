import { PassThrough } from "node:stream";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROFILES } from "../src/agent/profile.js";
import type { RunAgentOptions } from "../src/agent/runner.js";
import type { ModelProvider, ProviderRequest, ProviderTurn } from "../src/providers/types.js";
import { runRepl, type RunReplOptions } from "../src/repl/index.js";
import { ReplRenderer, systemClock } from "../src/repl/renderer.js";
import type { RunReport } from "../src/types.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

const OFF_PEAK = Date.parse("2026-09-27T02:00:00Z");
const PEAK = Date.parse("2026-09-25T02:00:00Z");
const report: RunReport = {
  status: "success", task: "inspect", repo: "fixture", finalMessage: "done",
  changedFiles: [], commands: [], tests: [], diff: null,
  usage: {
    modelRounds: 1, toolCalls: 0, inputTokens: 10_000, outputTokens: 1_000,
    cacheHitInputTokens: 0, cacheMissInputTokens: 10_000, totalTokens: 11_000, wallTimeMs: 1
  }
};

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  return { input, output, text: () => text };
}

describe("REPL cost status", () => {
  it.each([[OFF_PEAK, "0.0021", "off-peak"], [PEAK, "0.0042", "peak"]] as const)(
    "shows current estimated USD at %s", (now, cost, basis) => {
      const io = streams();
      const renderer = new ReplRenderer(io.output, { ...systemClock, now: () => now });
      renderer.finish(report, "deepseek-flash");
      expect(io.text()).toContain(`success · 1 rounds · 11000 tokens · ~$${cost} (${basis} est.)`);
    }
  );

  it("keeps unknown models as tokens only", () => {
    const io = streams();
    new ReplRenderer(io.output).finish(report, "unknown-model");
    expect(io.text()).toContain("success · 1 rounds · 11000 tokens\n");
    expect(io.text()).not.toContain("$");
  });
});

describe("chat profiles and session pricing", () => {
  let repo: string;
  let userHome: string;
  beforeEach(async () => {
    repo = await makeTempDir("onehand-phase3-repl-");
    userHome = await makeTempDir("onehand-phase3-home-");
    await initGitRepo(repo);
    await writeFile(path.join(repo, "answer.txt"), "the answer is 42\n");
    await git(["add", "answer.txt"], repo);
    await git(["commit", "-qm", "fixture"], repo);
  });
  afterEach(async () => {
    await cleanupTempDir(repo);
    await cleanupTempDir(userHome);
  });

  async function session(lines: string, overrides: Partial<RunReplOptions> = {}) {
    const io = streams();
    io.input.end(lines);
    await runRepl({
      repoPath: repo, userHome, provider: "deepseek", mode: "ask", ...io,
      providerFactory: () => scripted(() => turn("done")),
      runAgentFn: async () => report,
      clock: { ...systemClock, now: () => OFF_PEAK },
      ...overrides
    });
    return io.text();
  }

  it("defaults to ctx and shows the selected profile in the banner and help", async () => {
    const calls: RunAgentOptions[] = [];
    const text = await session("/help\ninspect\n/exit\n", {
      runAgentFn: async (options) => { calls.push(options); return report; }
    });
    expect(calls[0]?.profile).toEqual(PROFILES.ctx);
    expect(calls[0]?.interactiveTools).toEqual(["explore", "review_changes"]);
    expect(text).toMatch(/OneHand chat.*profile: ctx/);
    expect(text).toContain("Profile: ctx");
    expect(text).toContain("/profile <name>");
  });

  it("switches profiles and preserves the last valid selection after rejection", async () => {
    const profiles: unknown[] = [];
    const text = await session("/profile baseline\nfirst\n/profile ctx-sandbox\nsecond\n/profile unknown\nthird\n/profile ctx\n/help\nfourth\n/exit\n", {
      runAgentFn: async (options) => { profiles.push(options.profile); return report; }
    });
    expect(profiles).toEqual([PROFILES.baseline, PROFILES.baseline, PROFILES.baseline, PROFILES.ctx]);
    expect(text).toContain("Profile: baseline");
    expect(text).toMatch(/ctx-sandbox.*local.*Docker/);
    expect(text).toContain("Unknown agent profile: unknown");
    expect(text).toContain("Profile: ctx");
  });

  it("reports the current profile without changing it when /profile has no argument", async () => {
    expect(await session("/profile\n/exit\n", { profile: "baseline" })).toContain("Profile: baseline");
  });

  it("accepts ctx-notices and rejects ctx-sandbox-notices", async () => {
    const profiles: unknown[] = [];
    const text = await session("/profile ctx-notices\nfirst\n/profile ctx-sandbox-notices\nsecond\n/exit\n", {
      runAgentFn: async (options) => { profiles.push(options.profile); return report; }
    });
    expect(profiles).toEqual([PROFILES["ctx-notices"], PROFILES["ctx-notices"]]);
    expect(text).toContain("Profile: ctx-notices");
    expect(text).toMatch(/ctx-sandbox-notices.*local.*Docker/);
  });

  it("rejects a Docker profile at startup before creating a provider", async () => {
    await expect(session("/exit\n", { profile: "ctx-sandbox" })).rejects.toThrow(/Docker/);
  });

  it("prices each model's usage separately across /model switches", async () => {
    const text = await session("first\n/model deepseek-v4-pro\nsecond\n/cost\n/exit\n", { model: "deepseek-flash" });
    expect(text).toContain("2 rounds · 0 tool calls · 22000 tokens · ~$0.0107 (off-peak est.)");
  });

  it("uses the provider default model for the estimate", async () => {
    const text = await session("inspect\n/cost\n/exit\n");
    expect(text).toContain("11000 tokens · ~$0.0086 (off-peak est.)");
  });

  it("uses the current rate for session estimates after a peak-window transition", async () => {
    let now = OFF_PEAK;
    let calls = 0;
    const text = await session("first\nsecond\n/cost\n/exit\n", {
      model: "deepseek-flash",
      clock: { ...systemClock, now: () => now },
      runAgentFn: async () => {
        if (++calls === 2) now = PEAK;
        return report;
      }
    });
    expect(text).toContain("11000 tokens · ~$0.0021 (off-peak est.)");
    expect(text).toContain("11000 tokens · ~$0.0042 (peak est.)");
    expect(text).toContain("22000 tokens · ~$0.0084 (peak est.)");
  });

  it("shows only tokens for an unknown model in both status and /cost", async () => {
    const text = await session("inspect\n/cost\n/exit\n", { model: "unknown-model" });
    expect(text).toContain("1 rounds · 0 tool calls · 11000 tokens\n");
    expect(text).not.toContain("$");
  });

  it("labels partial estimates when a session includes an unpriced model", async () => {
    const text = await session("first\n/model unknown-model\nsecond\n/cost\n/exit\n", { model: "deepseek-flash" });
    expect(text).toContain("22000 tokens · ~$0.0021 (off-peak est.; priced models only)");
  });

  it.each(["ctx", "baseline"])("keeps explore and /review working with %s", async (profile) => {
    const requests: ProviderRequest[] = [];
    let parentCalls = 0;
    const provider = scripted((request) => {
      requests.push(request);
      if (request.instructions.includes("You are the explore sub-agent")) return turn("answer.txt:1 says 42");
      if (request.instructions.includes("You are the review sub-agent")) return turn("no blocking issues");
      return parentCalls++ === 0 ? turn("", "explore", { question: "Find the answer" }) : turn("Found the answer");
    });
    const text = await session("inspect\n/review\n/cost\n/exit\n", {
      profile, model: "deepseek-flash", providerFactory: () => provider, runAgentFn: undefined
    });
    expect(text).toContain("explore finished · success");
    expect(text).toContain("review finished · success");
    expect(text).toContain("no blocking issues");
    expect(text).toContain("33000 tokens · ~$0.0063 (off-peak est.)");
    expect(text).toContain("44000 tokens · ~$0.0084 (off-peak est.)");
    expect(requests[0]!.tools.map((tool: any) => tool.name)).toContain("explore");
    for (const child of requests.filter((request) => request.instructions.includes("sub-agent."))) {
      expect(child.tools.map((tool: any) => tool.name)).not.toContain("explore");
      expect(child.tools.map((tool: any) => tool.name)).not.toContain("write_file");
    }
  });
});

function scripted(complete: (request: ProviderRequest) => ProviderTurn): ModelProvider {
  return {
    name: "deepseek", initialHistory: (content) => [{ role: "user", content }],
    toolResultItem: (call, output) => ({ callId: call.id, output }),
    complete: async (request) => complete(request)
  };
}

function turn(message: string, name?: string, args = {}): ProviderTurn {
  return {
    historyItems: [{ role: "assistant", content: message }], message,
    toolCalls: name ? [{ id: name, name, arguments: JSON.stringify(args) }] : [],
    usage: { ...report.usage! }
  };
}

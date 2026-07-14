import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../src/agent/persistence.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

describe("run persistence", () => {
  it("atomically stores resumable state and redacts secrets from state and trace", async () => {
    const runDir = await makeTempDir();
    dirs.push(runDir);
    const store = new RunStore({ runId: "run-test", runDir });
    await store.save({
      schemaVersion: 2,
      runId: "run-test",
      task: "test",
      repo: "/tmp/repo",
      gitHead: "abc",
      worktreeFingerprint: "def",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      history: [{ role: "user", content: "Bearer secret-token-value and sk-super-secret" }],
      plan: { revision: 0, status: "unset", steps: [], needsReplan: false, writeRevision: 0, validatedWriteRevision: 0 },
      usage: { modelRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheHitInputTokens: 0, cacheMissInputTokens: 0, totalTokens: 0, wallTimeMs: 0 },
      records: [],
      failureSignatures: {},
      finalMessage: "",
      status: "stopped",
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    });
    await store.trace("tool", { apiKey: "sk-super-secret", note: "Bearer secret-token-value" });
    const state = await readFile(store.statePath, "utf8");
    const trace = await readFile(store.tracePath, "utf8");
    expect(state + trace).not.toContain("sk-super-secret");
    expect(state + trace).not.toContain("secret-token-value");
    const loaded = await RunStore.load(runDir);
    expect(loaded.state.runId).toBe("run-test");
  });
});

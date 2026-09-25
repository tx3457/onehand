import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { PersistedRunState, redactDeep, RUN_STATE_VERSION, RunStore, summarizeToolArguments } from "../src/agent/persistence.js";
import { RunUsage } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const SECRET_KEYS = [
  "apiKey", "api_key", "DEEPSEEK_API_KEY", "authorization", "Authorization", "accessToken", "githubToken", "token",
  "tokens", "tokenValue", "refresh_tokens", "auth_token_value", "client_secret", "password", "passwd", "privateKey",
  "Cookie", "credentials", "reasoning_content"
];
const COUNTER_KEYS = [
  "inputTokens", "outputTokens", "cacheHitInputTokens", "cacheMissInputTokens", "totalTokens", "reasoningTokens",
  "maxInputTokens", "maxOutputTokens", "maxTurnOutputTokens"
];

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

describe("run persistence", () => {
  it("atomically stores resumable state and redacts secrets from state and trace", async () => {
    const runDir = await makeTempDir();
    dirs.push(runDir);
    const store = new RunStore({ runId: "run-test", runDir });
    await store.save({
      schemaVersion: RUN_STATE_VERSION,
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

  it("keeps numeric token counters through save, load, and trace", async () => {
    const runDir = await makeTempDir();
    dirs.push(runDir);
    const store = new RunStore({ runId: "run-counters", runDir });
    const usage: RunUsage = {
      modelRounds: 3, toolCalls: 5, inputTokens: 1200, outputTokens: 340, cacheHitInputTokens: 800,
      cacheMissInputTokens: 400, totalTokens: 1540, reasoningTokens: 120, wallTimeMs: 987
    };
    const limits = { maxInputTokens: 300_000, maxOutputTokens: 40_000, maxTurnOutputTokens: 8_192 };
    await store.save(stateWith({ runId: "run-counters", usage }));
    await store.trace("model_turn", { usage, limits });
    const loaded = await RunStore.load(runDir);
    expect(loaded.state.usage).toEqual(usage);
    const trace = JSON.parse((await readFile(store.tracePath, "utf8")).trim());
    expect(trace.data).toEqual({ usage, limits });
  });

  it("redacts string values under sensitive keys but keeps numbers, booleans, and nulls", () => {
    const secrets = Object.fromEntries(SECRET_KEYS.map((key) => [key, `plain-value-for-${key}`]));
    const counters = Object.fromEntries(COUNTER_KEYS.map((key, index) => [key, index + 1]));
    const redacted = redactDeep({
      nested: [{ ...secrets, ...counters, tokenValid: true, refreshToken: null, nanTokens: Number.NaN, tokenDetails: { id: 1 } }]
    });
    expect(redacted.nested[0]).toEqual({
      ...Object.fromEntries(SECRET_KEYS.map((key) => [key, "[REDACTED]"])),
      ...counters,
      tokenValid: true,
      refreshToken: null,
      nanTokens: "[REDACTED]",
      tokenDetails: "[REDACTED]"
    });
    expect(summarizeToolArguments({ token: "plain", maxTokens: 5, maxResults: 5, query: "api_key=abc123" })).toEqual({
      token: "[REDACTED]", maxTokens: 5, maxResults: 5, query: "api_key=[REDACTED]"
    });
  });

  it("redacts JSON-quoted credential forms inside a string value", () => {
    const secret = "sk-json-quoted-0000000000000";
    const value = redactDeep({
      note: `payload: {"apiKey":"${secret}","token": "shortvalue"}`
    });
    expect(value.note).not.toContain(secret);
    expect(value.note).not.toContain("shortvalue");
    expect(value.note).toContain('"apiKey":"[REDACTED]');
    expect(value.note).toContain('"token": "[REDACTED]');
  });

  it("rejects a state saved with the previous schema version", async () => {
    const runDir = await makeTempDir();
    dirs.push(runDir);
    await new RunStore({ runId: "run-v2", runDir }).save(stateWith({ runId: "run-v2", schemaVersion: 2 }));
    await expect(RunStore.load(runDir)).rejects.toThrow("Unsupported state schema version: 2");
  });

  it("rejects a state whose usage counter is not a number", async () => {
    const runDir = await makeTempDir();
    dirs.push(runDir);
    const usage = { ...stateWith({}).usage, inputTokens: "[REDACTED]" as unknown as number };
    await new RunStore({ runId: "run-corrupt", runDir }).save(stateWith({ runId: "run-corrupt", usage }));
    await expect(RunStore.load(runDir)).rejects.toThrow("Corrupt run state: usage.inputTokens is not a number");
  });
});

function stateWith(overrides: Partial<PersistedRunState>): PersistedRunState {
  return {
    schemaVersion: RUN_STATE_VERSION,
    runId: "run-test",
    task: "test",
    repo: "/tmp/repo",
    gitHead: "abc",
    worktreeFingerprint: "def",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    history: [],
    plan: { revision: 0, status: "unset", steps: [], needsReplan: false, writeRevision: 0, validatedWriteRevision: 0 },
    usage: { modelRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheHitInputTokens: 0, cacheMissInputTokens: 0, totalTokens: 0, wallTimeMs: 0 },
    records: [],
    failureSignatures: {},
    finalMessage: "",
    status: "stopped",
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

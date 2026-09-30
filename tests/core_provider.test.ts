import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_STATE_VERSION, RunStore } from "../src/agent/persistence.js";
import { DeepSeekChatProvider } from "../src/providers/deepseek.js";
import { createModelProvider, OpenAIResponsesProvider } from "../src/providers/index.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});

const providerRequest = {
  model: "contract-test-model",
  instructions: "system",
  history: [{ role: "user", content: "task" }],
  tools: [],
  reasoningEffort: "high" as const,
  thinking: "enabled" as const
};

describe("OpenAI provider", () => {
  it("uses an explicit API key and base URL without reading credentials from the network", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      id: "resp_contract",
      object: "response",
      status: "completed",
      output: [{
        id: "msg_contract",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "configured", annotations: [] }]
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createModelProvider({
      provider: "openai",
      apiKey: "contract-test-key",
      baseURL: "https://onehand.invalid/v1"
    });
    const turn = await provider.complete(providerRequest);

    expect(turn.message).toBe("configured");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = input instanceof Request ? input.url : String(input);
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    expect(url).toBe("https://onehand.invalid/v1/responses");
    expect(headers.get("authorization")).toBe("Bearer contract-test-key");
  });

  it("keeps an injected ResponsesClient and does not construct a network client", async () => {
    const networkFetch = vi.fn(() => {
      throw new Error("network client must not be used");
    });
    vi.stubGlobal("fetch", networkFetch);
    const create = vi.fn(async () => ({ model: "gpt-served", output: [], output_text: "injected" }));

    const responsesClient = { responses: { create } };
    const provider = createModelProvider({
      provider: "openai",
      apiKey: "unused-key",
      baseURL: "https://unused.invalid/v1",
      responsesClient
    });
    const turn = await provider.complete(providerRequest);
    const legacyInjectedTurn = await new OpenAIResponsesProvider(responsesClient).complete(providerRequest);

    expect(turn.message).toBe("injected");
    expect(turn.model).toBe("gpt-served");
    expect(legacyInjectedTurn.message).toBe("injected");
    expect(create).toHaveBeenCalledTimes(2);
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("maps an incomplete response to an output limit or a named incomplete reason", async () => {
    const finishReasonFor = async (reason: string) => (await new OpenAIResponsesProvider({
      responses: { create: async () => ({ status: "incomplete", incomplete_details: { reason }, output: [] }) }
    }).complete(providerRequest)).finishReason;
    expect(await finishReasonFor("max_output_tokens")).toBe("length");
    expect(await finishReasonFor("content_filter")).toBe("incomplete:content_filter");
  });

  it("drops trailing reasoning items that no output item follows", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [] };
    const call = { type: "function_call", name: "read_file", arguments: "{}", call_id: "call-1" };
    const cases = [
      [[reasoning], []],
      [[reasoning, call], [reasoning, call]],
      [[reasoning, call, { ...reasoning, id: "rs_2" }], [reasoning, call]]
    ];
    for (const [output, expected] of cases) {
      const provider = new OpenAIResponsesProvider({ responses: { create: async () => ({ status: "incomplete", output }) } });
      expect((await provider.complete(providerRequest)).historyItems).toEqual(expected);
    }
  });
});

describe("DeepSeek provider", () => {
  it("maps tool schemas, tool calls, thinking settings, usage, and reasoning pass-back", async () => {
    const toolCall = { id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } };
    const create = vi.fn(async (_input: Record<string, unknown>) => ({
      model: "deepseek-v4-pro-served",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "must not persist",
          tool_calls: [toolCall]
        }
      }],
      usage: {
        prompt_tokens: 12,
        prompt_cache_hit_tokens: 2,
        prompt_cache_miss_tokens: 10,
        completion_tokens: 4,
        total_tokens: 16,
        completion_tokens_details: { reasoning_tokens: 3 }
      }
    }));
    const provider = new DeepSeekChatProvider({ client: { chat: { completions: { create } } } as any });
    const turn = await provider.complete({
      model: "deepseek-v4-pro",
      instructions: "system",
      history: [{ role: "user", content: "task" }],
      tools: [{ type: "function", name: "read_file", description: "read", parameters: { type: "object", properties: {} } }],
      reasoningEffort: "high",
      thinking: "enabled",
      temperature: 0.2
    });
    const payload = create.mock.calls[0]![0] as any;
    expect(payload.tools[0].function.name).toBe("read_file");
    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(turn.toolCalls).toEqual([{ id: "call-1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" }]);
    expect(turn.historyItems).toEqual([
      { role: "assistant", content: null, reasoning_content: "must not persist", tool_calls: [toolCall] }
    ]);
    expect(turn.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, cacheHitInputTokens: 2, reasoningTokens: 3 });
    expect(turn.model).toBe("deepseek-v4-pro-served");
    expect(provider.toolResultItem(turn.toolCalls[0]!, "ok")).toEqual({ role: "tool", tool_call_id: "call-1", content: "ok" });

    const runDir = await makeTempDir();
    dirs.push(runDir);
    const store = new RunStore({ runId: "provider-test", runDir });
    await store.save({
      schemaVersion: RUN_STATE_VERSION,
      runId: "provider-test",
      task: "task",
      repo: "/tmp/repo",
      gitHead: null,
      worktreeFingerprint: null,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      profile: { name: "baseline", flags: {} },
      agentBehaviorFingerprint: "a".repeat(64),
      runBehaviorFingerprint: "b".repeat(64),
      history: [{ role: "user", content: "task" }, ...turn.historyItems],
      plan: { revision: 0, status: "unset", steps: [], needsReplan: false, writeRevision: 0, validatedWriteRevision: -1 },
      usage: { modelRounds: 1, toolCalls: 0, wallTimeMs: 0, ...turn.usage },
      records: [],
      failureSignatures: {},
      finalMessage: "",
      status: "stopped",
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    });
    const saved = await readFile(store.statePath, "utf8");
    expect(saved).not.toContain("must not persist");
    expect(JSON.parse(saved).history[1]).toEqual({
      role: "assistant", content: null, reasoning_content: "[REDACTED]", tool_calls: [toolCall]
    });
  });

  it("keeps a string content on a reasoning-only, tool-call-free turn so it replays without content: null", async () => {
    const create = vi.fn(async () => ({
      model: "deepseek-v4-pro",
      choices: [{
        finish_reason: "length",
        message: { role: "assistant", content: null, reasoning_content: "still thinking, ran out of output budget" }
      }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
    }));
    const provider = new DeepSeekChatProvider({ client: { chat: { completions: { create } } } });
    const turn = await provider.complete({ ...providerRequest, thinking: "enabled" });
    expect(turn.historyItems).toEqual([
      { role: "assistant", content: "", reasoning_content: "still thinking, ran out of output budget" }
    ]);
  });

  it("sends temperature only when thinking is disabled", async () => {
    const create = vi.fn(async (_input: Record<string, unknown>) => ({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }]
    }));
    const provider = new DeepSeekChatProvider({ client: { chat: { completions: { create } } } });
    await provider.complete({ ...providerRequest, thinking: "enabled", temperature: 0.7 });
    await provider.complete({ ...providerRequest, thinking: "disabled", temperature: 0.7 });
    expect(create.mock.calls[0]![0]).not.toHaveProperty("temperature");
    expect(create.mock.calls[1]![0]).toMatchObject({ thinking: { type: "disabled" }, temperature: 0.7 });
  });
});

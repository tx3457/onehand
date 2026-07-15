import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekChatProvider } from "../src/providers/deepseek.js";
import { createModelProvider, OpenAIResponsesProvider } from "../src/providers/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
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
    const create = vi.fn(async () => ({ output: [], output_text: "injected" }));

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
    expect(legacyInjectedTurn.message).toBe("injected");
    expect(create).toHaveBeenCalledTimes(2);
    expect(networkFetch).not.toHaveBeenCalled();
  });
});

describe("DeepSeek provider", () => {
  it("maps tool schemas, tool calls, thinking settings, and usage", async () => {
    const create = vi.fn(async (_input: Record<string, unknown>) => ({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "must not persist",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }]
        }
      }],
      usage: {
        prompt_tokens: 12,
        prompt_cache_hit_tokens: 2,
        prompt_cache_miss_tokens: 10,
        completion_tokens: 4,
        total_tokens: 16
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
    expect(JSON.stringify(turn.historyItems)).not.toContain("must not persist");
    expect(turn.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, cacheHitInputTokens: 2 });
    expect(provider.toolResultItem(turn.toolCalls[0]!, "ok")).toEqual({ role: "tool", tool_call_id: "call-1", content: "ok" });
  });
});

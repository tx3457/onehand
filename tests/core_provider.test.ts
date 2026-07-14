import { describe, expect, it, vi } from "vitest";
import { DeepSeekChatProvider } from "../src/providers/deepseek.js";

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

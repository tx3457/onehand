import OpenAI from "openai";
import { ModelProvider, NormalizedToolCall, ProviderRequest, ProviderTurn } from "./types.js";

type ChatClient = {
  chat: {
    completions: {
      create(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<any>;
    };
  };
};

export class DeepSeekChatProvider implements ModelProvider {
  readonly name = "deepseek" as const;
  private readonly client: ChatClient;

  constructor(options: { apiKey?: string; baseURL?: string; client?: ChatClient } = {}) {
    this.client = options.client ?? (new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? "https://api.deepseek.com",
      maxRetries: 0
    }) as unknown as ChatClient);
  }

  initialHistory(content: string): unknown[] {
    return [{ role: "user", content }];
  }

  async complete(request: ProviderRequest): Promise<ProviderTurn> {
    const tools = (request.tools as Array<Record<string, any>>).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
    const response = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: [{ role: "system", content: request.instructions }, ...request.history],
        tools,
        tool_choice: "auto",
        thinking: { type: request.thinking },
        reasoning_effort: request.reasoningEffort,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxOutputTokens,
        stream: false
      },
      { signal: request.signal }
    );
    const choice = response.choices?.[0];
    const message = choice?.message ?? { role: "assistant", content: "" };
    const toolCalls: NormalizedToolCall[] = (message.tool_calls ?? []).map((call: any) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments
    }));
    // Deliberately omit reasoning_content from persisted history.
    const historyMessage = {
      role: "assistant",
      content: message.content ?? null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {})
    };
    const usage = response.usage ?? {};
    const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
    const cacheMiss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - cacheHit);
    return {
      historyItems: [historyMessage],
      toolCalls,
      message: message.content ?? "",
      finishReason: choice?.finish_reason,
      usage: {
        inputTokens: usage.prompt_tokens ?? cacheHit + cacheMiss,
        outputTokens: usage.completion_tokens ?? 0,
        cacheHitInputTokens: cacheHit,
        cacheMissInputTokens: cacheMiss,
        totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
      }
    };
  }

  toolResultItem(call: NormalizedToolCall, output: string): unknown {
    return { role: "tool", tool_call_id: call.id, content: output };
  }
}

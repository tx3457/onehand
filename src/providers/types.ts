import { TokenUsage } from "../types.js";

export type NormalizedToolCall = {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
};

export type ProviderTurn = {
  historyItems: unknown[];
  toolCalls: NormalizedToolCall[];
  message: string;
  finishReason?: string;
  usage: TokenUsage;
};

export type ProviderRequest = {
  model: string;
  instructions: string;
  history: unknown[];
  tools: unknown[];
  reasoningEffort: "high" | "max";
  thinking: "enabled" | "disabled";
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export interface ModelProvider {
  readonly name: "openai" | "deepseek";
  initialHistory(content: string): unknown[];
  complete(request: ProviderRequest): Promise<ProviderTurn>;
  toolResultItem(call: NormalizedToolCall, output: string): unknown;
}

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    totalTokens: 0
  };
}

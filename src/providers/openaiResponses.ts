import OpenAI, { type ClientOptions } from "openai";
import { ModelProvider, NormalizedToolCall, ProviderRequest, ProviderTurn } from "./types.js";

export type ResponsesClient = {
  responses: {
    create(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<ResponseLike>;
  };
};

type ResponseLike = {
  output?: ResponseOutputItem[];
  output_text?: string;
  status?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
};

type ResponseOutputItem = {
  type?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  call_id?: string;
  content?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
};

export type OpenAIResponsesProviderOptions = {
  apiKey?: string;
  baseURL?: string;
  client?: ResponsesClient;
};

export class OpenAIResponsesProvider implements ModelProvider {
  readonly name = "openai" as const;
  private readonly client: ResponsesClient;

  constructor(options?: OpenAIResponsesProviderOptions | ResponsesClient) {
    if (isResponsesClient(options)) {
      this.client = options;
      return;
    }

    const sdkOptions: ClientOptions = {};
    if (options?.apiKey !== undefined) sdkOptions.apiKey = options.apiKey;
    if (options?.baseURL !== undefined) sdkOptions.baseURL = options.baseURL;
    this.client = options?.client ?? new OpenAI(sdkOptions) as unknown as ResponsesClient;
  }

  initialHistory(content: string): unknown[] {
    return [{ role: "user", content }];
  }

  async complete(request: ProviderRequest): Promise<ProviderTurn> {
    const response = await this.client.responses.create(
      {
        model: request.model,
        instructions: request.instructions,
        input: request.history,
        tools: request.tools,
        reasoning: { effort: request.reasoningEffort === "max" ? "high" : request.reasoningEffort },
        text: { verbosity: "low" },
        max_output_tokens: request.maxOutputTokens
      },
      { signal: request.signal }
    );
    const output = response.output ?? [];
    const toolCalls: NormalizedToolCall[] = output
      .filter((item) => item.type === "function_call" && item.name && item.call_id)
      .map((item) => ({
        id: item.call_id!,
        name: item.name!,
        arguments: item.arguments ?? {}
      }));
    const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
    const input = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;

    return {
      historyItems: output,
      toolCalls,
      message: extractMessage(response),
      finishReason: response.status,
      usage: {
        inputTokens: input,
        outputTokens,
        cacheHitInputTokens: cached,
        cacheMissInputTokens: Math.max(0, input - cached),
        totalTokens: response.usage?.total_tokens ?? input + outputTokens
      }
    };
  }

  toolResultItem(call: NormalizedToolCall, output: string): unknown {
    return { type: "function_call_output", call_id: call.id, output };
  }
}

function isResponsesClient(value: OpenAIResponsesProviderOptions | ResponsesClient | undefined): value is ResponsesClient {
  return typeof value === "object" && value !== null && "responses" in value;
}

function extractMessage(response: ResponseLike): string {
  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }
  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

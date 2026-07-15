import { DeepSeekChatProvider } from "./deepseek.js";
import { OpenAIResponsesProvider, ResponsesClient } from "./openaiResponses.js";
import { ModelProvider } from "./types.js";

type DeepSeekOptions = NonNullable<ConstructorParameters<typeof DeepSeekChatProvider>[0]>;

export function createModelProvider(options: {
  provider?: "openai" | "deepseek";
  apiKey?: string;
  baseURL?: string;
  responsesClient?: ResponsesClient;
  deepSeekClient?: DeepSeekOptions["client"];
} = {}): ModelProvider {
  if (options.provider === "deepseek") {
    return new DeepSeekChatProvider({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      client: options.deepSeekClient
    });
  }
  return new OpenAIResponsesProvider({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    client: options.responsesClient
  });
}

export type { ModelProvider, NormalizedToolCall, ProviderRequest, ProviderTurn } from "./types.js";
export type { ResponsesClient } from "./openaiResponses.js";
export { DeepSeekChatProvider } from "./deepseek.js";
export { OpenAIResponsesProvider } from "./openaiResponses.js";

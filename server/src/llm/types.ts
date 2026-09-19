export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionInput {
  messages: ChatMessage[];
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  provider: string;
  usage?: LlmUsage;
}

export interface ChatModel {
  readonly name: string;
  /** 最近一次调用的 token 用量（流式调用后由实现填充），供统计/成本观察 */
  lastUsage?: LlmUsage;
  complete(input: ChatCompletionInput): Promise<ChatCompletionResult>;
  /** 可选流式；无实现时由路由回退 complete */
  stream?(input: ChatCompletionInput): AsyncGenerator<string>;
}

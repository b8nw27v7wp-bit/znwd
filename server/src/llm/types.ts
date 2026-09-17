export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionInput {
  messages: ChatMessage[];
}

export interface ChatCompletionResult {
  content: string;
  provider: string;
}

export interface ChatModel {
  readonly name: string;
  complete(input: ChatCompletionInput): Promise<ChatCompletionResult>;
}

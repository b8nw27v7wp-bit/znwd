import type { ChatCompletionInput, ChatCompletionResult, ChatModel } from './types.js';
import { buildGroundedAnswer } from './grounded.js';

export class MockChatModel implements ChatModel {
  readonly name = 'mock';

  async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    const users = input.messages.filter((m) => m.role === 'user');
    const lastUser = users[users.length - 1];
    const question = lastUser?.content.trim() || '';
    const context = input.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    return {
      content: buildGroundedAnswer({
        question,
        context,
        historyTurns: users.length - 1,
      }),
      provider: this.name,
    };
  }

  async *stream(input: ChatCompletionInput): AsyncGenerator<string> {
    const { content } = await this.complete(input);
    const parts = content.split(/(?<=[。！？\n])/).filter(Boolean);
    for (const p of parts) yield p;
  }
}

import type { ChatCompletionInput, ChatCompletionResult, ChatModel } from './types.js';

/** 离线演示用：从最后一条 user 消息与上下文生成确定性回复 */
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
    const turns = users.length - 1;

    const hasKnowledge =
      context.includes('【企业知识】') && !context.includes('（无命中片段）');
    const multi =
      turns > 0
        ? `（已结合前序 ${turns} 轮对话上下文）`
        : '';
    const answer = hasKnowledge
      ? `根据展厅资料，关于「${question}」的要点如下：\n\n已在内部知识库检索到相关内容，请结合资料摘要查看。如需更详细参数或方案，可联系现场讲解或业务同事。${multi}\n\n（当前为 Mock 模型演示回复）`
      : `暂未在内部知识库中检索到直接相关内容。关于「${question}」，可先参考展项说明，或询问讲解员获取人工解答。${multi}\n\n（当前为 Mock 模型演示回复）`;

    return { content: answer, provider: this.name };
  }
}

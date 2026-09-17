import type { ChatCompletionInput, ChatCompletionResult, ChatModel } from './types.js';

/** 离线演示用：从最后一条 user 消息与上下文生成确定性回复 */
export class MockChatModel implements ChatModel {
  readonly name = 'mock';

  async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
    const question = lastUser?.content.trim() || '';
    const context = input.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    const hasKnowledge =
      context.includes('【企业知识】') && !context.includes('（无命中片段）');
    const answer = hasKnowledge
      ? `根据院内资料，关于「${question}」的要点如下：\n\n已在内部知识库检索到相关内容，请结合上方资料摘要查看。若需更精确条文，可尝试替换 knowledge/ 目录中的正式文档。\n\n（当前为 Mock 模型演示回复）`
      : `暂未在内部知识库中检索到直接相关内容。关于「${question}」，可先参考院内公开说明，或联系前台获取人工解答。\n\n（当前为 Mock 模型演示回复）`;

    return { content: answer, provider: this.name };
  }
}

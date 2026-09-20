package com.znwd.hostess.llm;

import java.util.List;
import java.util.function.Consumer;

/** 无网关演示模型：从 system 里的检索片段整理回答。 */
public class MockChatModel implements ChatModel {

    public static final String NAME = "mock";

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public LlmUsage lastUsage() {
        return null;
    }

    @Override
    public ChatModel.ChatCompletionResult complete(List<ChatMessage> messages) {
        String question = "";
        int userTurns = 0;
        StringBuilder context = new StringBuilder();
        for (ChatMessage m : messages) {
            if (m.role() == ChatRole.USER) {
                question = m.content().strip();
                userTurns++;
            } else if (m.role() == ChatRole.SYSTEM) {
                context.append(m.content()).append('\n');
            }
        }
        String content = GroundedAnswer.build(question, context.toString(), Math.max(0, userTurns - 1));
        return new ChatModel.ChatCompletionResult(content, NAME, null);
    }

    @Override
    public void stream(List<ChatMessage> messages, Consumer<String> onDelta) {
        String content = complete(messages).content();
        // 逐句吐字，模拟真实流：前端与 TTS 的行为在 mock 下也要能验证
        for (String piece : content.split("(?<=[。！？\\n])")) {
            if (!piece.isEmpty()) {
                onDelta.accept(piece);
            }
        }
    }
}

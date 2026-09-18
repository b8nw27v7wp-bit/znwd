import { useEffect, useRef } from 'react';
import { MessageBubble, type UiMessage } from './MessageBubble';

interface ChatPanelProps {
  messages: UiMessage[];
  busy: boolean;
  suggestions: string[];
  showSuggestions: boolean;
  onSuggest: (q: string) => void;
  onFeedback: (messageId: string, rating: 'up' | 'down') => void;
}

export function ChatPanel({
  messages,
  busy,
  suggestions,
  showSuggestions,
  onSuggest,
  onFeedback,
}: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant' && !m.streaming && !m.error)?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy, showSuggestions]);

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h1>对话咨询</h1>
        <p>可询问光伏清洁无人机、风场检测无人机、服务与展厅须知</p>
      </div>
      <div className="message-list">
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            canFeedback={m.id === lastAssistantId}
            onFeedback={(rating) => onFeedback(m.id, rating)}
          />
        ))}
        {busy && !messages.some((m) => m.streaming) && (
          <div className="bubble-row from-assistant">
            <div className="bubble bubble-bot bubble-busy">正在生成回答…</div>
          </div>
        )}
        {showSuggestions && suggestions.length > 0 && (
          <div className="suggestions" aria-label="推荐问题">
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => onSuggest(q)}
              >
                {q}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

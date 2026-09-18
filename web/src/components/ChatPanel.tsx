import { useEffect, useRef } from 'react';
import { MessageBubble, type UiMessage } from './MessageBubble';

interface ChatPanelProps {
  messages: UiMessage[];
  busy: boolean;
  suggestions: string[];
  showSuggestions: boolean;
  onSuggest: (q: string) => void;
}

export function ChatPanel({
  messages,
  busy,
  suggestions,
  showSuggestions,
  onSuggest,
}: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy, showSuggestions]);

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h1>对话咨询</h1>
        <p>可询问院区介绍、参观流程、开放平台等信息</p>
      </div>
      <div className="message-list">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {busy && (
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

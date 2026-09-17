export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  mode?: 'rag' | 'llm_only';
  sources?: Array<{ title: string; snippet: string }>;
  error?: boolean;
}

interface MessageBubbleProps {
  message: UiMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  return (
    <div className={`bubble-row ${isUser ? 'from-user' : 'from-assistant'}`}>
      <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-bot'} ${message.error ? 'bubble-error' : ''}`}>
        <div className="bubble-text">{message.text}</div>
        {!isUser && message.mode === 'llm_only' && (
          <div className="bubble-note">未命中内部资料，以下为通用回答</div>
        )}
        {!isUser && message.sources && message.sources.length > 0 && (
          <details className="sources">
            <summary>资料来源（{message.sources.length}）</summary>
            <ul>
              {message.sources.map((s, i) => (
                <li key={i}>
                  <strong>{s.title}</strong>
                  <span>{s.snippet}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

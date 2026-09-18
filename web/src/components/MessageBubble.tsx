export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  mode?: 'rag' | 'llm_only';
  sources?: Array<{ title: string; snippet: string }>;
  error?: boolean;
  streaming?: boolean;
  /** 知识库未覆盖（相关性闸门拦截） */
  noHit?: boolean;
  /** 访客反馈结果 */
  feedback?: 'up' | 'down';
}

interface MessageBubbleProps {
  message: UiMessage;
  /** 仅最后一条助手消息可反馈 */
  canFeedback?: boolean;
  onFeedback?: (rating: 'up' | 'down') => void;
}

export function MessageBubble({ message, canFeedback = false, onFeedback }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const voted = message.feedback !== undefined;
  return (
    <div className={`bubble-row ${isUser ? 'from-user' : 'from-assistant'}`}>
      <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-bot'} ${message.error ? 'bubble-error' : ''}`}>
        <div className="bubble-text">
          {message.text || (message.streaming ? '正在生成回答…' : '')}
        </div>
        {!isUser && message.noHit && (
          <div className="bubble-note">展厅资料未覆盖该问题，可换个问法</div>
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
        {!isUser && canFeedback && !message.streaming && !message.error && (
          <div className="bubble-feedback">
            {voted ? (
              <span className="feedback-done">{message.feedback === 'up' ? '已记录：有帮助' : '已记录：待改进'}</span>
            ) : (
              <>
                <button type="button" className="tool-btn" onClick={() => onFeedback?.('up')}>
                  有帮助
                </button>
                <button type="button" className="tool-btn" onClick={() => onFeedback?.('down')}>
                  没帮助
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

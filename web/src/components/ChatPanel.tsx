import { useEffect, useRef } from 'react';
import { MessageBubble, type UiMessage } from './MessageBubble';

interface ChatPanelProps {
  messages: UiMessage[];
  busy: boolean;
  disabled: boolean;
  suggestions: string[];
  showSuggestions: boolean;
  onSuggest: (q: string) => void;
  muted: boolean;
  speaking: boolean;
  onToggleMute: () => void;
  onStopSpeak: () => void;
  onReset: () => void;
}

export function ChatPanel({
  messages,
  busy,
  disabled,
  suggestions,
  showSuggestions,
  onSuggest,
  muted,
  speaking,
  onToggleMute,
  onStopSpeak,
  onReset,
}: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy, showSuggestions]);

  return (
    <div className="chat-panel">
      <div className="chat-toolbar" aria-label="功能选项">
        <button
          type="button"
          className="tool-btn"
          onClick={onToggleMute}
          aria-pressed={muted}
          title={muted ? '开启朗读' : '静音'}
        >
          {muted ? '开声' : '静音'}
        </button>
        <button
          type="button"
          className="tool-btn"
          onClick={onStopSpeak}
          disabled={!speaking}
          title="停止朗读"
        >
          停止
        </button>
        <button
          type="button"
          className="tool-btn"
          onClick={onReset}
          title="重新开始"
        >
          重置
        </button>
      </div>
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
      <p className="panel-foot">
        {busy
          ? '回答生成中，请稍候'
          : disabled
            ? '语音服务不可用，仍可文字提问'
            : '回答将自动语音朗读'}
      </p>
    </div>
  );
}

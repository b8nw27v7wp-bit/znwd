import { useEffect, useRef } from 'react';
import { MessageBubble, type UiMessage } from './MessageBubble';

interface ChatPanelProps {
  messages: UiMessage[];
  busy: boolean;
  disabled: boolean;
}

export function ChatPanel({ messages, busy, disabled }: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

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
        <div ref={endRef} />
      </div>
      <ComposerHint disabled={disabled} busy={busy} />
    </div>
  );
}

function ComposerHint({ disabled, busy }: { disabled: boolean; busy: boolean }) {
  return (
    <p className="panel-foot">
      {busy ? '回答生成中，请稍候' : disabled ? '语音服务不可用，仍可文字提问' : '回答将自动语音朗读'}
    </p>
  );
}

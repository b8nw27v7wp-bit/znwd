import { useCallback, useMemo, useState } from 'react';
import { sendChat } from './api/client';
import { ChatPanel } from './components/ChatPanel';
import { Composer } from './components/Composer';
import { Live2DStage } from './components/Live2DStage';
import { useSpeech } from './hooks/useSpeech';
import type { UiMessage } from './components/MessageBubble';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function App() {
  const [messages, setMessages] = useState<UiMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: '您好，我是 AI 虚拟接待员。可以问我院区概况、参观流程或开放平台等问题。',
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [voiceReady, setVoiceReady] = useState(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window,
  );
  const { state: speechState, speak, stop, muted, toggleMute } = useSpeech();

  const mood = useMemo(() => {
    if (speechState === 'speaking') return 'speaking' as const;
    if (busy) return 'thinking' as const;
    return 'idle' as const;
  }, [speechState, busy]);

  const handleSend = useCallback(
    async (text: string) => {
      if (busy) return;
      stop();
      setBusy(true);

      const userMsg: UiMessage = { id: uid(), role: 'user', text };
      setMessages((prev) => [...prev, userMsg]);

      try {
        const data = await sendChat(text);
        const botMsg: UiMessage = {
          id: uid(),
          role: 'assistant',
          text: data.answer,
          mode: data.mode,
          sources: data.sources?.map((s) => ({ title: s.title, snippet: s.snippet })),
        };
        setMessages((prev) => [...prev, botMsg]);
        if (typeof speechSynthesis !== 'undefined') {
          speak(data.answer);
        } else {
          setVoiceReady(false);
        }
      } catch (err) {
        const fail: UiMessage = {
          id: uid(),
          role: 'assistant',
          text: err instanceof Error ? err.message : '服务暂时不可用，请稍后再试。',
          error: true,
        };
        setMessages((prev) => [...prev, fail]);
      } finally {
        setBusy(false);
      }
    },
    [busy, speak, stop],
  );

  return (
    <div className="app">
      <aside className="left">
        <Live2DStage mood={mood} />
        <div className="voice-controls">
          <button type="button" onClick={toggleMute} className="ghost">
            {muted ? '开启朗读' : '静音'}
          </button>
          <button type="button" onClick={stop} className="ghost" disabled={speechState !== 'speaking'}>
            停止朗读
          </button>
          {!voiceReady && <span className="warn">当前浏览器不支持语音合成</span>}
        </div>
      </aside>
      <main className="right">
        <ChatPanel messages={messages} busy={busy} disabled={!voiceReady} />
        <Composer onSend={handleSend} busy={busy} />
      </main>
    </div>
  );
}

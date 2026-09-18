import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSuggestions, sendChat } from './api/client';
import { ChatPanel } from './components/ChatPanel';
import { Composer } from './components/Composer';
import { Live2DStage } from './components/Live2DStage';
import { useSpeech } from './hooks/useSpeech';
import type { UiMessage } from './components/MessageBubble';

const IDLE_MS = 120_000;

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function welcomeMessages(): UiMessage[] {
  return [
    {
      id: 'welcome',
      role: 'assistant',
      text: '您好，我是 AI 虚拟接待员。可以问我院区概况、参观流程或开放平台等问题。',
    },
  ];
}

export default function App() {
  const [messages, setMessages] = useState<UiMessage[]>(welcomeMessages);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState(() => newSessionId());
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [voiceReady, setVoiceReady] = useState(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window,
  );
  const lastActiveRef = useRef(Date.now());
  const busyRef = useRef(false);
  const { state: speechState, speak, stop, muted, toggleMute } = useSpeech();

  busyRef.current = busy;

  const touch = useCallback(() => {
    lastActiveRef.current = Date.now();
  }, []);

  const mood = useMemo(() => {
    if (speechState === 'speaking') return 'speaking' as const;
    if (busy) return 'thinking' as const;
    return 'idle' as const;
  }, [speechState, busy]);

  const showSuggestions =
    messages.length <= 1 && messages[0]?.id === 'welcome' && !busy;

  const resetConversation = useCallback(() => {
    stop();
    setBusy(false);
    setMessages(welcomeMessages());
    setSessionId(newSessionId());
    lastActiveRef.current = Date.now();
  }, [stop]);

  useEffect(() => {
    let cancelled = false;
    fetchSuggestions()
      .then((items) => {
        if (!cancelled) setSuggestions(items);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const bump = () => touch();
    const events: (keyof WindowEventMap)[] = [
      'pointerdown',
      'keydown',
      'wheel',
      'touchstart',
    ];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    const timer = window.setInterval(() => {
      if (busyRef.current) {
        lastActiveRef.current = Date.now();
        return;
      }
      if (speechState === 'speaking') {
        lastActiveRef.current = Date.now();
        return;
      }
      if (Date.now() - lastActiveRef.current >= IDLE_MS) {
        resetConversation();
      }
    }, 2_000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      window.clearInterval(timer);
    };
  }, [resetConversation, speechState, touch]);

  const handleSend = useCallback(
    async (text: string) => {
      if (busy) return;
      touch();
      stop();
      setBusy(true);

      const userMsg: UiMessage = { id: uid(), role: 'user', text };
      setMessages((prev) => [...prev, userMsg]);

      try {
        const data = await sendChat(text, sessionId);
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
        touch();
      }
    },
    [busy, messages, sessionId, speak, stop, touch],
  );

  return (
    <div className="app">
      <section className="rail">
        <div className="rail-top">
          <Live2DStage mood={mood} />
          <div className="voice-controls">
            <button
              type="button"
              onClick={toggleMute}
              className="ghost icon-btn"
              aria-label={muted ? '开启朗读' : '静音'}
              title={muted ? '开启朗读' : '静音'}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M2 6.5h2.5L8 3.5v9L4.5 9.5H2v-3z"
                  fill="currentColor"
                />
                {muted ? (
                  <path d="M10.5 6l3.5 4M14 6l-3.5 4" stroke="currentColor" strokeWidth="1.4" fill="none" />
                ) : (
                  <path
                    d="M10.5 6.2c.9.8.9 2.8 0 3.6M12.2 4.8c1.6 1.4 1.6 5 0 6.4"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    fill="none"
                    strokeLinecap="round"
                  />
                )}
              </svg>
            </button>
            <button
              type="button"
              onClick={stop}
              className="ghost icon-btn"
              disabled={speechState !== 'speaking'}
              aria-label="停止朗读"
              title="停止朗读"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              onClick={resetConversation}
              className="ghost icon-btn"
              aria-label="重新开始"
              title="重新开始"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  fill="none"
                  strokeLinecap="round"
                />
                <path d="M11 2.5v3h3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {!voiceReady && <span className="warn">当前浏览器不支持语音合成</span>}
          </div>
        </div>
        <div className="rail-bottom">
          <ChatPanel
            messages={messages}
            busy={busy}
            disabled={!voiceReady}
            suggestions={suggestions}
            showSuggestions={showSuggestions}
            onSuggest={handleSend}
          />
          <Composer onSend={handleSend} busy={busy} onTouch={touch} />
        </div>
      </section>
      <div className="blank" aria-hidden="true" />
    </div>
  );
}

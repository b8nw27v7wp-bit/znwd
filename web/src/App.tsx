import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSuggestions, sendChat, sendChatStream } from './api/client';
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
      text: '您好，我是 AI 虚拟讲解员。可以问我光伏清洁无人机、风场检测无人机、作业流程或服务合作等问题。',
    },
  ];
}

export default function App() {
  const [messages, setMessages] = useState<UiMessage[]>(welcomeMessages);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState(() => newSessionId());
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const lastActiveRef = useRef(Date.now());
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
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
    abortRef.current?.abort();
    abortRef.current = null;
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
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setBusy(true);

      const userMsg: UiMessage = { id: uid(), role: 'user', text };
      const botId = uid();
      const botMsg: UiMessage = {
        id: botId,
        role: 'assistant',
        text: '',
        streaming: true,
      };
      setMessages((prev) => [...prev, userMsg, botMsg]);

      const patchBot = (patch: Partial<UiMessage>) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === botId ? { ...m, ...patch } : m)),
        );
      };

      const finishWithData = (data: Awaited<ReturnType<typeof sendChat>>) => {
        patchBot({
          text: data.answer,
          mode: data.mode as 'rag' | 'llm_only',
          sources: data.sources?.map((s) => ({ title: s.title, snippet: s.snippet })),
          streaming: false,
          error: false,
        });
        speak(data.answer);
      };

      const failWith = (message: string) => {
        patchBot({
          text: message,
          error: true,
          streaming: false,
        });
      };

      try {
        try {
          const data = await sendChatStream(text, sessionId, {
            signal: ac.signal,
            onDelta: (delta) => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === botId
                    ? { ...m, text: (m.text || '') + delta, streaming: true }
                    : m,
                ),
              );
            },
          });
          if (ac.signal.aborted) return;
          finishWithData(data);
        } catch (streamErr) {
          if (ac.signal.aborted) return;
          // 回退非流式 POST /api/chat
          try {
            const data = await sendChat(text, sessionId);
            if (ac.signal.aborted) return;
            finishWithData(data);
          } catch (err) {
            failWith(
              err instanceof Error
                ? err.message
                : streamErr instanceof Error
                  ? streamErr.message
                  : '服务暂时不可用，请稍后再试。',
            );
          }
        }
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        setBusy(false);
        touch();
      }
    },
    [busy, sessionId, speak, stop, touch],
  );

  return (
    <div className="app">
      <section className="rail">
        <div className="rail-top">
          <Live2DStage mood={mood} />
        </div>
        <div className="rail-bottom">
          <ChatPanel
            messages={messages}
            busy={busy}
            suggestions={suggestions}
            showSuggestions={showSuggestions}
            onSuggest={handleSend}
          />
          <div className="chat-footer">
            <div className="chat-toolbar" aria-label="功能选项">
              <button
                type="button"
                className="tool-btn"
                onClick={toggleMute}
                aria-pressed={muted}
                title={muted ? '开启朗读' : '静音'}
              >
                {muted ? '开声' : '静音'}
              </button>
              <button
                type="button"
                className="tool-btn"
                onClick={stop}
                disabled={speechState !== 'speaking'}
                title="停止朗读"
              >
                停止
              </button>
              <button
                type="button"
                className="tool-btn"
                onClick={resetConversation}
                title="重新开始"
              >
                重置
              </button>
            </div>
            <Composer onSend={handleSend} busy={busy} onTouch={touch} />
          </div>
        </div>
      </section>
      <div className="blank" aria-hidden="true" />
    </div>
  );
}

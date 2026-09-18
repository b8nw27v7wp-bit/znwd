import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchHealth, fetchSuggestions, sendChat } from './api/client';
import { ChatPanel } from './components/ChatPanel';
import { Composer } from './components/Composer';
import { Live2DStage } from './components/Live2DStage';
import { useSpeech } from './hooks/useSpeech';
import type { UiMessage } from './components/MessageBubble';

const IDLE_MS = 120_000;
const HEALTH_MS = 15_000;

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
  const [online, setOnline] = useState<'connecting' | 'online' | 'offline'>('connecting');
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
    let cancelled = false;

    const probe = async () => {
      try {
        await fetchHealth();
        if (!cancelled) setOnline('online');
      } catch {
        if (!cancelled) setOnline('offline');
      }
    };

    probe();
    const timer = window.setInterval(probe, HEALTH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
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
      // 打过招呼后不再常驻推荐（复位后由 welcome 状态恢复）
      if (messages[0]?.id === 'welcome' && messages.length > 1) {
        // no-op; showSuggestions already derived from length
      }

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
        setOnline('online');
        if (typeof speechSynthesis !== 'undefined') {
          speak(data.answer);
        } else {
          setVoiceReady(false);
        }
      } catch (err) {
        if (err instanceof TypeError || (err instanceof Error && /fetch|network/i.test(err.message))) {
          setOnline('offline');
        }
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
            <button type="button" onClick={toggleMute} className="ghost">
              {muted ? '开启朗读' : '静音'}
            </button>
            <button
              type="button"
              onClick={stop}
              className="ghost"
              disabled={speechState !== 'speaking'}
            >
              停止朗读
            </button>
            <button type="button" onClick={resetConversation} className="ghost">
              重新开始
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
            online={online}
          />
          <Composer onSend={handleSend} busy={busy} onTouch={touch} />
        </div>
      </section>
      <div className="blank" aria-hidden="true" />
    </div>
  );
}

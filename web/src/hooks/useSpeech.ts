import { useCallback, useEffect, useRef, useState } from 'react';

export type SpeechState = 'idle' | 'speaking' | 'unsupported';

function pickChineseVoice(): SpeechSynthesisVoice | undefined {
  if (typeof speechSynthesis === 'undefined') return undefined;
  const voices = speechSynthesis.getVoices();
  return (
    voices.find((v) => v.lang === 'zh-CN') ||
    voices.find((v) => v.lang.startsWith('zh')) ||
    voices[0]
  );
}

export function useSpeech() {
  const [state, setState] = useState<SpeechState>(() =>
    typeof window !== 'undefined' && 'speechSynthesis' in window ? 'idle' : 'unsupported',
  );
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const warm = () => {
      pickChineseVoice();
    };
    warm();
    speechSynthesis.addEventListener?.('voiceschanged', warm);
    return () => {
      speechSynthesis.removeEventListener?.('voiceschanged', warm);
      speechSynthesis.cancel();
    };
  }, []);

  const stop = useCallback(() => {
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    utterRef.current = null;
    setState('idle');
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (typeof speechSynthesis === 'undefined' || muted) return;
      speechSynthesis.cancel();

      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean) return;

      const utter = new SpeechSynthesisUtterance(clean);
      const voice = pickChineseVoice();
      if (voice) utter.voice = voice;
      utter.lang = 'zh-CN';
      utter.rate = 1;
      utter.pitch = 1;
      utter.onstart = () => setState('speaking');
      utter.onend = () => {
        setState('idle');
        utterRef.current = null;
      };
      utter.onerror = () => {
        setState('idle');
        utterRef.current = null;
      };
      utterRef.current = utter;
      speechSynthesis.speak(utter);
    },
    [muted],
  );

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      if (next) speechSynthesis.cancel();
      return next;
    });
  }, []);

  return { state, speak, stop, muted, toggleMute };
}

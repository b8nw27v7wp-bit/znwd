import { useState, type FormEvent, type KeyboardEvent } from 'react';

interface ComposerProps {
  onSend: (text: string) => void;
  busy: boolean;
  onTouch?: () => void;
}

export function Composer({ onSend, busy, onTouch }: ComposerProps) {
  const [value, setValue] = useState('');

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    onTouch?.();
    onSend(text);
    setValue('');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={onSubmit}>
      <input
        type="text"
        value={value}
        placeholder="请输入问题，Enter 发送"
        onChange={(e) => {
          onTouch?.();
          setValue(e.target.value);
        }}
        onKeyDown={onKeyDown}
        disabled={busy}
        autoComplete="off"
      />
      <button type="submit" disabled={busy || !value.trim()}>
        发送
      </button>
    </form>
  );
}

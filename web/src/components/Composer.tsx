import { useState, type FormEvent, type KeyboardEvent } from 'react';

interface ComposerProps {
  onSend: (text: string) => void;
  busy: boolean;
}

export function Composer({ onSend, busy }: ComposerProps) {
  const [value, setValue] = useState('');

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setValue('');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        rows={2}
        value={value}
        placeholder="请输入问题，Enter 发送"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={busy}
      />
      <button type="submit" disabled={busy || !value.trim()}>
        发送
      </button>
    </form>
  );
}

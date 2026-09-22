import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SPEAK_CHARS, SPEAK_CHUNK_CHARS, sanitizeForSpeech, splitForSpeech, useSpeech } from './useSpeech';

/**
 * 语音播报测试：node 环境没有 window/speechSynthesis，全部用假实现顶替。
 * 重点盯三条：洗文本（别把 Markdown 记号念出来）、切片（长文别让 Chrome 静默）、
 * 开关与状态（关掉要立刻闭嘴，读完要回到 idle）。
 */

class FakeUtterance {
  text: string;
  lang = '';
  rate = 1;
  pitch = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  /** 浏览器错误事件的形状（真实实现里是 SpeechSynthesisErrorEvent） */
  onerror: ((ev?: { error?: string }) => void) | null = null;
  volume = 1;
  constructor(text: string) {
    this.text = text;
  }
}

type Engine = {
  synth: SpeechSynthesis;
  utterances: FakeUtterance[];
  spoken: string[];
  cancelCount: () => number;
};

function stubEngine(voices: Array<{ lang: string; name?: string }> = [{ lang: 'zh-CN', name: 'Tingting' }]): Engine {
  const utterances: FakeUtterance[] = [];
  const spoken: string[] = [];
  let cancels = 0;
  const synth = {
    speaking: false,
    paused: false,
    speak(u: FakeUtterance) {
      utterances.push(u);
      spoken.push(u.text);
      synth.speaking = true;
    },
    cancel() {
      cancels += 1;
      synth.speaking = false;
    },
    resume() {},
    getVoices: () => voices,
  };
  vi.stubGlobal('window', {
    speechSynthesis: synth,
    SpeechSynthesisUtterance: FakeUtterance,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  return { synth: synth as unknown as SpeechSynthesis, utterances, spoken, cancelCount: () => cancels };
}

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', memoryStorage());
});

describe('朗读文本清洗', () => {
  it('去掉 Markdown 记号、链接与代码块，只留能念出来的正文', () => {
    const raw = [
      '## 结论',
      '',
      '**叶片检测**不需要停机。',
      '',
      '- 依据：[巡检规程](https://example.com/a) 与 `3 级风` 以上要求。',
      '',
      '```js',
      'const x = 1',
      '```',
    ].join('\n');

    const clean = sanitizeForSpeech(raw);

    expect(clean).toContain('叶片检测不需要停机');
    expect(clean).toContain('巡检规程');
    expect(clean).toContain('3 级风');
    for (const noise of ['#', '*', '`', 'http', 'const x', '](']) {
      expect(clean).not.toContain(noise);
    }
  });
});

describe('朗读切片', () => {
  it('按句切分且每片不超过上限', () => {
    const text = '第一句。第二句！第三句？第四句；第五句。';
    const parts = splitForSpeech(text, 10);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(10));
    expect(parts.join('')).toBe(text);
  });

  it('单句超长时先按逗号断，再硬切，内容不丢', () => {
    const sentence = `${'甲'.repeat(80)}，${'乙'.repeat(80)}，${'丙'.repeat(80)}。`;
    const parts = splitForSpeech(sentence, SPEAK_CHUNK_CHARS);
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(SPEAK_CHUNK_CHARS));
    expect(parts.join('')).toBe(sentence);
  });

  it('默认上限与导出常量一致', () => {
    const parts = splitForSpeech('甲'.repeat(SPEAK_CHUNK_CHARS * 2));
    expect(parts.length).toBe(2);
  });
});

describe('播报状态机', () => {
  it('朗读前先停掉上一条，逐片排队，读完回到 idle', () => {
    const engine = stubEngine();
    const speech = useSpeech();
    expect(speech.supported).toBe(true);

    speech.speak('第一条。');
    expect(engine.cancelCount()).toBe(1);
    expect(speech.speaking.value).toBe(true);

    speech.speak('第二条很长。'.repeat(20));
    expect(engine.cancelCount()).toBe(2); // 换内容先取消
    expect(engine.spoken.length).toBeGreaterThan(1);

    const last = engine.utterances[engine.utterances.length - 1];
    expect(last?.lang).toBe('zh-CN');
    expect(last?.voice).toEqual({ lang: 'zh-CN', name: 'Tingting' });

    last?.onend?.();
    expect(speech.speaking.value).toBe(false);
    speech.stop();
  });

  it('关掉开关后不再朗读，并把选择落 localStorage', () => {
    const engine = stubEngine();
    const speech = useSpeech();
    expect(speech.enabled.value).toBe(true);

    speech.toggle();
    expect(speech.enabled.value).toBe(false);
    expect(localStorage.getItem('znwd.speak')).toBe('0');

    speech.speak('不该被念出来。');
    expect(engine.spoken.length).toBe(0);
    expect(speech.speaking.value).toBe(false);

    speech.toggle();
    expect(localStorage.getItem('znwd.speak')).toBe('1');
  });

  it('上次关过开关的机器重启后保持关闭', () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'znwd.speak': '0' }));
    const speech = useSpeech();
    expect(speech.enabled.value).toBe(false);
  });

  it('环境不支持时 supported=false，调用 speak 不报错也不读', () => {
    vi.stubGlobal('window', {});
    const speech = useSpeech();
    expect(speech.supported).toBe(false);
    expect(() => speech.speak('随便一句')).not.toThrow();
    expect(speech.speaking.value).toBe(false);
  });

  it('空回答不触发朗读', () => {
    const engine = stubEngine();
    const speech = useSpeech();
    speech.speak('   ');
    speech.speak('```\nonly code\n```');
    expect(engine.spoken.length).toBe(0);
  });

  it('超过上限的回答只读前 MAX_SPEAK_CHARS 个字', () => {
    const engine = stubEngine();
    const speech = useSpeech();
    speech.speak('甲'.repeat(MAX_SPEAK_CHARS * 2));
    expect(engine.spoken.join('').length).toBeLessThanOrEqual(MAX_SPEAK_CHARS);
    speech.stop();
  });
});

/**
 * 播报失败的可见性（plan.md 的 P0）。
 *
 * 现场最糟的表现是「一声不响」：应用照常调 speak、浏览器按自动播放策略拒掉、页面上什么都不显示。
 * 所以失败必须能被上报到运营视图，而**主动停读**（interrupted / canceled）不能混进来——
 * 那是换问题、点停读的正常语义，报出来只会把真故障淹掉。
 */
describe('播报失败的可见性', () => {
  it('not-allowed 会上报原因并复位状态', () => {
    const engine = stubEngine();
    const seen: string[] = [];
    const speech = useSpeech({ onError: (reason) => seen.push(reason) });

    speech.speak('一段回答。');
    expect(speech.speaking.value).toBe(true);

    engine.utterances[engine.utterances.length - 1]!.onerror?.({ error: 'not-allowed' });

    expect(seen).toEqual(['not-allowed']);
    expect(speech.lastError.value).toBe('not-allowed');
    expect(speech.speaking.value, '失败后要把「正在朗读」复位').toBe(false);
    expect(speech.enabled.value, '被浏览器拒掉不等于用户关了开关').toBe(true);
  });

  it('主动停读的 interrupted / canceled 不算失败', () => {
    const engine = stubEngine();
    const seen: string[] = [];
    const speech = useSpeech({ onError: (reason) => seen.push(reason) });

    speech.speak('一段回答。');
    engine.utterances[engine.utterances.length - 1]!.onerror?.({ error: 'interrupted' });
    expect(seen).toEqual([]);
    expect(speech.lastError.value).toBe('');

    speech.speak('另一段回答。');
    engine.utterances[engine.utterances.length - 1]!.onerror?.({ error: 'canceled' });
    expect(seen).toEqual([]);
    expect(speech.lastError.value).toBe('');
  });

  it('下一次成功播报会清掉上一次的失败标记', () => {
    const engine = stubEngine();
    const speech = useSpeech();
    speech.speak('第一段。');
    engine.utterances[engine.utterances.length - 1]!.onerror?.({ error: 'not-allowed' });
    expect(speech.lastError.value).toBe('not-allowed');

    speech.speak('第二段。');
    expect(speech.lastError.value).toBe('');
  });

  it('unlock() 播一段静音空 utterance 用来暖机，不改状态', () => {
    const engine = stubEngine();
    const speech = useSpeech();

    speech.unlock();

    expect(engine.utterances.length).toBe(1);
    expect(engine.utterances[0]!.text).toBe('');
    expect(engine.utterances[0]!.volume).toBe(0);
    expect(speech.speaking.value, '暖机不该把界面切成「正在朗读」').toBe(false);
    expect(speech.lastError.value).toBe('');

    // 环境不支持时也不能抛
    vi.stubGlobal('window', {});
    expect(() => useSpeech().unlock()).not.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SPEAK_CHARS, PLAYBACK_WATCHDOG_MS, SPEAK_CHUNK_CHARS, sanitizeForSpeech, splitForSpeech, useSpeech } from './useSpeech';

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

afterEach(() => {
  vi.useRealTimers();
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

/**
 * 服务端 TTS 路径。
 *
 * 这一组的价值：真机出声我没法在 CI 里验，但**取音频 → 排队播 → 失败降级 → 被停掉**这条逻辑
 * 可以钉死。踩过的坑都在这里：预取的那句没人消费会变成 unhandled rejection、播放被自动播放策略
 * 拒掉时不能静默、停读必须同时停住「正在播的」和「还没播的」。
 */
type FakeAudio = {
  src: string;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  paused: boolean;
  play: () => Promise<void>;
  pause: () => void;
};

/** 服务端播报环境：假 fetch + 假 Audio + 假 URL.createObjectURL；可选带浏览器合成器 */
function stubServer(options: { fail?: boolean; playRejects?: boolean; withSynth?: boolean } = {}) {
  const audios: FakeAudio[] = [];
  const bodies: string[] = [];
  const revoked: string[] = [];
  let seq = 0;

  const wav = new Blob([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])], { type: 'audio/wav' });
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ''));
    if (options.fail) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: 'speech_unavailable', message: '语音未启用（服务端 AUDIO_PROVIDER=none）' }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, blob: async () => wav } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);

  vi.stubGlobal('URL', {
    createObjectURL: () => `blob:fake/${++seq}`,
    revokeObjectURL: (url: string) => void revoked.push(url),
  });

  vi.stubGlobal(
    'Audio',
    class {
      src: string;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      paused = false;
      constructor(src: string) {
        this.src = src;
        audios.push(this as unknown as FakeAudio);
      }
      play(): Promise<void> {
        return options.playRejects ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
      }
      pause(): void {
        this.paused = true;
      }
    },
  );

  const engine = options.withSynth ? stubEngine() : null;
  if (!engine) {
    vi.stubGlobal('window', {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
  }
  return { audios, bodies, revoked, fetchMock, engine };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('服务端 TTS 播报', () => {
  it('服务端可用时走服务端：请求体带文本，用 Audio 播放', async () => {
    const env = stubServer();
    const speech = useSpeech();
    speech.setServerReady(true);
    expect(speech.engineKind.value).toBe('server');

    speech.speak('叶片检测要停机吗？');

    await vi.waitFor(() => expect(env.audios.length).toBe(1));
    expect(JSON.parse(env.bodies[0]!)).toEqual({ text: '叶片检测要停机吗？' });
    expect(env.audios[0]!.src).toContain('blob:');
    expect(speech.speaking.value).toBe(true);
  });

  it('多句时边播边预取：第一句还没播完，第二句的请求已经发出', async () => {
    const env = stubServer();
    const speech = useSpeech();
    speech.setServerReady(true);

    // 每片上限 120 字，短句会被切片器合并成一片（那是省请求数的正确行为）——
    // 想验预取就得给足长度，让切片真的分成三片
    const long = `${'甲'.repeat(80)}。${'乙'.repeat(80)}。${'丙'.repeat(80)}。`;
    speech.speak(long);

    // 先等第一片真的开始播（fetch 是同步发出的，audio 要等 blob resolve 之后才建）
    await vi.waitFor(() => expect(env.audios.length).toBe(1));
    expect(env.bodies.length, '第一片还在播时，第二片的请求已经在途').toBe(2);

    env.audios[0]!.onended?.();
    await vi.waitFor(() => expect(env.audios.length).toBe(2));
    expect(env.bodies.length).toBe(3); // 播第二片时预取第三片

    speech.stop();
  });

  it('播完最后一句回到 idle，并回收 blob URL', async () => {
    const env = stubServer();
    const speech = useSpeech();
    speech.setServerReady(true);

    speech.speak('只有一句。');
    await vi.waitFor(() => expect(env.audios.length).toBe(1));
    env.audios[0]!.onended?.();

    await vi.waitFor(() => expect(speech.speaking.value).toBe(false));
    expect(env.revoked.length).toBe(1);
  });

  it('中途失败只从未播放片段降级，并取消还在途的预取', async () => {
    const env = stubServer({ withSynth: true });
    const signals: AbortSignal[] = [];
    env.fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      const body = JSON.parse(String(init?.body)) as { text: string };
      if (body.text.includes('乙')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ message: '第二段合成失败' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(['wav'], { type: 'audio/wav' }),
      } as unknown as Response;
    });

    const speech = useSpeech();
    speech.setServerReady(true);
    const long = `${'甲'.repeat(80)}。${'乙'.repeat(80)}。${'丙'.repeat(80)}。`;
    speech.speak(long);

    await vi.waitFor(() => expect(env.audios).toHaveLength(1));
    env.audios[0]!.onended?.();
    await vi.waitFor(() => expect(env.engine!.spoken.length).toBeGreaterThan(0));

    expect(env.engine!.spoken.join('')).not.toContain('甲');
    expect(env.engine!.spoken.join('')).toContain('乙');
    expect(env.engine!.spoken.join('')).toContain('丙');
    expect(signals.some((signal) => signal.aborted)).toBe(true);
    speech.stop();
  });

  it('服务端 503 时当场降级到浏览器内置播报，并记住原因', async () => {
    const env = stubServer({ fail: true, withSynth: true });
    const speech = useSpeech();
    speech.setServerReady(true);

    speech.speak('这段会先试服务端。');

    await vi.waitFor(() => expect(env.engine!.spoken.length).toBe(1));
    expect(speech.serverReady.value, '失败后不再尝试服务端').toBe(false);
    expect(speech.engineKind.value).toBe('browser');
    expect(speech.lastError.value).toContain('语音未启用');
  });

  it('自动播放被浏览器拒掉时也降级，而不是静默不出声', async () => {
    const env = stubServer({ playRejects: true, withSynth: true });
    const speech = useSpeech();
    speech.setServerReady(true);

    speech.speak('这段会播放失败。');

    await vi.waitFor(() => expect(env.engine!.spoken.length).toBe(1));
    expect(speech.lastError.value).toContain('autoplay-blocked');
    expect(speech.serverReady.value).toBe(false);
  });

  it('运行中失败过之后，后续 health 再报可用也不复辟', async () => {
    const env = stubServer({ fail: true, withSynth: true });
    const speech = useSpeech();
    speech.setServerReady(true);
    speech.speak('先失败一次。');
    await vi.waitFor(() => expect(speech.serverReady.value).toBe(false));

    speech.setServerReady(true); // 陈旧的 health 结果

    expect(speech.serverReady.value, '失败过的会话不再回头信 health').toBe(false);
    void env;
  });

  it('stop() 停住正在播的那句，也不再继续后面的句子', async () => {
    const env = stubServer();
    const speech = useSpeech();
    speech.setServerReady(true);

    const long = `${'甲'.repeat(80)}。${'乙'.repeat(80)}。${'丙'.repeat(80)}。`;
    speech.speak(long);
    await vi.waitFor(() => expect(env.audios.length).toBe(1));

    speech.stop();
    expect(env.audios[0]!.paused, '正在播的要被暂停').toBe(true);
    expect(speech.speaking.value).toBe(false);

    await tick();
    expect(env.audios.length, '停读之后不该再起新的播放').toBe(1);
  });

  it('机器没有浏览器合成器时，服务端播报照样能用', async () => {
    const env = stubServer();
    const speech = useSpeech();
    expect(speech.supported, '这套环境里没有 speechSynthesis').toBe(false);

    speech.setServerReady(true);
    speech.speak('照样能出声。');

    await vi.waitFor(() => expect(env.audios.length).toBe(1));
  });

  it('没有浏览器合成器时开关仍默认为开（不许因为 supported=false 就把播报整体关掉）', () => {
    stubServer();
    const speech = useSpeech();
    expect(speech.supported).toBe(false);
    expect(speech.enabled.value, '开关初值只看用户上次的选择').toBe(true);
    expect(speech.available.value, '还没探到服务端时整体不可用').toBe(false);

    speech.setServerReady(true);
    expect(speech.available.value, '服务端可用即整体可用').toBe(true);
  });

  it('首次手势早于 health 时，serverReady 后仍会用静音音频暖机', () => {
    const env = stubServer();
    const speech = useSpeech();

    speech.unlock();
    expect(env.audios).toHaveLength(0);
    speech.setServerReady(true);

    expect(env.audios).toHaveLength(1);
    expect(env.audios[0]!.src.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('服务端模式下 unlock() 用一段静音音频暖机，不抛也不改状态', async () => {
    const env = stubServer();
    const speech = useSpeech();
    speech.setServerReady(true);

    expect(() => speech.unlock()).not.toThrow();

    expect(env.audios.length).toBe(1);
    expect(env.audios[0]!.src.startsWith('data:audio/wav;base64,')).toBe(true);
    expect(speech.speaking.value).toBe(false);
  });

  it('未启用服务端时仍走浏览器内置（回归）', async () => {
    const env = stubServer({ withSynth: true });
    const speech = useSpeech();
    expect(speech.engineKind.value).toBe('browser');

    speech.speak('走浏览器。');

    expect(env.engine!.spoken.length).toBeGreaterThan(0);
    expect(env.fetchMock, '不该白打一次语音接口').not.toHaveBeenCalled();
  });

  it('播放没有结束事件时 watchdog 会降级，避免一直卡在播报中', async () => {
    vi.useFakeTimers();
    const env = stubServer({ withSynth: true });
    const speech = useSpeech();
    speech.setServerReady(true);
    speech.speak('播放事件丢失。');

    await vi.advanceTimersByTimeAsync(0);
    expect(env.audios).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PLAYBACK_WATCHDOG_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(speech.lastError.value).toBe('audio-play-timeout');
    expect(env.engine!.spoken).toHaveLength(1);
    expect(speech.speaking.value).toBe(true);
    speech.stop();
  });

  it('Audio.onerror 会 reject 并触发浏览器播报降级', async () => {
    const env = stubServer({ withSynth: true });
    const speech = useSpeech();
    speech.setServerReady(true);
    speech.speak('播放失败时降级。');

    await vi.waitFor(() => expect(env.audios.length).toBe(1));
    env.audios[0]!.onerror?.();
    await vi.waitFor(() => expect(env.engine!.spoken.length).toBe(1));
    expect(speech.lastError.value).toBe('audio-play-failed');
    expect(speech.serverReady.value).toBe(false);
  });

  it('stop 会中止尚未返回的 TTS 请求', async () => {
    const env = stubServer();
    let resolveFetch: ((response: Response) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }));
    const speech = useSpeech();
    speech.setServerReady(true);
    speech.speak('取消在途请求。');
    await vi.waitFor(() => expect(requestSignal).toBeTruthy());

    speech.stop();
    expect(requestSignal?.aborted).toBe(true);
    resolveFetch?.(new Response(new Blob(['wav']), { status: 200 }));
    await tick();
    expect(env.audios.length).toBe(0);
  });
});

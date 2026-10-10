import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chunkRms,
  encodeWav,
  resample,
  TARGET_SAMPLE_RATE,
  dictationSupported,
  useDictation,
  vadStep,
  VAD_NO_SPEECH_MS,
  VAD_SILENCE_MS,
  type DictationOptions,
} from './useDictation';

/** 把 WAV 头读回来断言：这些字段错一个，服务端就会把它当成非 WAV 拒掉 */
function header(blob: Blob): Promise<DataView> {
  return blob.arrayBuffer().then((buffer) => new DataView(buffer));
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/** performance.now 探针的复位钩子：stop() 靠它把录音时长拨过 400ms 的有效门槛 */
let restoreNow: (() => void) | undefined;

afterEach(() => {
  restoreNow?.();
  restoreNow = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('encodeWav', () => {
  it('写出标准 RIFF 头与 16bit 单声道声明', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const view = await header(encodeWav(samples, TARGET_SAMPLE_RATE));

    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // 单声道
    expect(view.getUint32(24, true)).toBe(TARGET_SAMPLE_RATE);
    expect(view.getUint32(28, true)).toBe(TARGET_SAMPLE_RATE * 2); // 字节率
    expect(view.getUint16(34, true)).toBe(16); // 位深
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
  });

  it('把 [-1,1] 的浮点量化成 int16，负满量程不削顶', async () => {
    const view = await header(encodeWav(new Float32Array([0, 1, -1, 2, -2]), TARGET_SAMPLE_RATE));
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    // 用 0x8000 而不是 0x7fff：否则最小负值会被算成 -32767
    expect(view.getInt16(48, true)).toBe(-32768);
    // 越界输入按削顶处理，而不是回绕成噪声
    expect(view.getInt16(50, true)).toBe(32767);
    expect(view.getInt16(52, true)).toBe(-32768);
  });

  it('类型是 audio/wav：服务端按 data URL 的 MIME 校验，这里错了会被 400 拒掉', async () => {
    const blob = encodeWav(new Float32Array([0]), TARGET_SAMPLE_RATE);
    expect(blob.type).toBe('audio/wav');
    expect(await blob.arrayBuffer()).toHaveProperty('byteLength', 46);
  });
});

describe('resample', () => {
  it('48kHz 降到 16kHz 后样本数约为三分之一', () => {
    const input = new Float32Array(new Array(4800).fill(0).map((_, i) => Math.sin(i / 10)));
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(1600);
  });

  it('采样率相同时原样返回（不做无意义的重算）', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it('空输入不炸（误触录音时长度可能为 0）', () => {
    expect(resample(new Float32Array(0), 48000, 16000).length).toBe(0);
  });

  it('线性插值：常数信号重采样后还是同一个常数', () => {
    const input = new Float32Array(300).fill(0.25);
    const out = resample(input, 48000, 16000);
    for (const value of out) expect(value).toBeCloseTo(0.25, 5);
  });
});

describe('dictationSupported', () => {
  it('jsdom 下没有 getUserMedia，应当直接判定不支持（按钮不出现，而不是点了没反应）', () => {
    expect(dictationSupported()).toBe(false);
  });
});

/**
 * 假浏览器：getUserMedia + AudioContext + ScriptProcessorNode 三件套。
 * 返回 processor——stop() 的三条回调分支都要先往它里面喂 PCM 才走得到识别。
 */
function installBrowser(getUserMedia: () => Promise<MediaStream>, sampleRate = TARGET_SAMPLE_RATE) {
  const processor = {
    onaudioprocess: null as ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  class FakeAudioContext {
    sampleRate = sampleRate;
    destination = {};
    createMediaStreamSource = vi.fn(() => source);
    createScriptProcessor = vi.fn(() => processor);
    close = vi.fn(async () => {});
  }
  vi.stubGlobal('window', {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return { processor };
}

/**
 * stop() 的识别回调链：录音结束到 onText/onError 之间有三条出口，此前零覆盖——
 * 1) 识别成功 → onText 带去空白文本、error 清空；
 * 2) 录音 <400ms → 误触，不浪费一次识别调用，走「录音太短」提示；
 * 3) 识别接口失败 → onError 带后端文案，busy 必须复位（否则按钮永久禁用）。
 *
 * 桩法与 useSpeech.spec 同路子：不 mock 模块，stub 全局 fetch 走真 recognizeSpeech；
 * 另外 node 没有 FileReader（Blob→data URL 那步是浏览器 API），补一个最小实现。
 */
/** node 环境没有全局 FileReader：桩一个能把 Blob 转成 data URL 的最小实现 */
function installFileReader(): void {
  class FakeFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private aborted = false;

    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer().then(
        (buffer) => {
          if (this.aborted) return;
          const base64 = Buffer.from(buffer).toString('base64');
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
          this.onload?.();
        },
        () => {
          if (this.aborted) return;
          this.onerror?.();
        },
      );
    }

    abort(): void {
      this.aborted = true;
      this.onabort?.();
    }
  }
  vi.stubGlobal('FileReader', FakeFileReader);
}

/** 起一套能录音的假环境：必须先 stub 浏览器三件套，useDictation 才会判定「支持」 */
function startableDictation(options: DictationOptions = {}, sampleRate = TARGET_SAMPLE_RATE) {
  const getUserMedia = vi.fn(() =>
    Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream),
  );
  const { processor } = installBrowser(getUserMedia, sampleRate);
  return { dictation: useDictation(options), processor };
}

/** 喂一段 PCM：不喂的话 pcm 长度为 0，stop() 走「没有采到声音」而不是识别 */
function feedAudio(processor: {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null;
}): void {
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(320).fill(0.1) } });
}

/**
 * 喂一个与真实 ScriptProcessor 同尺寸的静音块（4096 帧 @16k ≈ 256ms）：
 * VAD 按时长累计，测试块的采样点数直接决定多久触发收尾，不能拿 320 的小块凑数。
 */
function feedSilence(processor: {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null;
}, fill = 0): void {
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(fill) } });
}

describe('录音操作生命周期', () => {
  it('getUserMedia 等待期间拒绝重复 start，并在释放后停止轨道', async () => {
    let resolveMedia: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    }));
    const stop = vi.fn();
    installBrowser(getUserMedia);
    const dictation = useDictation();

    const first = dictation.start();
    const second = dictation.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(dictation.pending.value).toBe(true);

    resolveMedia?.({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await Promise.all([first, second]);
    expect(dictation.pending.value).toBe(false);
    expect(dictation.recording.value).toBe(true);

    dictation.cancel();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dictation.recording.value).toBe(false);
  });

  it('dispose 使等待中的 getUserMedia 失效，返回的旧流也会被停止', async () => {
    let resolveMedia: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    }));
    const stop = vi.fn();
    installBrowser(getUserMedia);
    const dictation = useDictation();

    const starting = dictation.start();
    dictation.dispose();
    expect(dictation.pending.value).toBe(false);
    resolveMedia?.({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dictation.recording.value).toBe(false);
  });
});

describe('stop() 识别回调链', () => {
  it('识别成功：onText 拿到去空白文本，错误清空、busy 复位、确实打到识别接口', async () => {
    installFileReader();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ text: '  叶片有裂纹  ', seconds: 1.4 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onText = vi.fn();
    const onError = vi.fn();
    const { dictation, processor } = startableDictation({ onText, onError });

    await dictation.start();
    expect(dictation.recording.value).toBe(true);
    feedAudio(processor);
    now.mockReturnValue(1_500); // 录音 500ms，稳过 400ms 的有效门槛
    await dictation.stop();

    expect(onError).not.toHaveBeenCalled();
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('叶片有裂纹');
    expect(dictation.error.value).toBe('');
    expect(dictation.busy.value).toBe(false);
    expect(dictation.recording.value).toBe(false);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/speech/recognize');
  });

  it('录音太短（误触）：不打识别接口，走 onError 的既有提示', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onText = vi.fn();
    const onError = vi.fn();
    const { dictation } = startableDictation({ onText, onError });

    await dictation.start();
    // 不推进时钟：紧挨着 stop，真实时长远小于 400ms
    await dictation.stop();

    expect(fetchMock, '误触不该浪费一次识别调用').not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('录音太短');
    expect(dictation.error.value).toBe('录音太短');
    expect(dictation.busy.value).toBe(false);
    expect(dictation.recording.value).toBe(false);
  });

  it('识别接口失败：onError 收到后端文案，busy 复位（按钮不会永久禁用）', async () => {
    installFileReader();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: '语音识别服务不可用' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onText = vi.fn();
    const onError = vi.fn();
    const { dictation, processor } = startableDictation({ onText, onError });

    await dictation.start();
    feedAudio(processor);
    now.mockReturnValue(1_500); // 录音 500ms，稳过 400ms 的有效门槛
    await dictation.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onText).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('语音识别服务不可用');
    expect(dictation.error.value).toBe('语音识别服务不可用');
    expect(dictation.busy.value).toBe(false);
    expect(dictation.recording.value).toBe(false);
  });
});

describe('VAD 纯函数', () => {
  const init = () => ({ speechSeen: false, audible: false, silentMs: 0 });

  it('chunkRms：全零为 0，恒值信号的 RMS 等于其绝对值', () => {
    expect(chunkRms(new Float32Array(64))).toBe(0);
    expect(chunkRms(new Float32Array(0))).toBe(0);
    expect(chunkRms(new Float32Array(64).fill(0.05))).toBeCloseTo(0.05, 5);
    expect(chunkRms(new Float32Array(64).fill(-0.05))).toBeCloseTo(0.05, 5);
  });

  it('vadStep：达到说话阈值置 speechSeen/audible 并清零静音时长', () => {
    const state = vadStep({ ...init(), silentMs: 300 }, 0.05, 256);
    expect(state).toEqual({ speechSeen: true, audible: true, silentMs: 0 });
  });

  it('vadStep：低于地板的块累计静音时长，不动 speechSeen', () => {
    const armed = vadStep(init(), 0, 256);
    expect(armed).toEqual({ speechSeen: false, audible: false, silentMs: 256 });
    const afterSpeech = vadStep({ ...init(), speechSeen: true }, 0, 100);
    expect(afterSpeech).toEqual({ speechSeen: true, audible: false, silentMs: 100 });
  });

  it('vadStep：滞回带不触发说话，但按时长计入静音（环境音停在带内也能凑满收尾）', () => {
    const band = vadStep({ ...init(), speechSeen: true }, 0.015, 256);
    expect(band).toEqual({ speechSeen: true, audible: true, silentMs: 256 });
    const notArmed = vadStep(init(), 0.015, 256);
    expect(notArmed.speechSeen, '带内不误触发说话').toBe(false);
    expect(notArmed.audible, '带内算有动静').toBe(true);
    expect(notArmed.silentMs, '带内照样累计，不冻结').toBe(256);
  });

  it('vadStep：静音时长按传入的块时长累计——48kHz 的 85ms 小块要攒更多块才够 1 秒', () => {
    let state = vadStep(init(), 0.05, 85); // 先听到人声
    let steps = 0;
    while (state.silentMs < VAD_SILENCE_MS && steps < 50) {
      state = vadStep(state, 0.015, 85);
      steps += 1;
    }
    expect(state.silentMs).toBeGreaterThanOrEqual(VAD_SILENCE_MS);
    expect(steps, '85ms 块需要 ~12 个而不是 4 个').toBeGreaterThanOrEqual(11);
  });

  it('纯环境噪声（永达不到说话阈值）不会触发自动停止条件', () => {
    let state = init();
    for (let i = 0; i < 50; i++) state = vadStep(state, 0.005, 256);
    expect(state.speechSeen).toBe(false);
    expect(state.speechSeen && state.silentMs >= VAD_SILENCE_MS).toBe(false);
  });

  it('攒满 VAD_SILENCE_MS 静音时长才满足自动停止（16k 下 4 个 256ms 块 = 1024ms）', () => {
    let state = vadStep(init(), 0.1, 256);
    let steps = 0;
    while (state.silentMs < VAD_SILENCE_MS) {
      state = vadStep(state, 0, 256);
      steps += 1;
      expect(steps).toBeLessThanOrEqual(4);
    }
    expect(steps).toBe(4);
    expect(state.speechSeen && state.silentMs >= VAD_SILENCE_MS).toBe(true);
  });
});

describe('VAD 自动断句', () => {
  it('人声后连续静音攒满 VAD_SILENCE_MS：自动结束并识别，onText 正常回调', async () => {
    installFileReader();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ text: '叶片有裂纹', seconds: 1.4 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onText = vi.fn();
    const onError = vi.fn();
    const { dictation, processor } = startableDictation({ onText, onError });

    await dictation.start();
    feedAudio(processor); // 人声块 → speechDetected
    expect(dictation.speechDetected.value).toBe(true);
    now.mockReturnValue(3_000); // 越过 400ms 门槛，让自动 stop 走到识别
    // 4 × 4096 帧 @16k = 1024ms ≥ VAD_SILENCE_MS
    for (let i = 0; i < 4; i++) feedSilence(processor);

    await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();
    expect(dictation.recording.value).toBe(false);
    expect(dictation.busy.value).toBe(false);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/speech/recognize');
  });

  it('48kHz 设备上按真实块时长累计：4 个静音块（≈341ms）不收尾，攒到 1 秒才收', async () => {
    installFileReader();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ text: '好', seconds: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const { dictation, processor } = startableDictation({}, 48_000);

    await dictation.start();
    feedAudio(processor);
    now.mockReturnValue(3_000);
    for (let i = 0; i < 4; i++) feedSilence(processor); // 4 × 85.3ms ≈ 341ms < 1000ms
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(dictation.recording.value, '按块数算是 bug：4 块在 48kHz 只有 341ms').toBe(true);

    for (let i = 0; i < 8; i++) feedSilence(processor); // 累计 12 × 85.3 ≈ 1024ms
    // recording=false 是 stop() 同步置的，识别请求在异步链后面——等 fetch 才是终点
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(dictation.recording.value).toBe(false);
    dictation.cancel();
  });

  it('停顿不满阈值不收尾：3 个 256ms 块（768ms）后仍在录音', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const { dictation, processor } = startableDictation();

    await dictation.start();
    feedAudio(processor);
    now.mockReturnValue(3_000);
    for (let i = 0; i < 3; i++) feedSilence(processor);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(dictation.recording.value).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    dictation.cancel();
  });

  it('全程纯静音：超过 VAD_NO_SPEECH_MS 取消并报错，麦克风收回、不打识别接口', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onError = vi.fn();
    const onText = vi.fn();
    // fake timers 必须先于 installBrowser：window.setInterval 在 stub 时从 globalThis 抓取
    const { dictation, processor } = startableDictation({ onText, onError });

    await dictation.start();
    // 低于「有动静」地板的底噪：audible 不置位，超时照常开火
    feedSilence(processor, 0.005);
    expect(dictation.speechDetected.value).toBe(false);

    now.mockReturnValue(1_000 + VAD_NO_SPEECH_MS + 100);
    await vi.advanceTimersByTimeAsync(200); // 触发 100ms ticker

    expect(onError).toHaveBeenCalledWith('没有听到声音');
    expect(onText).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dictation.error.value).toBe('没有听到声音');
    expect(dictation.recording.value).toBe(false);
    expect(dictation.speechDetected.value).toBe(false);
  });

  it('带内轻声动静不算「没人」：超过 6 秒也不触发无语音超时（防掐掉轻声说话者）', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onError = vi.fn();
    const { dictation, processor } = startableDictation({ onError });

    await dictation.start();
    // 0.015 落在 [VAD_SILENCE_RMS, VAD_SPEECH_RMS)：有动静但没到「说话」——
    // 轻声说话者就在这里，旧逻辑 speechDetected=false 会在 6 秒被掐掉
    feedSilence(processor, 0.015);

    now.mockReturnValue(1_000 + VAD_NO_SPEECH_MS + 100);
    await vi.advanceTimersByTimeAsync(200);

    expect(onError).not.toHaveBeenCalled();
    expect(dictation.recording.value).toBe(true);
    dictation.cancel();
  });

  it('tick 被节流合并越过 20 秒：纯静音走「没有听到声音」的免识别路径，不白跑 ASR', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onError = vi.fn();
    const { dictation, processor } = startableDictation({ onError });

    await dictation.start();
    feedSilence(processor, 0.005);
    // 第一次 tick 就落在 21 秒：无语音超时必须先于 MAX_RECORD_MS 判掉
    now.mockReturnValue(1_000 + 21_000);
    await vi.advanceTimersByTimeAsync(200);

    expect(onError).toHaveBeenCalledWith('没有听到声音');
    expect(fetchMock, '纯静音不该浪费一次识别调用').not.toHaveBeenCalled();
    expect(dictation.recording.value).toBe(false);
  });
});

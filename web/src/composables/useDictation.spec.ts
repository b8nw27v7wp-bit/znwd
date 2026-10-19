import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyGain,
  chunkRms,
  encodeWav,
  ENHANCE_HIGHPASS_HZ,
  ENHANCE_PEAK_CEILING,
  ENHANCE_SPEECH_RMS,
  ENHANCE_TARGET_RMS,
  enhanceForUpload,
  highPass,
  joinPartials,
  resample,
  speechGain,
  TARGET_SAMPLE_RATE,
} from './audioPcm';
import { SEGMENT_FIRST_MS, SEGMENT_MS } from './useSegmentStream';
import {
  BARGEIN_HOLD_MS,
  dictationSupported,
  TRUNCATION_WINDOW_MS,
  useDictation,
  VAD_ADAPT_MAX_RMS,
  VAD_NO_SPEECH_MS,
  VAD_SILENCE_MS,
  VAD_SPEECH_RMS,
  vadStep,
  type DictationOptions,
  type DictationMetric,
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

/** 500Hz 的正弦：落在增强高通的通带里，所以电平的变化只可能来自增益那一层 */
function tone(
  amplitude: number,
  frames: number,
  frequency = 500,
  sampleRate = TARGET_SAMPLE_RATE,
): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return out;
}

/** 一段采样的 RMS：独立算一遍，不借被测实现（免得两边一起错） */
function rms(values: Float32Array): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum / values.length);
}

/**
 * 把最后一次上传的 data URL 解回 [-1,1] 采样（跳过 44 字节 WAV 头）。
 * 「送上去的音频到底长什么样」只有从这里看得到——纯函数单测证明不了接线接对了。
 */
function uploadedSamples(fetchMock: { mock: { calls: unknown[][] } }): Float32Array {
  const calls = fetchMock.mock.calls;
  const init = (calls[calls.length - 1]?.[1] ?? {}) as RequestInit;
  const body = JSON.parse(String(init.body)) as { audio: string };
  const base64 = body.audio.slice(body.audio.indexOf(',') + 1);
  const buffer = Buffer.from(base64, 'base64');
  const samples = new Float32Array((buffer.length - 44) / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(44 + i * 2) / 32768;
  return samples;
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

/**
 * 送 ASR 前的语音增强：高通 + 增益归一化，**只走上传路径**。
 * 这一组只验纯函数本身；「接线上没有」在文件末尾那组里从上传的 data URL 上验。
 */
describe('highPass', () => {
  /** 掐掉滤波器起始瞬态再比电平（双二阶从零状态起，头几毫秒本来就不该参与比较） */
  const tail = (values: Float32Array) => values.subarray(values.length / 2);

  it('50Hz 哼声至少压 9dB，500Hz 的语音几乎不动，长度不变', () => {
    const hum = tone(0.3, TARGET_SAMPLE_RATE, 50);
    const filteredHum = highPass(hum, TARGET_SAMPLE_RATE);
    expect(filteredHum).toHaveLength(hum.length);
    expect(rms(tail(filteredHum))).toBeLessThan(rms(tail(hum)) * 0.35);

    const voice = tone(0.3, TARGET_SAMPLE_RATE, 500);
    const filteredVoice = highPass(voice, TARGET_SAMPLE_RATE);
    expect(rms(tail(filteredVoice))).toBeGreaterThan(rms(tail(voice)) * 0.97);
  });

  it('参数非法或空输入时原样返回：这一层是锦上添花，不该让一次录音因它出错', () => {
    const samples = tone(0.3, 64);
    expect(highPass(samples, 0)).toBe(samples);
    expect(highPass(samples, TARGET_SAMPLE_RATE, 0)).toBe(samples);
    // 截止频率越过奈奎斯特：算出来的系数会是废的，直接不滤
    expect(highPass(samples, 8000, 4000)).toBe(samples);
    expect(highPass(new Float32Array(0), TARGET_SAMPLE_RATE)).toHaveLength(0);
  });

  it('默认截止频率就是 ENHANCE_HIGHPASS_HZ（现场只看这一个数）', () => {
    const samples = tone(0.3, TARGET_SAMPLE_RATE, 50);
    expect(Array.from(highPass(samples, TARGET_SAMPLE_RATE))).toEqual(
      Array.from(highPass(samples, TARGET_SAMPLE_RATE, ENHANCE_HIGHPASS_HZ)),
    );
  });
});

describe('speechGain', () => {
  it('轻声被抬到目标电平：0.03 振幅（RMS≈0.021）拿到 3 倍以上的增益', () => {
    const quiet = tone(0.03, TARGET_SAMPLE_RATE);
    const gain = speechGain(quiet, TARGET_SAMPLE_RATE);
    expect(gain).toBeGreaterThan(3);
    expect(rms(quiet) * gain).toBeCloseTo(ENHANCE_TARGET_RMS, 2);
  });

  it('已经够响的原样不动：只抬不削（识别对偏响的容忍度高于偏轻）', () => {
    expect(speechGain(tone(0.3, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE)).toBe(1);
  });

  it('整段没有一帧够得上语音（全底噪）时返回 1：不把底噪放大成一片响噪声', () => {
    const noise = tone(0.005, TARGET_SAMPLE_RATE);
    expect(rms(noise)).toBeLessThan(ENHANCE_SPEECH_RMS);
    expect(speechGain(noise, TARGET_SAMPLE_RATE)).toBe(1);
  });

  it('峰值余量不足时宁可不拉满，也不削顶', () => {
    const samples = tone(0.05, TARGET_SAMPLE_RATE);
    samples[100] = 0.5; // 一记爆音把峰值顶上去，余量从此说了算
    const gain = speechGain(samples, TARGET_SAMPLE_RATE);
    expect(gain).toBeLessThan(ENHANCE_TARGET_RMS / rms(samples));
    expect(gain * 0.5).toBeLessThanOrEqual(ENHANCE_PEAK_CEILING + 1e-9);
  });

  it('输入已经越过满量程时也不衰减：宁可原样送上去', () => {
    const samples = tone(0.03, TARGET_SAMPLE_RATE);
    samples[10] = 1.2;
    expect(speechGain(samples, TARGET_SAMPLE_RATE)).toBe(1);
  });

  it('空输入与非法采样率返回 1（防除零，不做无意义的重算）', () => {
    expect(speechGain(new Float32Array(0), TARGET_SAMPLE_RATE)).toBe(1);
    expect(speechGain(tone(0.03, 320), 0)).toBe(1);
  });
});

describe('applyGain', () => {
  it('增益 ≤1 或非正值时原样返回同一个数组：不衰减、也不白复制一份', () => {
    const samples = new Float32Array([0.5, -0.5]);
    expect(applyGain(samples, 1)).toBe(samples);
    expect(applyGain(samples, 0)).toBe(samples);
    expect(applyGain(samples, Number.NaN)).toBe(samples);
  });

  it('增益 >1 时缩放成一份新数组（不改入参）', () => {
    const samples = new Float32Array([0.5, -0.25]);
    expect(Array.from(applyGain(samples, 2))).toEqual([1, -0.5]);
    expect(Array.from(samples)).toEqual([0.5, -0.25]);
  });
});

describe('enhanceForUpload', () => {
  it('48kHz 采集：重采样到 16k 后长度按速率折算', () => {
    const out = enhanceForUpload(tone(0.05, 48_000, 500, 48_000), 48_000);
    expect(out).toHaveLength(TARGET_SAMPLE_RATE);
  });

  it('只有底噪的录音不被放大：电平原地不动', () => {
    const hum = tone(0.005, TARGET_SAMPLE_RATE);
    const out = enhanceForUpload(hum, TARGET_SAMPLE_RATE);
    expect(rms(out)).toBeLessThanOrEqual(rms(hum) * 1.01);
  });

  it('空输入不炸（误触录音时长度可能为 0）', () => {
    expect(enhanceForUpload(new Float32Array(0), TARGET_SAMPLE_RATE)).toHaveLength(0);
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

/**
 * 常开聆听（第 3 档）：麦克风常开、说话即开始一句、说话中分段送识别。
 *
 * 与上面那组用例的差别只在「谁决定麦克风开着」——采集、VAD、编码这三段代码是共用的，
 * 所以这里不重复验 VAD 纯函数，只验状态机与分段管线。
 */
describe('常开聆听', () => {
  /** 起一套常开聆听环境：`arm()` 之后停在聆听态（点按模式要 start() 才开麦） */
  function alwaysDictation(options: DictationOptions = {}, sampleRate = TARGET_SAMPLE_RATE) {
    const stop = vi.fn();
    const getUserMedia = vi.fn(
      () => Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
    );
    const { processor } = installBrowser(getUserMedia, sampleRate);
    const dictation = useDictation(options);
    dictation.setAlwaysOn(true);
    return { dictation, processor, getUserMedia, stop };
  }

  /** 喂一个「像人声」的 4096 帧块（16k 下 256ms）：常开聆听靠它开始一句并累积分段 */
  function feedSpeech(processor: {
    onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null;
  }): void {
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } });
  }

  /**
   * 喂一个小块（1024 帧 @16k = 64ms）。
   *
   * <p>插话判据按**持续时长**算（BARGEIN_HOLD_MS），用 256ms 的大块一次就够长了，
   * 测不出「一记爆音不该算插话」——那一半判据只有小块喂得出来。
   */
  const SMALL_MS = (1024 / TARGET_SAMPLE_RATE) * 1000;
  /** 凑够 BARGEIN_HOLD_MS 需要几个小块（64ms 一块 → 2 块 = 128ms） */
  const BARGEIN_BLOCKS = Math.ceil(BARGEIN_HOLD_MS / SMALL_MS);

  function feedSmall(
    processor: {
      onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null;
    },
    fill: number,
    frames = 1024,
  ): void {
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(frames).fill(fill) } });
  }

  /**
   * 攒够**首段**门槛需要的块数（2.8 秒 ÷ 256ms ≈ 11 块）。
   *
   * <p>首段比后续段长是 §5 S5 的修法：门槛从起句开始算，而静音尾巴也算在里面——
   * 1.5 秒的短句到 2 秒就攒满发出去了，而那正是 VAD 马上要收尾的时刻。
   */
  const FIRST_SEGMENT_CHUNKS = Math.ceil((SEGMENT_FIRST_MS / 1000) * TARGET_SAMPLE_RATE / 4096);
  /** 首段之后每一片的块数（2 秒 ÷ 256ms ≈ 8 块，最后一块多出 768 个样本） */
  const SEGMENT_CHUNKS = Math.ceil((SEGMENT_MS / 1000) * TARGET_SAMPLE_RATE / 4096);

  /** 识别接口回固定文本的环境 */
  function stubRecognize(text: string | (() => Promise<Response>)) {
    installFileReader();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (typeof text === 'function') return text();
      return new Response(JSON.stringify({ text, seconds: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('arm 只开一次麦克风，句子之间不释放（常开的全部意义就在这里）', async () => {
    stubRecognize('叶片有裂纹');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onText = vi.fn();
    const { dictation, processor, getUserMedia, stop } = alwaysDictation({ onText });

    await dictation.arm();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(dictation.armed.value).toBe(true);
    expect(dictation.listening.value, '麦克风开着且没人说话 = 聆听中').toBe(true);

    // 第一句：一个块就检出人声 → 开始录；4 个静音块 = 1024ms → 自动收尾
    feedSpeech(processor);
    expect(dictation.recording.value, '检出人声就该开始这一句').toBe(true);
    now.mockReturnValue(3_000);
    for (let i = 0; i < 4; i++) feedSilence(processor);
    await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));

    expect(stop, '句子结束不该收麦').not.toHaveBeenCalled();
    expect(getUserMedia, '第二句不需要再开一次麦').toHaveBeenCalledTimes(1);
    expect(dictation.armed.value).toBe(true);
    expect(dictation.listening.value).toBe(true);

    // 第二句照样能起（VAD 与缓冲都回到干净状态）
    feedSpeech(processor);
    expect(dictation.recording.value).toBe(true);

    dictation.dispose();
    expect(stop, 'dispose 才收麦').toHaveBeenCalledTimes(1);
    expect(dictation.armed.value).toBe(false);
  });

  it('说话中每 SEGMENT_MS 送一段识别，文本拼成预览（终稿仍走整段）', async () => {
    const fetchMock = stubRecognize('叶片有');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onPartial = vi.fn();
    const onText = vi.fn();
    const onMetrics = vi.fn();
    const { dictation, processor } = alwaysDictation({ onPartial, onText, onMetrics });

    await dictation.arm();
    // 首段门槛是 SEGMENT_FIRST_MS（§5 S5），不到它不发
    for (let i = 0; i < FIRST_SEGMENT_CHUNKS - 1; i++) feedSpeech(processor);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock, '不够一个切片的长度就不该发').not.toHaveBeenCalled();

    feedSpeech(processor); // 攒满首段门槛 → 送第一段
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith('叶片有'));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/speech/recognize');
    expect(onMetrics).toHaveBeenCalledWith({
      kind: 'segment',
      latencyMs: expect.any(Number),
      // §5 S8：ASR 按音频秒计费，这一段有多少秒必须跟着一起报
      audioMs: expect.any(Number),
    });
    expect(onText, '预览不是终稿').not.toHaveBeenCalled();

    dictation.dispose();
  });

  it('短句不白发一段分段：整句走终稿就够了（§5 S5）', async () => {
    // 说明为什么是「攒不够」而不是「发了被丢」——今天的状态是白花一次 ASR 调用，
    // 而且预览与终稿几乎同时落地，输入框里的字会闪一下
    const fetchMock = stubRecognize('叶片有裂纹');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onPartial = vi.fn();
    const onText = vi.fn();
    const { dictation, processor } = alwaysDictation({ onPartial, onText });

    await dictation.arm();
    // 说话 1.5 秒（6 块）后停：到 t≈2.5s 就自动收尾，而旧门槛（2 秒）会在 t≈2.05s 抢先发一段
    for (let i = 0; i < 6; i++) feedSpeech(processor);
    now.mockReturnValue(2_500);
    for (let i = 0; i < 4; i++) feedSilence(processor); // 攒满 1 秒静音 → 自动收尾

    await vi.waitFor(() => expect(onText).toHaveBeenCalledWith('叶片有裂纹'));
    expect(fetchMock, '短句只该走终稿那一次识别').toHaveBeenCalledTimes(1);
    expect(onPartial, '整段走终稿，没有分段预览').not.toHaveBeenCalled();

    dictation.dispose();
  });

  it('切片里大半是停顿就先不发，攒到下一片再判（§5 S5 的另一半）', async () => {
    // 停顿用 0.015 而不是 0.005：真实展厅的底噪就在这一档，它**高于**「有动静」地板(0.01)、
    // 低于说话阈值——旧口径（按「有动静」算占比）下这些块全算人声，这条过滤等于没写
    const fetchMock = stubRecognize('叶片有裂纹');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onPartial = vi.fn();
    const { dictation, processor } = alwaysDictation({ onPartial });

    await dictation.arm();
    // 「说一句停一下」的人：说话块之间夹着接近收尾阈值的停顿。
    // 停顿连续不超过 3 块（768ms < VAD_SILENCE_MS），否则这一句直接收尾、轮到终稿了
    const statementThenPause = () => {
      feedSpeech(processor);
      for (let i = 0; i < 3; i++) feedSilence(processor, 0.015);
    };
    statementThenPause();
    statementThenPause();
    feedSpeech(processor);
    for (let i = 0; i < 2; i++) feedSilence(processor, 0.015); // 到这里攒满首段门槛（11 块）
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock, '只有三成是语音的切片，送去识别只能换回几个字').not.toHaveBeenCalled();

    // 后面连着说话，占比过线，门槛顺延一片之后照样会切
    for (let i = 0; i < SEGMENT_CHUNKS; i++) feedSpeech(processor);
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith('叶片有裂纹'));
    dictation.dispose();
  });

  it('取消之后迟到的分段结果不再改写预览', async () => {
    let release: ((response: Response) => void) | undefined;
    const fetchMock = stubRecognize(
      () => new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onPartial = vi.fn();
    const { dictation, processor } = alwaysDictation({ onPartial });

    await dictation.arm();
    for (let i = 0; i < FIRST_SEGMENT_CHUNKS; i++) feedSpeech(processor);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    dictation.cancel(); // 在途请求被 abort，语句号也换了
    release?.(new Response(JSON.stringify({ text: '两秒前的旧话', seconds: 2 }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onPartial, '过期的分段结果一个字都不该上屏').not.toHaveBeenCalledWith('两秒前的旧话');
    expect(dictation.armed.value).toBe(false);
  });

  it('分段失败静默计数，不打扰参观者（终稿还在后面）', async () => {
    const fetchMock = stubRecognize(async () => new Response('{"error":"rate_limited"}', { status: 429 }));
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onPartial = vi.fn();
    const onError = vi.fn();
    const onMetrics = vi.fn();
    const { dictation, processor } = alwaysDictation({ onPartial, onError, onMetrics });

    await dictation.arm();
    for (let i = 0; i < FIRST_SEGMENT_CHUNKS; i++) feedSpeech(processor);
    await vi.waitFor(() =>
      expect(onMetrics).toHaveBeenCalledWith({ kind: 'segmentFailure', audioMs: expect.any(Number) }));

    expect(onError, '一段预览失败不该在展厅大屏上刷错误').not.toHaveBeenCalled();
    expect(onPartial).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    dictation.dispose();
  });

  it('抑制期间语句与底噪照旧冻结，但会把回声采下来（P3a-1）', async () => {
    const fetchMock = stubRecognize('不该被叫到');
    const onMetrics = vi.fn();
    const onPartial = vi.fn();
    const onError = vi.fn();
    const { dictation, processor } = alwaysDictation({ onMetrics, onPartial, onError });

    await dictation.arm();
    feedSpeech(processor);
    expect(dictation.recording.value).toBe(true);

    dictation.setSuppressed(true);
    expect(onMetrics).toHaveBeenCalledWith({ kind: 'suppressedAbandon' });
    expect(onPartial, '预览要被清掉').toHaveBeenCalledWith(null);
    expect(dictation.recording.value, '正在说的这句被放弃').toBe(false);
    expect(dictation.armed.value, '抑制不收麦（避免权限抖动）').toBe(true);
    expect(onError).not.toHaveBeenCalled();

    // 抑制期间喂进来的喇叭声：既不能起句、也不能进底噪，只能记成回声样本——
    // 那正是「自己的喇叭在麦克风里到底多响」唯一的来源（旧实现一律冻结，这组数根本采不到）
    const before = onMetrics.mock.calls.length;
    const kinds = () => onMetrics.mock.calls.slice(before).map((c) => (c[0] as DictationMetric).kind);
    for (let i = 0; i < SEGMENT_CHUNKS + 4; i++) feedSpeech(processor);
    expect(kinds()).toHaveLength(SEGMENT_CHUNKS + 4);
    expect(kinds().every((kind) => kind === 'echo'), '抑制期间只该产生回声样本').toBe(true);
    expect(dictation.recording.value).toBe(false);
    expect(fetchMock, '抑制期间不该送分段').not.toHaveBeenCalled();

    dictation.setSuppressed(false);
    feedSpeech(processor);
    expect(dictation.recording.value, '解除抑制后重新开始听').toBe(true);

    dictation.dispose();
  });

  it('抑制期间低于插话门限的声音保持抑制：不判插话，也不污染底噪', async () => {
    // 0.03 高于常量地板（按今天的判据就是「说话」），但低于插话门限（阈值的 2 倍）：
    // 这正是「自己的喇叭声漏进麦克风」的典型量级，它必须**什么都不触发**
    stubRecognize('不该被叫到');
    const onMetrics = vi.fn();
    const onBargeIn = vi.fn();
    const { dictation, processor } = alwaysDictation({ onMetrics, onBargeIn });

    await dictation.arm();
    dictation.setBargeIn(true);
    dictation.setSuppressed(true);
    for (let i = 0; i < 8; i++) feedSmall(processor, 0.03);

    const events = onMetrics.mock.calls.map((c) => c[0] as DictationMetric);
    expect(events.filter((e) => e.kind === 'noise'), '回声不该进底噪').toHaveLength(0);
    expect(events.filter((e) => e.kind === 'bargeIn')).toHaveLength(0);
    expect(onBargeIn).not.toHaveBeenCalled();
    expect(dictation.recording.value).toBe(false);
    // 而且它照样被记进「越过说话阈值」那一列——运营据此才知道门限该抬到哪儿
    expect(events.filter((e) => e.kind === 'echo' && e.over)).toHaveLength(8);
    expect(events.filter((e) => e.kind === 'echo' && e.farOver)).toHaveLength(0);

    dictation.dispose();
  });

  it('插话判决：越限声音要持续够久才算，一记爆音不算（P3a-2）', async () => {
    // 判据是「持续」而不是峰值：关门声、话筒被碰到都是一记，只有真人说话会连着好几块都越限
    stubRecognize('叶片有裂纹');
    const onMetrics = vi.fn();
    const onBargeIn = vi.fn();
    const { dictation, processor } = alwaysDictation({ onMetrics, onBargeIn });

    await dictation.arm();
    dictation.setBargeIn(true);
    dictation.setSuppressed(true);

    for (let i = 0; i < BARGEIN_BLOCKS - 1; i++) feedSmall(processor, 0.2); // 64ms × 1 = 短于 BARGEIN_HOLD_MS
    expect(onMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'echo', over: true, farOver: true }),
    );
    expect(onBargeIn, '一记爆音不是插话').not.toHaveBeenCalled();
    expect(dictation.recording.value).toBe(false);

    feedSmall(processor, 0.2); // 攒够 BARGEIN_HOLD_MS（64ms × 2 = 128ms）
    expect(onMetrics).toHaveBeenCalledWith({ kind: 'bargeIn' });
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(dictation.recording.value, '判成插话就该当场开始录这一句').toBe(true);

    dictation.dispose();
  });

  it('慢采样率（256ms 块）上，一记爆音同样不算插话', async () => {
    // 「持续超过 BARGEIN_HOLD_MS」只看时长是不够的：块长按设备在 85ms~256ms 之间，
    // 而 AudioContext 老实给出 16kHz 时一块就是 256ms —— 那一块就越过了 120ms 的门槛，
    // 判据退化成峰值检测，关门声就能把回答掐掉。所以另加 BARGEIN_MIN_BLOCKS 一起卡。
    stubRecognize('叶片有裂纹');
    const onMetrics = vi.fn();
    const onBargeIn = vi.fn();
    const { dictation, processor } = alwaysDictation({ onMetrics, onBargeIn });

    await dictation.arm();
    dictation.setBargeIn(true);
    dictation.setSuppressed(true);

    feedSmall(processor, 0.2, 4096); // 一记（256ms 一块）
    expect(onMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'echo', over: true, farOver: true }),
    );
    expect(onBargeIn, '一记爆音不是插话').not.toHaveBeenCalled();
    expect(dictation.recording.value).toBe(false);

    feedSmall(processor, 0.2, 4096); // 连着两块：真人插话会持续好几块
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(dictation.recording.value).toBe(true);
    dictation.dispose();
  });

  it('插话判决关着时只量不判（缺省形态）', async () => {
    stubRecognize('叶片有裂纹');
    const onMetrics = vi.fn();
    const onBargeIn = vi.fn();
    const { dictation, processor } = alwaysDictation({ onMetrics, onBargeIn });

    await dictation.arm();
    dictation.setSuppressed(true); // 不调 setBargeIn：缺省就是关
    for (let i = 0; i < 10; i++) feedSmall(processor, 0.2);

    expect(onBargeIn).not.toHaveBeenCalled();
    expect(onMetrics.mock.calls.map((c) => (c[0] as DictationMetric).kind)).not.toContain('bargeIn');
    expect(dictation.recording.value).toBe(false);
    // 回声样本照记：门限要按它定，关了判决也不该把这份数据一起关掉
    expect(onMetrics.mock.calls.filter((c) => (c[0] as DictationMetric).kind === 'echo')).toHaveLength(10);

    dictation.dispose();
  });

  it('判出插话后，越限的那几块被接成新一句的开头（不削掉半个字）', async () => {
    stubRecognize('等一下');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onBargeIn = vi.fn();
    const onText = vi.fn();
    const { dictation, processor } = alwaysDictation({ onBargeIn, onText });

    await dictation.arm();
    dictation.setBargeIn(true);
    dictation.setSuppressed(true);
    // 判出插话那几块 + 之后正常采集的一块
    for (let i = 0; i < BARGEIN_BLOCKS + 1; i++) feedSmall(processor, 0.2);
    expect(dictation.recording.value).toBe(true);

    // 插话的这几块必须进 VAD：只塞 PCM 的话「哼一声就停」要挂到 20 秒上限才收尾
    now.mockReturnValue(3_000);
    for (let i = 0; i < 4; i++) feedSilence(processor);
    await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));
    expect(dictation.recording.value).toBe(false);
    dictation.dispose();
  });

  it('底噪只在「不像人声」的块上采样（说话声不该拉高底噪）', async () => {
    stubRecognize('叶片有裂纹');
    const onMetrics = vi.fn();
    const { dictation, processor } = alwaysDictation({ onMetrics });

    await dictation.arm();
    feedSpeech(processor);
    expect(onMetrics.mock.calls.filter((c) => (c[0] as { kind: string }).kind === 'noise')).toHaveLength(0);

    feedSilence(processor, 0.005);
    const noise = onMetrics.mock.calls.map((c) => c[0] as { kind: string; rms?: number }).find((e) => e.kind === 'noise');
    // Float32Array 存不下 0.005 的十进制表示，只能按近似断言
    expect(noise?.rms).toBeCloseTo(0.005, 6);

    dictation.dispose();
  });

  it('整段识别回空只清预览与计数，不报错（环境噪声误触发）', async () => {
    stubRecognize('   ');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onText = vi.fn();
    const onError = vi.fn();
    const onPartial = vi.fn();
    const onMetrics = vi.fn();
    const { dictation, processor } = alwaysDictation({ onText, onError, onPartial, onMetrics });

    await dictation.arm();
    feedSpeech(processor);
    now.mockReturnValue(3_000);
    for (let i = 0; i < 4; i++) feedSilence(processor);

    await vi.waitFor(() => expect(onMetrics).toHaveBeenCalledWith({ kind: 'falseTrigger' }));
    expect(onError, '常开模式下没人说话是常态，不能一直刷「没有听清」').not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(onPartial).toHaveBeenCalledWith(null);
    expect(dictation.error.value).toBe('');
    expect(dictation.listening.value, '误触发之后继续聆听').toBe(true);

    dictation.dispose();
  });

  it('点按模式的空识别仍然报错（明确的操作要有明确的反馈）', async () => {
    stubRecognize('');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onError = vi.fn();
    const { dictation, processor } = startableDictation({ onError });

    await dictation.start();
    feedAudio(processor);
    now.mockReturnValue(1_500);
    await dictation.stop();

    expect(onError).toHaveBeenCalledWith('没有听清，请再说一次');
    expect(dictation.recording.value).toBe(false);
  });

  it('关掉常开：放弃当前语句、放开麦克风并清掉预览', async () => {
    stubRecognize('叶片有裂纹');
    const onPartial = vi.fn();
    const { dictation, processor, stop } = alwaysDictation({ onPartial });

    await dictation.arm();
    feedSpeech(processor);
    expect(dictation.recording.value).toBe(true);

    dictation.setAlwaysOn(false);
    expect(dictation.armed.value).toBe(false);
    expect(dictation.recording.value).toBe(false);
    expect(onPartial).toHaveBeenCalledWith(null);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('排队中的第二句终稿还在飞时，busy 不会被第一句清掉', async () => {
    // 终稿是排队的（finalChain）：先落地的那一句只能代表自己结束，
    // 按「单次调用结束」清 busy 会让按钮的「…」提前消失、:disabled 提前解除
    const pending: Array<(response: Response) => void> = [];
    installFileReader();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      pending.push(resolve);
    })));
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onText = vi.fn();
    const { dictation, processor } = alwaysDictation({ onText });

    await dictation.arm();
    feedSpeech(processor);
    now.mockReturnValue(2_000);
    for (let i = 0; i < 4; i++) feedSilence(processor);
    await vi.waitFor(() => expect(pending.length).toBe(1));
    expect(dictation.busy.value).toBe(true);

    // 第二句在第一句的终稿仍在飞的时候起、结束 → 它的终稿排队
    now.mockReturnValue(3_000);
    feedSpeech(processor);
    now.mockReturnValue(5_000);
    for (let i = 0; i < 4; i++) feedSilence(processor);
    await vi.waitFor(() => expect(dictation.recording.value).toBe(false));

    pending[0]?.(new Response(JSON.stringify({ text: '第一句', seconds: 1 }), { status: 200 }));
    // 等第二句的请求真的发出去——那说明第一句的 finally 已经跑过了
    await vi.waitFor(() => expect(pending.length).toBe(2));
    expect(dictation.busy.value, '第二句的终稿仍在飞').toBe(true);

    pending[1]?.(new Response(JSON.stringify({ text: '第二句', seconds: 1 }), { status: 200 }));
    await vi.waitFor(() => expect(dictation.busy.value).toBe(false));
    expect(onText).toHaveBeenCalledTimes(2);
    dictation.dispose();
  });

  it('被取消后排队的终稿不再发识别请求', async () => {
    // 过期判定必须在**发请求之前**：wait 之后才判的话，一段已经没有去处的录音
    // 照样会白白付一次 ASR 调用（结果回来也只会被丢弃）
    const pending: Array<(response: Response) => void> = [];
    installFileReader();
    const fetchMock = vi.fn((_input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      pending.push(resolve);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const { dictation, processor } = alwaysDictation({ onText: vi.fn() });

    await dictation.arm();
    feedSpeech(processor);
    now.mockReturnValue(2_000);
    for (let i = 0; i < 4; i++) feedSilence(processor);
    await vi.waitFor(() => expect(pending.length).toBe(1));

    // 第二句结束、终稿排队，此时运营把常开聆听关掉
    now.mockReturnValue(3_000);
    feedSpeech(processor);
    now.mockReturnValue(5_000);
    for (let i = 0; i < 4; i++) feedSilence(processor);
    await vi.waitFor(() => expect(dictation.recording.value).toBe(false));
    dictation.setAlwaysOn(false);

    pending[0]?.(new Response(JSON.stringify({ text: '第一句', seconds: 1 }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchMock, '作废的终稿不该再打一次识别接口').toHaveBeenCalledTimes(1);
  });

  it('插话判错（终稿回空）另记一笔：门限敢不敢开低就看这个数', async () => {
    // 打断判错的代价是「把回答掐了、又没有新问题」。它同时也是一次空识别，
    // 所以既计 falseTriggers（总数）又计 bargeInRejected（子集），与「语句数 = 各种结束原因之和」同一套口径
    stubRecognize('   ');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onMetrics = vi.fn();
    const { dictation, processor } = alwaysDictation({ onMetrics });

    await dictation.arm();
    dictation.setBargeIn(true);
    dictation.setSuppressed(true);
    for (let i = 0; i < BARGEIN_BLOCKS; i++) feedSmall(processor, 0.2); // → 判出插话
    now.mockReturnValue(3_000);
    for (let i = 0; i < 4; i++) feedSilence(processor);

    await vi.waitFor(() => expect(onMetrics).toHaveBeenCalledWith({ kind: 'bargeInRejected' }));
    expect(onMetrics).toHaveBeenCalledWith({ kind: 'falseTrigger' });
    dictation.dispose();
  });

  it('点按起句的语句结束后照样收麦（即使常开开关是开着的）', async () => {
    // 常开开关开着、但自动 arm 没成功（典型：speechReady=false 被门禁挡住）时，
    // 参观者手点麦克风走的是点按路径。若按「当前开关」判断，这一句之后麦克风就不关了，
    // 页面会在这台没有语音服务的机器上悄悄进入常开聆听，之后每阵噪声都打一次 ASR 拿 503
    const stop = vi.fn();
    const getUserMedia = vi.fn(
      () => Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
    );
    const { processor } = installBrowser(getUserMedia);
    const dictation = useDictation({ onText: vi.fn() });
    dictation.setAlwaysOn(true);
    expect(dictation.armed.value, '先确认 arming 跟这里的场景无关').toBe(false);

    installFileReader();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ text: '叶片有裂纹', seconds: 1 }), { status: 200 })));
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();

    await dictation.start();
    expect(dictation.armed.value).toBe(true);
    feedSpeech(processor);
    now.mockReturnValue(1_800);
    await dictation.stop();

    expect(dictation.armed.value, '点按起句结束就该收麦').toBe(false);
    expect(dictation.listening.value).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dictation.recording.value).toBe(false);
  });

  it('开麦被拒只报一次错，后续手势重试不再刷运营视图', async () => {
    // arm 成功前每次手势都会重试（权限弹窗要求用户激活）：被拒的机器上就是每次点屏幕
    // 都失败一次。同一条错反复灌进 chat.errors（上限 20 条）会把真正的故障挤出去
    const getUserMedia = vi.fn(() => Promise.reject(new Error('Permission denied')));
    installBrowser(getUserMedia);
    const onError = vi.fn();
    const dictation = useDictation({ onError });
    dictation.setAlwaysOn(true);

    await dictation.arm();
    await dictation.arm();
    await dictation.arm();

    expect(getUserMedia, '每次都要真的重试').toHaveBeenCalledTimes(3);
    expect(onError, '但同一个原因只报一次').toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Permission denied');
    expect(dictation.error.value, '错误本身仍留在状态里').toBe('Permission denied');
    dictation.dispose();
  });

  it('常开模式下不再有「开麦后没人说话」的超时收回', async () => {
    // 点按模式下 6 秒无声会收回麦克风；常开聆听没有「录音开始」这个概念，
    // 对应的动作是继续听下去——否则参观者站在屏幕前想一会儿就被收走了话筒
    vi.useFakeTimers();
    stubRecognize('叶片有裂纹');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const onError = vi.fn();
    // fake timers 必须先于 installBrowser：window.setInterval 在 stub 时从 globalThis 抓取
    const { dictation, processor } = alwaysDictation({ onError });

    await dictation.arm();
    now.mockReturnValue(1_000 + VAD_NO_SPEECH_MS * 5);
    await vi.advanceTimersByTimeAsync(500);

    expect(onError).not.toHaveBeenCalled();
    expect(dictation.armed.value, '麦克风必须还开着').toBe(true);
    processor.onaudioprocess = null;
    dictation.dispose();
  });

  /**
   * 底噪自适应（§5 S1）：采了必须真的用上。
   *
   * <p>修的正是「采了不用」——底噪一直在上报，而 `VAD_SPEECH_RMS` 到用的时候仍是常量，
   * 于是展厅底噪一上来，每一阵空调声都当成有人说话。
   */
  describe('底噪自适应', () => {
    it('底噪抬上来之后阈值跟着抬，但一步都不越过上界（不许把参观者挡在外面）', async () => {
      // 这条是「宁可误触发也不能聋」的回归：底噪 0.019（低于常量地板、本身不该起句）持续存在时，
      // 阈值会从 0.02 抬到 0.019×1.5 ≈ 0.028，**但正常说话（0.04）必须进得来**。
      // 旧口径（系数 3、上限 0.08）下这里阈值是 0.057，0.04 的说话永远起不了句——
      // 表现是「麦克风没反应」，而且底噪上报样本同时掉到 0，运营看不出阈值已经顶死。
      const onMetrics = vi.fn();
      const { dictation, processor } = alwaysDictation({ onMetrics });

      await dictation.arm();
      for (let i = 0; i < 400; i++) feedSilence(processor, 0.019);
      expect(dictation.recording.value, '底噪本身不该起句').toBe(false);

      feedSmall(processor, 0.04, 4096);
      expect(dictation.recording.value, '正常说话（0.04）必须起得了句').toBe(true);

      const thresholds = onMetrics.mock.calls
        .map((c) => (c[0] as DictationMetric))
        .filter((e): e is { kind: 'threshold'; rms: number } => e.kind === 'threshold')
        .map((e) => e.rms);
      expect(Math.max(...thresholds), '自适应确实在干活').toBeGreaterThan(VAD_SPEECH_RMS);
      expect(Math.max(...thresholds), '但一步都没越过上界').toBeLessThanOrEqual(VAD_ADAPT_MAX_RMS);
      dictation.dispose();
    });

    it('安静环境下阈值不会掉到常量以下（常量地板是下限）', async () => {
      const onMetrics = vi.fn();
      const { dictation, processor } = alwaysDictation({ onMetrics });

      await dictation.arm();
      for (let i = 0; i < 100; i++) feedSilence(processor, 0.002);
      // 底噪极低：阈值必须仍是 VAD_SPEECH_RMS，而不是跟着往下压（压下去就开始误触发）
      const thresholds = onMetrics.mock.calls
        .map((c) => (c[0] as DictationMetric))
        .filter((e): e is { kind: 'threshold'; rms: number } => e.kind === 'threshold');
      expect(thresholds.length).toBeGreaterThan(0);
      expect(Math.min(...thresholds.map((e) => e.rms))).toBe(VAD_SPEECH_RMS);

      // 常量口算得到的那一档仍然算人声
      feedSmall(processor, VAD_SPEECH_RMS * 1.05);
      expect(dictation.recording.value).toBe(true);
      dictation.dispose();
    });

    it('vadStep 的阈值可以外传：同一块在两个阈值下判决不同', () => {
      const loud = VAD_SPEECH_RMS * 1.5; // 0.03：常量口径下算人声，抬到上界就不算
      const init = () => ({ speechSeen: false, audible: false, silentMs: 0 });
      expect(vadStep(init(), loud, 256).speechSeen, '常量口径下算人声').toBe(true);
      expect(
        vadStep(init(), loud, 256, VAD_ADAPT_MAX_RMS).speechSeen,
        '阈值抬到上界之后同一块就不算了',
      ).toBe(false);
    });
  });

  /**
   * 疑似漏断（§5 S3）：P1 要的三组现场数据里唯一还没出口的那组。
   *
   * <p>「一句话被静音阈值截成两句」在计数上看不出来：语句数只多了一条，
   * 与「参观者换了个人接着说」在数据上长得一模一样。区别在**时间**——被截断的两段挨得极近。
   */
  describe('疑似漏断', () => {
    it('自动收尾后窗口内又起一句：记一次', async () => {
      stubRecognize('叶片有裂纹');
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();
      const onText = vi.fn();
      const onMetrics = vi.fn();
      const { dictation, processor } = alwaysDictation({ onText, onMetrics });

      await dictation.arm();
      feedSpeech(processor);
      now.mockReturnValue(2_000);
      for (let i = 0; i < 4; i++) feedSilence(processor);
      await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));

      const truncations = () =>
        onMetrics.mock.calls.filter((c) => (c[0] as DictationMetric).kind === 'truncationSuspected').length;
      expect(truncations(), '这一句是正常的停顿结束').toBe(0);

      now.mockReturnValue(2_000 + TRUNCATION_WINDOW_MS - 1);
      feedSpeech(processor);
      expect(truncations(), '收尾判决后 1.5 秒内又起一句 = 上一句多半被截断了').toBe(1);

      now.mockReturnValue(2_000 + TRUNCATION_WINDOW_MS + 1_500); // 先让这一句够长，再收尾
      for (let i = 0; i < 4; i++) feedSilence(processor);
      await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(2));
      now.mockReturnValue(2_000 + TRUNCATION_WINDOW_MS * 10);
      feedSpeech(processor);
      expect(truncations(), '窗口之外的下一句就是下一位参观者').toBe(1);

      dictation.dispose();
    });

    it('上一句的终稿是空的（噪声误触发）不算漏断', async () => {
      // 嘈杂展厅里噪声触发也会「自动收尾后马上又起一句」，按时间判会把漏断率顶到接近 100%，
      // 而运营会据此把 VAD_SILENCE_MS 越调越长——上一句根本没识出文字，就不是被截断的话
      stubRecognize('   ');
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();
      const onMetrics = vi.fn();
      const { dictation, processor } = alwaysDictation({ onMetrics });

      await dictation.arm();
      feedSpeech(processor);
      now.mockReturnValue(2_000);
      for (let i = 0; i < 4; i++) feedSilence(processor);
      await vi.waitFor(() => expect(onMetrics).toHaveBeenCalledWith({ kind: 'falseTrigger' }));

      now.mockReturnValue(2_000 + TRUNCATION_WINDOW_MS - 1);
      feedSpeech(processor);
      expect(
        onMetrics.mock.calls.filter((c) => (c[0] as DictationMetric).kind === 'truncationSuspected'),
        '上一句回空 = 那阵动静不是话，谈不上被截断',
      ).toHaveLength(0);
      dictation.dispose();
    });

    it('插话起的那一句不算漏断（主动打断与静音阈值无关）', async () => {
      stubRecognize('叶片有裂纹');
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();
      const onMetrics = vi.fn();
      const { dictation, processor } = alwaysDictation({ onMetrics });

      await dictation.arm();
      feedSpeech(processor);
      now.mockReturnValue(2_000);
      for (let i = 0; i < 4; i++) feedSilence(processor);
      await vi.waitFor(() => expect(onMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'final' })));

      // 落在窗口内、上一句也确实识出了文字，唯一挡下这次计数的就是「这句是插话起的」
      now.mockReturnValue(2_000 + 100);
      dictation.setBargeIn(true);
      dictation.setSuppressed(true);
      feedSmall(processor, 0.2, 4096);
      feedSmall(processor, 0.2, 4096);

      expect(onMetrics).toHaveBeenCalledWith({ kind: 'bargeIn' });
      expect(
        onMetrics.mock.calls.filter((c) => (c[0] as DictationMetric).kind === 'truncationSuspected'),
      ).toHaveLength(0);
      dictation.dispose();
    });
  });

  /**
   * 终稿延迟与音频秒数（§5 S4 / S8）：P2 的三段基线里，第一段就靠它。
   *
   * <p>拆成三段上报是刻意的（§4 P2 修订 1）：只有一个「说完→首音」的总数，超标了也不知道
   * 该优化 VAD 的停顿阈值、识别往返，还是合成的首包。
   */
  describe('终稿延迟与音频秒数', () => {
    it('说完→收尾、说完→终稿、服务端耗时与音频秒数各自上报', async () => {
      installFileReader();
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ text: '叶片有裂纹', seconds: 1.28, elapsedMs: 700 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      vi.stubGlobal('fetch', fetchMock);
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();
      const onText = vi.fn();
      const onMetrics = vi.fn();
      const { dictation, processor } = alwaysDictation({ onText, onMetrics });

      await dictation.arm();
      feedSpeech(processor); // 最后一块人声 = 1_000，「说完」从这一刻算
      now.mockReturnValue(2_500); // 停顿 1.5 秒 → 收尾判决
      for (let i = 0; i < 4; i++) feedSilence(processor);
      now.mockReturnValue(3_000); // 识别往返 500ms
      await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));

      expect(onMetrics).toHaveBeenCalledWith({
        kind: 'final',
        endDelayMs: 1_500, // 说完 → 收尾判决
        latencyMs: 2_000, // 说完 → 终稿文本
        serverMs: 700, // 服务端自己量的那一段（两者之差就是浏览器侧开销）
        audioMs: 1_280, // 1 块人声 + 4 块静音 = 5 × 256ms
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      dictation.dispose();
    });

    it('终稿失败不报延迟：超时那种会把均值带偏（与分段延迟同一口径）', async () => {
      installFileReader();
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('断网');
      }));
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();
      const onError = vi.fn();
      const onMetrics = vi.fn();
      const { dictation, processor } = alwaysDictation({ onError, onMetrics });

      await dictation.arm();
      feedSpeech(processor);
      now.mockReturnValue(3_000);
      for (let i = 0; i < 4; i++) feedSilence(processor);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('断网'));

      expect(onMetrics.mock.calls.map((c) => (c[0] as DictationMetric).kind)).not.toContain('final');
      dictation.dispose();
    });
  });
});

describe('joinPartials', () => {
  it('两段中文之间不补空格（补了会把「叶片有 裂纹」摆到参观者面前）', () => {
    expect(joinPartials(['叶片有', '裂纹需要检查'])).toBe('叶片有裂纹需要检查');
  });

  it('拉丁文本相邻时补空格，避免连成一个词', () => {
    expect(joinPartials(['The machine', 'Please stand by'])).toBe('The machine Please stand by');
  });

  it('中英混排的边界补空格', () => {
    expect(joinPartials(['展区是 PV-Clean', '它是自动清洗设备'])).toBe('展区是 PV-Clean 它是自动清洗设备');
  });

  it('边界已有标点时不再补空格', () => {
    expect(joinPartials(['叶子。', '我们走吧'])).toBe('叶子。我们走吧');
  });

  it('每段先去掉首尾空白（识别结果常带前导空格，留着会让预览起伏）', () => {
    expect(joinPartials(['  叶片有  ', ' 裂纹  '])).toBe('叶片有裂纹');
  });

  it('空段与纯空白段被跳过（识别回空的那一段不该在预览里留个空格）', () => {
    expect(joinPartials(['', '   ', '叶片'])).toBe('叶片');
    expect(joinPartials([])).toBe('');
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

/**
 * 接线验收（送 ASR 前的语音增强）：判决路径吃原始 PCM、上传路径过 enhanceForUpload。
 *
 * <p>纯函数在上面已经验过，这里只问一件纯函数答不了的事——**送上去的那份音频变了没有**。
 * 用例都从 fetch 的 body 里把 WAV 解回来量电平，所以「改了函数忘了改调用点」这种漏接会当场红。
 */
describe('上传路径的语音增强', () => {
  /** 一段轻声（RMS≈0.035）：过得了 VAD 地板，但离识别习惯的电平还差一截 */
  const quiet = () => tone(0.05, 4096);

  function stubRecognize(text: string) {
    installFileReader();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text, seconds: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function installMic() {
    const getUserMedia = vi.fn(() =>
      Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream),
    );
    return installBrowser(getUserMedia);
  }

  it('终稿：轻声被抬到目标电平，判决路径不受影响（VAD 照样按原始 RMS 判出人声）', async () => {
    const fetchMock = stubRecognize('叶片有裂纹');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    const { processor } = installMic();
    const dictation = useDictation();

    await dictation.start();
    const chunk = quiet();
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
    expect(dictation.speechDetected.value, '判决看的是原始 RMS').toBe(true);
    now.mockReturnValue(1_500);
    await dictation.stop();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const uploaded = uploadedSamples(fetchMock);
    expect(rms(uploaded)).toBeGreaterThan(rms(chunk) * 1.5);
    expect(rms(uploaded)).toBeCloseTo(ENHANCE_TARGET_RMS, 1);
  });

  it('分段切片：与终稿走同一条增强（预览与终稿的电平口径一致）', async () => {
    const fetchMock = stubRecognize('叶片');
    const { processor } = installMic();
    const dictation = useDictation();
    dictation.setAlwaysOn(true);
    await dictation.arm();

    // 首段门槛 2.8s ≈ 11 个 256ms 块：喂到第 11 块才切出去
    const chunk = quiet();
    const blocks = Math.ceil(((SEGMENT_FIRST_MS / 1000) * TARGET_SAMPLE_RATE) / chunk.length);
    for (let i = 0; i < blocks; i++) {
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const uploaded = uploadedSamples(fetchMock);
    expect(rms(uploaded)).toBeGreaterThan(rms(chunk) * 1.5);
    expect(rms(uploaded)).toBeCloseTo(ENHANCE_TARGET_RMS, 1);
    dictation.dispose();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeWav,
  resample,
  TARGET_SAMPLE_RATE,
  dictationSupported,
  useDictation,
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

afterEach(() => {
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

describe('录音操作生命周期', () => {
  function installBrowser(getUserMedia: () => Promise<MediaStream>): void {
    const processor = {
      onaudioprocess: null as ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    class FakeAudioContext {
      sampleRate = TARGET_SAMPLE_RATE;
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
  }

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

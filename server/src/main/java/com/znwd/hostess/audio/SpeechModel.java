package com.znwd.hostess.audio;

/**
 * 语音能力（合成 + 识别）。
 *
 * <p>与 {@code ChatModel} 分开是有意的：对话模型的装配规则（thinking 开关、extra body、max tokens）
 * 对语音接口完全不适用，硬塞进一个接口只会让两边都变糊。展厅的语音是可降级能力——
 * 语音不通时前端退回浏览器内置播报，问答本身不受影响，所以这里也没有 mock 实现。
 */
public interface SpeechModel {

    /** 实现名，出现在日志与 /api/health 上 */
    String name();

    /**
     * 文本转语音。
     *
     * @param text 要合成的正文（已由调用方按句切片，不是整篇回答）
     * @return WAV 字节流（24kHz/单声道/16bit，MiMo 的默认输出）
     */
    byte[] synthesize(String text);

    /**
     * 语音转文本。
     *
     * @param wav 16bit PCM 的 WAV 字节流；MiMo 只认 mp3/wav 两种容器
     * @return 识别文本与音频时长（时长用于日志与用量核对）
     */
    Recognition recognize(byte[] wav);

    /** 识别结果。 */
    record Recognition(String text, double seconds) {
    }
}

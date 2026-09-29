package com.znwd.hostess.audio;

/**
 * 语音未启用时的占位实现（provider=none 或没配 base-url）。
 *
 * <p>为什么不留一个 {@code null} bean：Controller 里到处判空比抛异常更容易漏。
 * 真实调用一律抛 {@link Unavailable}，由路由层转成 503，前端据此退回浏览器内置播报。
 */
public final class DisabledSpeechModel implements SpeechModel {

    public static final String NAME = "none";

    private final String reason;

    public DisabledSpeechModel(String reason) {
        this.reason = reason;
    }

    public String reason() {
        return reason;
    }

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public byte[] synthesize(String text) {
        throw new Unavailable(reason);
    }

    @Override
    public Recognition recognize(byte[] wav) {
        throw new Unavailable(reason);
    }

    /** 语音能力未启用：前端应当降级，而不是把它当成故障反复重试。 */
    public static final class Unavailable extends RuntimeException {
        public Unavailable(String message) {
            super(message);
        }
    }
}

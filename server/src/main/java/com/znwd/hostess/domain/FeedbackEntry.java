package com.znwd.hostess.domain;

/**
 * 参观者对回答的点赞/点踩。
 *
 * @param question 问题摘要；缺省时由服务端从会话里取最后一条用户提问，保证运营看到的是真实问题
 */
public record FeedbackEntry(long at, String sessionId, String rating, String comment, String question) {

    public static final String UP = "up";
    public static final String DOWN = "down";

    public boolean down() {
        return DOWN.equals(rating);
    }

    public boolean up() {
        return UP.equals(rating);
    }
}

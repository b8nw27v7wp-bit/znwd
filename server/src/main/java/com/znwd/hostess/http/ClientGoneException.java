package com.znwd.hostess.http;

/**
 * 客户端中途断开（关屏/切页/前端新提问 abort 旧流）——不是服务端错误，按正常收尾处理。
 *
 * <p>为什么在 {@code http} 包而不是 {@code web}：写帧的一侧（{@code web/ChatController#send}）
 * 要抛它，问答链路的一侧（{@code rag/ChatRunService#stream}）要接住它——接住之后要把**已生成的
 * 部分回答**写回会话、给 chat_log 落一条 {@code client_gone}。RAG 层不能反向依赖 web 层，
 * 而两边共享的只有 http（传输层）这一层，所以信号类放这里。
 *
 * <p>禁用栈追踪：它是纯控制流信号，从来不会被打印或记录（打印反而会把「访客关页面」
 * 变成日志里的噪音，tools/security.py 的 G07 正是盯着这条）。
 */
public class ClientGoneException extends RuntimeException {

    public ClientGoneException() {
        super("client gone", null, false, false);
    }
}

package com.znwd.hostess.rag;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.analytics.Analytics;
import com.znwd.hostess.config.KnowledgeService;
import com.znwd.hostess.domain.ChatLogEntry;
import com.znwd.hostess.embedding.BagEmbeddingProvider;
import com.znwd.hostess.http.ClientGoneException;
import com.znwd.hostess.http.JsonlStore;
import com.znwd.hostess.http.LruCache;
import com.znwd.hostess.http.LruCache.CachedAnswer;
import com.znwd.hostess.knowledge.HybridRetriever;
import com.znwd.hostess.knowledge.KnowledgeChunk;
import com.znwd.hostess.knowledge.KnowledgeLoader;
import com.znwd.hostess.knowledge.VectorStore;
import com.znwd.hostess.llm.ChatMessage;
import com.znwd.hostess.llm.ChatModel;
import com.znwd.hostess.llm.ChatRole;
import com.znwd.hostess.llm.LlmUsage;
import com.znwd.hostess.session.SessionStore;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/**
 * 客户端中途断开时的记账（P0-1）。
 *
 * <p>背景：前端「新提问 abort 旧流」是常态交互，关屏/切页同理。老实现里 delta 一断，
 * 异常直接穿出 {@code ChatRunService.stream}——本轮的会话写回、chat_log、缓存全部被跳过，
 * 下一轮追问也就没有被打断那一问的上下文。
 *
 * <p>三个边界各一条用例（落账之后异常都要**继续上抛**，由 ChatController 在
 * {@code catch (ClientGoneException)} 里 complete 收尾——那条路径是 tools/security.py
 * G06/G07 走过的已验证组合）：
 * <ul>
 *   <li>meta/delta 断开 → 部分回答写回会话 + chat_log 落一条 {@code client_gone}、不进缓存、不发 done；</li>
 *   <li>meta 就断开（还没有任何回答）→ 不写空会话，但同样只落一条留痕；</li>
 *   <li>done 断开 → append/logChat/缓存在发帧之前就完成了，**不得**再落第二条账。</li>
 * </ul>
 *
 * <p>{@link ScriptedModel} 刻意不吞回调里的异常：这与 {@code OpenAiCompatChatModel.stream} 的
 * 实际行为一致（它只接 LlmHttpException/Interrupted/IOException，RuntimeException 直接穿出）。
 */
class ChatRunServiceStreamAbortTest {

    private static final String MESSAGE = "光伏清洁机器人怎么清洗组件";
    private static final String SESSION = "s-abort";

    @TempDir
    Path tmpDir;

    private SessionStore sessions;
    private Analytics analytics;
    private LruCache<CachedAnswer> cache;
    private ChatRunService service;

    @BeforeEach
    void setUp() throws Exception {
        sessions = new SessionStore(null, null);
        analytics = mock(Analytics.class);
        cache = new LruCache<>(16);
        JsonlStore logStore = mock(JsonlStore.class);
        service = new ChatRunService(knowledge(), new ScriptedModel(), sessions, analytics, cache, logStore,
                PromptStore.defaults(), true);
    }

    @Test
    void 中途断开时部分回答写回会话且绝不进缓存() {
        RecordingSink sink = new RecordingSink();
        sink.deltaBudget = 1; // 第 2 片 delta 起客户端已经走了

        assertThrows(ClientGoneException.class, () -> service.stream(MESSAGE, SESSION, sink),
                "落完账要把断开信号交回控制器收尾");

        List<ChatMessage> history = sessions.history(SESSION);
        assertEquals(2, history.size(), "部分回答必须写回会话：下一轮追问的上下文不能丢掉被打断的那一问");
        assertEquals(ChatRole.USER, history.get(0).role());
        assertEquals(ChatRole.ASSISTANT, history.get(1).role());
        assertEquals("第一句。第二句。",
                history.get(1).content(), "模型已生成的都算（含 send 失败的那片，它本来就在答案里）");
        assertFalse(sink.doneCalled(), "客户端已经走了，不再发 done 帧");
        assertEquals(0, cache.size(), "半截回答绝不进答案缓存——否则下一问会拿到残缺答案");

        ChatLogEntry entry = singleChatLog();
        assertEquals(ChatRunService.ERROR_CLIENT_GONE, entry.error(),
                "chat_log 落一条 client_gone（schema 的 error 列）");
        assertFalse(entry.answerPreview() == null || entry.answerPreview().isBlank(),
                "留痕里要能看到被打断时已生成的那部分");
    }

    @Test
    void meta帧就断开时不写会话但同样只落一条留痕() {
        RecordingSink sink = new RecordingSink();
        sink.breakOnMeta = true;

        assertThrows(ClientGoneException.class, () -> service.stream(MESSAGE, SESSION, sink));

        assertTrue(sessions.history(SESSION).isEmpty(), "一帧都没发出去：没有可写回的回答，不写空轮次");
        assertFalse(sink.doneCalled());
        assertEquals(0, cache.size());

        ChatLogEntry entry = singleChatLog();
        assertEquals(ChatRunService.ERROR_CLIENT_GONE, entry.error(),
                "meta 断开也要留一条痕（且只有一条，不与后续账重复）");
    }

    @Test
    void done帧断开时append与日志已完成不得重复落账() {
        RecordingSink sink = new RecordingSink();
        sink.breakOnDone = true;

        assertThrows(ClientGoneException.class, () -> service.stream(MESSAGE, SESSION, sink),
                "done 帧失败原样交给控制器收尾（它按客户端断开 complete，不打错误日志）");

        assertEquals(2, sessions.history(SESSION).size(), "回答是完整的，会话写回照旧");
        ChatLogEntry entry = singleChatLog();
        assertNull(entry.error(), "done 才断开：这轮本来就成功了，错误码只能是 null（否则一问两条账）");
        assertEquals(1, cache.size(), "完整回答照常进缓存");
        assertTrue(sink.events().contains("meta"));
    }

    @Test
    void 正常路径行为不变() {
        RecordingSink sink = new RecordingSink();

        service.stream(MESSAGE, SESSION, sink);

        assertEquals(List.of("meta", "delta", "delta", "delta", "done"), sink.events());
        assertEquals("第一句。第二句。第三句。", sessions.history(SESSION).get(1).content());
        assertEquals(1, cache.size());
        ChatLogEntry entry = singleChatLog();
        assertNull(entry.error(), "成功路径不带错误码");
    }

    // ── helpers ──────────────────────────────────────────────────

    /** 恰好一条 chat_log：任何「多落一条」的实现都会在这里现形 */
    private ChatLogEntry singleChatLog() {
        ArgumentCaptor<ChatLogEntry> captor = ArgumentCaptor.forClass(ChatLogEntry.class);
        verify(analytics, times(1)).logChat(captor.capture());
        return captor.getValue();
    }

    private KnowledgeService knowledge() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        VectorStore vectors = new VectorStore(new BagEmbeddingProvider(16),
                tmpDir.resolve("vectors.bag.json"), mapper);
        HybridRetriever retriever = new HybridRetriever(vectors, 3.8, 0.35);
        retriever.replace(List.of(
                new KnowledgeChunk("01_光伏清洁机器人/产品概述.md#0", "光伏清洁机器人",
                        "01_光伏清洁机器人/产品概述.md",
                        "两栖光伏清洁机器人用于光伏组件清洗，可替代人工。", "pv-clean", "光伏清洁",
                        List.of("光伏", "清洁"))));
        return new KnowledgeService(new KnowledgeLoader(mapper), retriever, vectors, Path.of("."), false);
    }

    /** 每次固定吐三片，便于断言「断在哪一片」 */
    private static final class ScriptedModel implements ChatModel {

        @Override
        public String name() {
            return "scripted";
        }

        @Override
        public LlmUsage lastUsage() {
            return null;
        }

        @Override
        public ChatCompletionResult complete(List<ChatMessage> messages) {
            return new ChatCompletionResult("第一句。第二句。第三句。", name(), null);
        }

        @Override
        public void stream(List<ChatMessage> messages, Consumer<String> onDelta) {
            for (String piece : List.of("第一句。", "第二句。", "第三句。")) {
                onDelta.accept(piece);
            }
        }
    }

    /** 可脚本化的 SSE 出口：按计划在 meta/delta/done 上抛 {@link ClientGoneException} */
    private static final class RecordingSink implements ChatRunService.StreamSink {

        private final List<String> events = new ArrayList<>();
        private int deltaBudget = Integer.MAX_VALUE;
        private boolean breakOnMeta;
        private boolean breakOnDone;

        @Override
        public void meta(Map<String, Object> meta) {
            if (breakOnMeta) {
                throw new ClientGoneException();
            }
            events.add("meta");
        }

        @Override
        public void delta(String text) {
            if (deltaBudget <= 0) {
                throw new ClientGoneException();
            }
            deltaBudget--;
            events.add("delta");
        }

        @Override
        public void done(Map<String, Object> done) {
            if (breakOnDone) {
                throw new ClientGoneException();
            }
            events.add("done");
        }

        boolean doneCalled() {
            return events.contains("done");
        }

        List<String> events() {
            return events;
        }
    }
}

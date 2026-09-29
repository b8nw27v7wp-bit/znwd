package com.znwd.hostess.rag;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.config.KnowledgeService;
import com.znwd.hostess.embedding.BagEmbeddingProvider;
import com.znwd.hostess.knowledge.HybridRetriever;
import com.znwd.hostess.knowledge.KnowledgeLoader;
import com.znwd.hostess.knowledge.VectorStore;
import com.znwd.hostess.llm.ChatMessage;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Prompt 外置（{@link PromptStore}）的加载与回退规则。
 *
 * <p>核心承诺有两条：① 默认文本与历史常量逐字一致（行为零变化）；② 任何一环读失败都回退
 * classpath 默认并记日志，问答绝不中断——现场改措辞是可选项，不是新的故障点。
 */
class PromptStoreTest {

    @Test
    void classpath默认文本与内置兜底常量逐字一致() {
        for (String resource : List.of(PromptStore.SYSTEM_RESOURCE, PromptStore.NO_HIT_HINT_RESOURCE,
                PromptStore.NO_HIT_REPLY_RESOURCE)) {
            assertNotNull(PromptStore.class.getClassLoader().getResource(resource),
                    resource + " 必须打进 classpath，缺失会静默退回内置常量");
        }

        PromptStore store = PromptStore.defaults();
        assertEquals(PromptStore.DEFAULT_SYSTEM, store.systemBase());
        assertEquals(PromptStore.DEFAULT_NO_HIT_HINT, store.noHitHint());
        assertEquals(PromptStore.DEFAULT_NO_HIT_REPLY, store.noHitReply());
        assertFalse(store.systemBase().isBlank());
        assertFalse(store.noHitReply().isBlank());
    }

    @Test
    void 无配置时用classpath默认() {
        PromptStore store = new PromptStore(null);
        assertEquals(PromptStore.DEFAULT_SYSTEM, store.systemBase());
        assertEquals(PromptStore.DEFAULT_NO_HIT_REPLY, store.noHitReply());
    }

    @Test
    void 外部文件只覆盖自己那一项_其余仍是默认(@TempDir Path dir) throws Exception {
        Path system = dir.resolve("system.txt");
        Files.writeString(system, "现场改版的 system prompt", StandardCharsets.UTF_8);

        PromptStore store = new PromptStore(new AppProperties.Prompt(system.toString(), null, null));

        assertEquals("现场改版的 system prompt", store.systemBase());
        assertEquals(PromptStore.DEFAULT_NO_HIT_HINT, store.noHitHint());
        assertEquals(PromptStore.DEFAULT_NO_HIT_REPLY, store.noHitReply());
    }

    @Test
    void 外部文件缺失时回退classpath默认(@TempDir Path dir) throws Exception {
        Path missing = dir.resolve("not-here.txt");
        PromptStore store = new PromptStore(new AppProperties.Prompt(missing.toString(), null, null));
        assertEquals(PromptStore.DEFAULT_SYSTEM, store.systemBase());

        // 路径指向目录（现场把目录填进了配置）同样回退
        PromptStore dirAsFile = new PromptStore(new AppProperties.Prompt(dir.toString(), null, null));
        assertEquals(PromptStore.DEFAULT_SYSTEM, dirAsFile.systemBase());
    }

    @Test
    void 外部路径非法时回退classpath默认() {
        // NUL 不是合法路径字符：Path.of 抛 InvalidPathException（RuntimeException），必须被兜住
        PromptStore store = new PromptStore(new AppProperties.Prompt("bad\0path", null, null));
        assertEquals(PromptStore.DEFAULT_SYSTEM, store.systemBase());
    }

    @Test
    void 外部文件为空白时回退classpath默认(@TempDir Path dir) throws Exception {
        Path blank = dir.resolve("blank.txt");
        Files.writeString(blank, "  \r\n\r\n", StandardCharsets.UTF_8);

        PromptStore store = new PromptStore(new AppProperties.Prompt(null, null, blank.toString()));

        assertEquals(PromptStore.DEFAULT_NO_HIT_REPLY, store.noHitReply());
    }

    @Test
    void reload读到最新内容_文件删掉后回退默认(@TempDir Path dir) throws Exception {
        Path reply = dir.resolve("reply.txt");
        Files.writeString(reply, "第一版拒答", StandardCharsets.UTF_8);
        PromptStore store = new PromptStore(new AppProperties.Prompt(null, null, reply.toString()));
        assertEquals("第一版拒答", store.noHitReply());

        Files.writeString(reply, "第二版拒答", StandardCharsets.UTF_8);
        assertEquals("第一版拒答", store.noHitReply(), "不 reload 不该自己变，避免问答中途换话术");
        store.reload();
        assertEquals("第二版拒答", store.noHitReply());

        Files.delete(reply);
        store.reload();
        assertEquals(PromptStore.DEFAULT_NO_HIT_REPLY, store.noHitReply());
    }

    @Test
    void CRLF与行尾换行不改变生效文本(@TempDir Path dir) throws Exception {
        // Windows 记事本另存、git autocrlf 检出都会变 CRLF 并补行尾换行，生效文本必须仍与常量一致
        Path crlf = dir.resolve("system-crlf.txt");
        Files.write(crlf, (PromptStore.DEFAULT_SYSTEM + "\n").replace("\n", "\r\n").getBytes(StandardCharsets.UTF_8));

        PromptStore store = new PromptStore(new AppProperties.Prompt(crlf.toString(), null, null));
        assertEquals(PromptStore.DEFAULT_SYSTEM, store.systemBase());
    }

    @Test
    void 管道的system与拒答取自注入的PromptStore(@TempDir Path dir) throws Exception {
        Path system = dir.resolve("system.txt");
        Files.writeString(system, "现场版讲解员设定", StandardCharsets.UTF_8);
        Path hint = dir.resolve("hint.txt");
        Files.writeString(hint, "现场版无命中指令", StandardCharsets.UTF_8);
        Path reply = dir.resolve("reply.txt");
        Files.writeString(reply, "现场版拒答", StandardCharsets.UTF_8);
        PromptStore store = new PromptStore(
                new AppProperties.Prompt(system.toString(), hint.toString(), reply.toString()));

        RagPipeline pipeline = new RagPipeline(null, null, false, store);
        List<ChatMessage> messages = pipeline.buildPrompt(List.of(), "你好", List.of());

        assertEquals(2, messages.size(), "system + 用户提问");
        assertTrue(messages.get(0).content().startsWith("现场版讲解员设定"));
        assertTrue(messages.get(0).content().contains("现场版无命中指令"));
        assertEquals("现场版拒答", pipeline.noHitReply());
    }

    @Test
    void 知识reload顺带重载prompt(@TempDir Path dir) throws Exception {
        CountingPromptStore prompts = new CountingPromptStore();
        KnowledgeService service = knowledgeService(dir, prompts);
        service.loadInitial();

        service.reload();
        assertEquals(1, prompts.reloads, "POST /api/knowledge/reload 走的就是这条路");
    }

    @Test
    void prompt重载失败不会中断知识reload(@TempDir Path dir) throws Exception {
        KnowledgeService service = knowledgeService(dir, new ExplodingPromptStore());
        service.loadInitial();

        assertTrue(service.reload() > 0, "prompt 读失败只回退默认文本，知识重载照常完成");
        assertFalse(service.chunks().isEmpty());
    }

    @Test
    void 未挂prompt钩子的旧构造器reload照常工作(@TempDir Path dir) throws Exception {
        KnowledgeService service = knowledgeService(dir, null);
        service.loadInitial();

        assertTrue(service.reload() > 0);
    }

    private static KnowledgeService knowledgeService(Path dir, PromptStore prompts) throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        Path knowledgeDir = Files.createDirectory(dir.resolve("kb"));
        Files.writeString(knowledgeDir.resolve("a.md"), "# 标题\n\n这是知识正文。", StandardCharsets.UTF_8);
        VectorStore vectors = new VectorStore(new BagEmbeddingProvider(8), dir.resolve("vectors.json"), mapper);
        HybridRetriever retriever = new HybridRetriever(vectors, 0.1, 0.5);
        return new KnowledgeService(new KnowledgeLoader(mapper), retriever, vectors, knowledgeDir, false, prompts);
    }

    private static final class CountingPromptStore extends PromptStore {
        private int reloads;

        private CountingPromptStore() {
            super(null);
        }

        @Override
        public void reload() {
            reloads++;
            super.reload();
        }
    }

    private static final class ExplodingPromptStore extends PromptStore {
        private ExplodingPromptStore() {
            super(null);
        }

        @Override
        public void reload() {
            throw new IllegalStateException("模拟 prompt 重载失败");
        }
    }
}

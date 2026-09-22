package com.znwd.hostess.rag;

import java.util.ArrayList;
import java.util.List;

import com.znwd.hostess.knowledge.HybridHit;
import com.znwd.hostess.knowledge.HybridRetriever;
import com.znwd.hostess.knowledge.RetrievalDiagnostics;
import com.znwd.hostess.knowledge.RetrievalOutcome;
import com.znwd.hostess.llm.ChatMessage;
import com.znwd.hostess.llm.ChatModel;
import com.znwd.hostess.llm.LlmUsage;

/**
 * RAG 主链路：检索 → 拼 prompt → 调模型。
 *
 * <p>两个产品决策写在这里，别在别处重做：
 * <ol>
 *   <li>闸门未通过时**不调用大模型**，直接返回固定拒答（省一次调用、响应即时、措辞稳定）。
 *       需要模型措辞时把 NO_HIT_LLM 打开。</li>
 *   <li>知识不足时 system 里换成「直说没有」的指令，而不是喂几段无关片段让它硬答。</li>
 * </ol>
 */
public class RagPipeline {

    public static final int DEFAULT_TOP_K = 4;
    public static final int MAX_HISTORY_MESSAGES = 12;

    private static final String SYSTEM_BASE =
            "你是本项目的 AI 虚拟讲解员，主题为两栖光伏清洁机器人、“光伏医生”智慧运维系统与项目的研发团队。用简体中文、礼貌、简洁地回答项目、产品、技术方案、作业流程与合作相关问题。"
                    + "优先依据提供的企业知识；知识不足时明确说明并给出可操作建议。避免编造不确定的参数与承诺。回答时可分点列出资料中的关键信息。"
                    // 展厅里被追问最多、也最容易被编出来的就是「在哪 / 怎么联系 / 多少钱」这三类，
                    // 知识里没有就直说没有：编出来的地址和邮箱参观者会当真，比答不上来更糟。
                    // 但反过来过度保守同样错——实测「清洁机器人有多重？」资料里有 23kg，
                    // 却因为「型号参数一律说未提供」这句被答成「资料中未提供」。
                    + "资料里给了的数字与参数（重量、尺寸、效率、成本、价格、时间、规模等）必须照实回答，不要因为属于「参数」就保守地答「资料中未提供」；"
                    + "只有资料里确实查不到的（地址、电话、邮箱、联系人、未列明的报价或业绩）才回答「资料中未提供」，不要推测、不要举例、不要编造联系方式或承诺。"
                    // 效益指标在申报书与项目概述里是两套口径，合成一个数就是编造
                    + "同一指标若资料给了两套口径（如申报书口径与项目概述口径），分别说明各自来源与前提，不要合成一个数。"
                    // 展厅大屏会把回答念出来、也会原样显示：Markdown 记号既上屏也进朗读，直接要纯文本
                    + "直接输出纯文本：不要使用 Markdown 记号（如 **、#、* 等），需要分点时用「1. 2. 3.」或「·」开头，句子尽量短、便于朗读。";

    /** 闸门未通过时给模型的明确指令：宁可说没有，也不要拿无关片段拼答案 */
    private static final String NO_HIT_HINT =
            "（本次未检索到相关资料。请直接说明资料中没有这部分内容，并建议提问者改问项目介绍、产品与作业流程、技术方案、落地成效或服务合作相关的问题；不要凭常识编造产品参数、价格或承诺。）";

    /**
     * 闸门未通过时的固定回复。拒答文案是固定的，让模型再生成一遍纯属花钱（实测一次约 780 tokens），
     * 且展厅场景要的是稳定、即时，不是文采。
     */
    public static final String NO_HIT_REPLY =
            "抱歉，这个问题不在我的讲解范围内，资料中也没有相关内容。\n\n"
                    + "我是本项目的虚拟讲解员，可以为您解答：\n"
                    + "1. 光伏清洁机器人：两栖作业形式、结构材料与清洁流程\n"
                    + "2. 光伏医生智慧运维：无人机巡检、缺陷诊断、数据与平台功能\n"
                    + "3. 项目与团队：项目背景、落地案例、商业模式与团队资质\n\n"
                    + "欢迎换个角度提问。";

    private final HybridRetriever retriever;
    private final ChatModel model;
    private final boolean noHitLlm;

    public RagPipeline(HybridRetriever retriever, ChatModel model, boolean noHitLlm) {
        this.retriever = retriever;
        this.model = model;
        this.noHitLlm = noHitLlm;
    }

    /**
     * 命中片段 → 前端「来源」列表。
     *
     * <p>按**资料文件**去重：同一份资料的相关片段常常一次占满 topK（实测问「光伏清洁无人机怎么清洗组件」，
     * 4 条来源里 3 条同属一篇 demo 文件）。不去重的后果是来源面板里挂着 3 张同名卡片、前端 `:key` 撞车，
     * 而参观者要的是「回答引了哪几份资料」。保留闸门分最高的那条，片段内容取该文件的代表片段。
     */
    public static List<RagSource> toSources(List<HybridHit> hits) {
        List<RagSource> out = new ArrayList<>(hits.size());
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (HybridHit h : hits) {
            String key = h.sourcePath() == null || h.sourcePath().isBlank() ? h.title() : h.sourcePath();
            if (!seen.add(key)) {
                continue;
            }
            out.add(new RagSource(
                    h.title(),
                    h.text().length() > 200 ? h.text().substring(0, 200) : h.text(),
                    round(h.score(), 4),
                    h.sourcePath(),
                    h.zone(),
                    h.zoneTitle(),
                    h.vectorScore(),
                    h.keywordScore()));
        }
        return out;
    }

    /** 检索 + 指代改写（回答仍按原问题，只有检索用改写后的查询） */
    public RetrievalForMessage retrieveForMessage(String message, List<ChatMessage> history, int topK) {
        RewriteResult rewrite = QueryRewriter.rewrite(retriever, message, history);
        RetrievalOutcome outcome = retriever.retrieveWithDiagnostics(rewrite.query(), topK);
        return new RetrievalForMessage(outcome.hits(), outcome.diagnostics(), rewrite);
    }

    public RagAnswer answer(String message, List<ChatMessage> history) {
        List<ChatMessage> trimmed = history.size() > MAX_HISTORY_MESSAGES
                ? history.subList(history.size() - MAX_HISTORY_MESSAGES, history.size())
                : history;
        RetrievalForMessage retrieved = retrieveForMessage(message, trimmed, DEFAULT_TOP_K);
        List<HybridHit> hits = retrieved.hits();

        if (hits.isEmpty() && !noHitLlm) {
            return new RagAnswer(NO_HIT_REPLY, List.of(), RagAnswer.MODE_LLM_ONLY, RagAnswer.PROVIDER_GATE,
                    retrieved.diagnostics().mode().value(), true, retrieved.diagnostics(), retrieved.rewrite(), null);
        }

        ChatModel.ChatCompletionResult result = model.complete(buildPrompt(hits, message, trimmed));
        return new RagAnswer(
                result.content(),
                toSources(hits),
                hits.isEmpty() ? RagAnswer.MODE_LLM_ONLY : RagAnswer.MODE_RAG,
                result.provider(),
                retrieved.diagnostics().mode().value(),
                hits.isEmpty(),
                retrieved.diagnostics(),
                retrieved.rewrite(),
                result.usage());
    }

    /**
     * 流式回答。闸门拦截时把固定回复一次性推给前端（与原实现一致：前端不必区分两种收尾方式）。
     *
     * @param onDelta 正文增量回调
     */
    public StreamOutcome stream(String message, List<ChatMessage> history, java.util.function.Consumer<String> onDelta) {
        List<ChatMessage> trimmed = history.size() > MAX_HISTORY_MESSAGES
                ? history.subList(history.size() - MAX_HISTORY_MESSAGES, history.size())
                : history;
        RetrievalForMessage retrieved = retrieveForMessage(message, trimmed, DEFAULT_TOP_K);
        List<HybridHit> hits = retrieved.hits();
        boolean gated = hits.isEmpty() && !noHitLlm;
        String provider = gated ? RagAnswer.PROVIDER_GATE : model.name();

        if (gated) {
            onDelta.accept(NO_HIT_REPLY);
            return new StreamOutcome(NO_HIT_REPLY, toSources(hits), RagAnswer.MODE_LLM_ONLY, provider,
                    retrieved.diagnostics().mode().value(), true, retrieved.diagnostics(), retrieved.rewrite(), null);
        }

        StringBuilder full = new StringBuilder();
        model.stream(buildPrompt(hits, message, trimmed), delta -> {
            full.append(delta);
            onDelta.accept(delta);
        });
        LlmUsage usage = model.lastUsage();
        return new StreamOutcome(
                full.toString(),
                toSources(hits),
                hits.isEmpty() ? RagAnswer.MODE_LLM_ONLY : RagAnswer.MODE_RAG,
                provider,
                retrieved.diagnostics().mode().value(),
                hits.isEmpty(),
                retrieved.diagnostics(),
                retrieved.rewrite(),
                usage);
    }

    /** 命中片段装进 system；闸门未通过时换成「直说没有」指令 */
    public List<ChatMessage> buildPrompt(List<HybridHit> hits, String message, List<ChatMessage> history) {
        List<ChatMessage> messages = new ArrayList<>();
        if (!hits.isEmpty()) {
            StringBuilder block = new StringBuilder();
            for (int i = 0; i < hits.size(); i++) {
                HybridHit h = hits.get(i);
                if (block.length() > 0) {
                    block.append("\n\n");
                }
                block.append("【片段 ").append(i + 1).append("｜").append(h.title()).append("｜")
                        .append(h.zoneTitle() == null || h.zoneTitle().isBlank() ? (h.zone() == null ? "" : h.zone()) : h.zoneTitle())
                        .append("｜").append(h.sourcePath()).append("】\n").append(h.text());
            }
            messages.add(ChatMessage.system(SYSTEM_BASE + "\n\n【企业知识】\n" + block));
        } else {
            messages.add(ChatMessage.system(SYSTEM_BASE + "\n\n【企业知识】\n" + NO_HIT_HINT));
        }
        for (ChatMessage turn : history) {
            if (turn.role() == com.znwd.hostess.llm.ChatRole.USER
                    || turn.role() == com.znwd.hostess.llm.ChatRole.ASSISTANT) {
                messages.add(turn);
            }
        }
        messages.add(ChatMessage.user(message));
        return messages;
    }

    static double round(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    public boolean noHitLlm() {
        return noHitLlm;
    }

    /** 历史裁剪（只保留最近若干条，避免多轮把上下文撑爆） */
    public static List<ChatMessage> trimHistory(List<ChatMessage> history) {
        return history.size() > MAX_HISTORY_MESSAGES
                ? history.subList(history.size() - MAX_HISTORY_MESSAGES, history.size())
                : history;
    }

    public record RetrievalForMessage(List<HybridHit> hits, RetrievalDiagnostics diagnostics, RewriteResult rewrite) {
    }

    public record StreamOutcome(
            String full,
            List<RagSource> sources,
            String mode,
            String provider,
            String retrieval,
            boolean noHit,
            RetrievalDiagnostics diagnostics,
            RewriteResult rewrite,
            LlmUsage usage) {
    }
}

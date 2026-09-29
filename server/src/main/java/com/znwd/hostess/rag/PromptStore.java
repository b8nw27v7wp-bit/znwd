package com.znwd.hostess.rag;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.znwd.hostess.config.AppProperties;

/**
 * Prompt 文本仓库：讲解话术（system prompt、无命中指令、固定拒答）外置，现场改措辞不必重编译发版。
 *
 * <p>每次加载的顺序（reload 从头再来，不叠加旧状态）：
 * <ol>
 *   <li>classpath 默认：{@code resources/prompts/*.txt}，随包发布，文本与历史常量逐字一致
 *       （守卫见 {@code PromptStoreTest}）；</li>
 *   <li>外部文件覆盖：{@code znwd.prompt.*-path}（.env 里的 {@code PROMPT_*_PATH}）指向的文件
 *       存在且非空时顶掉默认——一体机现场直接改这个文件；</li>
 *   <li>外部文件缺失/空白/读失败：记日志并回退 classpath 默认；连 classpath 资源都缺（打包遗漏）
 *       才用内置兜底常量。任何一环失败都不抛——问答绝不断。</li>
 * </ol>
 *
 * <p>重载时机：{@link com.znwd.hostess.config.KnowledgeService#reload()}（POST /api/knowledge/reload
 * 或知识热更新）会顺带 {@link #reload()}，与知识热更新共用同一条操作路径。
 */
public class PromptStore {

    private static final Logger log = LoggerFactory.getLogger(PromptStore.class);

    static final String SYSTEM_RESOURCE = "prompts/system.txt";
    static final String NO_HIT_HINT_RESOURCE = "prompts/no-hit-hint.txt";
    static final String NO_HIT_REPLY_RESOURCE = "prompts/no-hit-reply.txt";

    /**
     * 内置兜底常量：与 classpath 资源逐字一致，仅当资源缺失（打包遗漏）时使用。
     * 改任意一侧都会被 {@code PromptStoreTest} 拦下——两处必须同步改。
     */
    static final String DEFAULT_SYSTEM =
            "你是本项目的 AI 虚拟讲解员，主题为两栖光伏清洁机器人、“光伏医生”智慧运维系统与项目的研发团队。用简体中文、礼貌、简洁地回答项目、产品、技术方案、作业流程与合作相关问题。"
                    + "优先依据提供的企业知识；知识不足时明确说明并给出可操作建议。避免编造不确定的参数与承诺。回答时可分点列出资料中的关键信息。"
                    + "资料里给了的数字与参数（重量、尺寸、效率、成本、价格、时间、规模等）必须照实回答，不要因为属于「参数」就保守地答「资料中未提供」；"
                    + "只有资料里确实查不到的（地址、电话、邮箱、联系人、未列明的报价或业绩）才回答「资料中未提供」，不要推测、不要举例、不要编造联系方式或承诺。"
                    + "同一指标若资料给了两套口径（如申报书口径与项目概述口径），分别说明各自来源与前提，不要合成一个数。"
                    + "直接输出纯文本：不要使用 Markdown 记号（如 **、#、* 等），需要分点时用「1. 2. 3.」或「·」开头，句子尽量短、便于朗读。";

    /** 闸门未通过时给模型的明确指令：宁可说没有，也不要拿无关片段拼答案 */
    static final String DEFAULT_NO_HIT_HINT =
            "（本次未检索到相关资料。请直接说明资料中没有这部分内容，并建议提问者改问项目介绍、产品与作业流程、技术方案、落地成效或服务合作相关的问题；不要凭常识编造产品参数、价格或承诺。）";

    /** 闸门未通过时的固定回复（不调用大模型，措辞必须稳定、即时） */
    static final String DEFAULT_NO_HIT_REPLY =
            "抱歉，这个问题不在我的讲解范围内，资料中也没有相关内容。\n\n"
                    + "我是本项目的虚拟讲解员，可以为您解答：\n"
                    + "1. 光伏清洁机器人：两栖作业形式、结构材料与清洁流程\n"
                    + "2. 光伏医生智慧运维：无人机巡检、缺陷诊断、数据与平台功能\n"
                    + "3. 项目与团队：项目背景、落地案例、商业模式与团队资质\n\n"
                    + "欢迎换个角度提问。";

    private final AppProperties.Prompt config;
    private volatile Snapshot current;

    /** @param config 外部文件覆盖配置；null 或字段留空 = 只用 classpath 默认 */
    public PromptStore(AppProperties.Prompt config) {
        this.config = config;
        this.current = load();
    }

    /** 不带外部覆盖的默认实例（测试与无配置场景） */
    public static PromptStore defaults() {
        return new PromptStore(null);
    }

    /** 重新加载（classpath 默认 → 外部文件覆盖）。不抛异常，失败只记日志并回退默认。 */
    public synchronized void reload() {
        current = load();
    }

    /** system prompt（拼在【企业知识】之前） */
    public String systemBase() {
        return current.system();
    }

    /** 闸门未通过、仍要调用模型时的「直说没有」指令 */
    public String noHitHint() {
        return current.noHitHint();
    }

    /** 闸门未通过时的固定拒答话术 */
    public String noHitReply() {
        return current.noHitReply();
    }

    private Snapshot load() {
        return new Snapshot(
                loadOne("system", SYSTEM_RESOURCE, DEFAULT_SYSTEM, pathOf(config == null ? null : config.systemPath())),
                loadOne("no-hit-hint", NO_HIT_HINT_RESOURCE, DEFAULT_NO_HIT_HINT,
                        pathOf(config == null ? null : config.noHitHintPath())),
                loadOne("no-hit-reply", NO_HIT_REPLY_RESOURCE, DEFAULT_NO_HIT_REPLY,
                        pathOf(config == null ? null : config.noHitReplyPath())));
    }

    private static String pathOf(String raw) {
        return raw == null || raw.isBlank() ? null : raw.strip();
    }

    private static String loadOne(String name, String resource, String fallback, String externalPath) {
        String base = readClasspath(resource);
        if (base == null || base.isEmpty()) {
            log.error("[prompt] classpath 资源缺失或为空：{}（打包遗漏？），使用内置兜底文本", resource);
            base = fallback;
        }
        if (externalPath == null) {
            return base;
        }
        try {
            Path file = Path.of(externalPath);
            if (!Files.isRegularFile(file)) {
                log.warn("[prompt] {} 的外部文件不存在，回退 classpath 默认：{}", name, file);
                return base;
            }
            String text = normalize(Files.readString(file, StandardCharsets.UTF_8));
            if (text.isEmpty()) {
                log.warn("[prompt] {} 的外部文件为空白，回退 classpath 默认：{}", name, file);
                return base;
            }
            log.info("[prompt] {} 已加载外部文件：{}", name, file);
            return text;
        } catch (IOException | RuntimeException e) {
            log.error("[prompt] {} 的外部文件读取失败，回退 classpath 默认：{}", name, externalPath, e);
            return base;
        }
    }

    private static String readClasspath(String resource) {
        try (InputStream in = PromptStore.class.getClassLoader().getResourceAsStream(resource)) {
            return in == null ? null : normalize(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException | RuntimeException e) {
            log.error("[prompt] classpath 资源读取失败：{}", resource, e);
            return null;
        }
    }

    /**
     * 统一换行与行尾：现场用记事本存成 CRLF、或编辑器补了行尾空行，都不该改变生效文本
     * （Windows 检出时 git 的 autocrlf 也会把资源文件变成 CRLF）。
     */
    private static String normalize(String text) {
        return text.replace("\r\n", "\n").replace('\r', '\n').stripTrailing();
    }

    private record Snapshot(String system, String noHitHint, String noHitReply) {
    }
}

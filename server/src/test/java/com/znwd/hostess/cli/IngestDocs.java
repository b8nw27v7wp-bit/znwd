package com.znwd.hostess.cli;

import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.ParserConfigurationException;

import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.xml.sax.SAXException;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.knowledge.ZonesMeta;

/**
 * 资料入库：把 PDF / Word / txt 转成 {@code knowledge/<展区>/} 下的 Markdown（旧 Node 版
 * {@code server/scripts/ingest-docs.ts} 的 Java 版，行为逐条对齐）。
 *
 * <pre>
 * 运行（在 server/ 目录）：
 *   ../tools/mvn -B -q test-compile exec:java@ingest \
 *       -Dexec.args="--src ./inbox --zone wind-inspect [--force] [--dry-run] [--knowledge ./knowledge]"
 * 参数：
 *   --src       源目录（默认 ./inbox，递归取其下可入库文件）
 *   --zone      展区 id 或目录名（必填，见 knowledge/_meta/zones.json）
 *   --knowledge 知识库目录（默认 ./knowledge，相对仓库根）
 *   --force     覆盖已存在的目标文件（默认不覆盖，报错）
 *   --dry-run   只打印将写入的路径与字数，不写盘
 * </pre>
 *
 * <p>外部依赖：PDF 用 {@code pdftotext}（poppler/xpdf）；DOCX 与 txt/md 由内置解析器处理，不需要
 * python 或 Office —— .docx 本质是 zip + XML，直接读 {@code word/document.xml} 即可（旧 Node 版走
 * python-docx，新栈去掉了这层依赖：少一个「机器上没装 python-docx」的失败点，也能进 CI 单测）。
 *
 * <p><b>入库后必做</b>：{@code POST /api/knowledge/reload} → 重跑 {@code exec:java@calibrate}
 * （语料一变 IDF 就变，阈值要重新标定）→ 重跑 {@code exec:java@eval}（top1/top3 不退化、漏答 0）。
 */
public final class IngestDocs {

    private static final Set<String> SUPPORTED =
            Set.of(".pdf", ".docx", ".doc", ".txt", ".md", ".markdown");

    private static final Pattern ALREADY_MARKED = Pattern.compile("^(#{1,6}\\s|\\||[-*+]\\s|\\d+[.、)]\\s)");
    private static final Pattern PAGE_NO = Pattern.compile("^[-—–\\s]*\\d{1,4}[-—–\\s]*$");
    private static final Pattern SEPARATOR = Pattern.compile("^[-=_*·\\s]{4,}$");
    private static final Pattern ENDS_PUNCT = Pattern.compile("[。！？；：,，.！?]$");
    private static final Pattern LATIN_END = Pattern.compile("[A-Za-z0-9,;:).!?]$");
    private static final Pattern LATIN_START = Pattern.compile("^[A-Za-z0-9(]");
    private static final Pattern ILLEGAL_NAME = Pattern.compile("[\\\\/:*?\"<>|]");
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    private static final Pattern DASH_RUN = Pattern.compile("-+");
    private static final Pattern TRAILING_BLANK = Pattern.compile("[ \t]+$");
    private static final Pattern BLANK_RUN = Pattern.compile("\n{3,}");

    /** WordprocessingML 命名空间（w:）。 */
    static final String W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

    private IngestDocs() {
    }

    public static void main(String[] args) {
        // Windows 控制台默认 GBK，中文报告会花屏——工具类输出统一按 UTF-8
        System.setOut(new PrintStream(System.out, true, StandardCharsets.UTF_8));

        Map<String, String> opts = parseArgs(args);
        String zoneArg = opts.get("zone");
        if (zoneArg == null || zoneArg.isBlank() || "true".equals(zoneArg)) {
            System.err.println("用法：exec:java@ingest -Dexec.args=\"--src <目录> --zone <展区id> "
                    + "[--force] [--dry-run] [--knowledge <目录>]\"");
            System.exit(2);
        }

        Path repoRoot = AppProperties.repoRoot();
        Path knowledgeDir = resolve(repoRoot, opts.getOrDefault("knowledge", "./knowledge"));
        Path srcDir = resolve(repoRoot, opts.getOrDefault("src", "./inbox"));
        boolean force = opts.containsKey("force");
        boolean dryRun = opts.containsKey("dry-run");

        try {
            if (!Files.isDirectory(srcDir)) {
                System.err.println("源目录不存在：" + srcDir);
                System.exit(2);
            }
            ZonesMeta meta = readZonesMeta(knowledgeDir);
            ZonesMeta.ZoneDef zone = meta.zones().stream()
                    .filter(z -> zoneArg.equals(z.id()) || zoneArg.equals(z.dir()))
                    .findFirst()
                    .orElse(null);
            if (zone == null) {
                System.err.println("未知展区：" + zoneArg + "。可选：" + meta.zones().stream()
                        .map(ZonesMeta.ZoneDef::id).toList()
                        + "（或先在 knowledge/_meta/zones.json 新增展区）");
                System.exit(2);
            }
            Path targetDir = knowledgeDir.resolve(zone.dir());

            List<Path> files = listSources(srcDir);
            if (files.isEmpty()) {
                System.out.println("源目录没有可入库文件（支持 " + String.join(" / ", SUPPORTED) + "）：" + srcDir);
                return;
            }

            System.out.println("展区：" + zone.id() + "（" + zone.dir() + "）  源目录：" + srcDir
                    + (dryRun ? "  [dry-run]" : ""));
            int ok = 0;
            List<String> failed = new ArrayList<>();
            for (Path file : files) {
                try {
                    String result = ingestOne(file, zone, targetDir, force, dryRun);
                    ok++;
                    System.out.println("OK   " + file.getFileName() + " → " + result);
                } catch (Exception e) {
                    String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                    failed.add(file.getFileName() + ": " + msg);
                    System.out.println("FAIL " + file.getFileName() + " → " + msg);
                }
            }
            System.out.printf("%n完成：%d/%d 入库%s%n", ok, files.size(), dryRun ? "（dry-run，未写盘）" : "");
            if (!failed.isEmpty()) {
                System.out.println("失败：\n  " + String.join("\n  ", failed));
            }
            System.out.println("""

                    下一步：
                      1) POST /api/knowledge/reload（或重启 server）
                      2) ../tools/mvn -B test-compile exec:java@calibrate      # 阈值要按新知识重标
                      3) ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write"   # top1/top3 不退化、漏答 0
                    """);
            if (ok != files.size()) {
                System.exit(1);
            }
        } catch (IOException e) {
            System.err.println(e.getMessage());
            System.exit(1);
        }
    }

    /** 入库单个文件，返回人话结果（写入路径 + 字数）。 */
    static String ingestOne(Path file, ZonesMeta.ZoneDef zone, Path targetDir, boolean force, boolean dryRun)
            throws Exception {
        String name = file.getFileName().toString();
        String ext = extension(name);
        String body = switch (ext) {
            case ".pdf" -> convertPdf(file);
            case ".docx" -> convertDocx(file);
            case ".doc" -> throw new IOException("旧版 .doc 请先另存为 .docx 或 .txt（本机无 libreoffice）");
            default -> normalizeExtracted(Files.readString(file, StandardCharsets.UTF_8));
        };

        String slug = slugify(name);
        Path target = targetDir.resolve(slug + ".md");
        String content = frontmatter(slug, zone, name) + body + "\n";

        if (dryRun) {
            return "[dry-run] " + relative(target) + "（" + content.length() + " 字符）";
        }
        Files.createDirectories(targetDir);
        if (Files.exists(target) && !force) {
            throw new IOException("目标已存在（加 --force 覆盖）：" + relative(target));
        }
        Files.writeString(target, content, StandardCharsets.UTF_8);
        return relative(target) + "（" + content.length() + " 字符）";
    }

    /** frontmatter 的键名与 {@code KnowledgeLoader} 的解析规则一致（title/zone/zoneTitle/tags 会被读取）。 */
    static String frontmatter(String slug, ZonesMeta.ZoneDef zone, String sourceName) {
        String date = LocalDate.now(ZoneId.of("Asia/Shanghai")).toString();
        return "---\n"
                + "title: " + slug + "\n"
                + "zone: " + zone.id() + "\n"
                + "zoneTitle: " + zone.title() + "\n"
                + "tags: " + zone.id() + ",ingest\n"
                + "source: " + sourceName + "\n"
                + "ingestedAt: " + date + "\n"
                + "---\n\n";
    }

    /** PDF：优先 pdftotext（保留版面），无文字层时明确报错而不是产出空文件。 */
    static String convertPdf(Path file) throws Exception {
        if (!hasCommand("pdftotext")) {
            throw new IOException("缺少 pdftotext（poppler/xpdf）。安装后再跑，或先把 PDF 另存为文本。");
        }
        String out = run(List.of("pdftotext", "-layout", "-enc", "UTF-8", file.toString(), "-"), 120);
        String text = normalizeExtracted(out);
        if (text.replaceAll("\\s", "").length() < 20) {
            throw new IOException("该 PDF 没有可提取的文字层（可能是扫描件/图片版）。"
                    + "需要 OCR：先转图片再用 vision 或 marker-pdf 识别。");
        }
        return text;
    }

    /** DOCX：内置解析器（zip + XML），保留标题层级、列表与表格。 */
    static String convertDocx(Path file) throws Exception {
        String text = normalizeExtracted(parseDocx(file));
        if (text.replaceAll("\\s", "").length() < 5) {
            throw new IOException("DOCX 解析结果为空（文档里没有可提取的正文？）");
        }
        return text;
    }

    /**
     * 读 {@code word/document.xml}：段落按样式/大纲级别升级为标题、编号段落转列表项，表格转 Markdown 表格。
     *
     * <p>解析前关掉 DTD 与外部实体 —— 待入库的 Word 文件来自外部（可能从网上下载），
     * 不能让一份带 DOCTYPE 的文档在入库时去读本机文件。
     */
    static String parseDocx(Path file) throws IOException {
        try (ZipFile zip = new ZipFile(file.toFile())) {
            ZipEntry entry = zip.getEntry("word/document.xml");
            if (entry == null) {
                throw new IOException("不是有效的 .docx（缺少 word/document.xml）");
            }
            Element body;
            try (InputStream in = zip.getInputStream(entry)) {
                body = (Element) parseSecurely(in).getElementsByTagNameNS(W_NS, "body").item(0);
            } catch (SAXException | ParserConfigurationException e) {
                throw new IOException("DOCX 的 document.xml 解析失败：" + e.getMessage());
            }
            if (body == null) {
                throw new IOException("不是有效的 .docx（word/document.xml 里没有 w:body）");
            }

            List<String> out = new ArrayList<>();
            int tableIndex = 0;
            for (Element child : children(body)) {
                switch (child.getLocalName()) {
                    case "p" -> {
                        String block = paragraphToMarkdown(child);
                        if (!block.isEmpty()) {
                            out.add(block);
                        }
                    }
                    case "tbl" -> {
                        tableIndex++;
                        out.add("");
                        out.add("### 表格 " + tableIndex);
                        out.addAll(tableToMarkdown(child));
                    }
                    default -> {
                        // 书签、批注、节属性等不产出正文
                    }
                }
            }
            return String.join("\n", out);
        }
    }

    private static org.w3c.dom.Document parseSecurely(InputStream in)
            throws SAXException, IOException, ParserConfigurationException {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        return factory.newDocumentBuilder().parse(in);
    }

    private static String paragraphToMarkdown(Element paragraph) {
        String text = textOf(paragraph).strip();
        if (text.isEmpty()) {
            return "";
        }
        Element pPr = firstChild(paragraph, "pPr");
        String styleId = pPr == null ? "" : attribute(firstChild(pPr, "pStyle"), "val").toLowerCase(Locale.ROOT);
        Integer level = headingLevel(pPr, styleId);
        if (level != null) {
            // 与旧实现一致：标题降一级（frontmatter 的 title 占掉 H1）
            return "#".repeat(Math.min(level + 1, 6)) + " " + text;
        }
        if (styleId.contains("list") || styleId.contains("列表") || firstChild(pPr, "numPr") != null) {
            return "- " + text;
        }
        return text;
    }

    /** 标题级别：先看样式名（Heading1 / 标题 1 / heading 2），再看 w:outlineLvl（0 基）。 */
    private static Integer headingLevel(Element pPr, String styleId) {
        if (styleId.contains("heading") || styleId.contains("标题")) {
            String digits = styleId.replaceAll("\\D+", "");
            return digits.isEmpty() ? 2 : Integer.parseInt(digits);
        }
        Element outline = pPr == null ? null : firstChild(pPr, "outlineLvl");
        if (outline != null) {
            String val = attribute(outline, "val");
            if (val.matches("\\d+")) {
                return Integer.parseInt(val) + 1;
            }
        }
        return null;
    }

    private static List<String> tableToMarkdown(Element table) {
        List<String> lines = new ArrayList<>();
        for (Element row : children(table, "tr")) {
            List<String> cells = new ArrayList<>();
            for (Element cell : children(row, "tc")) {
                StringBuilder text = new StringBuilder();
                for (Element p : children(cell, "p")) {
                    String t = textOf(p).strip();
                    if (!t.isEmpty()) {
                        if (text.length() > 0) {
                            text.append(' ');
                        }
                        text.append(t);
                    }
                }
                cells.add(text.toString().replace("|", "/").replaceAll("\\s*\\n\\s*", " "));
            }
            lines.add("| " + String.join(" | ", cells) + " |");
            if (lines.size() == 1) {
                lines.add("|" + " --- |".repeat(cells.size()));
            }
        }
        return lines;
    }

    /** 段落/单元格文本：w:t 取字、w:tab 转空格、w:br 转换行。 */
    private static String textOf(Element root) {
        StringBuilder out = new StringBuilder();
        appendText(root, out);
        return out.toString();
    }

    private static void appendText(Element element, StringBuilder out) {
        for (Element child : children(element)) {
            switch (child.getLocalName()) {
                case "t" -> out.append(child.getTextContent());
                case "tab" -> out.append(' ');
                case "br", "cr" -> out.append('\n');
                case "delText" -> {
                    // 修订删除的文本不产出
                }
                default -> appendText(child, out);
            }
        }
    }

    private static List<Element> children(Element parent) {
        List<Element> out = new ArrayList<>();
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element element) {
                out.add(element);
            }
        }
        return out;
    }

    private static List<Element> children(Element parent, String localName) {
        return children(parent).stream().filter(e -> localName.equals(e.getLocalName())).toList();
    }

    private static Element firstChild(Element parent, String localName) {
        if (parent == null) {
            return null;
        }
        return children(parent).stream().filter(e -> localName.equals(e.getLocalName())).findFirst().orElse(null);
    }

    private static String attribute(Element element, String name) {
        if (element == null) {
            return "";
        }
        String value = element.getAttributeNS(W_NS, name);
        return value.isEmpty() ? element.getAttribute("w:" + name) : value;
    }

    /**
     * 文本规范化：去掉页码/分隔线这类版式噪声、合并被 PDF 逐行断开的段落、短行升级为标题，
     * 保留列表与表格结构。与旧 Node 版 {@code normalizeExtracted} 同一套规则。
     */
    public static String normalizeExtracted(String raw) {
        List<String> kept = new ArrayList<>();
        for (String line : raw.replace("\r\n", "\n").replace('\r', '\n').replace('\u000c', '\n').split("\n", -1)) {
            String trimmed = TRAILING_BLANK.matcher(line).replaceAll("").strip();
            if (PAGE_NO.matcher(trimmed).matches() || SEPARATOR.matcher(trimmed).matches()) {
                continue;
            }
            kept.add(trimmed);
        }

        List<String> blocks = new ArrayList<>();
        List<String> buffer = new ArrayList<>();
        for (String line : kept) {
            if (line.isEmpty()) {
                flush(buffer, blocks);
                continue;
            }
            boolean alreadyMarked = ALREADY_MARKED.matcher(line).find();
            boolean isHeading = !alreadyMarked && !line.contains("|")
                    && line.length() <= 24 && !ENDS_PUNCT.matcher(line).find();
            if (isHeading) {
                flush(buffer, blocks);
                blocks.add("## " + line);
                continue;
            }
            if (alreadyMarked) {
                flush(buffer, blocks);
                String last = blocks.isEmpty() ? null : blocks.get(blocks.size() - 1);
                // 连续表格行必须贴在一起，否则 Markdown 表格会散架
                if (line.startsWith("|") && last != null && last.startsWith("|")) {
                    blocks.set(blocks.size() - 1, last + "\n" + line);
                } else {
                    blocks.add(line);
                }
                continue;
            }
            // 拉丁文断行需要补空格，中文断行直接接上
            if (!buffer.isEmpty()) {
                String prev = buffer.get(buffer.size() - 1);
                if (LATIN_END.matcher(prev).find() && LATIN_START.matcher(line).find()) {
                    buffer.set(buffer.size() - 1, prev + " " + line);
                    continue;
                }
            }
            buffer.add(line);
        }
        flush(buffer, blocks);

        return BLANK_RUN.matcher(String.join("\n\n", blocks)).replaceAll("\n\n").strip();
    }

    /** 文件名 → 目标文件名：去扩展名、去路径非法字符、空白转连字符、截断 60。 */
    public static String slugify(String name) {
        String base = name.replaceFirst("\\.[^.]+$", "").strip();
        String cleaned = DASH_RUN.matcher(WHITESPACE.matcher(ILLEGAL_NAME.matcher(base).replaceAll("")).replaceAll("-"))
                .replaceAll("-");
        if (cleaned.isEmpty()) {
            return "doc";
        }
        return cleaned.length() > 60 ? cleaned.substring(0, 60) : cleaned;
    }

    static Map<String, String> parseArgs(String[] args) {
        Map<String, String> out = new LinkedHashMap<>();
        for (int i = 0; i < args.length; i++) {
            String arg = args[i];
            if (!arg.startsWith("--")) {
                continue;
            }
            String key = arg.substring(2);
            if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                out.put(key, args[++i]);
            } else {
                out.put(key, "true");
            }
        }
        return out;
    }

    private static List<Path> listSources(Path dir) throws IOException {
        try (Stream<Path> stream = Files.walk(dir)) {
            return stream.filter(Files::isRegularFile)
                    .filter(p -> SUPPORTED.contains(extension(p.getFileName().toString())))
                    .sorted(Comparator.comparing(Path::toString))
                    .toList();
        }
    }

    private static ZonesMeta readZonesMeta(Path knowledgeDir) throws IOException {
        Path file = knowledgeDir.resolve("_meta").resolve("zones.json");
        if (!Files.isRegularFile(file)) {
            throw new IOException("找不到展区定义：" + file + "（--knowledge 指向了错误目录？）");
        }
        return new ObjectMapper().readValue(Files.readString(file, StandardCharsets.UTF_8), ZonesMeta.class);
    }

    private static void flush(List<String> buffer, List<String> blocks) {
        if (!buffer.isEmpty()) {
            blocks.add(String.join("", buffer));
            buffer.clear();
        }
    }

    private static Path resolve(Path repoRoot, String raw) {
        Path path = Path.of(raw);
        return path.isAbsolute() ? path.normalize() : repoRoot.resolve(path).normalize();
    }

    private static String relative(Path target) {
        Path root = AppProperties.repoRoot();
        Path abs = target.toAbsolutePath().normalize();
        return abs.startsWith(root) ? root.relativize(abs).toString().replace('\\', '/') : abs.toString();
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot).toLowerCase();
    }

    private static boolean hasCommand(String command) {
        try {
            Process process = new ProcessBuilder(command, "-v").redirectErrorStream(true).start();
            process.getInputStream().readAllBytes();
            // 命令存在但以非零码退出（xpdf 的 -v 返回 99）也算存在；只有起不来（ENOENT）才是缺失
            return process.waitFor(10, TimeUnit.SECONDS);
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /** 跑外部命令：两个流并行读（避免管道缓冲区写满把子进程卡住），超时强杀。 */
    private static String run(List<String> command, long timeoutSeconds) throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder(command);
        Process process = builder.start();

        byte[][] buffers = new byte[2][];
        Thread outReader = Thread.ofVirtual().start(() -> buffers[0] = readQuietly(process.getInputStream()));
        Thread errReader = Thread.ofVirtual().start(() -> buffers[1] = readQuietly(process.getErrorStream()));

        boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            throw new IOException("命令超时（" + timeoutSeconds + "s）：" + command.get(0));
        }
        outReader.join(2000);
        errReader.join(2000);

        String stdout = new String(buffers[0] == null ? new byte[0] : buffers[0], StandardCharsets.UTF_8);
        String stderr = new String(buffers[1] == null ? new byte[0] : buffers[1], StandardCharsets.UTF_8).strip();
        if (process.exitValue() != 0) {
            String detail = stderr.isEmpty() ? stdout.strip() : stderr;
            throw new IOException(command.get(0) + " 退出码 " + process.exitValue() + "："
                    + detail.substring(0, Math.min(300, detail.length())));
        }
        return stdout;
    }

    private static byte[] readQuietly(java.io.InputStream in) {
        try {
            return in.readAllBytes();
        } catch (IOException e) {
            return new byte[0];
        }
    }
}

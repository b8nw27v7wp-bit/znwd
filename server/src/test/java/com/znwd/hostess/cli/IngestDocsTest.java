package com.znwd.hostess.cli;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.znwd.hostess.knowledge.ZonesMeta;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 入库工具的钉子测试：规范化、目标命名、写盘策略、参数解析。
 *
 * <p>外部命令（pdftotext / python-docx）不在这里测——CI 的 ubuntu runner 上没有 poppler 与 python-docx，
 * 测了会把「本机依赖没装」变成「代码坏了」。PDF/DOCX 两条转换路径由本机实测覆盖（见 CHANGELOG）。
 *
 * <p>规范化这几条守的是入库最常见的两种坏结果：一份 PDF 进来每行都被断成一段（检索块碎成一句一块），
 * 以及页码/分隔线被当成正文入库（这些行会进分块、被检索、被显示到来源面板上）。
 */
class IngestDocsTest {

    @Test
    void 页码与分隔线这类版式噪声不入库() {
        String out = IngestDocs.normalizeExtracted("第一段正文。\n\n12\n\n----------\n\n第二段正文。\n\n第 3 页\n");
        assertFalse(out.contains("12"), "纯页码行应被丢掉：" + out);
        assertFalse(out.contains("----------"));
        assertTrue(out.contains("第一段正文。"));
        assertTrue(out.contains("第二段正文。"));
    }

    @Test
    void 中文断行合并成一段_拉丁断行补空格() {
        String cn = IngestDocs.normalizeExtracted("这是被 PDF 断开的同一行。\n后面这句属于同一段。\n\n新的一段。");
        assertTrue(cn.contains("这是被 PDF 断开的同一行。后面这句属于同一段。"), "中文断行应直接接上：" + cn);
        assertTrue(cn.contains("\n\n新的一段。"), "空行仍然分段：" + cn);

        String latin = IngestDocs.normalizeExtracted(
                "This is a fairly long English line that continues\nand then ends here.");
        assertTrue(latin.contains("continues and then ends here."), "拉丁断行要补空格：" + latin);
    }

    @Test
    void 短行升级为标题_带句号的短行不升级() {
        String out = IngestDocs.normalizeExtracted("产品概述\n\n它是一台会飞的相机。\n\n检测流程");
        assertTrue(out.contains("## 产品概述"), out);
        assertTrue(out.contains("## 检测流程"), out);
        assertTrue(out.contains("它是一台会飞的相机。"), out);
        assertFalse(out.contains("## 它是一台会飞的相机。"), "句尾有标点的短行是正文不是标题：" + out);
    }

    @Test
    void 连续表格行贴在一起() {
        String out = IngestDocs.normalizeExtracted("| 型号 | 载重 |\n| --- | --- |\n| A1 | 5kg |");
        assertTrue(out.contains("| 型号 | 载重 |\n| --- | --- |\n| A1 | 5kg |"), "表格行必须贴在同一个块里：" + out);
    }

    @Test
    void 目标文件名去掉非法字符并截断() {
        assertEquals("我的-报告(2026)", IngestDocs.slugify("我的 报告(2026).pdf"));
        assertEquals("abcd", IngestDocs.slugify("a/b:c*d.docx"));
        assertEquals("doc", IngestDocs.slugify("///.pdf"));
        assertEquals(60, IngestDocs.slugify("长".repeat(80) + ".txt").length());
    }

    @Test
    void 参数解析_取值与布尔开关() {
        Map<String, String> opts = IngestDocs.parseArgs(
                new String[] {"--src", "./inbox", "--zone", "wind-inspect", "--force", "--dry-run"});
        assertEquals("./inbox", opts.get("src"));
        assertEquals("wind-inspect", opts.get("zone"));
        assertEquals("true", opts.get("force"));
        assertEquals("true", opts.get("dry-run"));
    }

    @Test
    void frontmatter键名与加载器一致() {
        ZonesMeta.ZoneDef zone = new ZonesMeta.ZoneDef("wind-inspect", "02_风场检测无人机", "风场检测无人机",
                List.of("风电"), List.of());
        String head = IngestDocs.frontmatter("叶片检测说明", zone, "叶片检测说明.docx");
        assertTrue(head.startsWith("---\n"), head);
        assertTrue(head.contains("\ntitle: 叶片检测说明\n"), head);
        assertTrue(head.contains("\nzone: wind-inspect\n"), head);
        assertTrue(head.contains("\nzoneTitle: 风场检测无人机\n"), head);
        assertTrue(head.contains("\ntags: wind-inspect,ingest\n"), head);
        assertTrue(head.contains("\nsource: 叶片检测说明.docx\n"), head);
        assertTrue(head.contains("\ningestedAt: "), head);
    }

    @Test
    void docx解析_标题层级_列表与表格(@TempDir Path tmp) throws Exception {
        String xml = """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                  <w:body>
                    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>光伏清洁无人机作业手册</w:t></w:r></w:p>
                    <w:p><w:r><w:t>本手册说明清洁作业的</w:t></w:r><w:r><w:t>准备与验收。</w:t></w:r></w:p>
                    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>作业前准备</w:t></w:r></w:p>
                    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>确认组件表面无积雪。</w:t></w:r></w:p>
                    <w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>参数表</w:t></w:r></w:p>
                    <w:tbl>
                      <w:tr>
                        <w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc>
                        <w:tc><w:p><w:r><w:t>取值</w:t></w:r></w:p></w:tc>
                      </w:tr>
                      <w:tr>
                        <w:tc><w:p><w:r><w:t>清洗效率</w:t></w:r></w:p></w:tc>
                        <w:tc><w:p><w:r><w:t>95%</w:t></w:r></w:p></w:tc>
                      </w:tr>
                    </w:tbl>
                  </w:body>
                </w:document>
                """;
        Path docx = writeDocx(tmp.resolve("作业手册.docx"), xml);

        String body = IngestDocs.parseDocx(docx);
        assertTrue(body.contains("## 光伏清洁无人机作业手册"), body);
        assertTrue(body.contains("### 作业前准备"), body);
        assertTrue(body.contains("#### 参数表"), "w:outlineLvl 也要能认成标题：" + body);
        assertTrue(body.contains("本手册说明清洁作业的准备与验收。"), "同段落多个 run 要拼起来：" + body);
        assertTrue(body.contains("- 确认组件表面无积雪。"), "编号段落转列表项：" + body);
        assertTrue(body.contains("### 表格 1"), body);
        assertTrue(body.contains("| 项目 | 取值 |\n| --- | --- |\n| 清洗效率 | 95% |"), body);
    }

    @Test
    void docx解析_拒绝带DOCTYPE的文档(@TempDir Path tmp) throws Exception {
        String xml = """
                <?xml version="1.0" encoding="UTF-8"?>
                <!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]>
                <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                  <w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body>
                </w:document>
                """;
        Path docx = writeDocx(tmp.resolve("evil.docx"), xml);
        IOException error = assertThrows(IOException.class, () -> IngestDocs.parseDocx(docx));
        assertTrue(error.getMessage().contains("document.xml 解析失败"), error.getMessage());
    }

    private static Path writeDocx(Path target, String documentXml) throws IOException {
        try (java.util.zip.ZipOutputStream zip = new java.util.zip.ZipOutputStream(Files.newOutputStream(target))) {
            zip.putNextEntry(new java.util.zip.ZipEntry("[Content_Types].xml"));
            zip.write("<Types/>".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
            zip.putNextEntry(new java.util.zip.ZipEntry("word/document.xml"));
            zip.write(documentXml.getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        return target;
    }

    @Test
    void 写盘策略_默认不覆盖_dryRun不落盘(@TempDir Path tmp) throws Exception {
        Path src = Files.writeString(tmp.resolve("叶片检测说明.txt"), "叶片检测要停机吗？\n\n可以不停机。", StandardCharsets.UTF_8);
        Path knowledgeDir = Files.createDirectories(tmp.resolve("knowledge/02_风场检测无人机"));
        ZonesMeta.ZoneDef zone = new ZonesMeta.ZoneDef("wind-inspect", "02_风场检测无人机", "风场检测无人机",
                List.of("风电"), List.of());

        Path target = knowledgeDir.resolve("叶片检测说明.md");
        String dry = IngestDocs.ingestOne(src, zone, knowledgeDir, false, true);
        assertTrue(dry.contains("[dry-run]"), dry);
        assertFalse(Files.exists(target), "dry-run 不该写盘");

        IngestDocs.ingestOne(src, zone, knowledgeDir, false, false);
        String written = Files.readString(target, StandardCharsets.UTF_8);
        assertTrue(written.contains("zone: wind-inspect"));
        assertTrue(written.contains("叶片检测要停机吗？"));

        IOException again = assertThrows(IOException.class, () -> IngestDocs.ingestOne(src, zone, knowledgeDir, false, false));
        assertTrue(again.getMessage().contains("目标已存在"), again.getMessage());

        Files.writeString(src, "改过的正文。", StandardCharsets.UTF_8);
        IngestDocs.ingestOne(src, zone, knowledgeDir, true, false);
        assertTrue(Files.readString(target, StandardCharsets.UTF_8).contains("改过的正文。"), "--force 应覆盖");
    }
}

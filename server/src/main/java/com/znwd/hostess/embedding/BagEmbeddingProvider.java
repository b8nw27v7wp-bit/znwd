package com.znwd.hostess.embedding;

import java.util.ArrayList;
import java.util.List;

/**
 * 离线兜底：特征哈希 embedding（原 TS 版 embedding/bag.ts 的等价实现）。
 *
 * <p>不是语义模型，但比纯关键词对同义表述更稳；配置 EMBED_PROVIDER=openai_compat 后改走真实向量。
 * 向量路在 {@code semantic=false} 时不参与 RRF 融合、也不做闸门兜底——那边按语义能力判断。
 */
public class BagEmbeddingProvider implements EmbeddingProvider {

    private final int dims;

    public BagEmbeddingProvider(int dims) {
        this.dims = dims > 0 ? dims : 512;
    }

    @Override
    public String name() {
        return "bag";
    }

    @Override
    public int dims() {
        return dims;
    }

    @Override
    public boolean semantic() {
        return false;
    }

    @Override
    public List<float[]> embed(List<String> texts) {
        List<float[]> out = new ArrayList<>(texts.size());
        for (String text : texts) {
            out.add(embedOne(text));
        }
        return out;
    }

    private float[] embedOne(String text) {
        float[] vec = new float[dims];
        for (String token : tokenize(text)) {
            int h = hashToken(token);
            int idx = (int) ((h & 0xFFFFFFFFL) % dims);
            int sign = (hashToken(token + "#s") & 1) == 0 ? 1 : -1;
            // 词组（bigram/拉丁词）权重稍高
            float w = token.length() > 1 ? 1.2f : 0.8f;
            vec[idx] += sign * w;
        }
        Vectors.l2Normalize(vec);
        return vec;
    }

    /** 拉丁词 + 单字 + 中文 bigram（与原实现顺序一致：latin → chars → bigrams） */
    private List<String> tokenize(String text) {
        String lower = text.toLowerCase();
        List<String> tokens = new ArrayList<>();
        StringBuilder latin = new StringBuilder();
        for (int i = 0; i <= lower.length(); i++) {
            char c = i < lower.length() ? lower.charAt(i) : '\0';
            if (c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
                latin.append(c);
            } else if (latin.length() > 0) {
                tokens.add(latin.toString());
                latin.setLength(0);
            }
        }
        List<Character> cjk = new ArrayList<>();
        for (int i = 0; i < lower.length(); i++) {
            char c = lower.charAt(i);
            if (c >= 0x4e00 && c <= 0x9fff) {
                cjk.add(c);
            }
        }
        for (char c : cjk) {
            tokens.add(String.valueOf(c));
        }
        for (int i = 0; i + 1 < cjk.size(); i++) {
            tokens.add("" + cjk.get(i) + cjk.get(i + 1));
        }
        return tokens;
    }

    /** FNV-1a 变体，与 TS 版 Math.imul 语义一致（Java int 乘法即 32 位回绕） */
    private static int hashToken(String token) {
        int h = 0x811c9dc5; // 2166136261 超过 int 上限，写成十六进制等价常量
        for (int i = 0; i < token.length(); i++) {
            h ^= token.charAt(i);
            h *= 16777619;
        }
        return h;
    }
}

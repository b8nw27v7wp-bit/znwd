package com.znwd.hostess.embedding;

import java.util.ArrayList;
import java.util.List;

/** 余弦相似度与向量归一化。 */
public final class Vectors {

    private Vectors() {
    }

    /** 余弦相似度；长度不一致时按较短的算（与原实现一致），任一为零向量返回 0 */
    public static double cosine(float[] a, float[] b) {
        int n = Math.min(a.length, b.length);
        if (n == 0) {
            return 0;
        }
        double dot = 0;
        double na = 0;
        double nb = 0;
        for (int i = 0; i < n; i++) {
            double x = a[i];
            double y = b[i];
            dot += x * y;
            na += x * x;
            nb += y * y;
        }
        if (na == 0 || nb == 0) {
            return 0;
        }
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    public static void l2Normalize(float[] vec) {
        double sum = 0;
        for (float v : vec) {
            sum += (double) v * v;
        }
        double norm = Math.sqrt(sum);
        if (norm > 0) {
            for (int i = 0; i < vec.length; i++) {
                vec[i] = (float) (vec[i] / norm);
            }
        }
    }

    public static List<Float> toList(float[] vec) {
        List<Float> out = new ArrayList<>(vec.length);
        for (float v : vec) {
            out.add(v);
        }
        return out;
    }

    public static float[] toArray(List<Number> list) {
        if (list == null) {
            return new float[0];
        }
        float[] out = new float[list.size()];
        for (int i = 0; i < list.size(); i++) {
            Number n = list.get(i);
            out[i] = n == null ? 0f : n.floatValue();
        }
        return out;
    }
}

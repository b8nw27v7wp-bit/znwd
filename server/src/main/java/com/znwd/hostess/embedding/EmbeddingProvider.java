package com.znwd.hostess.embedding;

import java.util.List;

public interface EmbeddingProvider {

    String name();

    int dims();

    boolean semantic();

    default String model() {
        return name();
    }

    default String modelName() {
        return model();
    }

    default String embeddingModel() {
        return modelName();
    }

    default String endpoint() {
        return "local";
    }

    default String endpointIdentity() {
        return endpoint();
    }

    List<float[]> embed(List<String> texts);
}

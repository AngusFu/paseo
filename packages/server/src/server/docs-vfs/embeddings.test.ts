import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSameEmbeddingDimensions,
  cosineSimilarity,
  loadEmbeddingsConfig,
} from "./embeddings.js";

describe("docs embeddings helpers", () => {
  it("loads config from env and defaults model", () => {
    const config = loadEmbeddingsConfig({
      env: {
        PASEO_EMBEDDINGS_MODEL: "qwen3-embedding:0.6b",
        PASEO_EMBEDDINGS_BASE_URL: "http://127.0.0.1:11434/v1",
      },
    });
    expect(config?.enabled).toBe(true);
    expect(config?.model).toBe("qwen3-embedding:0.6b");
  });

  it("loads config from $PASEO_HOME/config.json localTools.embeddings", () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-home-embed-cfg-"));
    writeFileSync(
      join(paseoHome, "config.json"),
      `${JSON.stringify({
        localTools: {
          embeddings: {
            enabled: true,
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "ollama",
            model: "qwen3-embedding:0.6b",
          },
        },
      })}\n`,
    );
    const config = loadEmbeddingsConfig({ paseoHome, env: {} });
    expect(config).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "qwen3-embedding:0.6b",
    });
  });

  it("returns null when embeddings are not enabled", () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-x-"));
    expect(loadEmbeddingsConfig({ env: {}, paseoHome })).toBeNull();
  });

  it("rejects cosine similarity when dimensions differ", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/dimension mismatch/i);
    expect(() => assertSameEmbeddingDimensions([1], [1, 2], "query")).toThrow(/query/);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertSameEmbeddingDimensions,
  cosineSimilarity,
  detectOllamaForEmbeddings,
  loadEmbeddingsConfig,
  resolveEmbeddingsConfigForProbe,
  suggestEmbeddingModel,
  testEmbeddingsProbe,
} from "./embeddings.js";

function writeEmbeddingsConfig(paseoHome: string, embeddings: Record<string, unknown>): void {
  writeFileSync(
    join(paseoHome, "config.json"),
    `${JSON.stringify({ localTools: { embeddings } })}\n`,
  );
}

describe("docs embeddings helpers", () => {
  it("loads config from $PASEO_HOME/config.json localTools.embeddings", () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-home-embed-cfg-"));
    writeEmbeddingsConfig(paseoHome, {
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "qwen3-embedding:0.6b",
    });
    const config = loadEmbeddingsConfig({ paseoHome, env: {} });
    expect(config).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "qwen3-embedding:0.6b",
    });
  });

  it("applies defaults when enabled but fields omitted", () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-home-embed-defaults-"));
    writeEmbeddingsConfig(paseoHome, { enabled: true });
    expect(loadEmbeddingsConfig({ paseoHome, env: {} })).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "qwen3-embedding:0.6b",
    });
  });

  it("returns null unless enabled is explicitly true", () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-home-embed-off-"));
    expect(loadEmbeddingsConfig({ env: {}, paseoHome })).toBeNull();
    writeEmbeddingsConfig(paseoHome, { enabled: false, model: "qwen3-embedding:0.6b" });
    expect(loadEmbeddingsConfig({ paseoHome, env: {} })).toBeNull();
    writeEmbeddingsConfig(paseoHome, { model: "qwen3-embedding:0.6b" });
    expect(loadEmbeddingsConfig({ paseoHome, env: {} })).toBeNull();
  });

  it("ignores PASEO_EMBEDDINGS_* env vars", () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-home-embed-ignore-env-"));
    writeEmbeddingsConfig(paseoHome, {
      enabled: true,
      baseUrl: "http://127.0.0.1:9999/v1",
      model: "from-file",
    });
    const config = loadEmbeddingsConfig({
      paseoHome,
      env: {
        PASEO_HOME: paseoHome,
        PASEO_EMBEDDINGS_ENABLED: "0",
        PASEO_EMBEDDINGS_BASE_URL: "http://env.example/v1",
        PASEO_EMBEDDINGS_MODEL: "from-env",
        PASEO_EMBEDDINGS_API_KEY: "env-key",
      },
    });
    expect(config).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKey: "ollama",
      model: "from-file",
    });

    const emptyHome = mkdtempSync(join(tmpdir(), "paseo-home-embed-env-only-"));
    expect(
      loadEmbeddingsConfig({
        paseoHome: emptyHome,
        env: {
          PASEO_EMBEDDINGS_ENABLED: "1",
          PASEO_EMBEDDINGS_MODEL: "qwen3-embedding:0.6b",
        },
      }),
    ).toBeNull();
  });

  it("rejects cosine similarity when dimensions differ", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/dimension mismatch/i);
    expect(() => assertSameEmbeddingDimensions([1], [1, 2], "query")).toThrow(/query/);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });

  it("suggests embedding-named models first, then documented default", () => {
    expect(
      suggestEmbeddingModel(["llama3", "text-embedding-3-small", "qwen3-embedding:0.6b"]),
    ).toBe("text-embedding-3-small");
    expect(suggestEmbeddingModel(["llama3", "qwen3-embedding:0.6b"])).toBe("qwen3-embedding:0.6b");
    expect(suggestEmbeddingModel(["llama3", "mistral"])).toBe("llama3");
    expect(suggestEmbeddingModel([])).toBeNull();
  });

  it("detects Ollama tags and returns OpenAI-compat fill baseUrl", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          models: [{ name: "llama3" }, { name: "qwen3-embedding:0.6b" }],
        }),
        { status: 200 },
      );
    });

    await expect(
      detectOllamaForEmbeddings({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      available: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      models: ["llama3", "qwen3-embedding:0.6b"],
      suggestedModel: "qwen3-embedding:0.6b",
      error: null,
    });
  });

  it("reports unavailable when Ollama tags probe fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });

    await expect(
      detectOllamaForEmbeddings({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      available: false,
      baseUrl: null,
      models: [],
      suggestedModel: null,
      error: "connection refused",
    });
  });

  it("resolves probe config from overrides before save", () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-home-embed-probe-"));
    expect(
      resolveEmbeddingsConfigForProbe({
        paseoHome,
        env: {},
        override: {
          enabled: true,
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "nomic-embed-text",
        },
      }),
    ).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "nomic-embed-text",
    });
  });

  it("runs a tiny embeddings probe and returns dimensions", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        }),
        { status: 200 },
      );
    });

    await expect(
      testEmbeddingsProbe({
        env: {},
        override: {
          enabled: true,
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "qwen3-embedding:0.6b",
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      ok: true,
      dimensions: 3,
      error: null,
    });
  });
});

import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBEDDINGS_API_KEY,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_MODEL,
  applyOllamaDetectToDraft,
  createKnowledgeBaseEmbeddingsPatch,
  daemonConfigSupportsEmbeddings,
  knowledgeBaseEmbeddingsDraftHasChanges,
  readKnowledgeBaseEmbeddingsDraft,
} from "./knowledge-base-embeddings-config";

function makeConfig(embeddings?: {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): MutableDaemonConfig {
  const base: MutableDaemonConfig = {
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    proseStop: { enabled: true, preventionPrompt: true },
  };
  if (embeddings === undefined) {
    return base;
  }
  return { ...base, embeddings } as MutableDaemonConfig;
}

describe("knowledge base embeddings config helpers", () => {
  it("detects when mutable config includes embeddings", () => {
    expect(daemonConfigSupportsEmbeddings(null)).toBe(false);
    expect(daemonConfigSupportsEmbeddings(makeConfig())).toBe(false);
    expect(daemonConfigSupportsEmbeddings(makeConfig({}))).toBe(true);
    expect(daemonConfigSupportsEmbeddings(makeConfig({ enabled: true }))).toBe(true);
  });

  it("reads draft defaults when embeddings are absent or empty", () => {
    expect(readKnowledgeBaseEmbeddingsDraft(null)).toEqual({
      enabled: false,
      baseUrl: "",
      apiKey: "",
      model: "",
    });
    expect(readKnowledgeBaseEmbeddingsDraft(makeConfig())).toEqual({
      enabled: false,
      baseUrl: "",
      apiKey: "",
      model: "",
    });
    expect(readKnowledgeBaseEmbeddingsDraft(makeConfig({}))).toEqual({
      enabled: false,
      baseUrl: "",
      apiKey: "",
      model: "",
    });
  });

  it("reads persisted embeddings values", () => {
    expect(
      readKnowledgeBaseEmbeddingsDraft(
        makeConfig({
          enabled: true,
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: "ollama",
          model: "qwen3-embedding:0.6b",
        }),
      ),
    ).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "qwen3-embedding:0.6b",
    });
  });

  it("builds a trimmed embeddings patch", () => {
    expect(
      createKnowledgeBaseEmbeddingsPatch({
        enabled: true,
        baseUrl: "  http://127.0.0.1:11434/v1  ",
        apiKey: "  ollama  ",
        model: "  qwen3-embedding:0.6b  ",
      }),
    ).toEqual({
      embeddings: {
        enabled: true,
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        model: "qwen3-embedding:0.6b",
      },
    });
  });

  it("detects dirty draft fields", () => {
    const persisted = {
      enabled: false,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "qwen3-embedding:0.6b",
    };
    expect(knowledgeBaseEmbeddingsDraftHasChanges(persisted, persisted)).toBe(false);
    expect(
      knowledgeBaseEmbeddingsDraftHasChanges(
        { ...persisted, baseUrl: "  http://127.0.0.1:11434/v1  " },
        persisted,
      ),
    ).toBe(false);
    expect(knowledgeBaseEmbeddingsDraftHasChanges({ ...persisted, enabled: true }, persisted)).toBe(
      true,
    );
    expect(
      knowledgeBaseEmbeddingsDraftHasChanges(
        { ...persisted, model: "nomic-embed-text" },
        persisted,
      ),
    ).toBe(true);
  });

  it("fills draft from Ollama detect with defaults", () => {
    expect(
      applyOllamaDetectToDraft(
        { enabled: false, baseUrl: "", apiKey: "", model: "" },
        { baseUrl: null, suggestedModel: null },
      ),
    ).toEqual({
      enabled: true,
      baseUrl: DEFAULT_EMBEDDINGS_BASE_URL,
      apiKey: DEFAULT_EMBEDDINGS_API_KEY,
      model: DEFAULT_EMBEDDINGS_MODEL,
    });

    expect(
      applyOllamaDetectToDraft(
        { enabled: false, baseUrl: "keep", apiKey: "secret", model: "keep" },
        {
          baseUrl: "http://127.0.0.1:11434/v1",
          suggestedModel: "nomic-embed-text",
          apiKey: "  from-detect  ",
        },
      ),
    ).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "from-detect",
      model: "nomic-embed-text",
    });
  });
});

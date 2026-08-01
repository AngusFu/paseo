import type { DaemonClient } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";
import {
  resolveKnowledgeBaseEmbeddingsDetectOllama,
  resolveKnowledgeBaseEmbeddingsRpcs,
  resolveKnowledgeBaseEmbeddingsTest,
} from "./resolve-knowledge-base-embeddings";

describe("resolve knowledge base embeddings RPCs", () => {
  it("returns null when client or methods are missing", () => {
    expect(resolveKnowledgeBaseEmbeddingsDetectOllama(null)).toBeNull();
    expect(resolveKnowledgeBaseEmbeddingsTest(undefined)).toBeNull();
    expect(resolveKnowledgeBaseEmbeddingsRpcs({} as DaemonClient)).toBeNull();
  });

  it("binds detect + test when both methods exist", async () => {
    const detect = vi.fn(async () => ({
      available: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      models: ["qwen3-embedding:0.6b"],
      suggestedModel: "qwen3-embedding:0.6b",
      error: null,
    }));
    const test = vi.fn(async () => ({
      ok: true,
      dimensions: 8,
      error: null,
    }));
    const client = {
      knowledgeBaseEmbeddingsDetectOllama: detect,
      knowledgeBaseEmbeddingsTest: test,
    } as unknown as DaemonClient;

    const rpcs = resolveKnowledgeBaseEmbeddingsRpcs(client);
    expect(rpcs).not.toBeNull();
    await rpcs?.detectOllama();
    await rpcs?.test({ enabled: true });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(test).toHaveBeenCalledWith({ enabled: true });
  });
});

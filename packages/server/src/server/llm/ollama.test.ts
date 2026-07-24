import { describe, expect, it, vi } from "vitest";
import {
  defaultOllamaOpenAiBaseUrl,
  detectAndListOllamaModels,
  listOllamaModels,
  resolveOllamaOrigin,
} from "./ollama.js";

describe("ollama helpers", () => {
  it("normalizes OpenAI-compat base URLs to an Ollama origin", () => {
    expect(resolveOllamaOrigin("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaOrigin(" http://127.0.0.1:11434/v1/ ")).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaOrigin(null)).toBe("http://127.0.0.1:11434");
    expect(defaultOllamaOpenAiBaseUrl()).toBe("http://127.0.0.1:11434/v1");
  });

  it("lists models from /api/tags", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          models: [{ name: "qwen2.5:0.5b" }, { model: "qwen3.5:0.8b" }],
        }),
        { status: 200 },
      );
    });

    await expect(
      listOllamaModels({
        baseUrl: "http://127.0.0.1:11434/v1",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual(["qwen2.5:0.5b", "qwen3.5:0.8b"]);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/tags",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("falls back to /v1/models when tags fails", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response("missing", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          data: [{ id: "qwen3:0.6b" }],
        }),
        { status: 200 },
      );
    });

    await expect(
      listOllamaModels({
        baseUrl: "http://127.0.0.1:11434",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual(["qwen3:0.6b"]);
  });

  it("reports unavailable when the ollama binary is missing", async () => {
    const result = await detectAndListOllamaModels({
      candidates: ["ollama"],
      execFileImpl: (async () => {
        throw new Error("not found");
      }) as never,
      isExecutableImpl: async () => false,
      fetchImpl: (async () => {
        throw new Error("should not fetch");
      }) as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ollamaAvailable: false,
      ollamaPath: null,
      models: [],
      error: null,
    });
  });
});

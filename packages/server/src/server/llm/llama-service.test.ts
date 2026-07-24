import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LlamaService,
  LlmGenerateError,
  normalizeLocalLlmBaseUrl,
  resolveLocalLlmConfig,
} from "./llama-service.js";

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(input, init)),
  ) as typeof fetch;
}

function jsonCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("normalizeLocalLlmBaseUrl", () => {
  it("trims trailing slashes and appends /v1", () => {
    expect(normalizeLocalLlmBaseUrl("http://127.0.0.1:11434/")).toBe("http://127.0.0.1:11434/v1");
  });

  it("does not double-append /v1", () => {
    expect(normalizeLocalLlmBaseUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/v1");
  });
});

describe("resolveLocalLlmConfig", () => {
  it("returns nulls for empty config", () => {
    expect(resolveLocalLlmConfig(null)).toEqual({
      baseUrl: null,
      apiKey: null,
      model: null,
    });
  });

  it("trims whitespace from fields", () => {
    expect(
      resolveLocalLlmConfig({
        baseUrl: " http://localhost:11434 ",
        apiKey: " secret ",
        model: " qwen2.5:0.5b ",
      }),
    ).toEqual({
      baseUrl: "http://localhost:11434",
      apiKey: "secret",
      model: "qwen2.5:0.5b",
    });
  });
});

describe("LlamaService.getStatus", () => {
  let service: LlamaService;

  beforeEach(() => {
    service = new LlamaService({
      logger: pino({ level: "silent" }),
      getConfig: () => null,
    });
  });

  it("reports absent when base URL or model is missing", async () => {
    await expect(service.getStatus()).resolves.toEqual({ status: "absent" });
  });

  it("reports ready when configured", async () => {
    service = new LlamaService({
      logger: pino({ level: "silent" }),
      getConfig: () => ({
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:0.5b",
      }),
    });

    await expect(service.getStatus()).resolves.toEqual({
      status: "ready",
      loaded: true,
    });
  });

  it("reports error after a failed generation", async () => {
    service = new LlamaService({
      logger: pino({ level: "silent" }),
      getConfig: () => ({
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:0.5b",
      }),
      fetch: mockFetch(() => new Response("bad", { status: 500 })),
    });

    await expect(service.generate({ requestId: "req-1", prompt: "hi" })).rejects.toThrow(
      LlmGenerateError,
    );

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "error",
      message: expect.stringContaining("HTTP 500"),
    });
  });
});

function abortablePendingResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

describe("LlamaService.generate", () => {
  let service: LlamaService;

  beforeEach(() => {
    service = new LlamaService({
      logger: pino({ level: "silent" }),
      getConfig: () => ({
        baseUrl: "http://127.0.0.1:11434",
        apiKey: "test-key",
        model: "qwen2.5:0.5b",
      }),
    });
  });

  afterEach(() => {
    service.stop();
  });

  it("throws when not configured", async () => {
    service = new LlamaService({
      logger: pino({ level: "silent" }),
      getConfig: () => null,
    });

    await expect(service.generate({ requestId: "req-1", prompt: "hi" })).rejects.toThrow(
      "local LLM is not configured",
    );
  });

  it("posts to /v1/chat/completions and returns text", async () => {
    const fetch = mockFetch((_url, init) => {
      expect(String(_url)).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("qwen2.5:0.5b");
      expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
      return jsonCompletion("world");
    });

    service = new LlamaService({
      logger: pino({ level: "silent" }),
      getConfig: () => ({
        baseUrl: "http://127.0.0.1:11434",
        apiKey: "test-key",
        model: "qwen2.5:0.5b",
      }),
      fetch,
    });

    await expect(service.generate({ requestId: "req-1", prompt: "hello" })).resolves.toBe("world");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("maps abort to cancelled", async () => {
    let releaseFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    const fetch = mockFetch((_url, init) => {
      releaseFetch?.();
      return abortablePendingResponse(init?.signal);
    });

    service = new LlamaService({
      logger: pino({ level: "silent" }),
      getConfig: () => ({
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:0.5b",
      }),
      fetch,
    });

    const generatePromise = service.generate({ requestId: "req-cancel", prompt: "hi" });
    await fetchStarted;
    expect(service.cancel("req-cancel")).toBe(true);

    await expect(generatePromise).rejects.toThrow("cancelled");
  });

  it("rejects invalid JSON when jsonSchema is set", async () => {
    service = new LlamaService({
      logger: pino({ level: "silent" }),
      getConfig: () => ({
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:0.5b",
      }),
      fetch: mockFetch(() => jsonCompletion("not json")),
    });

    await expect(
      service.generate({
        requestId: "req-1",
        prompt: "hi",
        jsonSchema: { type: "object" },
      }),
    ).rejects.toThrow("model response is not valid JSON");
  });

  it("streams SSE chunks when requested", async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
      "data: [DONE]\n",
    ].join("");

    service = new LlamaService({
      logger: pino({ level: "silent" }),
      getConfig: () => ({
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:0.5b",
      }),
      fetch: mockFetch(() => new Response(sseBody, { status: 200 })),
    });

    const chunks: string[] = [];
    await expect(
      service.generate({
        requestId: "req-stream",
        prompt: "hi",
        stream: true,
        onChunk: (text) => chunks.push(text),
      }),
    ).resolves.toBe("hello");
    expect(chunks).toEqual(["hel", "lo"]);
  });
});

describe("LlamaService.startDownload", () => {
  it("returns COMPAT stub error directing users to settings", async () => {
    const service = new LlamaService({
      logger: pino({ level: "silent" }),
      getConfig: () => ({
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:0.5b",
      }),
    });

    await expect(service.startDownload()).rejects.toThrow(
      "Built-in model download is no longer available",
    );
    await expect(service.getStatus()).resolves.toMatchObject({
      status: "error",
      message: expect.stringContaining("host settings"),
    });
  });
});

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmChatMessage } from "@getpaseo/protocol/llm/chat-rpc-schemas";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkerHistory, LlmChatService, type LlmChatEventPayload } from "./chat-service.js";
import type { LlamaService } from "./llama-service.js";

function message(role: "user" | "assistant", text: string): LlmChatMessage {
  return {
    id: `${role}-${Math.random().toString(36).slice(2)}`,
    role,
    text,
    createdAt: new Date().toISOString(),
  };
}

describe("buildWorkerHistory", () => {
  it("maps roles and preserves order", () => {
    const history = buildWorkerHistory([
      message("user", "hi"),
      message("assistant", "hello"),
      message("user", "again"),
    ]);
    expect(history).toEqual([
      { role: "user", text: "hi" },
      { role: "model", text: "hello" },
      { role: "user", text: "again" },
    ]);
  });

  it("drops the oldest turns once the character budget runs out", () => {
    const long = "x".repeat(5000);
    const history = buildWorkerHistory([
      message("user", long),
      message("assistant", long),
      message("user", "latest"),
    ]);
    // 5000 + 5000 + 6 > 8000 budget → only the newest assistant turn fits
    // alongside the latest user turn, and the leading model turn is dropped to
    // keep strict user-first alternation.
    expect(history).toEqual([{ role: "user", text: "latest" }]);
  });

  it("never starts with a model turn", () => {
    const history = buildWorkerHistory([
      message("user", "x".repeat(9000)),
      message("assistant", "reply"),
      message("user", "next"),
    ]);
    expect(history[0]?.role).toBe("user");
  });
});

describe("LlmChatService", () => {
  let tempDir: string;
  let events: LlmChatEventPayload[];
  let service: LlmChatService;
  let generateCalls: Array<Record<string, unknown>>;

  function createService(replyText: string): LlmChatService {
    const fakeLlama = {
      generate: async (params: {
        requestId: string;
        prompt: string;
        stream?: boolean;
        onChunk?: (text: string) => void;
      }) => {
        generateCalls.push(params as unknown as Record<string, unknown>);
        if (params.stream) {
          for (const chunk of replyText.split(" ")) {
            params.onChunk?.(chunk);
          }
        }
        return replyText;
      },
      cancel: () => true,
    } as unknown as LlamaService;
    return new LlmChatService({
      paseoHome: tempDir,
      logger: pino({ enabled: false }),
      llamaService: fakeLlama,
      onEvent: (payload) => events.push(payload),
    });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "llm-chat-service-test-"));
    events = [];
    generateCalls = [];
    service = createService("hello there");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a chat on first send and persists both turns", async () => {
    const result = await service.send({ chatId: null, text: "hi 你好", requestId: "req-1" });
    expect(result.error).toBeNull();
    expect(result.message?.role).toBe("assistant");
    expect(result.message?.text).toBe("hello there");

    const stored = await service.getChat(result.chatId);
    expect(stored).not.toBeNull();
    expect(stored?.title).toBe("hi 你好");
    expect(stored?.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);

    const files = await readdir(join(tempDir, "llm-chat"));
    expect(files).toEqual([`${result.chatId}.json`]);
  });

  it("streams chunk events tagged with the send requestId and ends with done", async () => {
    const result = await service.send({ chatId: null, text: "hi", requestId: "req-2" });
    const kinds = events.map((event) => event.event.kind);
    expect(kinds.filter((kind) => kind === "chunk").length).toBeGreaterThan(0);
    expect(kinds.at(-1)).toBe("done");
    expect(events.every((event) => event.sendRequestId === "req-2")).toBe(true);
    expect(events.every((event) => event.chatId === result.chatId)).toBe(true);
  });

  it("replays prior turns as history on the next send", async () => {
    const first = await service.send({ chatId: null, text: "first", requestId: "req-3" });
    await service.send({ chatId: first.chatId, text: "second", requestId: "req-4" });
    const lastCall = generateCalls.at(-1) as { history?: Array<{ role: string; text: string }> };
    expect(lastCall.history).toEqual([
      { role: "user", text: "first" },
      { role: "model", text: "hello there" },
    ]);
  });

  it("lists chats newest-first and deletes them", async () => {
    const first = await service.send({ chatId: null, text: "one", requestId: "req-5" });
    const second = await service.send({ chatId: null, text: "two", requestId: "req-6" });
    const listed = await service.listChats();
    expect(listed.map((chat) => chat.id)).toContain(first.chatId);
    expect(listed.map((chat) => chat.id)).toContain(second.chatId);
    expect(listed[0].messageCount).toBe(2);

    expect(await service.deleteChat(first.chatId)).toBe(true);
    expect(await service.getChat(first.chatId)).toBeNull();
    expect(await service.deleteChat(first.chatId)).toBe(false);
  });

  it("rejects a send for an unknown chat id", async () => {
    const result = await service.send({ chatId: "missing", text: "hi", requestId: "req-7" });
    expect(result.error).toBe("chat not found");
    expect(result.message).toBeNull();
  });
});

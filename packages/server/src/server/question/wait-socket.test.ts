import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredInboxQuestion } from "@getpaseo/protocol/question/types";
import {
  createQuestionWaitSocket,
  parseWaitRequest,
  resolveQuestionWaitSocketPath,
} from "./wait-socket.js";

function makeQuestion(overrides: Partial<StoredInboxQuestion> = {}): StoredInboxQuestion {
  return {
    id: "qst_wait_1",
    agentId: "agent-1",
    createdAt: "2026-07-25T00:00:00.000Z",
    status: "answered",
    questions: [{ question: "Ship?", header: "Ship", options: [{ label: "Yes" }] }],
    answers: { Ship: "Yes" },
    source: "skill",
    ...overrides,
  };
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
} as never;

async function requestWait(
  socketPath: string,
  body: { op: "wait"; questionId: string; timeoutMs?: number },
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(body)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
    socket.on("error", reject);
  });
}

describe("parseWaitRequest", () => {
  it("parses a wait op with optional timeout", () => {
    expect(
      parseWaitRequest(JSON.stringify({ op: "wait", questionId: "qst_1", timeoutMs: 1000 })),
    ).toEqual({
      op: "wait",
      questionId: "qst_1",
      timeoutMs: 1000,
    });
  });

  it("rejects non-wait ops", () => {
    expect(() => parseWaitRequest(JSON.stringify({ op: "create", questionId: "qst_1" }))).toThrow(
      /op must be "wait"/,
    );
  });
});

describe.runIf(process.platform !== "win32")("createQuestionWaitSocket", () => {
  let home: string;

  afterEach(async () => {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns settled questions through NDJSON", async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-qwait-"));
    const question = makeQuestion();
    const socket = createQuestionWaitSocket({
      paseoHome: home,
      logger: noopLogger,
      waitInboxQuestion: async ({ questionId }) => {
        expect(questionId).toBe(question.id);
        return question;
      },
    });
    expect(socket).not.toBeNull();
    if (!socket) {
      return;
    }
    await socket.start();
    expect(resolveQuestionWaitSocketPath(home)).toBe(socket.path);

    const response = await requestWait(socket.path, { op: "wait", questionId: question.id });
    expect(response).toEqual({ ok: true, question });

    await socket.stop();
  });

  it("maps wait timeouts to ASK_QUESTION_TIMEOUT", async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-qwait-"));
    const socket = createQuestionWaitSocket({
      paseoHome: home,
      logger: noopLogger,
      waitInboxQuestion: async () => {
        throw new Error("ASK_QUESTION_TIMEOUT: question.wait exceeded 1ms");
      },
    });
    if (!socket) {
      return;
    }
    await socket.start();
    const response = await requestWait(socket.path, {
      op: "wait",
      questionId: "qst_missing",
      timeoutMs: 1,
    });
    expect(response).toEqual({
      ok: false,
      error: "ASK_QUESTION_TIMEOUT: question.wait exceeded 1ms",
      code: "ASK_QUESTION_TIMEOUT",
    });
    await socket.stop();
  });
});

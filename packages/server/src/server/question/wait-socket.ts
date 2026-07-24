import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { StoredInboxQuestion } from "@getpaseo/protocol/question/types";
import type { Logger } from "pino";

export const QUESTION_WAIT_SOCKET_FILENAME = "question-wait.sock";

export function resolveQuestionWaitSocketPath(paseoHome: string): string {
  return join(paseoHome, QUESTION_WAIT_SOCKET_FILENAME);
}

interface WaitRequest {
  op: "wait";
  questionId: string;
  timeoutMs?: number;
}

type WaitResponse =
  | { ok: true; question: StoredInboxQuestion }
  | { ok: false; error: string; code?: string };

export interface QuestionWaitSocketDeps {
  paseoHome: string;
  waitInboxQuestion: (input: {
    questionId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<StoredInboxQuestion>;
  logger: Logger;
}

export interface QuestionWaitSocket {
  path: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Local NDJSON unix socket for waiting on inbox questions without a WS client.
 * Path: `$PASEO_HOME/question-wait.sock` (mode 0600). Windows is skipped — use WS wait.
 */
export function createQuestionWaitSocket(deps: QuestionWaitSocketDeps): QuestionWaitSocket | null {
  if (process.platform === "win32") {
    return null;
  }

  const socketPath = resolveQuestionWaitSocketPath(deps.paseoHome);
  let server: Server | null = null;
  const active = new Set<Socket>();

  async function handleLine(socket: Socket, line: string): Promise<void> {
    let response: WaitResponse;
    try {
      const request = parseWaitRequest(line);
      const controller = new AbortController();
      const onClose = () => controller.abort();
      socket.once("close", onClose);
      try {
        const question = await deps.waitInboxQuestion({
          questionId: request.questionId,
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          signal: controller.signal,
        });
        response = { ok: true, question };
      } finally {
        socket.off("close", onClose);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response = {
        ok: false,
        error: message,
        ...(message.startsWith("ASK_QUESTION_TIMEOUT")
          ? { code: "ASK_QUESTION_TIMEOUT" }
          : { code: "QUESTION_WAIT_FAILED" }),
      };
    }
    if (!socket.destroyed) {
      socket.write(`${JSON.stringify(response)}\n`);
      socket.end();
    }
  }

  function attachSocket(socket: Socket): void {
    active.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      void handleLine(socket, line);
    });
    socket.on("error", (error) => {
      deps.logger.warn({ err: error, path: socketPath }, "question wait socket client error");
    });
    socket.on("close", () => {
      active.delete(socket);
    });
  }

  return {
    path: socketPath,
    start: async () => {
      if (server) {
        return;
      }
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
      server = createServer(attachSocket);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server?.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server?.off("error", onError);
          try {
            chmodSync(socketPath, 0o600);
          } catch (error) {
            deps.logger.warn(
              { err: error, path: socketPath },
              "failed to chmod question wait socket",
            );
          }
          resolve();
        };
        server?.once("error", onError);
        server?.once("listening", onListening);
        server?.listen(socketPath);
      });
      deps.logger.info({ path: socketPath }, "question wait socket listening");
    },
    stop: async () => {
      const current = server;
      server = null;
      for (const socket of active) {
        socket.destroy();
      }
      active.clear();
      if (!current) {
        if (existsSync(socketPath)) {
          unlinkSync(socketPath);
        }
        return;
      }
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
      });
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    },
  };
}

export function parseWaitRequest(line: string): WaitRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Invalid JSON wait request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Wait request must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.op !== "wait") {
    throw new Error('Wait request op must be "wait"');
  }
  if (typeof record.questionId !== "string" || record.questionId.trim().length === 0) {
    throw new Error("Wait request requires non-empty questionId");
  }
  let timeoutMs: number | undefined;
  if (record.timeoutMs !== undefined) {
    if (
      typeof record.timeoutMs !== "number" ||
      !Number.isInteger(record.timeoutMs) ||
      record.timeoutMs <= 0
    ) {
      throw new Error("Wait request timeoutMs must be a positive integer");
    }
    timeoutMs = record.timeoutMs;
  }
  return {
    op: "wait",
    questionId: record.questionId.trim(),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

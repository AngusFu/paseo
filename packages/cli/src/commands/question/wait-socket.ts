import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StoredInboxQuestion } from "@getpaseo/protocol/question/types";

const QUESTION_WAIT_SOCKET_FILENAME = "question-wait.sock";

export function resolveQuestionWaitSocketPath(
  home: string = process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
): string {
  return join(home, QUESTION_WAIT_SOCKET_FILENAME);
}

export function questionWaitSocketAvailable(
  socketPath: string = resolveQuestionWaitSocketPath(),
): boolean {
  return process.platform !== "win32" && existsSync(socketPath);
}

interface WaitSocketSuccess {
  ok: true;
  question: StoredInboxQuestion;
}

interface WaitSocketFailure {
  ok: false;
  error: string;
  code?: string;
}

export async function waitInboxQuestionOverSocket(input: {
  questionId: string;
  timeoutMs?: number;
  socketPath?: string;
}): Promise<StoredInboxQuestion> {
  const socketPath = input.socketPath ?? resolveQuestionWaitSocketPath();
  if (!questionWaitSocketAvailable(socketPath)) {
    throw new Error(`Question wait socket not available at ${socketPath}`);
  }

  const response = await new Promise<WaitSocketSuccess | WaitSocketFailure>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (value: WaitSocketSuccess | WaitSocketFailure) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      socket.end();
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
      socket.destroy();
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          op: "wait",
          questionId: input.questionId,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline);
      try {
        finish(JSON.parse(line) as WaitSocketSuccess | WaitSocketFailure);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => {
      fail(error);
    });
    socket.on("close", () => {
      if (!settled) {
        fail(new Error("Question wait socket closed before response"));
      }
    });
  });

  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.question;
}

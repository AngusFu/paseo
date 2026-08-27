import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import {
  connectDshClient,
  requireNoError,
  toDshCommandError,
  type DshCommandOptions,
} from "./shared.js";

export interface DshSendRow {
  sessionId: string;
  baseUrl: string;
  accepted: string;
}

const sendSchema: OutputSchema<DshSendRow> = {
  idField: "sessionId",
  columns: [
    { header: "SESSION ID", field: "sessionId", width: 28 },
    { header: "BASE URL", field: "baseUrl", width: 36 },
    { header: "ACCEPTED", field: "accepted", width: 10 },
  ],
};

export async function runSendCommand(
  sessionId: string,
  prompt: string,
  options: DshCommandOptions,
  _command: Command,
): Promise<SingleResult<DshSendRow>> {
  const { client } = await connectDshClient(options.host);
  try {
    const payload = await client.dshSessionPrompt({
      sessionId,
      text: prompt,
      mode: "queue",
      ...(options.dshHost ? { baseUrl: options.dshHost } : {}),
    });
    requireNoError(payload.error);
    return {
      type: "single",
      data: {
        sessionId: payload.sessionId ?? sessionId,
        baseUrl: payload.baseUrl ?? "",
        accepted: payload.accepted == null ? "" : String(payload.accepted),
      },
      schema: sendSchema,
    };
  } catch (error) {
    throw toDshCommandError("DSH_SEND_FAILED", "send DSH prompt", error);
  } finally {
    await client.close().catch(() => {});
  }
}

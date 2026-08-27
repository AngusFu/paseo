import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import {
  connectDshClient,
  requireNoError,
  toDshCommandError,
  type DshCommandOptions,
} from "./shared.js";

export interface DshStatusRow {
  running: boolean;
  baseUrl: string;
  port: string;
}

const statusSchema: OutputSchema<DshStatusRow> = {
  idField: "baseUrl",
  columns: [
    { header: "RUNNING", field: "running", width: 8 },
    { header: "BASE URL", field: "baseUrl", width: 36 },
    { header: "PORT", field: "port", width: 8 },
  ],
};

export async function runStatusCommand(
  options: DshCommandOptions,
  _command: Command,
): Promise<SingleResult<DshStatusRow>> {
  const { client } = await connectDshClient(options.host);
  try {
    const payload = await client.dshStatus(options.dshHost ? { baseUrl: options.dshHost } : {});
    requireNoError(payload.error);
    const status = payload.status;
    return {
      type: "single",
      data: {
        running: Boolean(status?.running),
        baseUrl: status?.baseUrl ?? "",
        port: status?.port != null ? String(status.port) : "",
      },
      schema: statusSchema,
    };
  } catch (error) {
    throw toDshCommandError("DSH_STATUS_FAILED", "check DSH status", error);
  } finally {
    await client.close().catch(() => {});
  }
}

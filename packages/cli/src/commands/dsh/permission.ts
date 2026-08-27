import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import {
  connectDshClient,
  requireNoError,
  toDshCommandError,
  type DshCommandOptions,
} from "./shared.js";

export interface DshPermissionRow {
  sessionId: string;
  permission: string;
  text: string;
  baseUrl: string;
}

const permissionSchema: OutputSchema<DshPermissionRow> = {
  idField: "sessionId",
  columns: [
    { header: "SESSION ID", field: "sessionId", width: 28 },
    { header: "PERMISSION", field: "permission", width: 20 },
    { header: "TEXT", field: "text", width: 40 },
    { header: "BASE URL", field: "baseUrl", width: 36 },
  ],
};

export async function runPermissionCommand(
  sessionId: string,
  permission: string,
  options: DshCommandOptions,
  _command: Command,
): Promise<SingleResult<DshPermissionRow>> {
  const { client } = await connectDshClient(options.host);
  try {
    const payload = await client.dshSessionSetPermission({
      sessionId,
      permission,
      ...(options.dshHost ? { baseUrl: options.dshHost } : {}),
    });
    requireNoError(payload.error);
    return {
      type: "single",
      data: {
        sessionId: payload.sessionId ?? sessionId,
        permission: payload.permission ?? permission,
        text: payload.text ?? "",
        baseUrl: payload.baseUrl ?? "",
      },
      schema: permissionSchema,
    };
  } catch (error) {
    throw toDshCommandError("DSH_PERMISSION_FAILED", "set DSH permission", error);
  } finally {
    await client.close().catch(() => {});
  }
}

import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import {
  connectDshClient,
  requireNoError,
  toDshCommandError,
  type DshCommandOptions,
} from "./shared.js";

export interface DshRunRow {
  sessionId: string;
  baseUrl: string;
  agentPreset: string;
  permission: string;
  accepted: string;
}

const runSchema: OutputSchema<DshRunRow> = {
  idField: "sessionId",
  columns: [
    { header: "SESSION ID", field: "sessionId", width: 28 },
    { header: "BASE URL", field: "baseUrl", width: 36 },
    { header: "PRESET", field: "agentPreset", width: 12 },
    { header: "PERMISSION", field: "permission", width: 20 },
    { header: "ACCEPTED", field: "accepted", width: 10 },
  ],
};

export async function runRunCommand(
  prompt: string,
  options: DshCommandOptions & {
    workspace?: string;
    cwd?: string;
    agentPreset?: string;
    permission?: string;
  },
  _command: Command,
): Promise<SingleResult<DshRunRow>> {
  const { client } = await connectDshClient(options.host);
  try {
    const payload = await client.dshSessionCreate({
      ...(options.dshHost ? { baseUrl: options.dshHost } : {}),
      ...(options.workspace ? { workspaceId: options.workspace } : {}),
      ...(!options.workspace ? { cwd: options.cwd ?? process.cwd() } : {}),
      ...(options.agentPreset ? { agentPreset: options.agentPreset } : {}),
      ...(options.permission ? { permission: options.permission } : {}),
      prompt,
    });
    requireNoError(payload.error);
    if (!payload.sessionId) {
      throw new Error("create returned no sessionId");
    }
    return {
      type: "single",
      data: {
        sessionId: payload.sessionId,
        baseUrl: payload.baseUrl ?? "",
        agentPreset: payload.agentPreset ?? "",
        permission: payload.permission ?? "",
        accepted: payload.accepted == null ? "" : String(payload.accepted),
      },
      schema: runSchema,
    };
  } catch (error) {
    throw toDshCommandError("DSH_RUN_FAILED", "create DSH session", error);
  } finally {
    await client.close().catch(() => {});
  }
}

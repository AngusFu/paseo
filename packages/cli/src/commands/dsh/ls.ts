import type { Command } from "commander";
import type { ListResult, OutputSchema } from "../../output/index.js";
import {
  connectDshClient,
  requireNoError,
  toDshCommandError,
  type DshCommandOptions,
} from "./shared.js";

export interface DshSessionRow {
  id: string;
  sessionId: string;
  title: string;
  status: string;
  model: string;
  provider: string;
  cwd: string;
  turns: string;
}

const sessionSchema: OutputSchema<DshSessionRow> = {
  idField: "sessionId",
  columns: [
    { header: "SESSION ID", field: "id", width: 12 },
    { header: "NAME", field: "title", width: 28 },
    { header: "STATUS", field: "status", width: 9 },
    { header: "MODEL", field: "model", width: 24 },
    { header: "PROVIDER", field: "provider", width: 16 },
    { header: "CWD", field: "cwd", width: 40 },
    { header: "TURNS", field: "turns", width: 6 },
  ],
};

function shortId(sessionId: string): string {
  return sessionId.replace(/^session-/, "").slice(0, 8);
}

export async function runLsCommand(
  options: DshCommandOptions & { all?: boolean; cwd?: string },
  _command: Command,
): Promise<ListResult<DshSessionRow>> {
  const { client } = await connectDshClient(options.host);
  try {
    const payload = await client.dshSessionList({
      ...(options.dshHost ? { baseUrl: options.dshHost } : {}),
      ...(options.all ? { includeAll: true } : {}),
    });
    requireNoError(payload.error);
    let rows = payload.sessions.map((session) => ({
      id: shortId(session.sessionId),
      sessionId: session.sessionId,
      title: session.title ?? "",
      status: session.status,
      model: session.model ?? "",
      provider: session.provider ?? "",
      cwd: session.cwd ?? "",
      turns: session.turns != null ? String(session.turns) : "",
    }));
    if (options.cwd) {
      rows = rows.filter((row) => row.cwd === options.cwd);
    }
    return { type: "list", data: rows, schema: sessionSchema };
  } catch (error) {
    throw toDshCommandError("DSH_LIST_FAILED", "list DSH sessions", error);
  } finally {
    await client.close().catch(() => {});
  }
}

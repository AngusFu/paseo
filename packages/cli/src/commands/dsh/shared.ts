import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import type { DaemonClient } from "@getpaseo/client";

export interface DshCommandOptions extends CommandOptions {
  host?: string;
  /** Optional DSH Web base URL override forwarded to the daemon proxy. */
  dshHost?: string;
}

export async function connectDshClient(
  host: string | undefined,
): Promise<{ client: DaemonClient; host: string }> {
  const resolvedHost = getDaemonHost({ host });
  try {
    const client = await connectToDaemon({ host });
    return { client, host: resolvedHost };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export function toDshCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

export function requireNoError(error: string | null | undefined): void {
  if (error) {
    throw new Error(error);
  }
}

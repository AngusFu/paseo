import { spawn } from "node:child_process";
import type { ScheduleTarget } from "@getpaseo/protocol/schedule/types";

// Runs stay inside the per-schedule JSON file, so captured output must stay small.
export const COMMAND_OUTPUT_TAIL_BYTES = 16 * 1024;
const KILL_GRACE_MS = 5_000;

export interface CommandRunResult {
  exitCode: number | null;
  output: string | null;
  timedOut: boolean;
}

// Keeps only the trailing `limit` bytes of everything appended to it.
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.size -= dropped?.length ?? 0;
      this.truncated = true;
    }
  }

  toString(): string | null {
    if (this.size === 0) {
      return null;
    }
    let text = Buffer.concat(this.chunks).toString("utf8");
    if (text.length > this.limit) {
      text = text.slice(text.length - this.limit);
      this.truncated = true;
    }
    return this.truncated ? `…[output truncated]\n${text}` : text;
  }
}

export function runScheduleCommand(
  target: Extract<ScheduleTarget, { type: "command" }>,
): Promise<CommandRunResult> {
  return new Promise((resolve, reject) => {
    // shell: true resolves to /bin/sh -c on POSIX and cmd /c on Windows,
    // matching classic crontab semantics for the command string.
    const child = spawn(target.command, {
      shell: true,
      cwd: target.cwd,
      env: { ...process.env, ...target.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tail = new TailBuffer(COMMAND_OUTPUT_TAIL_BYTES);
    child.stdout.on("data", (chunk: Buffer) => tail.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => tail.append(chunk));

    const unrefTimer = (timer: ReturnType<typeof setTimeout>) => {
      (timer as unknown as { unref?: () => void }).unref?.();
    };
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutTimer = target.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
          unrefTimer(killTimer);
        }, target.timeoutMs)
      : null;
    if (timeoutTimer) {
      unrefTimer(timeoutTimer);
    }

    const clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };

    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimers();
      resolve({
        exitCode: code,
        output: tail.toString(),
        timedOut,
      });
    });
  });
}

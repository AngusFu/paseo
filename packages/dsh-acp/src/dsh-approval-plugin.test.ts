import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";

import { ApprovalChannel } from "./dsh-approval-plugin.js";

describe("ApprovalChannel", () => {
  test("announces readiness without using stdout", async () => {
    const stream = new PassThrough();
    const line = new Promise<string>((resolve) => {
      stream.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    });
    const channel = new ApprovalChannel(stream);
    channel.ready();

    await expect(line).resolves.toBe('{"type":"approval/ready"}\n');
  });

  test("round-trips an allowed permission decision", async () => {
    const stream = new PassThrough();
    const channel = new ApprovalChannel(stream);
    let requestLine = "";
    stream.once("data", (chunk: Buffer) => {
      requestLine = chunk.toString();
      const request = JSON.parse(requestLine) as { id: string };
      stream.write(`${JSON.stringify({ id: request.id, outcome: "allowed-once" })}\n`);
    });

    const outcome = await channel.request({
      agent: { session: { id: "session-1" } },
      toolName: "bash",
      callId: "call-1",
      reason: "Needs wider access",
    });

    expect(outcome).toBe("allowed-once");
    expect(JSON.parse(requestLine)).toMatchObject({
      type: "approval/request",
      sessionId: "session-1",
      toolName: "bash",
      callId: "call-1",
      reason: "Needs wider access",
    });
  });
});

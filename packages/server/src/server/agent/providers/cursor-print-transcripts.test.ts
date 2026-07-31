import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  findCursorPrintAgentTranscript,
  projectCursorPrintTranscriptToTimeline,
  readCursorPrintTranscriptTimeline,
} from "./cursor-print-transcripts.js";

describe("cursor-print-transcripts", () => {
  test("projectCursorPrintTranscriptToTimeline maps user/assistant/tool_use", () => {
    const lines = [
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_info>\nhidden</user_info>" }],
        },
      }),
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<timestamp>t</timestamp>\n<user_query>\nfix the bug\n</user_query>",
            },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "looking" },
            { type: "tool_use", name: "Read", input: { path: "/tmp/a.ts" } },
          ],
        },
      }),
    ];

    expect(projectCursorPrintTranscriptToTimeline(lines)).toEqual([
      { type: "user_message", text: "fix the bug" },
      { type: "assistant_message", text: "looking" },
      {
        type: "tool_call",
        callId: "transcript-tool-0",
        name: "Read",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { path: "/tmp/a.ts" }, output: null },
      },
    ]);
  });

  test("find + read transcript from Cursor projects layout", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "cursor-transcript-home-"));
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const dir = join(
      homeDir,
      ".cursor",
      "projects",
      "Users-tmp-demo",
      "agent-transcripts",
      sessionId,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>\nhello\n</user_query>" }] },
      })}\n${JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      })}\n`,
      "utf8",
    );

    const found = await findCursorPrintAgentTranscript(sessionId, { homeDir, env: {} });
    expect(found).toBe(join(dir, `${sessionId}.jsonl`));

    const items = await readCursorPrintTranscriptTimeline({
      sessionId,
      homeDir,
      env: {},
    });
    expect(items).toEqual([
      { type: "user_message", text: "hello" },
      { type: "assistant_message", text: "hi" },
    ]);
  });
});

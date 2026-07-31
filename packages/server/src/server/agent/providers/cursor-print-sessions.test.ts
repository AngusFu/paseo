import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { execCommand } from "../../../utils/spawn.js";
import {
  cursorWorkspaceHash,
  extractCursorUserSummary,
  isCursorResumeFailure,
  listCursorPrintImportableSessions,
  listCursorPrintSessions,
  projectCursorPrintMessagesToTimeline,
  readCursorPrintTimelineHistory,
  resolveAbsoluteWorkspace,
} from "./cursor-print-sessions.js";

function blobId(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function hashField(tag: number, idHex: string): Buffer {
  return Buffer.concat([Buffer.from([tag, 0x20]), Buffer.from(idHex, "hex")]);
}

async function writeFixtureSession(options: {
  homeDir: string;
  workDir: string;
  sessionId: string;
  title: string;
  userText: string;
}): Promise<void> {
  const hash = cursorWorkspaceHash(options.workDir);
  const dir = join(options.homeDir, ".cursor", "chats", hash, options.sessionId);
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, "store.db");

  const userBlobId = blobId("user");
  const systemBlobId = blobId("system-user");
  const assistantBlobId = blobId("assistant");
  const toolBlobId = blobId("tool");
  const siblingBlobId = blobId("sibling");
  const rootBlobId = blobId("root");
  const meta = Buffer.from(
    JSON.stringify({
      agentId: options.sessionId,
      name: options.title,
      mode: "agent",
      latestRootBlobId: rootBlobId,
    }),
    "utf8",
  ).toString("hex");
  const systemJson = JSON.stringify({
    role: "user",
    content: "<user_info>\nhidden system dump\n</user_info>",
  });
  const userJson = JSON.stringify({
    role: "user",
    content: [{ type: "text", text: `<user_query>\n${options.userText}\n</user_query>` }],
  });
  const assistantJson = JSON.stringify({
    role: "assistant",
    content: [
      { type: "text", text: "working on it" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Shell",
        args: { command: "ls" },
      },
    ],
  });
  const toolJson = JSON.stringify({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "Shell",
        result: "ok\n",
      },
    ],
  });
  // Root includes a non-message 0x1a field between messages so naive parsers stop early.
  const rootBytes = Buffer.concat([
    hashField(0x0a, systemBlobId),
    hashField(0x0a, userBlobId),
    hashField(0x1a, siblingBlobId),
    hashField(0x0a, assistantBlobId),
    hashField(0x0a, toolBlobId),
  ]);

  const sql = [
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);",
    "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);",
    `INSERT INTO meta(key, value) VALUES ('0', '${meta}');`,
    `INSERT INTO blobs(id, data) VALUES ('${systemBlobId}', X'${Buffer.from(systemJson, "utf8").toString("hex")}');`,
    `INSERT INTO blobs(id, data) VALUES ('${userBlobId}', X'${Buffer.from(userJson, "utf8").toString("hex")}');`,
    `INSERT INTO blobs(id, data) VALUES ('${assistantBlobId}', X'${Buffer.from(assistantJson, "utf8").toString("hex")}');`,
    `INSERT INTO blobs(id, data) VALUES ('${toolBlobId}', X'${Buffer.from(toolJson, "utf8").toString("hex")}');`,
    `INSERT INTO blobs(id, data) VALUES ('${siblingBlobId}', X'${Buffer.from("{}", "utf8").toString("hex")}');`,
    `INSERT INTO blobs(id, data) VALUES ('${rootBlobId}', X'${rootBytes.toString("hex")}');`,
  ].join("\n");
  await execCommand("sqlite3", [dbPath, sql], { timeout: 5_000 });
}

describe("cursor-print-sessions", () => {
  test("workspace hash matches md5 of absolute path", () => {
    const cwd = "/tmp/project";
    expect(cursorWorkspaceHash(cwd)).toBe(
      createHash("md5").update(resolveAbsoluteWorkspace(cwd)).digest("hex"),
    );
  });

  test("extractCursorUserSummary prefers <user_query>", () => {
    expect(
      extractCursorUserSummary([
        { type: "text", text: "<user_query>\nfix the bug\n</user_query>" },
      ]),
    ).toBe("fix the bug");
    expect(extractCursorUserSummary("<user_info>\nhidden</user_info>")).toBe("");
  });

  test("isCursorResumeFailure detects resume errors", () => {
    expect(isCursorResumeFailure("Unable to resume session: not found")).toBe(true);
    expect(isCursorResumeFailure("network timeout")).toBe(false);
  });

  test("listCursorPrintSessions reads fixture store.db", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "cursor-print-home-"));
    const workDir = await mkdtemp(join(tmpdir(), "cursor-print-work-"));
    await writeFixtureSession({
      homeDir,
      workDir,
      sessionId: "11111111-2222-3333-4444-555555555555",
      title: "New Agent",
      userText: "hello from fixture",
    });

    const sessions = await listCursorPrintSessions(workDir, { homeDir, env: {} });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(sessions[0]?.summary).toContain("hello from fixture");

    const importable = await listCursorPrintImportableSessions({
      cwd: workDir,
      homeDir,
      env: {},
      limit: 10,
    });
    expect(importable).toEqual([
      expect.objectContaining({
        providerHandleId: "11111111-2222-3333-4444-555555555555",
        cwd: resolveAbsoluteWorkspace(workDir),
        firstPromptPreview: expect.stringContaining("hello from fixture"),
      }),
    ]);
  });

  test("projectCursorPrintMessagesToTimeline skips system dumps and maps tools", () => {
    const items = projectCursorPrintMessagesToTimeline([
      { role: "user", content: "<user_info>\nhidden</user_info>" },
      {
        role: "user",
        content: [{ type: "text", text: "<user_query>\nfix it\n</user_query>" }],
      },
      {
        role: "user",
        content:
          "Your conversation was summarized due to context constraints. Here is the summary...",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool-call", toolCallId: "t1", toolName: "Read", args: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "t1", toolName: "Read", result: "file" }],
      },
    ]);

    expect(items).toEqual([
      { type: "user_message", text: "fix it" },
      { type: "assistant_message", text: "on it" },
      {
        type: "tool_call",
        callId: "t1",
        name: "Read",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { path: "a.ts" }, output: "file" },
      },
    ]);
  });

  test("readCursorPrintTimelineHistory continues past non-message root fields", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "cursor-print-home-"));
    const workDir = await mkdtemp(join(tmpdir(), "cursor-print-work-"));
    await writeFixtureSession({
      homeDir,
      workDir,
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      title: "New Agent",
      userText: "resume me",
    });

    const items = await readCursorPrintTimelineHistory({
      cwd: workDir,
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      homeDir,
      env: {},
    });

    expect(items).toEqual([
      { type: "user_message", text: "resume me" },
      { type: "assistant_message", text: "working on it" },
      {
        type: "tool_call",
        callId: "call_1",
        name: "Shell",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { command: "ls" }, output: "ok\n" },
      },
    ]);
  });
});

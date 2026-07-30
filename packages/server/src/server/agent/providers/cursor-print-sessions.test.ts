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
  resolveAbsoluteWorkspace,
} from "./cursor-print-sessions.js";

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

  const userBlobId = createHash("sha256").update("user").digest("hex");
  const rootBlobId = createHash("sha256").update("root").digest("hex");
  const meta = Buffer.from(
    JSON.stringify({
      agentId: options.sessionId,
      name: options.title,
      mode: "agent",
      latestRootBlobId: rootBlobId,
    }),
    "utf8",
  ).toString("hex");
  const userJson = JSON.stringify({
    role: "user",
    content: [{ type: "text", text: `<user_query>\n${options.userText}\n</user_query>` }],
  });
  // Root blob: field-1 entry (0x0a 0x20 + 32-byte hash of user blob)
  const userHash = Buffer.from(userBlobId, "hex");
  const rootBytes = Buffer.concat([Buffer.from([0x0a, 0x20]), userHash]);

  const sql = [
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);",
    "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);",
    `INSERT INTO meta(key, value) VALUES ('0', '${meta}');`,
    `INSERT INTO blobs(id, data) VALUES ('${userBlobId}', X'${Buffer.from(userJson, "utf8").toString("hex")}');`,
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
});

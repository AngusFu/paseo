import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { dump } from "js-yaml";
import { afterEach, describe, expect, test } from "vitest";

import {
  createDshSessionId,
  formatDshSessionId,
  resolveDshHome,
  resolveDshSessionRoot,
} from "./dsh-home.js";
import { ensureDshProfile } from "./dsh-profile.js";
import { listDshImportableSessions } from "./dsh-session-import.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("dsh-home", () => {
  test("formats session ids with the Web prefix", () => {
    expect(formatDshSessionId("abc")).toBe("session-abc");
    expect(formatDshSessionId("session-abc")).toBe("session-abc");
    expect(createDshSessionId()).toMatch(/^session-[0-9a-f-]{36}$/);
  });

  test("resolves profile and session roots under DSH home", () => {
    const profileHome = mkdtempSync(join(tmpdir(), "dsh-home-"));
    tempDirs.push(profileHome);
    expect(resolveDshHome({ profileHome })).toBe(profileHome);
    expect(resolveDshSessionRoot({ profileHome })).toBe(join(profileHome, "sessions"));
  });
});

describe("ensureDshProfile", () => {
  test("uses shared settings.yaml at the DSH home root", () => {
    const profileHome = mkdtempSync(join(tmpdir(), "dsh-profile-"));
    tempDirs.push(profileHome);
    ensureDshProfile({ profileHome });

    writeFileSync(
      join(profileHome, "settings.yaml"),
      dump({
        "llm-pi-ai": {
          providers: {
            "x-9router": {
              displayName: "9Router",
              models: [{ id: "glm-5" }],
            },
          },
        },
      }),
      "utf8",
    );

    const state = ensureDshProfile({ profileHome });
    expect(state.settingsPath).toBe(join(profileHome, "settings.yaml"));
    expect(state.cordisPatchPath).toBe(join(profileHome, "paseo", "cordis.patch.yml"));
    expect(state.sessionRoot).toBe(join(profileHome, "sessions"));
  });
});

describe("listDshImportableSessions", () => {
  test("lists Web-format sessions from the shared session root", async () => {
    const profileHome = mkdtempSync(join(tmpdir(), "dsh-import-"));
    tempDirs.push(profileHome);
    const cwd = "/tmp/dsh-shared-workspace";
    const bucket = join(profileHome, "sessions", "--tmp-dsh-shared-workspace--");
    const sessionId = "session-11111111-1111-4111-8111-111111111111";
    const sessionDir = join(bucket, sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const logLine = JSON.stringify({
      type: "session",
      id: sessionId,
      cwd,
      createdAt: Date.now(),
    });
    const userLine = JSON.stringify({
      type: "user/message",
      time: Date.now(),
      data: {
        role: "user",
        content: [{ type: "text", text: "hello from web" }],
      },
    });
    const compressed = zstdCompressSync(Buffer.from(`${logLine}\n${userLine}\n`, "utf8"));
    writeFileSync(join(sessionDir, "session.jsonl.zstd"), compressed);

    const sessions = await listDshImportableSessions({
      profileHome,
      cwd,
      limit: 5,
    });

    expect(sessions).toEqual([
      expect.objectContaining({
        providerHandleId: sessionId,
        cwd,
        firstPromptPreview: "hello from web",
        lastPromptPreview: "hello from web",
      }),
    ]);
  });
});

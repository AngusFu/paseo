import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { attachDshSessionToWorkspace, readDshWorkspaceDocument } from "./dsh-workspace.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("dsh-workspace", () => {
  test("creates a new workspace entry when none exists for the cwd", () => {
    const profileHome = mkdtempSync(join(tmpdir(), "dsh-ws-"));
    tempDirs.push(profileHome);

    const result = attachDshSessionToWorkspace({
      cwd: "/tmp/project-a",
      sessionId: "session-1234",
      options: { profileHome },
    });

    expect(result.created).toBe(true);
    expect(result.workspaceId).toBeDefined();

    const doc = readDshWorkspaceDocument({ profileHome });
    expect(doc.global.workspaceIds).toContain(result.workspaceId);
    expect(doc.tables.workspaces[result.workspaceId]).toMatchObject({
      path: "/tmp/project-a",
      title: "project-a",
      sessionIds: ["session-1234"],
    });
  });

  test("attaches session to existing workspace if path matches", () => {
    const profileHome = mkdtempSync(join(tmpdir(), "dsh-ws-"));
    tempDirs.push(profileHome);

    const first = attachDshSessionToWorkspace({
      cwd: "/tmp/project-a",
      sessionId: "session-1",
      options: { profileHome },
    });

    const second = attachDshSessionToWorkspace({
      cwd: "/tmp/project-a",
      sessionId: "session-2",
      options: { profileHome },
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.workspaceId).toBe(first.workspaceId);

    const doc = readDshWorkspaceDocument({ profileHome });
    const ws = doc.tables.workspaces[first.workspaceId];
    expect(ws?.sessionIds).toEqual(["session-2", "session-1"]);
  });

  test("does not duplicate session id if already attached", () => {
    const profileHome = mkdtempSync(join(tmpdir(), "dsh-ws-"));
    tempDirs.push(profileHome);

    attachDshSessionToWorkspace({
      cwd: "/tmp/project-a",
      sessionId: "session-1",
      options: { profileHome },
    });

    attachDshSessionToWorkspace({
      cwd: "/tmp/project-a",
      sessionId: "session-1",
      options: { profileHome },
    });

    const doc = readDshWorkspaceDocument({ profileHome });
    const ws = Object.values(doc.tables.workspaces)[0];
    expect(ws?.sessionIds).toEqual(["session-1"]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { attachDshSessionToWorkspace, readDshWorkspaceDocument } from "./workspace.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DSH workspace registry", () => {
  test("creates the cwd workspace and attaches the session", () => {
    const dshHome = temporaryHome();
    const result = attachDshSessionToWorkspace({
      cwd: "/tmp/project-a",
      sessionId: "session-1",
      dshHome,
    });

    expect(result.created).toBe(true);
    expect(readDshWorkspaceDocument(dshHome).tables.workspaces[result.workspaceId]).toMatchObject({
      path: "/tmp/project-a",
      title: "project-a",
      sessionIds: ["session-1"],
    });
  });

  test("prepends new sessions without duplicating an existing session", () => {
    const dshHome = temporaryHome();
    const first = attachDshSessionToWorkspace({
      cwd: "/tmp/project-a",
      sessionId: "session-1",
      dshHome,
    });
    attachDshSessionToWorkspace({ cwd: "/tmp/project-a", sessionId: "session-2", dshHome });
    attachDshSessionToWorkspace({ cwd: "/tmp/project-a", sessionId: "session-2", dshHome });

    expect(
      readDshWorkspaceDocument(dshHome).tables.workspaces[first.workspaceId]?.sessionIds,
    ).toEqual(["session-2", "session-1"]);
  });
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-acp-workspace-"));
  tempDirs.push(directory);
  return directory;
}

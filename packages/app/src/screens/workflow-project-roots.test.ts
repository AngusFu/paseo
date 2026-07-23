import { describe, expect, it } from "vitest";
import type { ScheduleProjectTarget } from "@/schedules/schedule-project-targets";
import { resolveWorkflowProjectRoots } from "./workflow-project-roots";

function target(projectName: string, cwd: string): ScheduleProjectTarget {
  return {
    optionId: `project:srv:${projectName}`,
    serverId: "srv",
    serverName: "host",
    projectKey: projectName,
    projectName,
    cwd,
    isGit: true,
    ownsRepoRoot: true,
  };
}

describe("resolveWorkflowProjectRoots", () => {
  it("keeps one entry per repo root", () => {
    // A worktree and the checkout it came from are separate projects that
    // report the same repo root; reading it twice listed every definition
    // twice under one heading.
    const roots = resolveWorkflowProjectRoots([
      target("sciforum-frontend-v2", "/repos/sciforum"),
      target("feat__SCIF-3507_full_sso", "/repos/sciforum"),
    ]);

    expect(roots.cwds).toEqual(["/repos/sciforum"]);
  });

  it("names a root after the first project that claims it", () => {
    const roots = resolveWorkflowProjectRoots([
      target("sciforum-frontend-v2", "/repos/sciforum"),
      target("feat__SCIF-3507_full_sso", "/repos/sciforum"),
    ]);

    expect(roots.nameByCwd.get("/repos/sciforum")).toBe("sciforum-frontend-v2");
  });

  it("preserves distinct roots and their order", () => {
    const roots = resolveWorkflowProjectRoots([
      target("beta", "/repos/beta"),
      target("alpha", "/repos/alpha"),
      target("beta-worktree", "/repos/beta"),
    ]);

    expect(roots.cwds).toEqual(["/repos/beta", "/repos/alpha"]);
    expect(roots.nameByCwd.get("/repos/alpha")).toBe("alpha");
  });

  it("returns nothing for no projects", () => {
    const roots = resolveWorkflowProjectRoots([]);

    expect(roots.cwds).toEqual([]);
    expect(roots.nameByCwd.size).toBe(0);
  });
});

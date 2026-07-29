import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@/utils/projects";
import {
  buildProjectNameByCwd,
  buildScheduleProjectTargets,
  describeScheduleCwd,
} from "./schedule-project-targets";

function makeProject(overrides: Partial<ProjectSummary>): ProjectSummary {
  return {
    projectKey: "proj",
    projectName: "Project",
    hosts: [],
    totalWorkspaceCount: 0,
    hostCount: 0,
    onlineHostCount: 0,
    ...overrides,
  };
}

function makeHost(overrides: Partial<ProjectSummary["hosts"][number]>) {
  return {
    serverId: "host-1",
    projectId: "project-1",
    projectName: "Project",
    projectCustomName: null,
    serverName: "Host 1",
    isOnline: true,
    repoRoot: "/tmp/project",
    ownsRepoRoot: true,
    workspaceCount: 0,
    workspaces: [],
    ...overrides,
  };
}

describe("buildScheduleProjectTargets", () => {
  it("emits one target per online host with a repo root", () => {
    const targets = buildScheduleProjectTargets([
      makeProject({
        projectName: "Alpha",
        hosts: [
          makeHost({ projectName: "Alpha on Host 1", repoRoot: "/tmp/alpha" }),
          makeHost({ serverId: "host-2", projectName: "Alpha on Host 2" }),
        ],
      }),
    ]);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      serverId: "host-1",
      cwd: "/tmp/alpha",
      projectName: "Alpha on Host 1",
    });
  });

  it("skips offline hosts and blank repo roots", () => {
    const targets = buildScheduleProjectTargets([
      makeProject({
        hosts: [makeHost({ isOnline: false }), makeHost({ serverId: "host-3", repoRoot: "   " })],
      }),
    ]);
    expect(targets).toHaveLength(0);
  });
});

describe("describeScheduleCwd", () => {
  it("prefers a matched project name and shortens unmatched paths", () => {
    const byCwd = buildProjectNameByCwd(
      buildScheduleProjectTargets([
        makeProject({
          projectName: "Grouped Alpha",
          hosts: [makeHost({ projectName: "Alpha on Host 1", repoRoot: "/tmp/alpha" })],
        }),
      ]),
    );
    expect(
      describeScheduleCwd({ serverId: "host-1", cwd: "/tmp/alpha", projectNameByCwd: byCwd }),
    ).toBe("Alpha on Host 1");
    expect(
      describeScheduleCwd({ serverId: "host-1", cwd: "/Users/sam/api", projectNameByCwd: byCwd }),
    ).toBe("~/api");
  });

  it("names a shared root after the project that lives there, not a worktree project", () => {
    // A project made of Paseo worktrees reports the repo root it branched from,
    // so it claims the same path as the checkout that is actually there. The
    // schedule stores only that path, and used to be labelled with whichever
    // project was listed last — the worktree one, since projects sort by name.
    const byCwd = buildProjectNameByCwd(
      buildScheduleProjectTargets([
        makeProject({
          projectKey: "sciforum",
          projectName: "dev/sciforum-frontend-v2",
          hosts: [makeHost({ repoRoot: "/repos/sciforum", ownsRepoRoot: true })],
        }),
        makeProject({
          projectKey: "sso-worktrees",
          projectName: "feat__SCIF-3507_full_sso_migration",
          hosts: [makeHost({ repoRoot: "/repos/sciforum", ownsRepoRoot: false })],
        }),
      ]),
    );

    expect(
      describeScheduleCwd({ serverId: "host-1", cwd: "/repos/sciforum", projectNameByCwd: byCwd }),
    ).toBe("dev/sciforum-frontend-v2");
  });

  it("still names a root claimed only by worktree projects", () => {
    const byCwd = buildProjectNameByCwd(
      buildScheduleProjectTargets([
        makeProject({
          projectName: "first-worktree",
          hosts: [makeHost({ repoRoot: "/repos/sciforum", ownsRepoRoot: false })],
        }),
        makeProject({
          projectKey: "other",
          projectName: "second-worktree",
          hosts: [makeHost({ repoRoot: "/repos/sciforum", ownsRepoRoot: false })],
        }),
      ]),
    );

    expect(
      describeScheduleCwd({ serverId: "host-1", cwd: "/repos/sciforum", projectNameByCwd: byCwd }),
    ).toBe("first-worktree");
  });
});

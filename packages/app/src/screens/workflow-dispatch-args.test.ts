import { describe, expect, it } from "vitest";
import { buildWorkflowDispatchArgs, resolveInitialDispatchCwd } from "./workflow-dispatch-args";

const FULL_SELECTION = {
  task: "Fix the login crash",
  provider: "claude",
  model: "sonnet",
  effort: "high",
  mode: "plan",
  featureValues: null,
};

describe("buildWorkflowDispatchArgs", () => {
  it("packs the whole agent selection into args", () => {
    expect(buildWorkflowDispatchArgs(FULL_SELECTION)).toEqual({
      task: "Fix the login crash",
      provider: "claude",
      model: "sonnet",
      effort: "high",
      mode: "plan",
    });
  });

  it("trims the task and every selection value", () => {
    expect(
      buildWorkflowDispatchArgs({
        ...FULL_SELECTION,
        task: "  Fix the login crash  ",
        model: "  sonnet  ",
        effort: "  high  ",
        mode: "  plan  ",
      }),
    ).toMatchObject({
      task: "Fix the login crash",
      model: "sonnet",
      effort: "high",
      mode: "plan",
    });
  });

  it("omits blank optional fields instead of sending empty strings", () => {
    const args = buildWorkflowDispatchArgs({
      ...FULL_SELECTION,
      model: "",
      effort: "   ",
      mode: "",
    });

    expect(args).toEqual({ task: "Fix the login crash", provider: "claude" });
    expect(Object.hasOwn(args, "model")).toBe(false);
    expect(Object.hasOwn(args, "effort")).toBe(false);
    expect(Object.hasOwn(args, "mode")).toBe(false);
  });

  it("keeps a null provider rather than dropping the key", () => {
    expect(buildWorkflowDispatchArgs({ ...FULL_SELECTION, provider: null })).toMatchObject({
      provider: null,
    });
  });

  it("passes feature values through and mirrors fast_mode to the fast flag", () => {
    expect(
      buildWorkflowDispatchArgs({
        ...FULL_SELECTION,
        featureValues: { fast_mode: true, web_search: false },
      }),
    ).toMatchObject({
      featureValues: { fast_mode: true, web_search: false },
      fast: true,
    });
  });

  it("mirrors a false fast_mode too", () => {
    expect(
      buildWorkflowDispatchArgs({ ...FULL_SELECTION, featureValues: { fast_mode: false } }),
    ).toMatchObject({ fast: false });
  });

  it("does not invent a fast flag when fast_mode is absent or not a boolean", () => {
    const withoutFast = buildWorkflowDispatchArgs({
      ...FULL_SELECTION,
      featureValues: { web_search: true },
    });
    const withNonBoolean = buildWorkflowDispatchArgs({
      ...FULL_SELECTION,
      featureValues: { fast_mode: "yes" },
    });

    expect(Object.hasOwn(withoutFast, "fast")).toBe(false);
    expect(Object.hasOwn(withNonBoolean, "fast")).toBe(false);
  });

  it("omits featureValues entirely when the provider exposes no features", () => {
    const args = buildWorkflowDispatchArgs({ ...FULL_SELECTION, featureValues: undefined });

    expect(Object.hasOwn(args, "featureValues")).toBe(false);
    expect(Object.hasOwn(args, "fast")).toBe(false);
  });
});

const PROJECTS = [
  { cwd: "/repo/alpha", projectName: "Alpha" },
  { cwd: "/repo/beta", projectName: "Beta" },
];

describe("resolveInitialDispatchCwd", () => {
  it("prefers an explicit initialCwd over the project list", () => {
    expect(
      resolveInitialDispatchCwd({ initialCwd: "/repo/beta", projectTargets: PROJECTS }),
    ).toEqual({ cwd: "/repo/beta", label: "Beta" });
  });

  it("keeps an initialCwd that matches no known project, without a label", () => {
    expect(
      resolveInitialDispatchCwd({ initialCwd: "/repo/gamma", projectTargets: PROJECTS }),
    ).toEqual({ cwd: "/repo/gamma", label: null });
  });

  it("labels a worktree initialCwd as internal storage with no project name", () => {
    expect(
      resolveInitialDispatchCwd({
        initialCwd: "/repo/alpha/.paseo/worktrees/wt-1",
        projectTargets: [
          ...PROJECTS,
          { cwd: "/repo/alpha/.paseo/worktrees/wt-1", projectName: "Worktree" },
        ],
      }),
    ).toEqual({ cwd: "/repo/alpha/.paseo/worktrees/wt-1", label: null });
  });

  it("falls back to the first non-internal project when there is no initialCwd", () => {
    expect(resolveInitialDispatchCwd({ initialCwd: null, projectTargets: PROJECTS })).toEqual({
      cwd: "/repo/alpha",
      label: "Alpha",
    });
  });

  it("skips internal paseo paths when choosing the fallback project", () => {
    expect(
      resolveInitialDispatchCwd({
        initialCwd: null,
        projectTargets: [
          { cwd: "/home/.paseo/workflows", projectName: "Workflows" },
          { cwd: "/repo/beta", projectName: "Beta" },
        ],
      }),
    ).toEqual({ cwd: "/repo/beta", label: "Beta" });
  });

  it("uses an internal project as a last resort but gives it no label", () => {
    expect(
      resolveInitialDispatchCwd({
        initialCwd: null,
        projectTargets: [{ cwd: "/home/.paseo/workflows", projectName: "Workflows" }],
      }),
    ).toEqual({ cwd: "/home/.paseo/workflows", label: null });
  });

  it("returns null when there is nothing to preselect", () => {
    expect(resolveInitialDispatchCwd({ initialCwd: null, projectTargets: [] })).toBeNull();
  });

  it("treats windows-style internal paths as internal", () => {
    expect(
      resolveInitialDispatchCwd({
        initialCwd: null,
        projectTargets: [{ cwd: "C:\\repo\\.paseo\\worktrees\\wt-1", projectName: "WT" }],
      }),
    ).toEqual({ cwd: "C:\\repo\\.paseo\\worktrees\\wt-1", label: null });
  });
});

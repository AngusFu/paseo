import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowQueue } from "./queue.js";
import { WorkflowStore } from "./store.js";
import {
  buildWorkflowEngineArgs,
  extractWorkflowResultError,
  matchesKanbanWorkflowRule,
  mergeWorkflowError,
  resolveWorkflowWorkspaceTitle,
  WorkflowService,
} from "./service.js";
import { KanbanStore } from "../kanban/store.js";
import {
  WORKFLOW_CALL_ID_LABEL,
  WORKFLOW_RUN_ID_LABEL,
  WORKFLOW_RUN_WORKSPACE_LABEL,
} from "@getpaseo/protocol/agent-labels";

const dirs: string[] = [];

/** Poll until the run reaches a terminal status (same cadence as the inline loops). */
async function waitForRunToSettle(service: WorkflowService, runId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const latest = await service.getRun(runId);
    if (latest && (latest.status === "succeeded" || latest.status === "failed")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("WorkflowStore", () => {
  it("persists definitions and runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const store = new WorkflowStore(dir);
    const definition = await store.createDefinition({
      name: "Review",
      source: "export const meta = {};",
    });
    const run = await store.createRun({
      id: "wfr_test",
      definitionId: definition.id,
      status: "queued",
      args: {},
      cwd: dir,
      workspaceId: null,
      workspacePath: dir,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      result: null,
      error: null,
    });
    expect((await store.listDefinitions()).map((item) => item.id)).toEqual([definition.id]);
    expect(await store.getRun(run.id)).toEqual(run);
  });
});

describe("project workflow definitions (read-through)", () => {
  const FLOW = (name: string): string =>
    `export const meta = { name: ${JSON.stringify(name)}, description: "d" };\nreturn 1;\n`;

  async function makeRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "paseo-project-wf-"));
    dirs.push(repo);
    return repo;
  }

  it("lists .paseo/workflows and .claude/workflows scripts with project origin", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, ".paseo", "workflows"), { recursive: true });
    await mkdir(join(repo, ".claude", "workflows"), { recursive: true });
    await writeFile(join(repo, ".paseo", "workflows", "review.flow.js"), FLOW("review"));
    await writeFile(join(repo, ".claude", "workflows", "sweep.js"), FLOW("sweep"));
    await writeFile(join(repo, ".claude", "workflows", "README.md"), "not a flow");
    await writeFile(join(repo, ".claude", "workflows", "broken.js"), "no meta here");

    const home = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(home);
    const service = new WorkflowService({ paseoHome: home });
    const listed = await service.listDefinitions(repo);
    const project = listed.filter((definition) => definition.origin === "project");
    expect(project.map((definition) => definition.name).sort()).toEqual(["review", "sweep"]);
    expect(project.every((definition) => definition.id.startsWith("project:"))).toBe(true);
    expect(project.every((definition) => definition.builtin === false)).toBe(true);
    // without a cwd the list stays store-only (old-client behavior)
    expect(
      (await service.listDefinitions()).filter((definition) => definition.origin === "project"),
    ).toEqual([]);
  });

  it(".paseo wins a name collision with .claude", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, ".paseo", "workflows"), { recursive: true });
    await mkdir(join(repo, ".claude", "workflows"), { recursive: true });
    await writeFile(join(repo, ".paseo", "workflows", "dup.flow.js"), FLOW("dup"));
    await writeFile(join(repo, ".claude", "workflows", "dup.js"), FLOW("dup"));

    const home = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(home);
    const service = new WorkflowService({ paseoHome: home });
    const project = (await service.listDefinitions(repo)).filter(
      (definition) => definition.origin === "project",
    );
    expect(project).toHaveLength(1);
    expect(project[0].sourcePath).toContain(join(".paseo", "workflows"));
  });

  it("getDefinition resolves a project: id by reading the file fresh", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, ".paseo", "workflows"), { recursive: true });
    const file = join(repo, ".paseo", "workflows", "live.flow.js");
    await writeFile(file, FLOW("live"));

    const home = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(home);
    const service = new WorkflowService({ paseoHome: home });
    const id = `project:${file}`;
    const first = await service.getDefinition(id);
    expect(first?.name).toBe("live");

    // edit the repo file — next resolve sees the new source, no re-import
    await writeFile(file, FLOW("live").replace("return 1;", "return 2;"));
    const second = await service.getDefinition(id);
    expect(second?.source).toContain("return 2;");
  });

  it("rejects project: ids outside the allowed layout (no arbitrary file reads)", async () => {
    const repo = await makeRepo();
    const secret = join(repo, "secret.flow.js");
    await writeFile(secret, FLOW("secret"));

    const home = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(home);
    const service = new WorkflowService({ paseoHome: home });
    expect(await service.getDefinition(`project:${secret}`)).toBeNull();
    expect(await service.getDefinition("project:../../etc/passwd")).toBeNull();
    expect(
      await service.getDefinition(
        `project:${join(repo, ".paseo", "workflows", "..", "..", "secret.flow.js")}`,
      ),
    ).toBeNull();
  });
});

describe("WorkflowService builtins and authoring", () => {
  it("lists package builtin workflows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const service = new WorkflowService({ paseoHome: dir });
    const builtins = await service.listBuiltins();
    expect(builtins.length).toBeGreaterThan(0);
    expect(builtins.every((item) => item.builtin && item.id.startsWith("builtin:"))).toBe(true);
  });

  it("dispatches a builtin template without copying it first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const service = new WorkflowService({
      paseoHome: dir,
      runner: async () => ({ ok: true }),
    });
    const builtins = await service.listBuiltins();
    const target = builtins.find((item) => item.name === "autopilot") ?? builtins[0]!;
    expect(await service.getDefinition(target.id)).toMatchObject({
      id: target.id,
      builtin: true,
    });
    const run = await service.dispatch({
      definitionId: target.id,
      cwd: dir,
      args: { task: "noop from builtin" },
    });
    expect(run.definitionId).toBe(target.id);
    for (let i = 0; i < 50; i++) {
      const latest = await service.getRun(run.id);
      if (latest && (latest.status === "succeeded" || latest.status === "failed")) {
        expect(latest.status).toBe("succeeded");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("builtin dispatch did not finish");
  });

  it("prepares the authoring workspace under paseo home", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const service = new WorkflowService({ paseoHome: dir });
    const prepared = await service.prepareAuthoring();
    expect(prepared.cwd).toBe(join(dir, "workflows"));
    // Skill is copied when the monorepo skills/ dir is discoverable from this package.
    const skillMd = join(prepared.cwd, ".claude", "skills", "paseo-create-workflow", "SKILL.md");
    await expect(access(skillMd)).resolves.toBeUndefined();
  });

  it("uses dispatch workspaceTitle when minting the agent workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const ensureCalls: Array<{ cwd: string; runId: string; title?: string | null }> = [];
    const prev = process.env.PASEO_WORKFLOW_BACKEND;
    process.env.PASEO_WORKFLOW_BACKEND = "mock";
    try {
      const service = new WorkflowService({
        paseoHome: dir,
        ensureAgentWorkspace: async (input) => {
          ensureCalls.push(input);
          return "wks_named";
        },
      });
      const definition = await service.createDefinition({
        name: "named-ws",
        source: "export const meta = { name: 'named-ws' };\nreturn { ok: true };\n",
      });
      const run = await service.dispatch({
        definitionId: definition.id,
        cwd: dir,
        workspaceTitle: "SCIF-5041 RCA",
        args: { task: "noop" },
      });
      for (let i = 0; i < 50; i++) {
        const latest = await service.getRun(run.id);
        if (latest && (latest.status === "succeeded" || latest.status === "failed")) {
          expect(ensureCalls[0]?.title).toBe("⚙️ SCIF-5041 RCA");
          expect(resolveWorkflowWorkspaceTitle(definition, latest)).toBe("⚙️ SCIF-5041 RCA");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("named workspace dispatch did not finish");
    } finally {
      if (prev === undefined) {
        delete process.env.PASEO_WORKFLOW_BACKEND;
      } else {
        process.env.PASEO_WORKFLOW_BACKEND = prev;
      }
    }
  });

  it("reuses a targeted workspace instead of minting one, and takes its cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const ensureCalls: Array<{ cwd: string; runId: string; title?: string | null }> = [];
    const prev = process.env.PASEO_WORKFLOW_BACKEND;
    process.env.PASEO_WORKFLOW_BACKEND = "mock";
    try {
      const service = new WorkflowService({
        paseoHome: dir,
        ensureAgentWorkspace: async (input) => {
          ensureCalls.push(input);
          return "wks_freshly_minted";
        },
        resolveWorkspaceDirectory: async (workspaceId) =>
          workspaceId === "wks_existing" ? dir : null,
      });
      const definition = await service.createDefinition({
        name: "target-ws",
        source: "export const meta = { name: 'target-ws' };\nreturn { ok: true };\n",
      });
      const run = await service.dispatch({
        definitionId: definition.id,
        workspaceId: "wks_existing",
        args: { task: "noop" },
      });
      expect(run.workspaceId).toBe("wks_existing");
      expect(run.cwd).toBe(dir);
      for (let i = 0; i < 50; i++) {
        const latest = await service.getRun(run.id);
        if (latest && (latest.status === "succeeded" || latest.status === "failed")) {
          expect(latest.workspaceId).toBe("wks_existing");
          // The whole point: no new workspace was created for this run.
          expect(ensureCalls).toHaveLength(0);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("targeted workspace dispatch did not finish");
    } finally {
      if (prev === undefined) {
        delete process.env.PASEO_WORKFLOW_BACKEND;
      } else {
        process.env.PASEO_WORKFLOW_BACKEND = prev;
      }
    }
  });

  it("rejects a dispatch that targets an unknown workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const service = new WorkflowService({
      paseoHome: dir,
      resolveWorkspaceDirectory: async () => null,
    });
    const definition = await service.createDefinition({
      name: "missing-ws",
      source: "export const meta = { name: 'missing-ws' };\nreturn { ok: true };\n",
    });
    await expect(
      service.dispatch({
        definitionId: definition.id,
        workspaceId: "wks_nope",
        args: { task: "noop" },
      }),
    ).rejects.toThrow(/workspace not found/i);
  });

  it("mints one agent workspace per run and persists run.workspaceId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const ensureCalls: Array<{ cwd: string; runId: string; title?: string | null }> = [];
    const prev = process.env.PASEO_WORKFLOW_BACKEND;
    process.env.PASEO_WORKFLOW_BACKEND = "mock";
    try {
      const service = new WorkflowService({
        paseoHome: dir,
        ensureAgentWorkspace: async (input) => {
          ensureCalls.push(input);
          return "wks_workflow_shared";
        },
      });
      const definition = await service.createDefinition({
        name: "shared-ws",
        source: "export const meta = { name: 'shared-ws' };\nreturn { ok: true };\n",
      });
      const run = await service.dispatch({
        definitionId: definition.id,
        cwd: dir,
        args: { task: "noop" },
      });
      for (let i = 0; i < 50; i++) {
        const latest = await service.getRun(run.id);
        if (latest && (latest.status === "succeeded" || latest.status === "failed")) {
          expect(latest.workspaceId).toBe("wks_workflow_shared");
          expect(ensureCalls).toHaveLength(1);
          expect(ensureCalls[0]?.cwd).toBe(dir);
          expect(ensureCalls[0]?.title).toContain("shared-ws");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("workflow run did not finish");
    } finally {
      if (prev === undefined) {
        delete process.env.PASEO_WORKFLOW_BACKEND;
      } else {
        process.env.PASEO_WORKFLOW_BACKEND = prev;
      }
    }
  });
});

describe("reconstructRunHistory", () => {
  it("builds a timeline from run.json + journal.jsonl when events are missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const { reconstructRunHistory, paginateLogEntries } = await import("./run-history.js");
    const runDir = join(dir, "run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "journal.jsonl"),
      `${JSON.stringify({ key: "wf_plan", result: { summary: "found root cause in migrator" } })}\n${JSON.stringify({ key: "wf_review", result: { verdict: "REVISE", holes: [{}, {}] } })}\n`,
      "utf8",
    );
    const history = await reconstructRunHistory({
      id: "wfr_hist",
      definitionId: "wfd_1",
      status: "failed",
      args: { task: "fix", provider: "cursor" },
      cwd: dir,
      workspaceId: "wks_1",
      workspacePath: runDir,
      queuedAt: "2026-07-16T05:00:00.000Z",
      startedAt: "2026-07-16T05:00:01.000Z",
      endedAt: "2026-07-16T05:10:00.000Z",
      result: { stats: { agentCalls: 2, structuredRetries: 1 } },
      error: "Implementation incomplete",
    });
    const events = history.map((entry) => entry.event);
    expect(events[0]).toBe("run.queued");
    expect(events).toContain("journal.record");
    expect(events).toContain("run.stats");
    expect(events.at(-1)).toBe("run.failed");
    expect(history.some((entry) => entry.message.includes("verdict=REVISE"))).toBe(true);
    const page = paginateLogEntries(history, { afterSeq: 0, limit: 3 });
    expect(page.entries).toHaveLength(3);
    expect(page.hasMore).toBe(true);
  });
});

describe("WorkflowEventLog paging", () => {
  it("pages run logs with afterSeq/limit/hasMore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const { WorkflowEventLog } = await import("./event-log.js");
    const log = new WorkflowEventLog(join(dir, "workflows"));
    for (let i = 0; i < 5; i++) {
      await log.append({
        event: "test.page",
        message: `line ${i}`,
        runId: "wfr_page",
      });
    }
    const page1 = await log.readRunLogs("wfr_page", { afterSeq: 0, limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await log.readRunLogs("wfr_page", {
      afterSeq: page1.nextSeq,
      limit: 2,
    });
    expect(page2.entries).toHaveLength(2);
    expect(page2.hasMore).toBe(true);
    const page3 = await log.readRunLogs("wfr_page", {
      afterSeq: page2.nextSeq,
      limit: 2,
    });
    expect(page3.entries).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
    expect([...page1.entries, ...page2.entries, ...page3.entries].map((e) => e.message)).toEqual([
      "line 0",
      "line 1",
      "line 2",
      "line 3",
      "line 4",
    ]);
  });
});

describe("WorkflowService.cancel", () => {
  it("cancels a queued run before it ever executes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    let started = false;
    const service = new WorkflowService({
      paseoHome: dir,
      maxConcurrency: 0, // never dequeues — the run stays "queued"
      runner: async () => {
        started = true;
        return { ok: true };
      },
    });
    const definition = await service.createDefinition({
      name: "never-runs",
      source: "export const meta = {};",
    });
    const run = await service.dispatch({ definitionId: definition.id, cwd: dir, args: {} });
    const cancelled = await service.cancel(run.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(started).toBe(false);
  });

  it("flags a running run and settles it as cancelled once the script stops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    let releaseRun: () => void = () => {};
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const cancelAgentsCalls: Array<{ workspaceId: string; runId: string }> = [];
    const service = new WorkflowService({
      paseoHome: dir,
      runner: async () => {
        await runGate;
        return { ok: true };
      },
      cancelWorkflowAgents: async (input) => {
        cancelAgentsCalls.push(input);
      },
    });
    const definition = await service.createDefinition({
      name: "cancel-me",
      source: "export const meta = {};",
    });
    const run = await service.dispatch({ definitionId: definition.id, cwd: dir, args: {} });

    for (let i = 0; i < 50; i++) {
      const latest = await service.getRun(run.id);
      if (latest?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const midCancel = await service.cancel(run.id);
    // Status write is left to execute()'s settlement — cancel() only flags it
    // and (when a workspaceId is known) best-effort interrupts the in-flight
    // agent. A custom runner never mints a workspace, so no interrupt fires.
    expect(midCancel?.status).toBe("running");
    expect(cancelAgentsCalls).toEqual([]);

    releaseRun();
    for (let i = 0; i < 50; i++) {
      const latest = await service.getRun(run.id);
      if (latest && latest.status !== "running") {
        expect(latest.status).toBe("cancelled");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("cancelled run did not settle");
  });
});

describe("WorkflowService.recoverAfterRestart", () => {
  it("re-enqueues a queued run left over from a prior daemon process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const before = new WorkflowService({ paseoHome: dir, maxConcurrency: 0 });
    const definition = await before.createDefinition({
      name: "requeue-me",
      source: "export const meta = {};",
    });
    const run = await before.dispatch({ definitionId: definition.id, cwd: dir, args: {} });
    // Still queued — maxConcurrency: 0 never dequeues, simulating a run that
    // never got its process-local queue slot before the daemon died.
    expect((await before.getRun(run.id))?.status).toBe("queued");

    const after = new WorkflowService({
      paseoHome: dir,
      runner: async () => ({ ok: true }),
    });
    await after.recoverAfterRestart();
    for (let i = 0; i < 50; i++) {
      const latest = await after.getRun(run.id);
      if (latest && latest.status !== "queued") {
        expect(latest.status).toBe("succeeded");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("requeued run did not settle");
  });

  it("marks a stale running run failed instead of leaving it stuck", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const service = new WorkflowService({ paseoHome: dir });
    const definition = await service.createDefinition({
      name: "stale-running",
      source: "export const meta = {};",
    });
    const store = new WorkflowStore(join(dir, "workflows"));
    await store.createRun({
      id: "wfr_stale",
      definitionId: definition.id,
      status: "running",
      args: {},
      cwd: dir,
      workspaceId: null,
      workspacePath: dir,
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      result: null,
      error: null,
    });

    await service.recoverAfterRestart();
    const recovered = await service.getRun("wfr_stale");
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toBe("Interrupted by daemon restart");
  });

  it("fails out a queued run whose definition no longer exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const store = new WorkflowStore(join(dir, "workflows"));
    await store.createRun({
      id: "wfr_orphan",
      definitionId: "wfd_missing",
      status: "queued",
      args: {},
      cwd: dir,
      workspaceId: null,
      workspacePath: dir,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      result: null,
      error: null,
    });
    const service = new WorkflowService({ paseoHome: dir });
    await service.recoverAfterRestart();
    const recovered = await service.getRun("wfr_orphan");
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toContain("wfd_missing");
  });
});

describe("WorkflowEventLog incremental cache", () => {
  it("reads entries appended between polls without re-parsing prior lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const { WorkflowEventLog } = await import("./event-log.js");
    const log = new WorkflowEventLog(join(dir, "workflows"));

    await log.append({ event: "test.inc", message: "line 0", runId: "wfr_inc" });
    const first = await log.readRunLogs("wfr_inc", { afterSeq: 0 });
    expect(first.entries.map((e) => e.message)).toEqual(["line 0"]);

    // Nothing changed on disk — must not throw, must return the same entry.
    const unchanged = await log.readRunLogs("wfr_inc", { afterSeq: 0 });
    expect(unchanged.entries.map((e) => e.message)).toEqual(["line 0"]);

    // Multiple appends between two reads — the incremental reader must pick
    // up all of them from the last consumed byte offset, not just the latest.
    await log.append({ event: "test.inc", message: "line 1", runId: "wfr_inc" });
    await log.append({ event: "test.inc", message: "line 2", runId: "wfr_inc" });
    const second = await log.readRunLogs("wfr_inc", { afterSeq: first.nextSeq });
    expect(second.entries.map((e) => e.message)).toEqual(["line 1", "line 2"]);
    expect(second.hasMore).toBe(false);
  });

  it("resets and re-reads fully when the run log file shrinks (truncated/rebuilt)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const { WorkflowEventLog } = await import("./event-log.js");
    const runDir = join(dir, "workflows", "runs", "wfr_shrink");
    await mkdir(runDir, { recursive: true });
    const eventsPath = join(runDir, "events.jsonl");
    const log = new WorkflowEventLog(join(dir, "workflows"));

    await log.append({
      event: "test.shrink",
      message: "long line before rebuild",
      runId: "wfr_shrink",
    });
    const before = await log.readRunLogs("wfr_shrink", { afterSeq: 0 });
    expect(before.entries).toHaveLength(1);

    // Simulate the file being rebuilt smaller than the cached size.
    await writeFile(
      eventsPath,
      `${JSON.stringify({ seq: 1, ts: new Date().toISOString(), level: "info", event: "rebuilt", message: "fresh" })}\n`,
      "utf8",
    );
    const after = await log.readRunLogs("wfr_shrink", { afterSeq: 0 });
    expect(after.entries.map((e) => e.event)).toEqual(["rebuilt"]);
  });

  it("returns entries in seq order even when concurrent appends landed out of order in the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const { WorkflowEventLog } = await import("./event-log.js");
    const fsPromises = await import("node:fs/promises");
    const root = join(dir, "workflows");
    const runId = "wfr_out_of_order";
    await fsPromises.mkdir(join(root, "runs", runId), { recursive: true });
    const line = (seq: number, event: string) =>
      JSON.stringify({
        seq,
        ts: "2026-07-19T00:00:00.000Z",
        level: "debug",
        event,
        message: event,
        runId,
      });
    // seq 2 (start) hit the file before seq 1 (queued) — the void-log race.
    await fsPromises.writeFile(
      join(root, "runs", runId, "events.jsonl"),
      [line(2, "agent.start"), line(1, "agent.queued"), line(3, "agent.complete"), ""].join("\n"),
    );

    const log = new WorkflowEventLog(root);
    const firstPage = await log.readRunLogs(runId, { limit: 2 });
    expect(firstPage.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(firstPage.hasMore).toBe(true);
    // Without seq-sorting, seq 1 would fall behind the page cursor and vanish.
    const secondPage = await log.readRunLogs(runId, { afterSeq: firstPage.nextSeq });
    expect(secondPage.entries.map((entry) => entry.seq)).toEqual([3]);
  });

  it("hasRunLogs is false for a missing or empty run log and true once a valid line lands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const { WorkflowEventLog } = await import("./event-log.js");
    const log = new WorkflowEventLog(join(dir, "workflows"));

    expect(await log.hasRunLogs("wfr_missing")).toBe(false);
    await log.append({ event: "test.has", message: "hi", runId: "wfr_missing" });
    expect(await log.hasRunLogs("wfr_missing")).toBe(true);
  });
});

describe("WorkflowEventLog via service", () => {
  it("records definition and run lifecycle events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const prev = process.env.PASEO_WORKFLOW_BACKEND;
    process.env.PASEO_WORKFLOW_BACKEND = "mock";
    try {
      const service = new WorkflowService({ paseoHome: dir });
      const definition = await service.createDefinition({
        name: "logged",
        source: "export const meta = { name: 'logged' };\nreturn { ok: true };\n",
      });
      const run = await service.dispatch({
        definitionId: definition.id,
        cwd: dir,
        args: { task: "noop" },
      });
      for (let i = 0; i < 50; i++) {
        const latest = await service.getRun(run.id);
        if (latest && (latest.status === "succeeded" || latest.status === "failed")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const { entries } = await service.listRunLogs(run.id);
      const events = entries.map((entry) => entry.event);
      expect(events).toContain("run.queued");
      expect(events.some((event) => event.startsWith("run."))).toBe(true);
      expect(entries.every((entry) => entry.runId === run.id)).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.PASEO_WORKFLOW_BACKEND;
      } else {
        process.env.PASEO_WORKFLOW_BACKEND = prev;
      }
    }
  });
});

describe("workflow engine progress events via service", () => {
  it("records phase, log, and callId-tagged agent start/complete entries for the progress tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const prev = process.env.PASEO_WORKFLOW_BACKEND;
    process.env.PASEO_WORKFLOW_BACKEND = "mock";
    try {
      const service = new WorkflowService({ paseoHome: dir });
      const definition = await service.createDefinition({
        name: "progress",
        source: [
          "export const meta = { name: 'progress' };",
          "phase('Scan');",
          "log('starting scan');",
          "await agent('do the thing', { label: 'scan:main' });",
          "return { ok: true };",
        ].join("\n"),
      });
      const run = await service.dispatch({
        definitionId: definition.id,
        cwd: dir,
        args: { task: "noop" },
      });
      for (let i = 0; i < 50; i++) {
        const latest = await service.getRun(run.id);
        if (latest && (latest.status === "succeeded" || latest.status === "failed")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const { entries } = await service.listRunLogs(run.id);

      const phaseEntry = entries.find((entry) => entry.event === "phase");
      expect(phaseEntry?.message).toBe("Scan");
      const logEntry = entries.find((entry) => entry.event === "log");
      expect(logEntry?.message).toBe("starting scan");
      const startEntry = entries.find((entry) => entry.event === "agent.start");
      expect(startEntry?.data).toMatchObject({
        callId: expect.any(Number),
        label: "scan:main",
        phase: "Scan",
      });
      const completeEntry = entries.find((entry) => entry.event === "agent.complete");
      expect(completeEntry?.data).toMatchObject({
        callId: startEntry?.data?.callId,
        phase: "Scan",
      });
    } finally {
      if (prev === undefined) {
        delete process.env.PASEO_WORKFLOW_BACKEND;
      } else {
        process.env.PASEO_WORKFLOW_BACKEND = prev;
      }
    }
  });

  it("carries provider/effort/mode selection onto every engine agent entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const prev = process.env.PASEO_WORKFLOW_BACKEND;
    process.env.PASEO_WORKFLOW_BACKEND = "mock";
    try {
      const service = new WorkflowService({ paseoHome: dir });
      const definition = await service.createDefinition({
        name: "selection",
        source: [
          "export const meta = { name: 'selection' };",
          "await agent('x', { label: 'sel', provider: 'codex', effort: 'high', mode: 'plan' });",
          "return { ok: true };",
        ].join("\n"),
      });
      const run = await service.dispatch({
        definitionId: definition.id,
        cwd: dir,
        args: { task: "noop" },
      });
      await waitForRunToSettle(service, run.id);
      const { entries } = await service.listRunLogs(run.id);

      for (const event of ["agent.queued", "agent.start", "agent.complete"]) {
        const entry = entries.find((candidate) => candidate.event === event);
        expect(entry?.data, `${event} entry`).toMatchObject({
          provider: "codex",
          effort: "high",
          mode: "plan",
        });
      }
    } finally {
      if (prev === undefined) {
        delete process.env.PASEO_WORKFLOW_BACKEND;
      } else {
        process.env.PASEO_WORKFLOW_BACKEND = prev;
      }
    }
  });

  it("tags host agent.done with the engine callId and the provider's whole usage record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const prev = process.env.PASEO_WORKFLOW_BACKEND;
    delete process.env.PASEO_WORKFLOW_BACKEND;
    const usage = {
      inputTokens: 120,
      cachedInputTokens: 30,
      outputTokens: 9,
      totalCostUsd: 0.02,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 4_096,
    };
    const seenCallIds: Array<number | undefined> = [];
    const seenLabels: Array<Record<string, string> | undefined> = [];
    try {
      const service = new WorkflowService({
        paseoHome: dir,
        ensureAgentWorkspace: async () => "wks_test",
        agentHost: {
          runAgent: async (request) => {
            seenCallIds.push(request.callId);
            seenLabels.push(request.labels);
            return { text: "done", agentId: "agent_1", usage };
          },
        },
      });
      const definition = await service.createDefinition({
        name: "host-usage",
        source: [
          "export const meta = { name: 'host-usage' };",
          "await agent('x', { label: 'host:main' });",
          "return { ok: true };",
        ].join("\n"),
      });
      const run = await service.dispatch({
        definitionId: definition.id,
        cwd: dir,
        args: { task: "noop", provider: "claude" },
      });
      await waitForRunToSettle(service, run.id);
      const { entries } = await service.listRunLogs(run.id);

      const startEntry = entries.find((entry) => entry.event === "agent.start");
      const doneEntry = entries.find((entry) => entry.event === "agent.done");
      // Pin the id to a real number first: comparing two undefineds would pass
      // vacuously if callId never threaded through at all.
      expect(startEntry?.data?.callId).toEqual(expect.any(Number));
      expect(seenCallIds).toEqual([startEntry?.data?.callId]);
      // The same pairing as a label, so clients can resolve a call to its
      // agent while the call is still running (agent.done lands only at the end).
      expect(seenLabels[0]).toMatchObject({
        [WORKFLOW_CALL_ID_LABEL]: String(startEntry?.data?.callId),
        [WORKFLOW_RUN_ID_LABEL]: run.id,
        [WORKFLOW_RUN_WORKSPACE_LABEL]: "wks_test",
      });
      expect(doneEntry?.data).toMatchObject({
        callId: startEntry?.data?.callId,
        agentId: "agent_1",
        usage,
      });
      // The engine's own complete event carries the same usage independently.
      const completeEntry = entries.find((entry) => entry.event === "agent.complete");
      expect(completeEntry?.data?.usage).toEqual(usage);
    } finally {
      if (prev === undefined) {
        delete process.env.PASEO_WORKFLOW_BACKEND;
      } else {
        process.env.PASEO_WORKFLOW_BACKEND = prev;
      }
    }
  });
});

describe("workflow run resume", () => {
  it("replays successful agent calls from the prior run's journal and re-runs the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const prev = process.env.PASEO_WORKFLOW_BACKEND;
    process.env.PASEO_WORKFLOW_BACKEND = "mock";
    try {
      const service = new WorkflowService({ paseoHome: dir });
      const definition = await service.createDefinition({
        name: "resumable",
        source: [
          "export const meta = { name: 'resumable' };",
          "await agent('step one', { label: 'one' });",
          "if (args && typeof args === 'object' && args.fail) {",
          "  throw new Error('boom after step one');",
          "}",
          "await agent('step two', { label: 'two' });",
          "return { ok: true };",
        ].join("\n"),
      });
      const waitForTerminal = async (runId: string) => {
        for (let i = 0; i < 50; i++) {
          const latest = await service.getRun(runId);
          if (latest && (latest.status === "succeeded" || latest.status === "failed")) {
            return latest;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("run did not finish");
      };

      const first = await service.dispatch({
        definitionId: definition.id,
        cwd: dir,
        args: { task: "noop", fail: true },
      });
      const firstFinal = await waitForTerminal(first.id);
      expect(firstFinal.status).toBe("failed");

      // Resume with args that no longer trip the failure branch.
      const resumed = await service.dispatch({
        definitionId: definition.id,
        resumeFromRunId: first.id,
        args: { task: "noop" },
      });
      const resumedFinal = await waitForTerminal(resumed.id);
      expect(resumedFinal.status).toBe("succeeded");
      // cwd inherited from the prior run.
      expect(resumedFinal.cwd).toBe(firstFinal.cwd);

      const { entries } = await service.listRunLogs(resumed.id);
      const resumedEvent = entries.find((entry) => entry.event === "run.resumed");
      expect(resumedEvent?.data).toMatchObject({ resumeFromRunId: first.id });
      // "step one" replays from the journal (cached), "step two" runs live.
      const starts = entries.filter((entry) => entry.event === "agent.start");
      expect(starts.map((entry) => [entry.data?.label, entry.data?.cached])).toEqual([
        ["one", true],
        ["two", false],
      ]);
    } finally {
      if (prev === undefined) {
        delete process.env.PASEO_WORKFLOW_BACKEND;
      } else {
        process.env.PASEO_WORKFLOW_BACKEND = prev;
      }
    }
  });

  it("rejects resuming across definitions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const prev = process.env.PASEO_WORKFLOW_BACKEND;
    process.env.PASEO_WORKFLOW_BACKEND = "mock";
    try {
      const service = new WorkflowService({ paseoHome: dir });
      const a = await service.createDefinition({
        name: "def-a",
        source: "export const meta = { name: 'def-a' };\nreturn { ok: true };\n",
      });
      const b = await service.createDefinition({
        name: "def-b",
        source: "export const meta = { name: 'def-b' };\nreturn { ok: true };\n",
      });
      const run = await service.dispatch({ definitionId: a.id, cwd: dir, args: { task: "x" } });
      await expect(
        service.dispatch({ definitionId: b.id, resumeFromRunId: run.id }),
      ).rejects.toThrow("Cannot resume");
      await expect(
        service.dispatch({ definitionId: a.id, resumeFromRunId: "wfr_missing" }),
      ).rejects.toThrow("Cannot resume: workflow run not found");
      // Let the dispatched run settle before the temp dir is removed.
      for (let i = 0; i < 50; i++) {
        const latest = await service.getRun(run.id);
        if (latest && latest.status !== "queued" && latest.status !== "running") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      if (prev === undefined) {
        delete process.env.PASEO_WORKFLOW_BACKEND;
      } else {
        process.env.PASEO_WORKFLOW_BACKEND = prev;
      }
    }
  });
});

describe("extractWorkflowResultError", () => {
  it("reads nested engine result errors", () => {
    expect(
      extractWorkflowResultError({
        result: { error: "No task provided. Pass the task description as args." },
      }),
    ).toBe("No task provided. Pass the task description as args.");
    expect(extractWorkflowResultError({ result: { ok: true } })).toBeNull();
  });
});

describe("mergeWorkflowError", () => {
  it("annotates generic skip errors with the last host/backend error", () => {
    expect(mergeWorkflowError("Plan draft skipped.", ["Provider 'claude' is disabled"])).toBe(
      "Plan draft skipped. — Provider 'claude' is disabled",
    );
  });

  it("returns the host error alone when the script had none", () => {
    expect(mergeWorkflowError(null, ["boom"])).toBe("boom");
  });
});

describe("buildWorkflowEngineArgs", () => {
  it("passes a bare task string for UI-style { task, provider, model } dispatch", () => {
    expect(
      buildWorkflowEngineArgs({
        args: { task: "fix login", provider: "cursor", model: "grok-4.5" },
        workspacePath: "/tmp/run",
        runId: "wfr_1",
      }),
    ).toBe("fix login");
  });

  it("treats effort/mode/fast as host defaults (still a bare task string)", () => {
    expect(
      buildWorkflowEngineArgs({
        args: {
          task: "fix login",
          provider: "claude",
          model: "opus",
          effort: "high",
          mode: "agent",
          fast: true,
        },
        workspacePath: "/tmp/run",
        runId: "wfr_1",
      }),
    ).toBe("fix login");
  });

  it("keeps structured payloads (e.g. kanban card fields) as an object", () => {
    expect(
      buildWorkflowEngineArgs({
        args: {
          task: "fix login",
          cardId: "card_1",
          title: "Fix login",
          provider: "claude",
        },
        workspacePath: "/tmp/run",
        runId: "wfr_1",
      }),
    ).toEqual({
      task: "fix login",
      cardId: "card_1",
      title: "Fix login",
      provider: "claude",
      runtimeDir: "/tmp/run",
      key: "wfr_1",
    });
  });

  it("falls back to prompt when task is absent", () => {
    expect(
      buildWorkflowEngineArgs({
        args: { prompt: "research X" },
        workspacePath: "/tmp/run",
        runId: "wfr_1",
      }),
    ).toBe("research X");
  });
});

describe("WorkflowQueue", () => {
  it("keeps the second run queued until the first finishes", async () => {
    const queue = new WorkflowQueue({ maxConcurrency: 1 });
    let releaseFirst: (() => void) | undefined;
    const first = queue.enqueue(
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve("first");
        }),
    );
    await Promise.resolve();
    const second = queue.enqueue(async () => "second");
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(1);
    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });
});

describe("matchesKanbanWorkflowRule", () => {
  it("requires every configured filter to match", () => {
    const card = {
      id: "card",
      title: "Fix login",
      url: null,
      status: "pending" as const,
      columnId: "todo",
      theme: "jira",
      source: { kind: "jira" as const, externalId: "AUTH-1", issueKey: "AUTH-1", project: "AUTH" },
      externalId: "AUTH-1",
      order: 0,
      statusPinnedByUser: false,
      labels: ["bug"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const rule = {
      id: "rule",
      sourceId: "source",
      enabled: true,
      workflowDefinitionId: "definition",
      filter: { labelsAny: ["bug"], titleRegex: "^Fix", projectKey: "AUTH" },
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    };
    expect(matchesKanbanWorkflowRule(rule, card, "source")).toBe(true);
    expect(matchesKanbanWorkflowRule(rule, card, "other")).toBe(false);
  });
});

describe("KanbanStore source upsert", () => {
  it("reports whether a source card was newly created", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-kanban-"));
    dirs.push(dir);
    const store = new KanbanStore(dir);
    const source = { kind: "jira" as const, externalId: "AUTH-1", issueKey: "AUTH-1" };
    const payload = {
      title: "Fix login",
      url: null,
      status: "pending" as const,
      columnId: "todo",
      theme: "jira",
    };
    expect((await store.upsertCardBySource(source, payload)).created).toBe(true);
    expect((await store.upsertCardBySource(source, payload)).created).toBe(false);
  });
});

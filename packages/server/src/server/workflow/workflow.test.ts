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

const dirs: string[] = [];

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

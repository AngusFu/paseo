import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowQueue } from "./queue.js";
import { WorkflowStore } from "./store.js";
import { matchesKanbanWorkflowRule, WorkflowService } from "./service.js";
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

  it("prepares the authoring workspace under paseo home", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
    dirs.push(dir);
    const service = new WorkflowService({ paseoHome: dir });
    const prepared = await service.prepareAuthoring();
    expect(prepared.cwd).toBe(join(dir, "workflows"));
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

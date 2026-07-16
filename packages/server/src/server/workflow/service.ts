import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createEngine,
  Journal,
  listWorkflows,
  MockBackend,
  PaseoBackend,
} from "@getpaseo/agents-workflow";
import {
  WorkflowDefinitionSchema,
  type CreateKanbanWorkflowRuleInput,
  type CreateWorkflowDefinitionInput,
  type DispatchWorkflowRunInput,
  type KanbanWorkflowRule,
  type UpdateKanbanWorkflowRuleInput,
  type UpdateWorkflowDefinitionInput,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@getpaseo/protocol/workflow/types";
import type { StoredKanbanCard } from "@getpaseo/protocol/kanban/types";
import { WorkflowQueue } from "./queue.js";
import { WorkflowStore } from "./store.js";

const AUTHORING_README = `# Paseo workflows

Author \`*.flow.js\` definitions under \`definitions/\`.

Use the \`paseo-create-workflow\` skill (or ask the agent in this workspace) to
create or edit workflow scripts. Built-in templates live in the
\`@getpaseo/agents-workflow\` package and can be copied into \`definitions/\`.
`;

export function matchesKanbanWorkflowRule(
  rule: KanbanWorkflowRule,
  card: StoredKanbanCard,
  sourceId: string,
): boolean {
  if (!rule.enabled || rule.sourceId !== sourceId) {
    return false;
  }
  const { labelsAny, titleRegex, projectKey } = rule.filter;
  if (labelsAny && !labelsAny.some((label) => card.labels?.includes(label))) {
    return false;
  }
  if (titleRegex && !new RegExp(titleRegex).test(card.title)) {
    return false;
  }
  if (projectKey && card.source.kind === "jira" && card.source.project !== projectKey) {
    return false;
  }
  if (projectKey && card.source.kind !== "jira") {
    return false;
  }
  return true;
}

export interface WorkflowServiceOptions {
  paseoHome: string;
  maxConcurrency?: number;
  runner?: (definition: WorkflowDefinition, run: WorkflowRun) => Promise<unknown>;
}

export class WorkflowService {
  private readonly store: WorkflowStore;
  private readonly queue: WorkflowQueue;
  private readonly paseoHome: string;
  private readonly runner: (definition: WorkflowDefinition, run: WorkflowRun) => Promise<unknown>;

  constructor(options: WorkflowServiceOptions) {
    this.paseoHome = options.paseoHome;
    this.store = new WorkflowStore(join(options.paseoHome, "workflows"));
    this.queue = new WorkflowQueue({ maxConcurrency: options.maxConcurrency });
    this.runner = options.runner ?? ((definition, run) => this.runEngine(definition, run));
  }

  async listDefinitions(): Promise<WorkflowDefinition[]> {
    return this.store.listDefinitions();
  }

  async listBuiltins(): Promise<WorkflowDefinition[]> {
    const now = new Date().toISOString();
    return listWorkflows()
      .filter((workflow) => workflow.origin === "builtin")
      .map((workflow) =>
        WorkflowDefinitionSchema.parse({
          id: `builtin:${workflow.name}`,
          name: workflow.name,
          description:
            typeof workflow.meta.description === "string" ? workflow.meta.description : null,
          source: workflow.source,
          builtin: true,
          createdAt: now,
          updatedAt: now,
        }),
      );
  }

  /** Ensure `$PASEO_HOME/workflows` exists for agent-authored `*.flow.js` definitions. */
  async prepareAuthoring(): Promise<{ cwd: string }> {
    const cwd = join(this.paseoHome, "workflows");
    await mkdir(join(cwd, "definitions"), { recursive: true });
    const readmePath = join(cwd, "README.md");
    try {
      await access(readmePath);
    } catch {
      await writeFile(readmePath, AUTHORING_README, "utf8");
    }
    return { cwd };
  }

  async getDefinition(id: string): Promise<WorkflowDefinition | null> {
    return this.store.getDefinition(id);
  }

  async createDefinition(input: CreateWorkflowDefinitionInput): Promise<WorkflowDefinition> {
    return this.store.createDefinition(input);
  }

  async updateDefinition(input: UpdateWorkflowDefinitionInput): Promise<WorkflowDefinition | null> {
    return this.store.updateDefinition(input);
  }

  async deleteDefinition(id: string): Promise<boolean> {
    return this.store.deleteDefinition(id);
  }

  async listRuns(): Promise<WorkflowRun[]> {
    return this.store.listRuns();
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    return this.store.getRun(id);
  }

  async dispatch(input: DispatchWorkflowRunInput): Promise<WorkflowRun> {
    const definition = await this.store.getDefinition(input.definitionId);
    if (!definition) {
      throw new Error(`Workflow definition not found: ${input.definitionId}`);
    }
    const id = `wfr_${randomUUID()}`;
    const runDir = join(this.paseoHome, "workflows", "runs", id);
    await mkdir(runDir, { recursive: true });
    const run: WorkflowRun = {
      id,
      definitionId: definition.id,
      status: "queued",
      args: input.args ?? {},
      cwd: input.cwd ?? runDir,
      workspaceId: null,
      workspacePath: runDir,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      result: null,
      error: null,
    };
    await this.store.createRun(run);
    void this.queue.enqueue(() => this.execute(definition, run));
    return run;
  }

  async cancel(id: string): Promise<WorkflowRun | null> {
    return this.store.updateRun(id, (run) => {
      if (run.status !== "queued") {
        return run;
      }
      return { ...run, status: "cancelled", endedAt: new Date().toISOString() };
    });
  }

  async listRules(): Promise<KanbanWorkflowRule[]> {
    return this.store.listRules();
  }

  async createRule(input: CreateKanbanWorkflowRuleInput): Promise<KanbanWorkflowRule> {
    return this.store.createRule(input);
  }

  async updateRule(input: UpdateKanbanWorkflowRuleInput): Promise<KanbanWorkflowRule | null> {
    return this.store.updateRule(input);
  }

  async deleteRule(id: string): Promise<boolean> {
    return this.store.deleteRule(id);
  }

  async enqueueForNewKanbanCard(
    card: StoredKanbanCard,
    sourceId: string,
    cwd?: string,
  ): Promise<void> {
    const rules = await this.store.listRules();
    for (const rule of rules) {
      if (!matchesKanbanWorkflowRule(rule, card, sourceId)) {
        continue;
      }
      await this.dispatch({
        definitionId: rule.workflowDefinitionId,
        cwd,
        args: {
          cardId: card.id,
          title: card.title,
          url: card.url,
          externalId: card.externalId,
          labels: card.labels ?? [],
          metadata: card.metadata ?? {},
        },
      });
    }
  }

  private async execute(definition: WorkflowDefinition, initial: WorkflowRun): Promise<void> {
    const run = await this.store.updateRun(initial.id, (current) => {
      if (current.status === "cancelled") {
        return current;
      }
      return { ...current, status: "running", startedAt: new Date().toISOString() };
    });
    if (!run || run.status === "cancelled") {
      return;
    }
    try {
      const result = await this.runner(definition, run);
      await this.store.updateRun(run.id, (current) => ({
        ...current,
        status: "succeeded",
        endedAt: new Date().toISOString(),
        result,
      }));
    } catch (error) {
      await this.store.updateRun(run.id, (current) => ({
        ...current,
        status: "failed",
        endedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async runEngine(definition: WorkflowDefinition, run: WorkflowRun): Promise<unknown> {
    const backend =
      process.env.PASEO_WORKFLOW_BACKEND === "mock"
        ? new MockBackend()
        : new PaseoBackend({ cwd: run.cwd });
    const journal = new Journal({ path: join(run.workspacePath, "journal.jsonl") });
    const engine = createEngine({ backend, journal });
    try {
      return await engine.run(definition.source, {
        args: { ...run.args, runtimeDir: run.workspacePath, key: run.id },
      });
    } finally {
      await engine.dispose();
    }
  }
}

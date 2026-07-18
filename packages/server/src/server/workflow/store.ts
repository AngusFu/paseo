import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  KanbanWorkflowRuleSchema,
  WorkflowDefinitionSchema,
  WorkflowRunSchema,
  type CreateKanbanWorkflowRuleInput,
  type CreateWorkflowDefinitionInput,
  type KanbanWorkflowRule,
  type UpdateKanbanWorkflowRuleInput,
  type UpdateWorkflowDefinitionInput,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@getpaseo/protocol/workflow/types";
import { writeFileAtomic, writeJsonFileAtomic } from "../atomic-file.js";

export class WorkflowStore {
  constructor(private readonly dir: string) {}

  private get definitionsDir(): string {
    return join(this.dir, "definitions");
  }

  private get runsDir(): string {
    return join(this.dir, "runs");
  }

  private get rulesPath(): string {
    // Rules are colocated with workflow state, not kanban, because they select workflow dispatch.
    return join(this.dir, "rules.json");
  }

  async listDefinitions(): Promise<WorkflowDefinition[]> {
    const { readdir } = await import("node:fs/promises");
    await mkdir(this.definitionsDir, { recursive: true });
    const entries = await readdir(this.definitionsDir);
    const definitions = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.readDefinition(entry.slice(0, -5))),
    );
    return definitions
      .filter((definition): definition is WorkflowDefinition => definition !== null)
      .sort((left, right) =>
        // readdir order is filesystem-dependent (effectively random to the
        // user) — present a stable, scannable case-insensitive name order.
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );
  }

  async getDefinition(id: string): Promise<WorkflowDefinition | null> {
    return this.readDefinition(id);
  }

  async createDefinition(input: CreateWorkflowDefinitionInput): Promise<WorkflowDefinition> {
    const now = new Date().toISOString();
    const definition = WorkflowDefinitionSchema.parse({
      id: input.id ?? `wfd_${randomUUID()}`,
      name: input.name,
      description: input.description ?? null,
      source: input.source,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });
    await this.writeDefinition(definition);
    return definition;
  }

  async updateDefinition(input: UpdateWorkflowDefinitionInput): Promise<WorkflowDefinition | null> {
    const current = await this.getDefinition(input.id);
    if (!current || current.builtin) {
      return null;
    }
    const definition = WorkflowDefinitionSchema.parse({
      ...current,
      name: input.name ?? current.name,
      description: input.description === undefined ? current.description : input.description,
      source: input.source ?? current.source,
      updatedAt: new Date().toISOString(),
    });
    await this.writeDefinition(definition);
    return definition;
  }

  async deleteDefinition(id: string): Promise<boolean> {
    const definition = await this.getDefinition(id);
    if (!definition || definition.builtin) {
      return false;
    }
    await rm(join(this.definitionsDir, `${id}.json`), { force: true });
    await rm(join(this.definitionsDir, `${id}.flow.js`), { force: true });
    return true;
  }

  async createRun(run: WorkflowRun): Promise<WorkflowRun> {
    await mkdir(this.runsDir, { recursive: true });
    const parsed = WorkflowRunSchema.parse(run);
    await writeJsonFileAtomic(join(this.runsDir, `${run.id}.json`), parsed);
    return parsed;
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    try {
      return WorkflowRunSchema.parse(
        JSON.parse(await readFile(join(this.runsDir, `${id}.json`), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async listRuns(): Promise<WorkflowRun[]> {
    const { readdir } = await import("node:fs/promises");
    await mkdir(this.runsDir, { recursive: true });
    const entries = await readdir(this.runsDir);
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.getRun(entry.slice(0, -5))),
    );
    return runs
      .filter((run): run is WorkflowRun => run !== null)
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
  }

  async updateRun(
    id: string,
    update: (run: WorkflowRun) => WorkflowRun,
  ): Promise<WorkflowRun | null> {
    const current = await this.getRun(id);
    if (!current) {
      return null;
    }
    return this.createRun(update(current));
  }

  async listRules(): Promise<KanbanWorkflowRule[]> {
    try {
      const content = await readFile(this.rulesPath, "utf8");
      return (JSON.parse(content) as unknown[]).map((rule) => KanbanWorkflowRuleSchema.parse(rule));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async createRule(input: CreateKanbanWorkflowRuleInput): Promise<KanbanWorkflowRule> {
    const rules = await this.listRules();
    const now = new Date().toISOString();
    const rule = KanbanWorkflowRuleSchema.parse({
      id: `wkr_${randomUUID()}`,
      sourceId: input.sourceId,
      enabled: input.enabled ?? true,
      workflowDefinitionId: input.workflowDefinitionId,
      filter: input.filter ?? {},
      createdAt: now,
      updatedAt: now,
    });
    await this.writeRules([...rules, rule]);
    return rule;
  }

  async updateRule(input: UpdateKanbanWorkflowRuleInput): Promise<KanbanWorkflowRule | null> {
    const rules = await this.listRules();
    const index = rules.findIndex((rule) => rule.id === input.id);
    if (index === -1) {
      return null;
    }
    const current = rules[index];
    const updated = KanbanWorkflowRuleSchema.parse({
      ...current,
      enabled: input.enabled ?? current.enabled,
      workflowDefinitionId: input.workflowDefinitionId ?? current.workflowDefinitionId,
      filter: input.filter ?? current.filter,
      updatedAt: new Date().toISOString(),
    });
    rules[index] = updated;
    await this.writeRules(rules);
    return updated;
  }

  async deleteRule(id: string): Promise<boolean> {
    const rules = await this.listRules();
    const updated = rules.filter((rule) => rule.id !== id);
    if (updated.length === rules.length) {
      return false;
    }
    await this.writeRules(updated);
    return true;
  }

  private async readDefinition(id: string): Promise<WorkflowDefinition | null> {
    try {
      const metadata = JSON.parse(
        await readFile(join(this.definitionsDir, `${id}.json`), "utf8"),
      ) as object;
      const source = await readFile(join(this.definitionsDir, `${id}.flow.js`), "utf8");
      return WorkflowDefinitionSchema.parse({ ...metadata, source });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeDefinition(definition: WorkflowDefinition): Promise<void> {
    await mkdir(this.definitionsDir, { recursive: true });
    const { source, ...metadata } = definition;
    await writeJsonFileAtomic(join(this.definitionsDir, `${definition.id}.json`), metadata);
    await writeFileAtomic(join(this.definitionsDir, `${definition.id}.flow.js`), source);
  }

  private async writeRules(rules: KanbanWorkflowRule[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJsonFileAtomic(this.rulesPath, rules);
  }
}

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  StoredInboxQuestionSchema,
  type InboxQuestionItem,
  type InboxQuestionSource,
  type InboxQuestionStatus,
  type StoredInboxQuestion,
} from "@getpaseo/protocol/question/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

function generateQuestionId(): string {
  return `qst_${randomBytes(4).toString("hex")}`;
}

function normalizeQuestions(questions: unknown[]): InboxQuestionItem[] {
  return questions.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Inbox question item must be an object");
    }
    const record = item as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const header = typeof record.header === "string" ? record.header.trim() : "";
    if (!question || !header) {
      throw new Error("Inbox question item requires non-empty question and header");
    }
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return [];
          }
          const optionRecord = option as Record<string, unknown>;
          const label = typeof optionRecord.label === "string" ? optionRecord.label.trim() : "";
          if (!label) {
            return [];
          }
          return [
            {
              label,
              ...(typeof optionRecord.description === "string"
                ? { description: optionRecord.description }
                : {}),
            },
          ];
        })
      : undefined;
    return {
      question,
      header,
      ...(options ? { options } : {}),
      ...(typeof record.multiSelect === "boolean" ? { multiSelect: record.multiSelect } : {}),
      ...(typeof record.allowOther === "boolean" ? { allowOther: record.allowOther } : {}),
      ...(typeof record.allowEmpty === "boolean" ? { allowEmpty: record.allowEmpty } : {}),
      ...(typeof record.placeholder === "string" ? { placeholder: record.placeholder } : {}),
    };
  });
}

export interface CreateInboxQuestionInput {
  agentId: string;
  workspaceId?: string;
  title?: string;
  questions: unknown[];
  source: InboxQuestionSource;
  mcpRequestId?: string;
  expiresAt?: string;
  createdAt?: string;
  id?: string;
}

export interface ListInboxQuestionsFilter {
  status?: InboxQuestionStatus;
  agentId?: string;
}

export class QuestionStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async serializeMutation<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.mutations.set(id, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(id) === next) {
        this.mutations.delete(id);
      }
    }
  }

  async list(filter: ListInboxQuestionsFilter = {}): Promise<StoredInboxQuestion[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const questions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = await readFile(join(this.dir, entry.name), "utf-8");
          return StoredInboxQuestionSchema.parse(JSON.parse(content));
        }),
    );
    return questions
      .filter((question) => (filter.status ? question.status === filter.status : true))
      .filter((question) => (filter.agentId ? question.agentId === filter.agentId : true))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredInboxQuestion | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return StoredInboxQuestionSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async create(input: CreateInboxQuestionInput): Promise<StoredInboxQuestion> {
    const created = StoredInboxQuestionSchema.parse({
      id: input.id ?? generateQuestionId(),
      agentId: input.agentId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      status: "pending" as const,
      ...(input.title ? { title: input.title } : {}),
      questions: normalizeQuestions(input.questions),
      source: input.source,
      ...(input.mcpRequestId ? { mcpRequestId: input.mcpRequestId } : {}),
    });
    await this.write(created);
    return created;
  }

  async update(
    id: string,
    updater: (current: StoredInboxQuestion) => StoredInboxQuestion | Promise<StoredInboxQuestion>,
  ): Promise<StoredInboxQuestion | null> {
    return this.serializeMutation(id, async () => {
      const current = await this.get(id);
      if (!current) {
        return null;
      }
      const next = StoredInboxQuestionSchema.parse(await updater(current));
      await this.write(next);
      return next;
    });
  }

  async markAnswered(
    id: string,
    answers: Record<string, string>,
  ): Promise<StoredInboxQuestion | null> {
    return this.update(id, (current) => ({
      ...current,
      status: "answered",
      answers,
    }));
  }

  async markDismissed(id: string): Promise<StoredInboxQuestion | null> {
    return this.update(id, (current) => {
      const { answers: _answers, ...rest } = current;
      return {
        ...rest,
        status: "dismissed",
      };
    });
  }

  private async write(question: StoredInboxQuestion): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(question.id), question);
  }
}

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  StoredInboxQuestionSchema,
  type InboxQuestionItem,
  type InboxQuestionSource,
  type InboxQuestionStatus,
  type StoredInboxQuestion,
} from "@getpaseo/protocol/question/types";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { paginateSortedList, type ListPageRequest } from "../pagination/list-page.js";
import { SortablePager } from "../pagination/sortable-pager.js";
import { isInboxQuestionClosedPastRetention, isInboxQuestionPastExpiry } from "./ttl.js";

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
  statuses?: InboxQuestionStatus[];
  agentId?: string;
}

const QUESTION_LIST_SORT = [{ key: "created_at", direction: "desc" }] as const;
const questionListPager = new SortablePager<StoredInboxQuestion, "created_at">({
  validKeys: ["created_at"],
  defaultSort: QUESTION_LIST_SORT,
  label: "question_list",
  getId: (question) => question.id,
  getSortValue: (question, key) => (key === "created_at" ? question.createdAt : null),
});

function matchesInboxQuestionFilter(
  question: StoredInboxQuestion,
  filter: ListInboxQuestionsFilter,
): boolean {
  if (filter.statuses?.length) {
    if (!filter.statuses.includes(question.status)) {
      return false;
    }
  } else if (filter.status && question.status !== filter.status) {
    return false;
  }
  if (filter.agentId && question.agentId !== filter.agentId) {
    return false;
  }
  return true;
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
    const page = await this.listPage(filter);
    return page.questions;
  }

  async listPage(
    filter: ListInboxQuestionsFilter = {},
    page?: ListPageRequest,
  ): Promise<{
    questions: StoredInboxQuestion[];
    pageInfo?: { nextCursor: string | null; hasMore: boolean };
  }> {
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
    const filtered = questions.filter((question) => matchesInboxQuestionFilter(question, filter));
    const paged = paginateSortedList(filtered, questionListPager, QUESTION_LIST_SORT, page);
    return {
      questions: paged.items,
      ...(paged.pageInfo ? { pageInfo: paged.pageInfo } : {}),
    };
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
      if (current.status !== "pending") {
        return current;
      }
      const { answers: _answers, ...rest } = current;
      return {
        ...rest,
        status: "dismissed",
        closedAt: new Date().toISOString(),
      };
    });
  }

  async markExpired(id: string): Promise<StoredInboxQuestion | null> {
    return this.update(id, (current) => {
      if (current.status !== "pending") {
        return current;
      }
      const { answers: _answers, ...rest } = current;
      return {
        ...rest,
        status: "expired",
        closedAt: new Date().toISOString(),
      };
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.serializeMutation(id, async () => {
      try {
        await unlink(this.filePath(id));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    });
  }

  /**
   * Flip pending rows past `expiresAt` to `expired`. Returns newly expired rows.
   */
  async expireDuePending(nowMs: number = Date.now()): Promise<StoredInboxQuestion[]> {
    const pending = await this.list({ status: "pending" });
    const expired: StoredInboxQuestion[] = [];
    for (const question of pending) {
      if (!isInboxQuestionPastExpiry(question, nowMs)) {
        continue;
      }
      const marked = await this.markExpired(question.id);
      if (marked?.status === "expired") {
        expired.push(marked);
      }
    }
    return expired;
  }

  /**
   * Hard-delete dismissed/expired rows past Closed retention. Returns deleted ids.
   */
  async pruneClosedPastRetention(nowMs: number = Date.now()): Promise<string[]> {
    const closed = (await this.list()).filter(
      (question) => question.status === "dismissed" || question.status === "expired",
    );
    const deleted: string[] = [];
    for (const question of closed) {
      if (!isInboxQuestionClosedPastRetention(question, nowMs)) {
        continue;
      }
      if (await this.delete(question.id)) {
        deleted.push(question.id);
      }
    }
    return deleted;
  }

  private async write(question: StoredInboxQuestion): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(question.id), question);
  }
}

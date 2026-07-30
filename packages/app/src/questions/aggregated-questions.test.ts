import type { StoredInboxQuestion } from "@getpaseo/protocol/question/types";
import { describe, expect, it } from "vitest";
import {
  fetchAggregatedQuestionsPage,
  type QuestionRuntime,
  type QuestionRuntimeSnapshot,
} from "./aggregated-questions";

function makeQuestion(overrides: Partial<StoredInboxQuestion> = {}): StoredInboxQuestion {
  return {
    id: "qst_1",
    agentId: "agent-1",
    createdAt: "2026-07-25T00:00:00.000Z",
    status: "pending",
    questions: [
      {
        question: "Ship it?",
        header: "Ship",
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ],
    source: "mcp",
    ...overrides,
  };
}

function makeRuntime(input: {
  snapshots: Record<string, QuestionRuntimeSnapshot | null>;
  questions?: Record<string, StoredInboxQuestion[]>;
  pageInfo?: Record<string, { nextCursor: string | null; hasMore: boolean }>;
}): QuestionRuntime {
  return {
    getSnapshot: (serverId) => input.snapshots[serverId] ?? null,
    getClient: (serverId) => {
      const questions = input.questions?.[serverId];
      if (!questions) {
        return null;
      }
      return {
        questionList: async () => ({
          requestId: "test-request",
          questions,
          pageInfo: input.pageInfo?.[serverId] ?? { nextCursor: null, hasMore: false },
          error: null,
        }),
      };
    },
  };
}

describe("fetchAggregatedQuestionsPage load state", () => {
  it("does not report loaded empty while known hosts are still connecting", async () => {
    const result = await fetchAggregatedQuestionsPage({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "connecting" },
          "host-b": { connectionStatus: "connecting" },
        },
      }),
      bucket: "pending",
      cursorByServerId: null,
    });

    expect(result.status).not.toBe("loaded");
    expect(result).toEqual({ status: "connecting" });
  });

  it("reports loaded empty after all reachable hosts answer with no questions", async () => {
    const result = await fetchAggregatedQuestionsPage({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "online" },
        },
        questions: {
          "host-a": [],
          "host-b": [],
        },
      }),
      bucket: "pending",
      cursorByServerId: null,
    });

    expect(result).toEqual({
      status: "loaded",
      data: [],
      hostErrors: [],
      pageInfoByServerId: {
        "host-a": { nextCursor: null, hasMore: false },
        "host-b": { nextCursor: null, hasMore: false },
      },
    });
  });

  it("merges questions from multiple hosts newest-first", async () => {
    const result = await fetchAggregatedQuestionsPage({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "online" },
        },
        questions: {
          "host-a": [makeQuestion({ id: "qst_a", createdAt: "2026-07-26T00:00:00.000Z" })],
          "host-b": [makeQuestion({ id: "qst_b", createdAt: "2026-07-27T00:00:00.000Z" })],
        },
      }),
      bucket: "pending",
      cursorByServerId: null,
    });

    if (result.status !== "loaded") {
      throw new Error("expected loaded state");
    }
    expect(result.data.map((question) => question.id)).toEqual(["qst_b", "qst_a"]);
  });
});

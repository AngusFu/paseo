import type { StoredInboxQuestion } from "@getpaseo/protocol/question/types";
import { describe, expect, it } from "vitest";
import {
  fetchAggregatedQuestions,
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
}): QuestionRuntime {
  return {
    getSnapshot: (serverId) => input.snapshots[serverId] ?? null,
    getClient: (serverId) => {
      const questions = input.questions?.[serverId];
      if (!questions) {
        return null;
      }
      return {
        questionList: async () => ({ requestId: "test-request", questions, error: null }),
      };
    },
  };
}

describe("fetchAggregatedQuestions load state", () => {
  it("does not report loaded empty while known hosts are still connecting", async () => {
    const result = await fetchAggregatedQuestions({
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
    });

    expect(result.status).not.toBe("loaded");
    expect(result).toEqual({ status: "connecting" });
  });

  it("reports loaded empty after all reachable hosts answer with no questions", async () => {
    const result = await fetchAggregatedQuestions({
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
    });

    expect(result).toEqual({ status: "loaded", data: [], hostErrors: [] });
  });

  it("merges questions from online hosts and tags server metadata", async () => {
    const result = await fetchAggregatedQuestions({
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
          "host-a": [makeQuestion({ id: "qst_a", createdAt: "2026-07-25T01:00:00.000Z" })],
          "host-b": [makeQuestion({ id: "qst_b", createdAt: "2026-07-25T00:00:00.000Z" })],
        },
      }),
    });

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") {
      return;
    }
    expect(result.data.map((question) => question.id)).toEqual(["qst_b", "qst_a"]);
    expect(result.data[0]?.serverName).toBe("Host B");
    expect(result.data[1]?.serverId).toBe("host-a");
  });
});

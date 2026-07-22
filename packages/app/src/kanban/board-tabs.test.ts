import { describe, expect, it } from "vitest";
import type { StoredKanbanCard, StoredKanbanSource } from "@getpaseo/protocol/kanban/types";
import { buildKanbanBoardTabs, selectCardsForSource, selectKanbanTabCards } from "./board-tabs";

function source(id: string, kind: "jira" | "gitlab", name: string): StoredKanbanSource {
  return {
    id,
    kind,
    name,
    baseUrl: "https://example.com",
    query: "state=opened",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  } as StoredKanbanSource;
}

function gitlabCard(id: string, sourceIds: string[] | undefined, sourceId?: string) {
  return {
    id,
    title: id,
    url: null,
    status: "wip",
    theme: "gitlab-mr",
    source: { kind: "gitlab", externalId: `gitlab:1!${id}`, projectId: "1", mrIid: id },
    externalId: `gitlab:1!${id}`,
    sourceId,
    sourceIds,
    order: 1,
    statusPinnedByUser: false,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  } as StoredKanbanCard;
}

function manualCard(id: string): StoredKanbanCard {
  return {
    ...gitlabCard(id, undefined),
    source: { kind: "manual" },
    externalId: null,
  } as StoredKanbanCard;
}

describe("kanban board tabs", () => {
  const review = source("src_review", "gitlab", "Review queue");
  const mine = source("src_mine", "gitlab", "My MRs");
  const jira = source("src_jira", "jira", "Jira");

  it("gives every configured source its own tab, kinds grouped, manual last", () => {
    const tabs = buildKanbanBoardTabs({ sources: [review, mine, jira], cards: [] });

    expect(tabs.map((tab) => tab.key)).toEqual([
      "overview",
      "src_jira",
      "src_review",
      "src_mine",
      "manual",
    ]);
  });

  it("scopes a source tab to that source, so two GitLab sources do not share counts", () => {
    const shared = gitlabCard("1", ["src_review", "src_mine"], "src_review");
    const reviewOnly = gitlabCard("2", ["src_review"], "src_review");
    const mineOnly = gitlabCard("3", ["src_mine"], "src_mine");
    const cards = [shared, reviewOnly, mineOnly];
    const sources = [review, mine];
    const tabs = buildKanbanBoardTabs({ sources, cards });
    const reviewTab = tabs.find((tab) => tab.key === "src_review");
    const mineTab = tabs.find((tab) => tab.key === "src_mine");

    expect(
      selectKanbanTabCards({ tab: reviewTab!, cards, sources }).map((card) => card.id),
    ).toEqual(["1", "2"]);
    expect(selectKanbanTabCards({ tab: mineTab!, cards, sources }).map((card) => card.id)).toEqual([
      "1",
      "3",
    ]);
    // The shared MR is one card counted by both queues — not two cards.
    expect(selectCardsForSource(cards, "src_review")).toHaveLength(2);
    expect(selectCardsForSource(cards, "src_mine")).toHaveLength(2);
  });

  it("falls back to sourceId for cards written before sourceIds existed", () => {
    const legacy = gitlabCard("9", undefined, "src_review");

    expect(selectCardsForSource([legacy], "src_review")).toHaveLength(1);
    expect(selectCardsForSource([legacy], "src_mine")).toHaveLength(0);
  });

  it("keeps cards of a deleted source reachable through an orphan tab", () => {
    const orphan = gitlabCard("4", ["src_gone"], "src_gone");
    const cards = [orphan, gitlabCard("5", ["src_review"], "src_review")];
    const sources = [review];
    const tabs = buildKanbanBoardTabs({ sources, cards });
    const orphanTab = tabs.find((tab) => tab.key === "orphan:gitlab");

    expect(orphanTab).toBeDefined();
    expect(
      selectKanbanTabCards({ tab: orphanTab!, cards, sources }).map((card) => card.id),
    ).toEqual(["4"]);
  });

  it("has no orphan tab when every synced card still has a live source", () => {
    const cards = [gitlabCard("6", ["src_review"], "src_review"), manualCard("7")];

    expect(buildKanbanBoardTabs({ sources: [review], cards }).map((tab) => tab.key)).toEqual([
      "overview",
      "src_review",
      "manual",
    ]);
  });

  it("scopes the manual tab to hand-created cards", () => {
    const cards = [gitlabCard("8", ["src_review"], "src_review"), manualCard("10")];
    const sources = [review];
    const manualTab = buildKanbanBoardTabs({ sources, cards }).find((tab) => tab.key === "manual");

    expect(
      selectKanbanTabCards({ tab: manualTab!, cards, sources }).map((card) => card.id),
    ).toEqual(["10"]);
  });
});

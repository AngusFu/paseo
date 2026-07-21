import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { KanbanBoardProps } from "@/components/kanban/kanban-board";
import {
  KanbanStatusBoard,
  type KanbanStatusBucket,
} from "@/components/kanban/kanban-status-board";
import { KanbanGitlabStats } from "@/components/kanban/kanban-gitlab-stats";

type GitlabBucketKey = "draft" | "open" | "approved" | "merged" | "closed";
// Fixed lane order — GitLab MRs always get all five lanes rendered, even
// empty ones (unlike the Jira board's fully dynamic column set), since the
// MR lifecycle is the same five stops for every source.
const BUCKET_ORDER: GitlabBucketKey[] = ["draft", "open", "approved", "merged", "closed"];

// Reads {state, draft, approvals} off a synced GitLab MR card's raw metadata
// blob (packages/server/src/server/kanban/sync.ts stores the GitLab API MR
// object there, plus an `approvals` field it fetches separately since the MR
// list endpoint never includes approval state). Pure + defensive: metadata is
// `Record<string, unknown> | undefined` on the wire, so every field is
// narrowed before use instead of assumed. `state` is GitLab's own
// opened/merged/closed; an "opened" MR still marked draft gets its own Draft
// lane ahead of Open, matching how MR authors think about their own queue. An
// opened, non-draft MR only lands in Approved once `approvals.approved` is
// explicitly true — missing/null approvals (fetch failed, or not yet
// resolved) or `approved: false` both fall back to Open rather than guessing.
function readGitlabBucket(metadata: Record<string, unknown> | undefined): GitlabBucketKey | null {
  const state = metadata?.state;
  if (typeof state !== "string") {
    return null;
  }
  if (state === "merged") {
    return "merged";
  }
  if (state === "closed") {
    return "closed";
  }
  if (state === "opened") {
    if (metadata?.draft === true) {
      return "draft";
    }
    const approvals = metadata?.approvals as { approved?: unknown } | null | undefined;
    return approvals?.approved === true ? "approved" : "open";
  }
  return null;
}

/**
 * GitLab source-kind view: five fixed lanes (Draft / Open / Approved / Merged
 * / Closed) derived from the MR's real state + draft flag + approval state,
 * not Paseo's generic pending/wip/done buckets. Unlike the Jira view, all
 * five lanes always render (even with zero cards) since GitLab's MR
 * lifecycle is fixed. Cards synced before the raw state metadata was stored
 * (or any card this parser can't read) fall back to a lane named after the
 * legacy KanbanStatus so nothing silently disappears from the board. A
 * read-only stats strip (KanbanGitlabStats) sits above the lanes:
 * merged-in-7d/30d, average time-to-merge, pending-review backlog,
 * unresolved-discussion count.
 */
export function KanbanGitlabBoard({
  cards,
  serverId,
  cardDetailSupported,
  mutations,
}: KanbanBoardProps): ReactElement {
  const { t } = useTranslation();
  const buckets = useMemo<KanbanStatusBucket[]>(() => {
    const fixed = new Map<GitlabBucketKey, KanbanStatusBucket>(
      BUCKET_ORDER.map((key) => [
        key,
        { id: key, title: t(`kanban.gitlabColumns.${key}`), cards: [] },
      ]),
    );
    const legacy = new Map<string, KanbanStatusBucket>();
    for (const card of cards) {
      // A merged MR that dropped out of the source query is kept in the store
      // (flagged detached) only so the stats strip below can still count it —
      // the board itself is a live review queue, so hide it from the lanes. Note
      // this filters lane rendering ONLY; KanbanGitlabStats still receives the
      // full `cards` set, so merged-in-7d/30d and avg-time-to-merge stay intact.
      if (card.detachedFromSource === true && card.metadata?.state === "merged") {
        continue;
      }
      const bucket = readGitlabBucket(card.metadata);
      if (bucket) {
        fixed.get(bucket)?.cards.push(card);
        continue;
      }
      const key = `legacy:${card.status}`;
      let entry = legacy.get(key);
      if (!entry) {
        entry = { id: key, title: t(`kanban.columns.${card.status}`), cards: [] };
        legacy.set(key, entry);
      }
      entry.cards.push(card);
    }
    return [...fixed.values(), ...legacy.values()];
  }, [cards, t]);

  return (
    <>
      <KanbanGitlabStats cards={cards} />
      <KanbanStatusBoard
        buckets={buckets}
        serverId={serverId}
        cardDetailSupported={cardDetailSupported}
        mutations={mutations}
      />
    </>
  );
}

import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { KanbanBoardProps } from "@/components/kanban/kanban-board";
import {
  KanbanStatusBoard,
  type KanbanStatusBucket,
} from "@/components/kanban/kanban-status-board";
import { KanbanGitlabStats } from "@/components/kanban/kanban-gitlab-stats";

type GitlabBucketKey = "draft" | "open";
// Live queue only: Draft + Open. Merged/closed drop out of `state=opened`
// sources and are deleted on reconcile; Approved is not a separate lane —
// an opened non-draft MR stays in Open regardless of approval state.
const BUCKET_ORDER: GitlabBucketKey[] = ["draft", "open"];

// Reads {state, draft} off a synced GitLab MR card's raw metadata blob
// (packages/server/src/server/kanban/sync.ts stores the GitLab API MR
// object there). Pure + defensive: metadata is
// `Record<string, unknown> | undefined` on the wire, so every field is
// narrowed before use instead of assumed. Terminal states return null so
// the card is omitted from the live queue (sync deletes them; this is a
// render-time belt for stale local data).
function readGitlabBucket(metadata: Record<string, unknown> | undefined): GitlabBucketKey | null {
  const state = metadata?.state;
  if (typeof state !== "string") {
    return null;
  }
  if (state === "merged" || state === "closed") {
    return null;
  }
  if (state === "opened") {
    return metadata?.draft === true ? "draft" : "open";
  }
  return null;
}

/**
 * GitLab source-kind view: Draft + Open only — the live `state=opened` queue
 * for both review boards and authored-MR boards. Not Paseo's generic
 * pending/wip/done buckets. Both lanes always render (even empty). Cards
 * synced before raw state metadata was stored fall back to a lane named
 * after the legacy KanbanStatus. Stats strip still sits above for pending
 * review / unresolved discussion counts (merge stats are zero once merged
 * cards are purged from the store).
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
      const bucket = readGitlabBucket(card.metadata);
      if (bucket) {
        fixed.get(bucket)?.cards.push(card);
        continue;
      }
      // Terminal / unreadable metadata: omit from the live queue.
      if (card.metadata?.state === "merged" || card.metadata?.state === "closed") {
        continue;
      }
      if (card.detachedFromSource === true) {
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

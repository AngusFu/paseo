import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { KanbanBoardProps } from "@/components/kanban/kanban-board";
import {
  KanbanStatusBoard,
  type KanbanStatusBucket,
} from "@/components/kanban/kanban-status-board";

type GitlabBucketKey = "draft" | "open" | "merged" | "closed";
// Fixed lane order — GitLab MRs always get all four lanes rendered, even
// empty ones (unlike the Jira board's fully dynamic column set), since the
// MR lifecycle is the same four stops for every source.
const BUCKET_ORDER: GitlabBucketKey[] = ["draft", "open", "merged", "closed"];

// Reads {state, draft} off a synced GitLab MR card's raw metadata blob
// (packages/server/src/server/kanban/sync.ts stores the GitLab API MR object
// there). Pure + defensive: metadata is `Record<string, unknown> | undefined`
// on the wire, so every field is narrowed before use instead of assumed.
// `state` is GitLab's own opened/merged/closed; an "opened" MR still marked
// draft gets its own Draft lane ahead of Open, matching how MR authors think
// about their own queue.
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
    return metadata?.draft === true ? "draft" : "open";
  }
  return null;
}

/**
 * GitLab source-kind view: four fixed lanes (Draft / Open / Merged / Closed)
 * derived from the MR's real state + draft flag, not Paseo's generic
 * pending/wip/done buckets. Unlike the Jira view, all four lanes always
 * render (even with zero cards) since GitLab's MR lifecycle is fixed. Cards
 * synced before the raw state metadata was stored (or any card this parser
 * can't read) fall back to a lane named after the legacy KanbanStatus so
 * nothing silently disappears from the board.
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
    <KanbanStatusBoard
      buckets={buckets}
      serverId={serverId}
      cardDetailSupported={cardDetailSupported}
      mutations={mutations}
    />
  );
}

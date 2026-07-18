import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { StoredKanbanCard } from "@getpaseo/protocol/kanban/types";
import { formatDuration } from "@/utils/time";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Reads an ISO timestamp off a synced GitLab MR card's raw metadata blob
// (sync.ts stores the GitLab API MR object there, unfiltered). Defensive —
// metadata is `Record<string, unknown> | undefined` on the wire — a bad or
// missing value just means this card is skipped from that stat rather than
// throwing.
function readGitlabMetadataDate(
  metadata: Record<string, unknown> | undefined,
  key: string,
): Date | null {
  const value = metadata?.[key];
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface GitlabStatsSummary {
  merged7d: number;
  merged30d: number;
  avgTimeToMergeMs: number | null;
  pendingReview: number;
  unresolvedDiscussions: number;
}

interface MergedCardTally {
  merged7d: number;
  merged30d: number;
  mergeDurationsMs: number[];
}

// Split out of summarizeGitlabCards to keep block nesting under the lint
// limit — one merged card can affect the 7d count, the 30d count, and the
// time-to-merge sample in one pass.
function tallyMergedCard(
  metadata: Record<string, unknown> | undefined,
  now: Date,
  tally: MergedCardTally,
): void {
  const mergedAt = readGitlabMetadataDate(metadata, "merged_at");
  if (!mergedAt) {
    return;
  }
  const ageMs = now.getTime() - mergedAt.getTime();
  if (ageMs < 0) {
    return;
  }
  if (ageMs <= SEVEN_DAYS_MS) {
    tally.merged7d += 1;
  }
  if (ageMs > THIRTY_DAYS_MS) {
    return;
  }
  tally.merged30d += 1;
  const createdAt = readGitlabMetadataDate(metadata, "created_at");
  if (createdAt) {
    tally.mergeDurationsMs.push(mergedAt.getTime() - createdAt.getTime());
  }
}

// Pure aggregation over whatever GitLab cards are currently synced —
// client-only, no RPC. Cards missing the fields a given stat needs are
// silently excluded from that stat (no error, no annotation — keeping this
// simple per the steering note) rather than counted as zero/skipped-with-a-mark.
function summarizeGitlabCards(cards: StoredKanbanCard[], now: Date): GitlabStatsSummary {
  const tally: MergedCardTally = { merged7d: 0, merged30d: 0, mergeDurationsMs: [] };
  let pendingReview = 0;
  let unresolvedDiscussions = 0;

  for (const card of cards) {
    const metadata = card.metadata;
    const state = metadata?.state;
    if (state === "merged") {
      tallyMergedCard(metadata, now, tally);
    } else if (state === "opened" && metadata?.draft !== true) {
      pendingReview += 1;
    }
    if (card.hasUnresolvedThreads) {
      unresolvedDiscussions += 1;
    }
  }

  const avgTimeToMergeMs = tally.mergeDurationsMs.length
    ? tally.mergeDurationsMs.reduce((sum, ms) => sum + ms, 0) / tally.mergeDurationsMs.length
    : null;

  return {
    merged7d: tally.merged7d,
    merged30d: tally.merged30d,
    avgTimeToMergeMs,
    pendingReview,
    unresolvedDiscussions,
  };
}

export interface KanbanGitlabStatsProps {
  cards: StoredKanbanCard[];
}

/**
 * Read-only stats strip above the GitLab MR board: merged-in-7d/30d counts,
 * average time-to-merge over the last 30 days, still-open non-draft count
 * ("pending review"), and unresolved-discussion count. Computed entirely from
 * the already-synced card set — no protocol/RPC addition.
 */
export function KanbanGitlabStats({ cards }: KanbanGitlabStatsProps): ReactElement {
  const { t } = useTranslation();
  const summary = useMemo(() => summarizeGitlabCards(cards, new Date()), [cards]);

  return (
    <View style={styles.row}>
      <View style={styles.pill}>
        <Text style={styles.pillText}>
          {t("kanban.gitlabStats.merged7d", { count: summary.merged7d })}
        </Text>
      </View>
      <View style={styles.pill}>
        <Text style={styles.pillText}>
          {t("kanban.gitlabStats.merged30d", { count: summary.merged30d })}
        </Text>
      </View>
      <View style={styles.pill}>
        <Text style={styles.pillText}>
          {summary.avgTimeToMergeMs === null
            ? t("kanban.gitlabStats.avgTimeToMergeEmpty")
            : t("kanban.gitlabStats.avgTimeToMerge", {
                duration: formatDuration(summary.avgTimeToMergeMs),
              })}
        </Text>
      </View>
      <View style={styles.pill}>
        <Text style={styles.pillText}>
          {t("kanban.gitlabStats.pendingReview", { count: summary.pendingReview })}
        </Text>
      </View>
      <View style={styles.pill}>
        <Text style={styles.pillText}>
          {t("kanban.gitlabStats.unresolvedDiscussions", { count: summary.unresolvedDiscussions })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  pill: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  pillText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

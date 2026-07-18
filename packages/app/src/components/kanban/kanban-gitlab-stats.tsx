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

interface StatTileProps {
  value: string;
  label: string;
  testID: string;
}

// One "value line" (large, primary color) + "label line" (small, muted)
// tile — matches KanbanOverviewFocusRow's focusStat tiles in kanban-screen.tsx.
function StatTile({ value, label, testID }: StatTileProps): ReactElement {
  return (
    <View style={styles.tile} testID={testID}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

/**
 * Read-only stats strip above the GitLab MR board: merged-in-7d/30d counts,
 * average time-to-merge over the last 30 days, still-open non-draft count
 * ("pending review"), and unresolved-discussion count. Computed entirely from
 * the already-synced card set — no protocol/RPC addition. Each stat renders
 * as a value+label tile rather than a sentence, so the numbers actually read
 * as statistics instead of being buried in prose.
 */
export function KanbanGitlabStats({ cards }: KanbanGitlabStatsProps): ReactElement {
  const { t } = useTranslation();
  const summary = useMemo(() => summarizeGitlabCards(cards, new Date()), [cards]);
  const avgTimeToMergeValue =
    summary.avgTimeToMergeMs === null ? "—" : formatDuration(summary.avgTimeToMergeMs);
  const avgTimeToMergeLabel =
    summary.avgTimeToMergeMs === null
      ? t("kanban.gitlabStats.avgTimeToMergeEmpty")
      : t("kanban.gitlabStats.avgTimeToMerge");

  return (
    <View style={styles.row} testID="kanban-gitlab-stats">
      <StatTile
        testID="kanban-gitlab-stats-merged7d"
        value={String(summary.merged7d)}
        label={t("kanban.gitlabStats.merged7d")}
      />
      <StatTile
        testID="kanban-gitlab-stats-merged30d"
        value={String(summary.merged30d)}
        label={t("kanban.gitlabStats.merged30d")}
      />
      <StatTile
        testID="kanban-gitlab-stats-avg-time-to-merge"
        value={avgTimeToMergeValue}
        label={avgTimeToMergeLabel}
      />
      <StatTile
        testID="kanban-gitlab-stats-pending-review"
        value={String(summary.pendingReview)}
        label={t("kanban.gitlabStats.pendingReview")}
      />
      <StatTile
        testID="kanban-gitlab-stats-unresolved-discussions"
        value={String(summary.unresolvedDiscussions)}
        label={t("kanban.gitlabStats.unresolvedDiscussions")}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    // Match the screen's row padding (tabs/actions) and the board content
    // below so the tiles share the same left edge.
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    marginTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  tile: {
    // Hug content — flexGrow would stretch five tiny numbers across the full
    // row width, which reads as five bloated empty cards on wide screens.
    flexGrow: 0,
    alignSelf: "flex-start",
    minWidth: 96,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  tileValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 20,
  },
  tileLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

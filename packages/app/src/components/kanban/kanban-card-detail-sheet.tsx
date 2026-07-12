import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Copy, Pencil } from "lucide-react-native";
import type {
  KanbanCardDetail,
  KanbanCardDetailComment,
  KanbanCardSource,
  StoredKanbanCard,
} from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { resolveKanbanCardTheme } from "@/components/kanban/kanban-card-theme";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { useKanbanCardDetail } from "@/hooks/use-kanban-card-detail";
import { formatTimeAgo } from "@/utils/time";
import { openExternalUrl } from "@/utils/open-external-url";

const THEME_ICON_SIZE = 16;
const LINK_ICON_SIZE = 14;

// Stable empty reference so a label-less card doesn't create a new array on
// every render (react-perf/jsx-no-new-array-as-prop).
const EMPTY_LABELS: readonly string[] = [];

// Mirrors kanban-card.tsx's cardIssueKey — kept local rather than exported to
// avoid coupling into a file another change is currently polishing.
function cardIssueKey(source: KanbanCardSource): string | null {
  if (source.kind === "jira") {
    return source.issueKey;
  }
  if (source.kind === "gitlab") {
    return `!${source.mrIid}`;
  }
  return null;
}

// The prompt template a user pastes into a shell to dispatch an agent against
// this card. Jira cards get a "Fix" prefix with the issue key, GitLab MRs get
// a "Review" prefix with the MR iid, manual cards fall back to a plain "Fix".
function buildDispatchCommand(card: StoredKanbanCard, detail: KanbanCardDetail | null): string {
  const title = detail?.title ?? card.title;
  const url = detail?.url ?? card.url;
  let prefix: string;
  if (card.source.kind === "jira") {
    prefix = `Fix ${card.source.issueKey}: ${title}`;
  } else if (card.source.kind === "gitlab") {
    prefix = `Review MR !${card.source.mrIid}: ${title}`;
  } else {
    prefix = `Fix: ${title}`;
  }
  const prompt = url ? `${prefix}\n${url}` : prefix;
  return `paseo run "${prompt.replace(/"/g, '\\"')}"`;
}

function sortCommentsAscending(
  comments: readonly KanbanCardDetailComment[],
): KanbanCardDetailComment[] {
  return [...comments].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });
}

function commentKey(comment: KanbanCardDetailComment): string {
  return `${comment.author ?? ""}:${comment.createdAt ?? ""}:${comment.bodyMarkdown}`;
}

export interface KanbanCardDetailSheetProps {
  visible: boolean;
  card: StoredKanbanCard | null;
  serverId: string | null;
  detailSupported: boolean;
  onClose: () => void;
  onEdit: () => void;
}

/**
 * Read-only tracker detail for a card: description, comments, and a ready-to-
 * paste CLI dispatch command. Fetches `kanban.card.detail` on open when the
 * host supports it; old daemons fall back to the card's local fields only.
 */
export function KanbanCardDetailSheet({
  visible,
  card,
  serverId,
  detailSupported,
  onClose,
  onEdit,
}: KanbanCardDetailSheetProps): ReactElement {
  const { t } = useTranslation();
  const { detail, isLoading, isError, refetch } = useKanbanCardDetail(
    serverId,
    card?.id ?? null,
    visible && detailSupported,
  );

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("kanban.cardDetail.title"),
      actions: (
        <Button size="sm" variant="ghost" leftIcon={Pencil} onPress={onEdit}>
          {t("kanban.card.edit")}
        </Button>
      ),
    }),
    [onEdit, t],
  );

  if (!card) {
    return (
      <AdaptiveModalSheet header={header} visible={visible} onClose={onClose}>
        <View />
      </AdaptiveModalSheet>
    );
  }

  const themeVisual = resolveKanbanCardTheme(card.theme);
  const issueKey = cardIssueKey(card.source);
  const url = detail?.url ?? card.url;

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      webScrollbar
      testID="kanban-card-detail-sheet"
    >
      <View style={styles.topRow}>
        <themeVisual.icon size={THEME_ICON_SIZE} color={themeVisual.color ?? styles.glyph.color} />
        {issueKey ? (
          <View style={styles.issueKeyChip}>
            <Text style={styles.issueKeyText}>{issueKey}</Text>
          </View>
        ) : null}
        {detail?.externalStatus ? <StatusBadge label={detail.externalStatus} /> : null}
        <View style={styles.topRowSpacer} />
        {url ? <OpenUrlButton url={url} /> : null}
      </View>

      <Text style={styles.title}>{detail?.title ?? card.title}</Text>

      <KanbanCardDetailBody
        card={card}
        detail={detail ?? null}
        detailSupported={detailSupported}
        isLoading={isLoading}
        isError={isError}
        onRetry={refetch}
      />
    </AdaptiveModalSheet>
  );
}

function OpenUrlButton({ url }: { url: string }): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    void openExternalUrl(url);
  }, [url]);
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="link"
      accessibilityLabel={t("kanban.card.open")}
      testID="kanban-card-detail-open-url"
      hitSlop={6}
    >
      <ArrowUpRight size={LINK_ICON_SIZE} color={styles.linkButton.color} />
    </Pressable>
  );
}

interface KanbanCardDetailBodyProps {
  card: StoredKanbanCard;
  detail: KanbanCardDetail | null;
  detailSupported: boolean;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

function KanbanCardDetailBody({
  card,
  detail,
  detailSupported,
  isLoading,
  isError,
  onRetry,
}: KanbanCardDetailBodyProps): ReactElement {
  const { t } = useTranslation();

  if (!detailSupported) {
    return <UnsupportedBody card={card} />;
  }
  if (isLoading) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }
  if (isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("kanban.cardDetail.loadError")}</Text>
        <Button variant="ghost" onPress={onRetry} testID="kanban-card-detail-retry">
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }
  return <LoadedBody card={card} detail={detail} />;
}

function UnsupportedBody({ card }: { card: StoredKanbanCard }): ReactElement {
  const { t } = useTranslation();
  const labels = card.labels ?? EMPTY_LABELS;
  return (
    <>
      {labels.length > 0 ? <LabelChips labels={labels} /> : null}
      {card.assignee ? (
        <View style={styles.metaGroup}>
          <MetaRow label={t("kanban.cardDetail.assignee")} value={card.assignee} />
        </View>
      ) : null}
      <Text style={styles.unsupported} testID="kanban-card-detail-unsupported">
        {t("kanban.cardDetail.unsupported")}
      </Text>
    </>
  );
}

function LoadedBody({
  card,
  detail,
}: {
  card: StoredKanbanCard;
  detail: KanbanCardDetail | null;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const handleCopyDispatch = useCallback(() => {
    const command = buildDispatchCommand(card, detail);
    void Clipboard.setStringAsync(command);
    toast.copied();
  }, [card, detail, toast]);

  return (
    <>
      <View style={styles.metaGroup}>
        {detail?.assignee ? (
          <MetaRow label={t("kanban.cardDetail.assignee")} value={detail.assignee} />
        ) : null}
        {detail?.reporter ? (
          <MetaRow label={t("kanban.cardDetail.reporter")} value={detail.reporter} />
        ) : null}
        {detail?.priority ? (
          <MetaRow label={t("kanban.cardDetail.priority")} value={detail.priority} />
        ) : null}
        {detail?.createdAt ? (
          <MetaRow
            label={t("kanban.cardDetail.created")}
            value={formatTimeAgo(new Date(detail.createdAt))}
          />
        ) : null}
        {detail?.updatedAt ? (
          <MetaRow
            label={t("kanban.cardDetail.updated")}
            value={formatTimeAgo(new Date(detail.updatedAt))}
          />
        ) : null}
      </View>

      {detail && detail.labels.length > 0 ? <LabelChips labels={detail.labels} /> : null}

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t("kanban.cardDetail.description")}</Text>
        {detail?.descriptionMarkdown ? (
          <MarkdownRenderer text={detail.descriptionMarkdown} compact />
        ) : (
          <Text style={styles.mutedText}>{t("kanban.cardDetail.noDescription")}</Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t("kanban.cardDetail.dispatch")}</Text>
        <View style={styles.dispatchBlock}>
          <Text style={styles.dispatchCommand} testID="kanban-card-detail-dispatch-command">
            {buildDispatchCommand(card, detail)}
          </Text>
          <Button
            size="xs"
            variant="secondary"
            leftIcon={Copy}
            onPress={handleCopyDispatch}
            testID="kanban-card-detail-dispatch-copy"
          >
            {t("common.actions.copy")}
          </Button>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t("kanban.cardDetail.comments")}</Text>
        {detail && detail.comments.length > 0 ? (
          <View style={styles.commentList}>
            {sortCommentsAscending(detail.comments).map((comment) => (
              <CommentRow key={commentKey(comment)} comment={comment} />
            ))}
          </View>
        ) : (
          <Text style={styles.mutedText}>{t("kanban.cardDetail.noComments")}</Text>
        )}
      </View>
    </>
  );
}

function CommentRow({ comment }: { comment: KanbanCardDetailComment }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.comment}>
      <View style={styles.commentHeader}>
        <Text style={styles.commentAuthor}>
          {comment.author ?? t("kanban.cardDetail.unknownAuthor")}
        </Text>
        {comment.createdAt ? (
          <Text style={styles.commentTime}>{formatTimeAgo(new Date(comment.createdAt))}</Text>
        ) : null}
      </View>
      <MarkdownRenderer text={comment.bodyMarkdown} compact />
    </View>
  );
}

function LabelChips({ labels }: { labels: readonly string[] }): ReactElement {
  return (
    <View style={styles.labelsRow}>
      {labels.map((label) => (
        <View key={label} style={styles.labelChip}>
          <Text style={styles.labelText}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

function MetaRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  glyph: {
    color: theme.colors.foregroundMuted,
  },
  issueKeyChip: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[1],
  },
  issueKeyText: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  topRowSpacer: {
    flex: 1,
  },
  linkButton: {
    color: theme.colors.foregroundMuted,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    marginTop: theme.spacing[3],
  },
  metaGroup: {
    marginTop: theme.spacing[3],
    gap: theme.spacing[1.5],
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    width: 80,
  },
  metaValue: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  labelsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    marginTop: theme.spacing[3],
  },
  labelChip: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 2,
  },
  labelText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  unsupported: {
    marginTop: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  section: {
    marginTop: theme.spacing[4],
    gap: theme.spacing[2],
  },
  sectionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  dispatchBlock: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  dispatchCommand: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  commentList: {
    gap: theme.spacing[3],
  },
  comment: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface2,
    paddingTop: theme.spacing[2],
    gap: theme.spacing[1],
  },
  commentHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  commentAuthor: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  commentTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  centered: {
    marginTop: theme.spacing[6],
    alignItems: "center",
    gap: theme.spacing[3],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

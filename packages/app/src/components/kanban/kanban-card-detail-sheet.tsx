import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Copy, Pencil } from "lucide-react-native";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type {
  KanbanCardDetail,
  KanbanCardDetailAttachment,
  KanbanCardDetailComment,
  KanbanCardSource,
  StoredKanbanCard,
} from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { resolveKanbanCardTheme } from "@/components/kanban/kanban-card-theme";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { useKanbanCardComments, useKanbanCardDetail } from "@/hooks/use-kanban-card-detail";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { formatTimeAgo } from "@/utils/time";
import { openExternalUrl } from "@/utils/open-external-url";

const THEME_ICON_SIZE = 16;
const LINK_ICON_SIZE = 14;

// Stable empty reference so a label-less card doesn't create a new array on
// every render (react-perf/jsx-no-new-array-as-prop).
const EMPTY_LABELS: readonly string[] = [];

// Stable empty reference for the case with no server selected or no
// workspaces registered yet, mirroring EMPTY_LABELS above.
const EMPTY_DISPATCH_WORKSPACES: readonly DispatchWorkspaceOption[] = [];

interface DispatchWorkspaceOption {
  id: string;
  label: string;
  cwd: string;
}

// Reads the daemon's known workspaces for `serverId` (same data the sidebar
// renders) so the dispatch command can target one with `--cwd`. Workspaces
// without a resolved directory (older daemons) are filtered out.
function useDispatchWorkspaces(serverId: string | null): readonly DispatchWorkspaceOption[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const session = serverId ? state.sessions[serverId] : undefined;
      if (!session) {
        return EMPTY_DISPATCH_WORKSPACES;
      }
      const options = Array.from(session.workspaces.values())
        .filter((workspace) => workspace.workspaceDirectory.length > 0)
        .map((workspace) => ({
          id: workspace.id,
          label: workspace.title ?? workspace.name,
          cwd: workspace.workspaceDirectory,
        }));
      return options.length > 0 ? options : EMPTY_DISPATCH_WORKSPACES;
    },
    equal,
  );
}

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

function escapeCommandQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}

// The `paseo run` command a user pastes into a shell to dispatch an agent
// against this card. Jira cards get a worktree named after the issue key and
// a --title of just the issue key; GitLab MRs get a review prompt with an
// explicit "check out the source branch" reminder; manual cards fall back to
// a plain title+url prompt. `cwd` (a workspace's directory) becomes --cwd
// when a workspace is selected, omitted otherwise.
function buildDispatchCommand(
  card: StoredKanbanCard,
  detail: KanbanCardDetail | null,
  cwd: string | null,
): string {
  const title = detail?.title ?? card.title;
  const url = detail?.url ?? card.url;
  const cwdArg = cwd ? `--cwd "${escapeCommandQuotes(cwd)}" ` : "";

  if (card.source.kind === "jira") {
    const issueKey = card.source.issueKey;
    const prefix = `Fix ${issueKey}: ${title}`;
    const prompt = url ? `${prefix}\n${url}` : prefix;
    return `paseo run ${cwdArg}--worktree "fix/${issueKey}" --title "${escapeCommandQuotes(issueKey)}" "${escapeCommandQuotes(prompt)}"`;
  }
  if (card.source.kind === "gitlab") {
    const mrIid = card.source.mrIid;
    const titleArg = `Review !${mrIid}`;
    const prefix = `Review merge request !${mrIid}: ${title}`;
    const prompt = url
      ? `${prefix}\n${url}\nCheck out the MR source branch before reviewing.`
      : `${prefix}\nCheck out the MR source branch before reviewing.`;
    return `paseo run ${cwdArg}--title "${escapeCommandQuotes(titleArg)}" "${escapeCommandQuotes(prompt)}"`;
  }
  const prompt = url ? `${title}\n${url}` : title;
  return `paseo run ${cwdArg}"${escapeCommandQuotes(prompt)}"`;
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

const ATTACHMENT_RELATIVE_IMAGE_MARKER = "](/kanban/attachment/";

// Jira image links come back as markdown pointing at the daemon's own
// attachment proxy path (e.g. "](/kanban/attachment/<token>"), not an
// absolute URL — the client resolves it against the active directTcp
// connection. Relay-only hosts have no HTTP origin to resolve against, so
// the path is left relative and the image simply fails to load there.
function resolveAttachmentMarkdownUrls(markdown: string, baseUrl: string | null): string {
  if (!baseUrl) {
    return markdown;
  }
  return markdown.split(ATTACHMENT_RELATIVE_IMAGE_MARKER).join(`](${baseUrl}/kanban/attachment/`);
}

// Mirrors download-store's resolveDaemonDownloadTarget baseUrl derivation,
// minus the auth handling — attachment proxy tokens are self-authorizing
// (10-minute expiry), so no Authorization header is needed here.
function resolveKanbanAttachmentBaseUrl(daemon: HostProfile | undefined): string | null {
  const connection = daemon?.connections.find((conn) => conn.type === "directTcp") ?? null;
  if (!connection) {
    return null;
  }
  try {
    const parsed = new URL(
      buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
    );
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    return parsed.origin;
  } catch {
    return null;
  }
}

const EMPTY_ATTACHMENTS: readonly KanbanCardDetailAttachment[] = [];

// Attachments the description markdown didn't already inline as an image —
// surfaced as a fallback link list so non-image or unmatched attachments
// (e.g. PDFs, or images the html-ish parser rejected) are still reachable.
function unreferencedAttachments(
  attachments: readonly KanbanCardDetailAttachment[] | undefined,
  descriptionMarkdown: string | null,
): readonly KanbanCardDetailAttachment[] {
  if (!attachments || attachments.length === 0) {
    return EMPTY_ATTACHMENTS;
  }
  const description = descriptionMarkdown ?? "";
  const unreferenced = attachments.filter(
    (attachment) => !description.includes(attachment.proxyPath),
  );
  return unreferenced.length > 0 ? unreferenced : EMPTY_ATTACHMENTS;
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
        serverId={serverId}
        visible={visible}
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
  serverId: string | null;
  visible: boolean;
}

function KanbanCardDetailBody({
  card,
  detail,
  detailSupported,
  isLoading,
  isError,
  onRetry,
  serverId,
  visible,
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
  return <LoadedBody card={card} detail={detail} serverId={serverId} visible={visible} />;
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
  serverId,
  visible,
}: {
  card: StoredKanbanCard;
  detail: KanbanCardDetail | null;
  serverId: string | null;
  visible: boolean;
}): ReactElement {
  const { t } = useTranslation();

  const daemons = useHosts();
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const attachmentBaseUrl = useMemo(
    () => resolveKanbanAttachmentBaseUrl(daemonProfile),
    [daemonProfile],
  );
  const descriptionMarkdown = useMemo(
    () =>
      detail?.descriptionMarkdown
        ? resolveAttachmentMarkdownUrls(detail.descriptionMarkdown, attachmentBaseUrl)
        : null,
    [detail?.descriptionMarkdown, attachmentBaseUrl],
  );
  const fallbackAttachments = useMemo(
    () => unreferencedAttachments(detail?.attachments, detail?.descriptionMarkdown ?? null),
    [detail?.attachments, detail?.descriptionMarkdown],
  );

  return (
    <>
      <CardMetaGroup detail={detail} />

      {detail && detail.labels.length > 0 ? <LabelChips labels={detail.labels} /> : null}

      <DescriptionSection
        descriptionMarkdown={descriptionMarkdown}
        fallbackAttachments={fallbackAttachments}
        attachmentBaseUrl={attachmentBaseUrl}
      />

      <DispatchSection card={card} detail={detail} serverId={serverId} />

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t("kanban.cardDetail.comments")}</Text>
        <CommentsSection
          key={visible ? "open" : "closed"}
          card={card}
          serverId={serverId}
          commentCount={detail?.commentCount ?? null}
          attachmentBaseUrl={attachmentBaseUrl}
        />
      </View>
    </>
  );
}

function CardMetaGroup({ detail }: { detail: KanbanCardDetail | null }): ReactElement {
  const { t } = useTranslation();
  return (
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
  );
}

function DescriptionSection({
  descriptionMarkdown,
  fallbackAttachments,
  attachmentBaseUrl,
}: {
  descriptionMarkdown: string | null;
  fallbackAttachments: readonly KanbanCardDetailAttachment[];
  attachmentBaseUrl: string | null;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{t("kanban.cardDetail.description")}</Text>
      {descriptionMarkdown ? (
        <MarkdownRenderer text={descriptionMarkdown} compact />
      ) : (
        <Text style={styles.mutedText}>{t("kanban.cardDetail.noDescription")}</Text>
      )}
      {fallbackAttachments.length > 0 && attachmentBaseUrl ? (
        <AttachmentsFallback attachments={fallbackAttachments} baseUrl={attachmentBaseUrl} />
      ) : null}
    </View>
  );
}

function CommentsSection({
  card,
  serverId,
  commentCount,
  attachmentBaseUrl,
}: {
  card: StoredKanbanCard;
  serverId: string | null;
  commentCount: number | null;
  attachmentBaseUrl: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { comments, isLoading, isError, refetch } = useKanbanCardComments(
    serverId,
    card.id,
    expanded,
  );

  const handleLoadPress = useCallback(() => {
    setExpanded(true);
  }, []);

  if (commentCount === 0) {
    return <Text style={styles.mutedText}>{t("kanban.cardDetail.noComments")}</Text>;
  }

  if (!expanded) {
    const label =
      commentCount !== null
        ? t("kanban.cardDetail.loadCommentsWithCount", { count: commentCount })
        : t("kanban.cardDetail.loadComments");
    return (
      <Button variant="ghost" onPress={handleLoadPress} testID="kanban-card-detail-load-comments">
        {label}
      </Button>
    );
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
        <Text style={styles.message}>{t("kanban.cardDetail.commentsLoadError")}</Text>
        <Button variant="ghost" onPress={refetch} testID="kanban-card-detail-comments-retry">
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  if (!comments || comments.length === 0) {
    return <Text style={styles.mutedText}>{t("kanban.cardDetail.noComments")}</Text>;
  }

  return (
    <View style={styles.commentList}>
      {sortCommentsAscending(comments).map((comment) => (
        <CommentRow
          key={commentKey(comment)}
          comment={comment}
          attachmentBaseUrl={attachmentBaseUrl}
        />
      ))}
    </View>
  );
}

function AttachmentsFallback({
  attachments,
  baseUrl,
}: {
  attachments: readonly KanbanCardDetailAttachment[];
  baseUrl: string;
}): ReactElement {
  return (
    <View style={styles.attachmentsRow}>
      {attachments.map((attachment) => (
        <AttachmentLink key={attachment.proxyPath} attachment={attachment} baseUrl={baseUrl} />
      ))}
    </View>
  );
}

function AttachmentLink({
  attachment,
  baseUrl,
}: {
  attachment: KanbanCardDetailAttachment;
  baseUrl: string;
}): ReactElement {
  const handlePress = useCallback(() => {
    void openExternalUrl(`${baseUrl}${attachment.proxyPath}`);
  }, [attachment.proxyPath, baseUrl]);
  return (
    <Pressable onPress={handlePress} hitSlop={6}>
      <Text style={styles.attachmentLink}>{attachment.filename}</Text>
    </Pressable>
  );
}

function DispatchSection({
  card,
  detail,
  serverId,
}: {
  card: StoredKanbanCard;
  detail: KanbanCardDetail | null;
  serverId: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const workspaces = useDispatchWorkspaces(serverId);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null;
  const workspaceOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      workspaces.map((workspace) => ({
        id: workspace.id,
        value: workspace.id,
        label: workspace.label,
      })),
    [workspaces],
  );
  const selectedWorkspaceDisplay = useMemo(
    () => (selectedWorkspace ? { label: selectedWorkspace.label } : null),
    [selectedWorkspace],
  );
  const handleWorkspaceChange = useCallback((value: string) => {
    setSelectedWorkspaceId(value);
  }, []);

  const dispatchCommand = useMemo(
    () => buildDispatchCommand(card, detail, selectedWorkspace?.cwd ?? null),
    [card, detail, selectedWorkspace],
  );

  const handleCopyDispatch = useCallback(() => {
    void Clipboard.setStringAsync(dispatchCommand);
    toast.copied();
  }, [dispatchCommand, toast]);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{t("kanban.cardDetail.dispatch")}</Text>
      {workspaceOptions.length > 0 ? (
        <SelectField
          label={t("kanban.cardDetail.dispatchWorkspaceLabel")}
          field={false}
          size="sm"
          value={selectedWorkspace?.id ?? null}
          selectedDisplay={selectedWorkspaceDisplay}
          options={workspaceOptions}
          onChange={handleWorkspaceChange}
          placeholder={t("kanban.cardDetail.dispatchWorkspacePlaceholder")}
          emptyText={t("common.empty.noResults")}
          testID="kanban-card-detail-dispatch-workspace"
        />
      ) : (
        <Text style={styles.mutedText}>{t("kanban.cardDetail.dispatchNoWorkspaces")}</Text>
      )}
      <View style={styles.dispatchBlock}>
        <Text style={styles.dispatchCommand} testID="kanban-card-detail-dispatch-command">
          {dispatchCommand}
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
  );
}

function CommentRow({
  comment,
  attachmentBaseUrl,
}: {
  comment: KanbanCardDetailComment;
  attachmentBaseUrl: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const bodyMarkdown = useMemo(
    () => resolveAttachmentMarkdownUrls(comment.bodyMarkdown, attachmentBaseUrl),
    [comment.bodyMarkdown, attachmentBaseUrl],
  );
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
      <MarkdownRenderer text={bodyMarkdown} compact />
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
  attachmentsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  attachmentLink: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.xs,
    textDecorationLine: "underline",
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

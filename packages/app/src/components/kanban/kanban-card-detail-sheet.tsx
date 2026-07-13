import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Copy, Pencil, Play, Rocket } from "lucide-react-native";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import type {
  KanbanCardDetail,
  KanbanCardDetailAttachment,
  KanbanCardDetailComment,
  KanbanCardSource,
  KanbanSourceKind,
  StoredKanbanCard,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { resolveKanbanCardTheme } from "@/components/kanban/kanban-card-theme";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useKanbanCardComments, useKanbanCardDetail } from "@/hooks/use-kanban-card-detail";
import { useKanbanSources } from "@/hooks/use-kanban-sources";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveDefaultModelId } from "@/provider-selection/resolve-agent-form";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { toErrorMessage } from "@/utils/error-messages";
import { renderDefaultPrompt, renderPromptTemplate } from "@/utils/kanban-prompt-template";
import { formatTimeAgo } from "@/utils/time";
import { openExternalUrl } from "@/utils/open-external-url";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";

const THEME_ICON_SIZE = 16;
const LINK_ICON_SIZE = 14;
// Card detail carries a description, comments and attachments, so it earns far
// more room than the default sheet. The card still fills 100% of the (padded)
// viewport below this cap, so it stays responsive on narrower windows.
const CARD_DETAIL_MAX_WIDTH = 960;

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

// Offers the daemon's known *projects* (one entry per projectRootPath) rather
// than individual workspaces: `paseo run --worktree` creates a worktree off
// --cwd, so the base must be the project's main checkout — dispatching from a
// workspace that is itself a worktree would nest worktrees.
function useDispatchWorkspaces(serverId: string | null): readonly DispatchWorkspaceOption[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const session = serverId ? state.sessions[serverId] : undefined;
      if (!session) {
        return EMPTY_DISPATCH_WORKSPACES;
      }
      const byRoot = new Map<string, DispatchWorkspaceOption>();
      for (const workspace of session.workspaces.values()) {
        const root = workspace.projectRootPath;
        if (!root || byRoot.has(root)) {
          continue;
        }
        const segments = root.split("/");
        let label = root;
        for (let i = segments.length - 1; i >= 0; i--) {
          if (segments[i]) {
            label = segments[i];
            break;
          }
        }
        byRoot.set(root, { id: root, label, cwd: root });
      }
      return byRoot.size > 0 ? [...byRoot.values()] : EMPTY_DISPATCH_WORKSPACES;
    },
    equal,
  );
}

interface DispatchProviderDefault {
  provider: string;
  model: string;
  label: string | null;
}

// Mirrors the new-workspace flow's provider default: prefer the user's last-used
// provider (from form preferences) if it's still ready on this host, otherwise
// the first ready provider; model defaults to that provider's isDefault model
// (see resolveDefaultModelId in provider-selection/resolve-agent-form.ts).
function resolveDispatchProviderDefault(
  preferredProvider: string | undefined,
  entries: readonly ProviderSnapshotEntry[] | undefined,
): DispatchProviderDefault | null {
  if (!entries || entries.length === 0) {
    return null;
  }
  const ready = entries.filter((entry) => entry.status === "ready");
  const preferred = preferredProvider
    ? ready.find((entry) => entry.provider === preferredProvider)
    : undefined;
  const entry = preferred ?? ready[0];
  if (!entry) {
    return null;
  }
  return {
    provider: entry.provider,
    model: resolveDefaultModelId(entry.models ?? null),
    label: entry.label ?? null,
  };
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

// Short branch-name slug from a card title: conventional-commit prefix
// stripped, lowercased, non-alphanumerics collapsed to "-", capped at 32
// chars. Teams commonly enforce <prefix>/<KEY>_<slug> branch contracts
// (e.g. a validate-branch-name pre-push hook), and a keyless bare
// "fix/SCIF-1234" fails those.
function branchSlug(title: string): string {
  const slug = title
    .replace(/^\w+(\([^)]*\))?!?:\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug;
}

// First Jira-style issue key (e.g. SCIF-4993) mentioned in a title, if any.
function issueKeyFromTitle(title: string): string | null {
  const match = /\b[A-Z][A-Z0-9]+-\d+\b/.exec(title);
  return match ? match[0] : null;
}

// The dispatch plan for a card: the default prompt text (editable by the
// user before dispatch), the worktree name (null for manual cards, which
// dispatch straight into the project checkout), and the --title arg (null
// alongside worktree). Jira cards get a fix/<issueKey> worktree and a title
// of just the issue key; GitLab MRs get a review/mr-<iid> worktree plus a
// check-out-the-source-branch reminder; manual cards fall back to a plain
// title+url prompt.
interface DispatchPlan {
  worktree: string | null;
  title: string | null;
  prompt: string;
}

// First same-kind source with a configured promptTemplate. Cards don't carry
// a sourceId, so kind is the same matching heuristic the detail service uses
// elsewhere to pick a source for a card.
function findPromptTemplate(
  kind: KanbanSourceKind,
  sources: readonly StoredKanbanSource[],
): string | null {
  return (
    sources.find((source) => source.kind === kind && source.promptTemplate)?.promptTemplate ?? null
  );
}

// Variables shared by every kind's template; kind-specific ones (issueKey,
// contractBranch, mrIid) are added by the caller.
function buildCommonTemplateVars(
  card: StoredKanbanCard,
  detail: KanbanCardDetail | null,
  title: string,
  url: string | null,
  worktree: string | null,
): Record<string, string> {
  const labels = detail?.labels ?? card.labels ?? [];
  return {
    title,
    url: url ?? "",
    description: detail?.descriptionMarkdown ?? "",
    status: detail?.externalStatus ?? "",
    assignee: detail?.assignee ?? card.assignee ?? "",
    labels: labels.join(", "),
    worktree: worktree ?? "",
  };
}

function buildDispatchPlan(
  card: StoredKanbanCard,
  detail: KanbanCardDetail | null,
  sources: readonly StoredKanbanSource[],
): DispatchPlan {
  const title = detail?.title ?? card.title;
  const url = detail?.url ?? card.url;

  if (card.source.kind === "jira") {
    const issueKey = card.source.issueKey;
    const slug = branchSlug(title);
    // Paseo slugifies worktree branch names to DNS-safe kebab-case (they feed
    // service-proxy hostnames), so a <prefix>/<KEY>_<slug> branch contract
    // can't survive creation. The prompt tells the agent to rename the branch
    // to the contract form as its first step instead.
    const contractBranch = slug ? `fix/${issueKey}_${slug}` : `fix/${issueKey}`;
    const worktree = slug
      ? `fix-${issueKey.toLowerCase()}-${slug}`
      : `fix-${issueKey.toLowerCase()}`;
    const vars = {
      ...buildCommonTemplateVars(card, detail, title, url, worktree),
      issueKey,
      contractBranch,
    };
    const template = findPromptTemplate("jira", sources);
    const prompt = template
      ? renderPromptTemplate(template, vars)
      : renderDefaultPrompt("jira", vars);
    return { worktree, title: issueKey, prompt };
  }
  if (card.source.kind === "gitlab") {
    const mrIid = card.source.mrIid;
    const titleArg = `Review !${mrIid}`;
    // The review runs in its own worktree too — checking out the MR source
    // branch in the main checkout would clobber whatever branch is there.
    // Branch-contract-friendly name: chore/<KEY>_review-mr-<iid> when the MR
    // title mentions an issue key, plain review-mr-<iid> slug otherwise.
    const issueKey = issueKeyFromTitle(title);
    const worktree = issueKey ? `chore/${issueKey}_review-mr-${mrIid}` : `chore/review-mr-${mrIid}`;
    const vars = {
      ...buildCommonTemplateVars(card, detail, title, url, worktree),
      mrIid,
    };
    const template = findPromptTemplate("gitlab", sources);
    const prompt = template
      ? renderPromptTemplate(template, vars)
      : renderDefaultPrompt("gitlab", vars);
    return { worktree, title: titleArg, prompt };
  }
  const prompt = renderDefaultPrompt(
    "manual",
    buildCommonTemplateVars(card, detail, title, url, null),
  );
  return { worktree: null, title: null, prompt };
}

// The `paseo run` command a user pastes into a shell to dispatch an agent
// against this card, built from the plan plus a (possibly user-edited)
// prompt. `cwd` (a project's main checkout) becomes --cwd when a project is
// selected, omitted otherwise.
function buildDispatchCommand(
  plan: DispatchPlan,
  cwd: string | null,
  prompt: string,
  provider: string,
  model: string,
): string {
  const cwdArg = cwd ? `--cwd "${escapeCommandQuotes(cwd)}" ` : "";
  const worktreeArg = plan.worktree ? `--worktree "${escapeCommandQuotes(plan.worktree)}" ` : "";
  const titleArg = plan.title ? `--title "${escapeCommandQuotes(plan.title)}" ` : "";
  const providerArg = provider ? `--provider "${escapeCommandQuotes(provider)}" ` : "";
  const modelArg = model ? `--model "${escapeCommandQuotes(model)}" ` : "";
  return `paseo run ${cwdArg}${worktreeArg}${titleArg}${providerArg}${modelArg}"${escapeCommandQuotes(prompt)}"`;
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
  /** Open the standalone dispatch panel (same action as the card's rocket). */
  onDispatch: () => void;
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
  onDispatch,
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
        <>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <View>
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={Rocket}
                  onPress={onDispatch}
                  accessibilityLabel={t("kanban.cardDetail.dispatch")}
                  testID="kanban-card-detail-dispatch"
                />
              </View>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center" offset={8}>
              <Text style={styles.tooltipText}>{t("kanban.cardDetail.dispatch")}</Text>
            </TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <View>
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={Pencil}
                  onPress={onEdit}
                  accessibilityLabel={t("kanban.card.edit")}
                  testID="kanban-card-detail-edit"
                />
              </View>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center" offset={8}>
              <Text style={styles.tooltipText}>{t("kanban.card.edit")}</Text>
            </TooltipContent>
          </Tooltip>
        </>
      ),
    }),
    [onDispatch, onEdit, t],
  );

  if (!card) {
    return (
      <AdaptiveModalSheet
        header={header}
        visible={visible}
        onClose={onClose}
        desktopMaxWidth={CARD_DETAIL_MAX_WIDTH}
      >
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
      desktopMaxWidth={CARD_DETAIL_MAX_WIDTH}
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

// Exported so the standalone dispatch sheet (opened from a card's hover
// quick-launch) can reuse the exact panel — it works from just the base card
// with detail={null}. See kanban-card-dispatch-sheet.tsx.
export function DispatchSection({
  card,
  detail,
  serverId,
}: {
  card: StoredKanbanCard;
  detail: KanbanCardDetail | null;
  serverId: string | null;
}): ReactElement {
  const { t } = useTranslation();

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

  const { sources, isLoading: isSourcesLoading } = useKanbanSources(serverId);
  const plan = useMemo(() => buildDispatchPlan(card, detail, sources), [card, detail, sources]);
  // Remounts DispatchActions (and its editable-prompt draft) whenever the card
  // changes, or once detail and sources finish loading for a card — so a
  // freshly fetched title/url/promptTemplate regenerates the prefilled prompt
  // exactly once, while further re-renders (e.g. comments loading) don't
  // clobber user edits.
  const promptResetKey = `${card.id}:${detail ? "loaded" : "pending"}:${isSourcesLoading ? "pending" : "loaded"}`;

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
      <DispatchActions
        key={promptResetKey}
        plan={plan}
        workspace={selectedWorkspace}
        serverId={serverId}
      />
    </View>
  );
}

function DispatchActions({
  plan,
  workspace,
  serverId,
}: {
  plan: DispatchPlan;
  workspace: DispatchWorkspaceOption | null;
  serverId: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId ?? "");
  const { preferences } = useFormPreferences();
  const cwd = workspace?.cwd ?? null;
  const snapshot = useProvidersSnapshot(serverId, { enabled: Boolean(serverId && cwd), cwd });
  const providerDefault = useMemo(
    () => resolveDispatchProviderDefault(preferences.provider, snapshot.entries),
    [preferences.provider, snapshot.entries],
  );
  const modelSelectorProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );

  const [prompt, setPrompt] = useState(plan.prompt);
  const [isRunSheetVisible, setIsRunSheetVisible] = useState(false);
  // Provider/model start from the resolved default and stay wherever the user
  // moves them. Seed once, when the default first resolves and nothing is chosen.
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  useEffect(() => {
    if (!selectedProvider && providerDefault) {
      setSelectedProvider(providerDefault.provider);
      setSelectedModel(providerDefault.model);
    }
  }, [providerDefault, selectedProvider]);

  const handleSelectModel = useCallback((provider: AgentProvider, modelId: string) => {
    setSelectedProvider(provider);
    setSelectedModel(modelId);
  }, []);

  // Full-width trigger matching the workspace dropdown above, so the dispatch
  // controls line up instead of the model chip floating at its own width.
  const renderModelTrigger = useCallback(
    (input: {
      selectedModelLabel: string;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }): ReactNode => (
      <SelectFieldTrigger
        label={input.selectedModelLabel}
        isPlaceholder={!selectedModel}
        placeholder={input.selectedModelLabel}
        disabled={input.disabled}
        active={input.hovered || input.pressed || input.isOpen}
        size="sm"
        testID="kanban-card-detail-dispatch-provider-trigger"
      />
    ),
    [selectedModel],
  );

  const selectedProviderLabel = useMemo(() => {
    const match = modelSelectorProviders.find((entry) => entry.id === selectedProvider);
    return match?.label ?? (selectedProvider || null);
  }, [modelSelectorProviders, selectedProvider]);

  const confirmProviderLabel = useMemo(() => {
    if (!selectedProviderLabel) {
      return null;
    }
    return selectedModel ? `${selectedProviderLabel} · ${selectedModel}` : selectedProviderLabel;
  }, [selectedProviderLabel, selectedModel]);

  const dispatchCommand = useMemo(
    () => buildDispatchCommand(plan, cwd, prompt, selectedProvider, selectedModel),
    [plan, cwd, prompt, selectedProvider, selectedModel],
  );

  const handleCopyDispatch = useCallback(() => {
    void Clipboard.setStringAsync(dispatchCommand);
    toast.copied();
  }, [dispatchCommand, toast]);

  const handleOpenRunSheet = useCallback(() => setIsRunSheetVisible(true), []);
  const handleCloseRunSheet = useCallback(() => setIsRunSheetVisible(false), []);

  const handleConfirmRun = useCallback(async () => {
    if (!client || !workspace) {
      throw new Error(t("kanban.cardDetail.dispatchRunNoWorkspace"));
    }
    if (!selectedProvider) {
      throw new Error(t("kanban.cardDetail.dispatchRunNoProvider"));
    }
    const workspacePayload = plan.worktree
      ? await client.createWorkspace({
          source: { kind: "worktree", cwd: workspace.cwd, worktreeSlug: plan.worktree },
        })
      : await client.createWorkspace({ source: { kind: "directory", path: workspace.cwd } });
    if (workspacePayload.error || !workspacePayload.workspace) {
      throw new Error(workspacePayload.error ?? t("kanban.cardDetail.dispatchRunNoWorkspace"));
    }
    const workspaceDirectory = requireWorkspaceDirectory({
      workspaceId: workspacePayload.workspace.id,
      workspaceDirectory: workspacePayload.workspace.workspaceDirectory,
    });
    await client.createAgent({
      provider: selectedProvider,
      model: selectedModel || undefined,
      cwd: workspaceDirectory,
      workspaceId: workspacePayload.workspace.id,
      ...(plan.title ? { title: plan.title } : {}),
      initialPrompt: prompt,
    });
    toast.show(t("kanban.cardDetail.dispatchRunSuccess"), { variant: "success" });
  }, [client, plan, prompt, selectedProvider, selectedModel, t, toast, workspace]);

  return (
    <>
      <Field label={t("kanban.cardDetail.dispatchRunConfirmProvider")}>
        <CombinedModelSelector
          providers={modelSelectorProviders}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          onSelect={handleSelectModel}
          isLoading={snapshot.isLoading || snapshot.isFetching}
          serverId={serverId}
          renderTrigger={renderModelTrigger}
          triggerFill
        />
      </Field>
      <Field label={t("kanban.cardDetail.dispatchPromptLabel")}>
        {/* AdaptiveTextInput is intentionally uncontrolled and discards `value`;
            initialValue + the parent's key-based remount seed the template. */}
        <FormTextInput
          size="sm"
          initialValue={plan.prompt}
          onChangeText={setPrompt}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
          style={styles.promptInput}
          testID="kanban-card-detail-dispatch-prompt"
        />
      </Field>
      <View style={styles.dispatchBlock}>
        <Text style={styles.dispatchCommand} testID="kanban-card-detail-dispatch-command">
          {dispatchCommand}
        </Text>
        <View style={styles.dispatchButtonRow}>
          <Button
            size="xs"
            variant="secondary"
            leftIcon={Copy}
            onPress={handleCopyDispatch}
            testID="kanban-card-detail-dispatch-copy"
          >
            {t("common.actions.copy")}
          </Button>
          <Button
            size="xs"
            variant="default"
            leftIcon={Play}
            onPress={handleOpenRunSheet}
            disabled={!workspace}
            testID="kanban-card-detail-dispatch-run"
          >
            {t("kanban.cardDetail.dispatchRun")}
          </Button>
        </View>
      </View>
      {workspace ? (
        <DispatchRunConfirmSheet
          visible={isRunSheetVisible}
          onClose={handleCloseRunSheet}
          projectPath={workspace.cwd}
          worktree={plan.worktree}
          providerLabel={confirmProviderLabel}
          promptPreview={prompt}
          onConfirm={handleConfirmRun}
        />
      ) : null}
    </>
  );
}

function DispatchRunConfirmSheet({
  visible,
  onClose,
  projectPath,
  worktree,
  providerLabel,
  promptPreview,
  onConfirm,
}: {
  visible: boolean;
  onClose: () => void;
  projectPath: string;
  worktree: string | null;
  providerLabel: string | null;
  promptPreview: string;
  onConfirm: () => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("kanban.cardDetail.dispatchRunConfirmTitle") }),
    [t],
  );

  const handleConfirm = useCallback(async () => {
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [onClose, onConfirm]);

  const handleConfirmPress = useCallback(() => {
    void handleConfirm();
  }, [handleConfirm]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          size={controlSize}
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSubmitting}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          size={controlSize}
          style={styles.footerButton}
          variant="default"
          onPress={handleConfirmPress}
          disabled={isSubmitting}
          loading={isSubmitting}
          testID="kanban-card-detail-dispatch-run-confirm"
        >
          {t("kanban.cardDetail.dispatchRunConfirmConfirm")}
        </Button>
      </View>
    ),
    [controlSize, handleConfirmPress, isSubmitting, onClose, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      testID="kanban-card-detail-dispatch-run-confirm-sheet"
    >
      <View style={styles.confirmRow}>
        <Text style={styles.confirmLabel}>{t("kanban.cardDetail.dispatchRunConfirmProject")}</Text>
        <Text style={styles.confirmValue}>{projectPath}</Text>
      </View>
      {worktree ? (
        <View style={styles.confirmRow}>
          <Text style={styles.confirmLabel}>
            {t("kanban.cardDetail.dispatchRunConfirmWorktree")}
          </Text>
          <Text style={styles.confirmValue}>{worktree}</Text>
        </View>
      ) : null}
      <View style={styles.confirmRow}>
        <Text style={styles.confirmLabel}>{t("kanban.cardDetail.dispatchRunConfirmProvider")}</Text>
        <Text style={styles.confirmValue}>
          {providerLabel ?? t("kanban.cardDetail.dispatchRunNoProvider")}
        </Text>
      </View>
      <Text style={styles.confirmLabel}>{t("kanban.cardDetail.dispatchRunConfirmPrompt")}</Text>
      <Text style={styles.confirmValue}>{promptPreview}</Text>
      {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}
    </AdaptiveModalSheet>
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
  // Matches the StatusBadge pill shell (rounded, bordered) so the ticket key and
  // the status tag beside it read as one family — only the mono font differs.
  // Kept in sync with the identical copy in kanban-card.tsx.
  issueKeyChip: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
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
  tooltipText: {
    color: theme.colors.popoverForeground,
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
  dispatchButtonRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  promptInput: {
    minHeight: 88,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  confirmRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  confirmLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    width: 80,
  },
  confirmValue: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[2],
  },
  submitError: {
    color: theme.colors.palette.red[300],
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

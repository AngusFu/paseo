import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Plus, RotateCw } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { StoredKanbanConnection, StoredKanbanSource } from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedRotateCw = withUnistyles(RotateCw);
// Icon brightens on hover so the sync button reads as interactive even though it
// sits on the same surface as the row.
const syncIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const syncIconHoverMapping = (theme: Theme) => ({ color: theme.colors.foreground });
import { useKanbanConnections } from "@/hooks/use-kanban-connections";
import { useKanbanSourceMutations } from "@/hooks/use-kanban-source-mutations";
import { useKanbanSources } from "@/hooks/use-kanban-sources";
import { formatTimeAgo } from "@/utils/time";

export interface KanbanSourcesSheetProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  onAddSource: () => void;
  onEditSource: (source: StoredKanbanSource) => void;
}

function kindLabel(kind: StoredKanbanSource["kind"], t: TFunction): string {
  return kind === "gitlab" ? t("kanban.sourceForm.gitlab") : t("kanban.sourceForm.jira");
}

function resolveSyncStatusLabel(source: StoredKanbanSource, t: TFunction): string {
  if (source.lastSyncError) {
    return t("kanban.sources.syncFailed", { error: source.lastSyncError });
  }
  if (source.lastSyncAt) {
    return t("kanban.sources.lastSync", { time: formatTimeAgo(new Date(source.lastSyncAt)) });
  }
  return t("kanban.sources.neverSynced");
}

// The connection line: its name + auth state, or an "unlinked" hint when the
// source has no connection yet (connections are configured in Settings).
function resolveConnectionLabel(
  connection: StoredKanbanConnection | undefined,
  t: TFunction,
): string {
  if (!connection) {
    return t("kanban.sources.noConnection");
  }
  const status = connection.authConnected
    ? t("kanban.connections.connected")
    : t("kanban.connections.notConnected");
  return `${connection.name} · ${status}`;
}

function KanbanSourceRow({
  source,
  connection,
  isSyncing,
  onEdit,
  onSync,
}: {
  source: StoredKanbanSource;
  connection: StoredKanbanConnection | undefined;
  isSyncing: boolean;
  onEdit: (source: StoredKanbanSource) => void;
  onSync: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => onEdit(source), [onEdit, source]);
  const handleSync = useCallback(() => onSync(source.id), [onSync, source.id]);
  const syncStatus = resolveSyncStatusLabel(source, t);
  const connectionLabel = resolveConnectionLabel(connection, t);
  const syncButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.syncButton,
      !isSyncing && (Boolean(hovered) || pressed) && styles.syncButtonHovered,
    ],
    [isSyncing],
  );
  const renderSyncIcon = useCallback(
    ({ hovered }: { hovered?: boolean }): ReactElement =>
      isSyncing ? (
        <LoadingSpinner size="small" color={styles.syncIcon.color} />
      ) : (
        <ThemedRotateCw size={16} uniProps={hovered ? syncIconHoverMapping : syncIconMapping} />
      ),
    [isSyncing],
  );

  return (
    <Pressable
      style={styles.row}
      onPress={handleEdit}
      accessibilityRole="button"
      accessibilityLabel={source.name}
      testID={`kanban-source-row-${source.id}`}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {source.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {`${kindLabel(source.kind, t)} · ${connectionLabel}`}
        </Text>
        <Text style={source.lastSyncError ? styles.rowError : styles.rowMeta} numberOfLines={1}>
          {syncStatus}
        </Text>
      </View>
      <Pressable
        style={syncButtonStyle}
        onPress={handleSync}
        disabled={isSyncing}
        // The row itself is a Pressable (accessibilityRole="button"), which
        // renders a <button> on web — a nested <button> is invalid HTML and
        // throws a hydration error. Drop the role on web so this renders a
        // <div>; keep it on native for the accessibility tree.
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={t("kanban.sources.sync")}
        testID={`kanban-source-sync-${source.id}`}
        hitSlop={8}
      >
        {renderSyncIcon}
      </Pressable>
    </Pressable>
  );
}

/**
 * Manage the active host's Jira / GitLab sources: list with per-source
 * connection + sync status, a per-row sync action, and add/edit. Auth
 * connections themselves are managed in Settings → Integrations.
 */
export function KanbanSourcesSheet({
  serverId,
  visible,
  onClose,
  onAddSource,
  onEditSource,
}: KanbanSourcesSheetProps): ReactElement {
  const { t } = useTranslation();
  const { connections } = useKanbanConnections(serverId);
  const { sources, isLoading } = useKanbanSources(serverId);
  const mutations = useKanbanSourceMutations({ serverId });
  const header = useMemo<SheetHeader>(() => ({ title: t("kanban.sources.title") }), [t]);

  const connectionsById = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections],
  );

  // Track the specific source being synced. The mutation hook only exposes a
  // single global isPending, so keying loading off it would spin every row's
  // button when one is synced.
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const handleSync = useCallback(
    (id: string) => {
      setSyncingId(id);
      // Swallow the rejection so a failed sync doesn't crash the app; the error
      // lands in this source's row via lastSyncError after the refetch.
      void mutations
        .syncSource(id)
        .catch(() => undefined)
        .finally(() => setSyncingId((current) => (current === id ? null : current)));
    },
    [mutations],
  );

  const body = useMemo(() => {
    if (isLoading) {
      return (
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      );
    }
    if (sources.length === 0) {
      return (
        <Text style={styles.emptyText} testID="kanban-sources-empty">
          {t("kanban.sources.empty")}
        </Text>
      );
    }
    return (
      <View style={styles.list}>
        {sources.map((source) => (
          <KanbanSourceRow
            key={source.id}
            source={source}
            connection={source.connectionId ? connectionsById.get(source.connectionId) : undefined}
            isSyncing={syncingId === source.id}
            onEdit={onEditSource}
            onSync={handleSync}
          />
        ))}
      </View>
    );
  }, [connectionsById, handleSync, isLoading, syncingId, onEditSource, sources, t]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="kanban-sources-sheet"
    >
      {body}
      <Button variant="outline" leftIcon={Plus} onPress={onAddSource} testID="kanban-sources-add">
        {t("kanban.sources.add")}
      </Button>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[8],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[3],
  },
  list: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  syncButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  syncButtonHovered: {
    backgroundColor: theme.colors.surface4,
  },
  syncIcon: {
    color: theme.colors.foregroundMuted,
  },
}));

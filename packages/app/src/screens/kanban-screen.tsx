import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { Plus, RotateCw, SquareKanban } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { KanbanCardSheet } from "@/components/kanban/kanban-card-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useKanbanCards } from "@/hooks/use-kanban-cards";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";

export function KanbanScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <KanbanScreenContent />;
}

function KanbanScreenContent(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  // Single active host for v1 (no multi-host aggregation). The first host is the
  // board's scope; capability detection happens once against it.
  const serverId = hosts[0]?.serverId ?? null;
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (connectionStatuses.get(serverId) ?? "connecting") : null;
  const isOnline = connectionStatus === "online";
  // Still settling (not yet online, not failed) → show a spinner rather than a
  // false offline/empty state. A truly offline/disconnected host falls through.
  const isConnecting = connectionStatus === "connecting" || connectionStatus === "idle";
  const kanbanSupported = useHostFeature(serverId, "kanban");

  const active = Boolean(serverId && isOnline && kanbanSupported);
  const { cards, isLoading, isError, refetch } = useKanbanCards(active ? serverId : null);
  const mutations = useKanbanMutations({ serverId: serverId ?? "" });

  const [createOpen, setCreateOpen] = useState(false);
  // Bump on each open so the create sheet remounts with empty fields.
  const [createNonce, setCreateNonce] = useState(0);
  const openCreate = useCallback(() => {
    setCreateNonce((nonce) => nonce + 1);
    setCreateOpen(true);
  }, []);
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const handleSync = useCallback(() => {
    void mutations.syncSources();
  }, [mutations]);

  return (
    <View style={styles.container}>
      <MenuHeader title={t("kanban.title")} />
      <KanbanScreenBody
        serverId={serverId}
        isOnline={isOnline}
        isConnecting={isConnecting}
        kanbanSupported={kanbanSupported}
        cards={cards}
        isLoading={isLoading}
        isError={isError}
        onRetry={refetch}
        onCreate={openCreate}
        onSync={handleSync}
        isSyncing={mutations.isSyncing}
        mutations={mutations}
      />
      <KanbanCardSheet
        key={`create:${createNonce}`}
        visible={createOpen}
        mode="create"
        onClose={closeCreate}
        onCreate={mutations.createCard}
        onUpdate={mutations.updateCard}
        onDelete={mutations.deleteCard}
      />
    </View>
  );
}

interface KanbanScreenBodyProps {
  serverId: string | null;
  isOnline: boolean;
  isConnecting: boolean;
  kanbanSupported: boolean;
  cards: ReturnType<typeof useKanbanCards>["cards"];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onSync: () => void;
  isSyncing: boolean;
  mutations: ReturnType<typeof useKanbanMutations>;
}

function KanbanScreenBody({
  serverId,
  isOnline,
  isConnecting,
  kanbanSupported,
  cards,
  isLoading,
  isError,
  onRetry,
  onCreate,
  onSync,
  isSyncing,
  mutations,
}: KanbanScreenBodyProps): ReactElement {
  const { t } = useTranslation();

  // Host reachable but without the capability → single, localized upgrade prompt.
  if (serverId && isOnline && !kanbanSupported) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message} testID="kanban-unsupported">
          {t("kanban.unsupported")}
        </Text>
      </View>
    );
  }

  // Spinner only while actively loading cards or while the host is still
  // settling — never when disconnected/offline (that falls through to empty).
  if (isLoading || isConnecting) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (isError && cards.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("kanban.loadError")}</Text>
        <Button variant="ghost" onPress={onRetry} testID="kanban-retry">
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <View style={styles.actionsRow}>
        <Button variant="outline" leftIcon={Plus} onPress={onCreate} size="sm" testID="kanban-add">
          {t("kanban.actions.add")}
        </Button>
        <Button
          variant="ghost"
          leftIcon={RotateCw}
          onPress={onSync}
          size="sm"
          loading={isSyncing}
          testID="kanban-sync"
        >
          {t("kanban.actions.sync")}
        </Button>
      </View>
      {cards.length > 0 ? (
        <KanbanBoard cards={cards} mutations={mutations} />
      ) : (
        <View style={styles.centered}>
          <View style={styles.emptyState} testID="kanban-empty">
            <SquareKanban size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
            <Text style={styles.emptyTitle}>{t("kanban.empty")}</Text>
            <Button variant="outline" leftIcon={Plus} onPress={onCreate} testID="kanban-empty-add">
              {t("kanban.actions.add")}
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[4],
    maxWidth: 420,
    width: "100%",
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  // Static color holder read by the spinner (no useUnistyles in new code).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
}));

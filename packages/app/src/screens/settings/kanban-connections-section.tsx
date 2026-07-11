import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { StoredKanbanConnection } from "@getpaseo/protocol/kanban/types";
import { KanbanConnectionFormSheet } from "@/components/kanban/kanban-connection-form-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useKanbanConnections } from "@/hooks/use-kanban-connections";

type ConnectionFormState =
  | { mode: "create" }
  | { mode: "edit"; connection: StoredKanbanConnection }
  | null;

function kindLabel(kind: StoredKanbanConnection["kind"], t: TFunction): string {
  return kind === "gitlab" ? t("kanban.connectionForm.gitlab") : t("kanban.connectionForm.jira");
}

function ConnectionRow({
  connection,
  onEdit,
}: {
  connection: StoredKanbanConnection;
  onEdit: (connection: StoredKanbanConnection) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => onEdit(connection), [connection, onEdit]);
  const statusLabel = connection.authConnected
    ? t("kanban.connections.connected")
    : t("kanban.connections.notConnected");

  return (
    <Pressable
      style={styles.row}
      onPress={handleEdit}
      accessibilityRole="button"
      accessibilityLabel={connection.name}
      testID={`kanban-connection-row-${connection.id}`}
    >
      <Text style={styles.rowTitle} numberOfLines={1}>
        {connection.name}
      </Text>
      <Text style={styles.rowMeta} numberOfLines={1}>
        {`${kindLabel(connection.kind, t)} · ${statusLabel}`}
      </Text>
    </Pressable>
  );
}

/**
 * Settings home for reusable Jira / GitLab auth connections (host-scoped). List
 * + add/edit/delete; credentials and the Connect (OAuth) button live in the
 * connection form. Kanban sources reference a connection by id.
 */
export function KanbanConnectionsSection({ serverId }: { serverId: string }): ReactElement {
  const { t } = useTranslation();
  const { connections, isLoading } = useKanbanConnections(serverId);
  const [form, setForm] = useState<ConnectionFormState>(null);
  const [nonce, setNonce] = useState(0);

  const openAdd = useCallback(() => {
    setNonce((current) => current + 1);
    setForm({ mode: "create" });
  }, []);
  const openEdit = useCallback((connection: StoredKanbanConnection) => {
    setNonce((current) => current + 1);
    setForm({ mode: "edit", connection });
  }, []);
  const close = useCallback(() => setForm(null), []);

  const listBody = useMemo(() => {
    if (isLoading) {
      return (
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      );
    }
    if (connections.length === 0) {
      return (
        <Text style={styles.emptyText} testID="kanban-connections-empty">
          {t("kanban.connections.empty")}
        </Text>
      );
    }
    return (
      <View style={styles.list}>
        {connections.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} onEdit={openEdit} />
        ))}
      </View>
    );
  }, [connections, isLoading, openEdit, t]);

  return (
    <>
      <SettingsSection title={t("kanban.connections.title")}>
        {listBody}
        <Button variant="outline" leftIcon={Plus} onPress={openAdd} testID="kanban-connections-add">
          {t("kanban.connections.add")}
        </Button>
      </SettingsSection>

      <KanbanConnectionFormSheet
        key={`kanban-connection-form:${nonce}`}
        serverId={serverId}
        visible={form !== null}
        mode={form?.mode === "edit" ? "edit" : "create"}
        connection={form?.mode === "edit" ? form.connection : undefined}
        onClose={close}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[6],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  list: {
    gap: theme.spacing[2],
  },
  row: {
    gap: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
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
}));

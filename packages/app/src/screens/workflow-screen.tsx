// oxlint-disable react-perf/jsx-no-new-function-as-prop
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { Play, Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { WorkflowDefinition } from "@getpaseo/protocol/workflow/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  useBuiltinWorkflowDefinitions,
  useWorkflowDefinitions,
} from "@/hooks/use-workflow-definitions";
import { useWorkflowMutations } from "@/hooks/use-workflow-mutations";
import { useWorkflowRuns } from "@/hooks/use-workflow-runs";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";

const BLANK_WORKFLOW_SOURCE = `/// <reference path="" />
export const meta = {
  name: "New workflow",
  description: "Blank workflow — edit with paseo-create-workflow",
  phases: [{ title: "Work", detail: "Replace this phase" }],
};

phase("Work");
const task = typeof args === "string" ? args : (args && args.task) || "";
const result = await agent(
  task
    ? "Complete this task and summarize the outcome:\\n" + task
    : "No task was provided. Reply with a one-line ready status.",
  { label: "work", phase: "Work" },
);
if (!result) return { error: "work agent returned null" };
return { ok: true, summary: result };
`;

export function WorkflowScreen(): ReactElement {
  const isFocused = useIsFocused();
  return isFocused ? <WorkflowScreenContent /> : <View style={styles.container} />;
}

function WorkflowScreenContent(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? null;
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const status = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const supported = useHostFeature(serverId, "workflow");
  const active = Boolean(serverId && status === "online" && supported);
  const definitions = useWorkflowDefinitions(active ? serverId : null);
  const builtins = useBuiltinWorkflowDefinitions(active ? serverId : null);
  const runs = useWorkflowRuns(active ? serverId : null);
  const mutations = useWorkflowMutations({ serverId: serverId ?? "" });
  const [createOpen, setCreateOpen] = useState(false);

  const dispatch = useCallback(
    (definitionId: string) => void mutations.dispatch({ definitionId }).catch(() => undefined),
    [mutations],
  );
  const copyBuiltin = useCallback(
    (definition: WorkflowDefinition) =>
      void mutations
        .create({
          name: definition.name,
          description: definition.description,
          source: definition.source,
        })
        .then(() => setCreateOpen(false))
        .catch(() => undefined),
    [mutations],
  );

  if (serverId && status === "online" && !supported) {
    return (
      <View style={styles.container}>
        <MenuHeader title={t("workflows.title")} />
        <View style={styles.centered}>
          <Text style={styles.message}>{t("workflows.unsupported")}</Text>
        </View>
      </View>
    );
  }
  if (status === "connecting" || status === "idle" || definitions.isLoading) {
    return (
      <View style={styles.container}>
        <MenuHeader title={t("workflows.title")} />
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <MenuHeader title={t("workflows.title")} />
      <View style={styles.body}>
        <View style={styles.actions}>
          <Button leftIcon={Plus} onPress={() => setCreateOpen(true)} size="sm">
            {t("workflows.actions.create")}
          </Button>
        </View>
        <Text style={styles.sectionTitle}>{t("workflows.definitions")}</Text>
        {definitions.definitions.length === 0 ? (
          <Text style={styles.empty}>{t("workflows.emptyDefinitions")}</Text>
        ) : (
          definitions.definitions.map((definition) => (
            <View key={definition.id} style={styles.card}>
              <View style={styles.cardText}>
                <View style={styles.titleRow}>
                  <Text style={styles.cardTitle}>{definition.name}</Text>
                  {definition.builtin ? (
                    <Text style={styles.badge}>{t("workflows.builtin")}</Text>
                  ) : null}
                </View>
                {definition.description ? (
                  <Text style={styles.meta}>{definition.description}</Text>
                ) : null}
              </View>
              <Button
                variant="outline"
                leftIcon={Play}
                size="sm"
                loading={mutations.isDispatching}
                onPress={() => dispatch(definition.id)}
              >
                {t("workflows.actions.dispatch")}
              </Button>
            </View>
          ))
        )}
        <Text style={styles.sectionTitle}>{t("workflows.recentRuns")}</Text>
        {runs.runs.length === 0 ? (
          <Text style={styles.empty}>{t("workflows.emptyRuns")}</Text>
        ) : (
          runs.runs.slice(0, 10).map((run) => (
            <View key={run.id} style={styles.run}>
              <Text style={styles.runStatus}>{t(`workflows.status.${run.status}`)}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {run.workspacePath}
              </Text>
            </View>
          ))
        )}
      </View>
      <WorkflowCreateSheet
        visible={createOpen}
        isCreating={mutations.isCreating}
        builtins={builtins.definitions}
        onClose={() => setCreateOpen(false)}
        onCreate={(name) =>
          mutations
            .create({ name, source: BLANK_WORKFLOW_SOURCE.replace("New workflow", name) })
            .then(() => setCreateOpen(false))
        }
        onCopyBuiltin={copyBuiltin}
      />
    </View>
  );
}

function WorkflowCreateSheet({
  visible,
  isCreating,
  builtins,
  onClose,
  onCreate,
  onCopyBuiltin,
}: {
  visible: boolean;
  isCreating: boolean;
  builtins: WorkflowDefinition[];
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onCopyBuiltin: (definition: WorkflowDefinition) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const header = useMemo<SheetHeader>(() => ({ title: t("workflows.createTitle") }), [t]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="workflow-create-sheet"
    >
      <Field label={t("workflows.name")}>
        <FormTextInput
          value={name}
          initialValue={name}
          onChangeText={setName}
          placeholder={t("workflows.namePlaceholder")}
        />
      </Field>
      <Button
        disabled={!name.trim() || isCreating}
        loading={isCreating}
        onPress={() => void onCreate(name.trim())}
      >
        {t("workflows.actions.createBlank")}
      </Button>
      <Text style={styles.sheetHeading}>{t("workflows.createFromBuiltin")}</Text>
      {builtins.map((builtin) => (
        <Button
          key={builtin.id}
          variant="outline"
          disabled={isCreating}
          onPress={() => onCopyBuiltin(builtin)}
        >
          {builtin.name}
        </Button>
      ))}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  body: { flex: 1, gap: theme.spacing[3], padding: theme.spacing[6] },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  spinner: { color: theme.colors.foregroundMuted },
  actions: { flexDirection: "row" },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    marginTop: theme.spacing[2],
  },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  titleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  badge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    backgroundColor: theme.colors.surface4,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  run: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  runStatus: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  sheetHeading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    marginTop: theme.spacing[3],
  },
}));

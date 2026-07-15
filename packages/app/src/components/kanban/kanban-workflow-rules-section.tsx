// oxlint-disable react-perf/jsx-no-new-function-as-prop
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import {
  useKanbanWorkflowRuleMutations,
  useKanbanWorkflowRules,
} from "@/hooks/use-kanban-workflow-rules";
import { useWorkflowDefinitions } from "@/hooks/use-workflow-definitions";
import { useTranslation } from "react-i18next";

function labelsFromInput(value: string): string[] | undefined {
  const labels = value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  return labels.length ? labels : undefined;
}

export function KanbanWorkflowRulesSection({
  serverId,
  sourceId,
}: {
  serverId: string;
  sourceId: string;
}): ReactElement {
  const { t } = useTranslation();
  const { rules } = useKanbanWorkflowRules(serverId);
  const { definitions } = useWorkflowDefinitions(serverId);
  const mutations = useKanbanWorkflowRuleMutations({ serverId });
  const [definitionId, setDefinitionId] = useState("");
  const [titleRegex, setTitleRegex] = useState("");
  const [labels, setLabels] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const sourceRules = useMemo(
    () => rules.filter((rule) => rule.sourceId === sourceId),
    [rules, sourceId],
  );
  const createRule = useCallback(() => {
    if (!definitionId) return;
    void mutations
      .create({
        sourceId,
        workflowDefinitionId: definitionId,
        enabled,
        filter: {
          ...(titleRegex.trim() ? { titleRegex: titleRegex.trim() } : {}),
          ...(labelsFromInput(labels) ? { labelsAny: labelsFromInput(labels) } : {}),
          ...(projectKey.trim() ? { projectKey: projectKey.trim() } : {}),
        },
      })
      .then(() => {
        setDefinitionId("");
        setTitleRegex("");
        setLabels("");
        setProjectKey("");
        return undefined;
      })
      .catch(() => undefined);
  }, [definitionId, enabled, labels, mutations, projectKey, sourceId, titleRegex]);

  return (
    <View style={styles.section}>
      <Text style={styles.title}>{t("kanban.workflowRules.title")}</Text>
      {sourceRules.map((rule) => {
        const definition = definitions.find((item) => item.id === rule.workflowDefinitionId);
        return (
          <View key={rule.id} style={styles.rule}>
            <View style={styles.ruleText}>
              <Text style={styles.ruleName}>{definition?.name ?? rule.workflowDefinitionId}</Text>
              <Text style={styles.meta}>
                {rule.filter.titleRegex ||
                  rule.filter.labelsAny?.join(", ") ||
                  rule.filter.projectKey ||
                  t("kanban.workflowRules.allCards")}
              </Text>
            </View>
            <Switch
              value={rule.enabled}
              onValueChange={(next) => void mutations.update({ id: rule.id, enabled: next })}
            />
            <Button variant="ghost" size="sm" onPress={() => void mutations.remove(rule.id)}>
              {t("kanban.workflowRules.delete")}
            </Button>
          </View>
        );
      })}
      <Field label={t("kanban.workflowRules.workflow")}>
        <View style={styles.definitionChoices}>
          {definitions.map((definition) => (
            <Button
              key={definition.id}
              size="sm"
              variant={definitionId === definition.id ? "default" : "outline"}
              onPress={() => setDefinitionId(definition.id)}
            >
              {definition.name}
            </Button>
          ))}
        </View>
      </Field>
      <Field label={t("kanban.workflowRules.titleRegex")}>
        <FormTextInput value={titleRegex} initialValue={titleRegex} onChangeText={setTitleRegex} />
      </Field>
      <Field label={t("kanban.workflowRules.labels")} hint={t("kanban.workflowRules.labelsHint")}>
        <FormTextInput value={labels} initialValue={labels} onChangeText={setLabels} />
      </Field>
      <Field label={t("kanban.workflowRules.projectKey")}>
        <FormTextInput value={projectKey} initialValue={projectKey} onChangeText={setProjectKey} />
      </Field>
      <Field label={t("kanban.workflowRules.enabled")}>
        <Switch value={enabled} onValueChange={setEnabled} />
      </Field>
      <Button variant="outline" disabled={!definitionId} onPress={createRule}>
        {t("kanban.workflowRules.add")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[4],
    marginTop: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  rule: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
  },
  ruleText: { flex: 1, minWidth: 0 },
  ruleName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  definitionChoices: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));

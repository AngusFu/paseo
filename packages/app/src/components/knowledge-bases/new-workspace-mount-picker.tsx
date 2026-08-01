import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react-native";
import type { KnowledgeBase } from "@getpaseo/protocol/knowledge-base/types";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import {
  createEmptyMountPickerSelection,
  isKnowledgeBaseSelected,
  listMountSelections,
  setMountSlugOverride,
  toggleKnowledgeBaseSelection,
  type KnowledgeBaseMountSelection,
  type MountPickerSelectionMap,
} from "@/knowledge-bases/mount-selection";
import { useKnowledgeBases } from "@/knowledge-bases/use-knowledge-bases";
import { vfsPathForMountSlug } from "@/knowledge-bases/mount-slug";
import type { Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const checkColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export interface NewWorkspaceMountPickerProps {
  serverId: string;
  disabled?: boolean;
  onSelectionChange: (selections: KnowledgeBaseMountSelection[]) => void;
}

function MountCheckbox({ checked }: { checked: boolean }): ReactElement {
  return (
    <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
      {checked ? <ThemedCheck size={12} uniProps={checkColorMapping} /> : null}
    </View>
  );
}

function MountRow({
  knowledgeBase,
  selected,
  mountSlug,
  disabled,
  controlSize,
  onToggle,
  onChangeMountSlug,
}: {
  knowledgeBase: KnowledgeBase;
  selected: boolean;
  mountSlug: string;
  disabled: boolean;
  controlSize: FieldControlSize;
  onToggle: (knowledgeBase: KnowledgeBase) => void;
  onChangeMountSlug: (knowledgeBaseId: string, mountSlug: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const previewSlug = mountSlug.trim() || knowledgeBase.slug;
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      !disabled && (Boolean(hovered) || pressed) && styles.rowHovered,
      disabled && styles.rowDisabled,
    ],
    [disabled],
  );
  const handleToggle = useCallback(() => {
    onToggle(knowledgeBase);
  }, [knowledgeBase, onToggle]);
  const handleSlugChange = useCallback(
    (value: string) => {
      onChangeMountSlug(knowledgeBase.id, value);
    },
    [knowledgeBase.id, onChangeMountSlug],
  );
  const accessibilityState = useMemo(() => ({ checked: selected }), [selected]);

  return (
    <View style={styles.rowCard} testID={`new-workspace-kb-mount-row-${knowledgeBase.id}`}>
      <Pressable
        style={rowStyle}
        onPress={handleToggle}
        disabled={disabled}
        accessibilityRole="checkbox"
        accessibilityState={accessibilityState}
        accessibilityLabel={knowledgeBase.name || knowledgeBase.slug}
      >
        <MountCheckbox checked={selected} />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {knowledgeBase.name || knowledgeBase.slug}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {t("knowledgeBases.pathPreview", { slug: previewSlug })}
          </Text>
        </View>
      </Pressable>
      {selected ? (
        <View style={styles.slugField}>
          <Field label={t("knowledgeBases.mountSlug")}>
            <FormTextInput
              size={controlSize}
              testID={`new-workspace-kb-mount-slug-${knowledgeBase.id}`}
              accessibilityLabel={t("knowledgeBases.mountSlug")}
              value={mountSlug}
              onChangeText={handleSlugChange}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!disabled}
            />
          </Field>
          <Text style={styles.pathHint}>{vfsPathForMountSlug(previewSlug)}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Optional New Workspace section: multi-select Knowledge bases to mount after create.
 * Hidden when capability missing; shown (incl. empty catalog) once list reaches loaded.
 */
export function NewWorkspaceMountPicker({
  serverId,
  disabled = false,
  onSelectionChange,
}: NewWorkspaceMountPickerProps): ReactElement | null {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const { loadState, knowledgeBases, supported } = useKnowledgeBases(serverId);
  const [selection, setSelection] = useState<MountPickerSelectionMap>(
    createEmptyMountPickerSelection,
  );

  const publish = useCallback(
    (next: MountPickerSelectionMap) => {
      setSelection(next);
      onSelectionChange(listMountSelections({ selection: next, knowledgeBases }));
    },
    [knowledgeBases, onSelectionChange],
  );

  const handleToggle = useCallback(
    (knowledgeBase: KnowledgeBase) => {
      publish(toggleKnowledgeBaseSelection({ selection, knowledgeBase }));
    },
    [publish, selection],
  );

  const handleSlugChange = useCallback(
    (knowledgeBaseId: string, mountSlug: string) => {
      publish(setMountSlugOverride({ selection, knowledgeBaseId, mountSlug }));
    },
    [publish, selection],
  );

  if (!supported) {
    return null;
  }

  if (loadState.status !== "loaded") {
    return (
      <View style={styles.section} testID="new-workspace-kb-mounts-loading">
        <Text style={styles.sectionTitle}>{t("knowledgeBases.mountKnowledgeBases")}</Text>
        <Text style={styles.optional}>{t("knowledgeBases.optional")}</Text>
        <View style={styles.loading}>
          <LoadingSpinner size="small" color={styles.spinner.color} />
        </View>
      </View>
    );
  }

  const selectedCount = Object.keys(selection).length;

  return (
    <View style={styles.section} testID="new-workspace-kb-mounts">
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{t("knowledgeBases.mountKnowledgeBases")}</Text>
        <Text style={styles.optional}>{t("knowledgeBases.optional")}</Text>
      </View>

      {knowledgeBases.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>{t("knowledgeBases.emptyCatalog")}</Text>
          <Text style={styles.emptyHint}>{t("knowledgeBases.emptyCatalogHint")}</Text>
        </View>
      ) : (
        <View style={styles.list}>
          {knowledgeBases.map((knowledgeBase) => {
            const selected = isKnowledgeBaseSelected(selection, knowledgeBase.id);
            const mountSlug = selection[knowledgeBase.id] ?? knowledgeBase.slug;
            return (
              <MountRow
                key={knowledgeBase.id}
                knowledgeBase={knowledgeBase}
                selected={selected}
                mountSlug={mountSlug}
                disabled={disabled}
                controlSize={controlSize}
                onToggle={handleToggle}
                onChangeMountSlug={handleSlugChange}
              />
            );
          })}
          {selectedCount === 0 ? (
            <Text style={styles.noneSelected} testID="new-workspace-kb-mounts-none-selected">
              {t("knowledgeBases.noneSelected")}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    width: "100%",
    marginBottom: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  optional: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  loading: {
    paddingVertical: theme.spacing[4],
    alignItems: "flex-start",
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  list: {
    gap: theme.spacing[2],
  },
  emptyCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[1],
  },
  emptyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  emptyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  noneSelected: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  rowCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface3,
  },
  rowDisabled: {
    opacity: 0.6,
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
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
  },
  checkboxChecked: {
    backgroundColor: theme.colors.surface4,
    borderColor: theme.colors.foregroundMuted,
  },
  slugField: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
  pathHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

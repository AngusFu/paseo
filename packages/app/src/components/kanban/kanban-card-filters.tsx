import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ListFilter, Search, X } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  KANBAN_DATE_RANGE_OPTIONS,
  UNASSIGNED_ASSIGNEE_FILTER,
  type KanbanCardDateRangeFilter,
  type KanbanCardSourceKindFilter,
  type UseKanbanCardFiltersResult,
} from "@/hooks/use-kanban-card-filters";
import type { Theme } from "@/styles/theme";

const SEARCH_ICON_SIZE = 14;
const CLEAR_ICON_SIZE = 12;
const CHEVRON_ICON_SIZE = 12;
const TRIGGER_ICON_SIZE = 14;

const ThemedSearch = withUnistyles(Search);
const ThemedX = withUnistyles(X);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedListFilter = withUnistyles(ListFilter);
const ThemedTextInput = withUnistyles(TextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const activeColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

interface SearchFilterFieldProps {
  search: string;
  onSearchChange: (value: string) => void;
  onClear: () => void;
  style?: StyleProp<ViewStyle>;
  testID: string;
}

function SearchFilterField({
  search,
  onSearchChange,
  onClear,
  style,
  testID,
}: SearchFilterFieldProps): ReactElement {
  const { t } = useTranslation();
  const fieldStyle = useMemo(
    () => [styles.searchField, search ? styles.searchFieldActive : null, style],
    [search, style],
  );
  return (
    <View style={fieldStyle}>
      <ThemedSearch size={SEARCH_ICON_SIZE} uniProps={mutedColorMapping} />
      <ThemedTextInput
        testID={testID}
        value={search}
        onChangeText={onSearchChange}
        accessibilityLabel={t("kanban.filters.searchLabel")}
        placeholder={t("kanban.filters.searchPlaceholder")}
        // @ts-expect-error - outlineStyle is web-only
        style={getSearchInputStyle()}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {search ? (
        <Pressable
          hitSlop={8}
          onPress={onClear}
          accessibilityRole="button"
          accessibilityLabel={t("kanban.filters.clearSearch")}
          testID={`${testID}-clear`}
        >
          <ThemedX size={CLEAR_ICON_SIZE} uniProps={mutedColorMapping} />
        </Pressable>
      ) : null}
    </View>
  );
}

interface SourceKindFilterControlProps {
  sourceKind: KanbanCardSourceKindFilter;
  onSourceKindChange: (value: KanbanCardSourceKindFilter) => void;
  onClear: () => void;
  testID: string;
}

function SourceKindFilterControl({
  sourceKind,
  onSourceKindChange,
  onClear,
  testID,
}: SourceKindFilterControlProps): ReactElement {
  const { t } = useTranslation();
  const options = useMemo<SegmentedControlOption<KanbanCardSourceKindFilter>[]>(
    () => [
      { value: "all", label: t("kanban.filters.source.all") },
      { value: "jira", label: t("kanban.filters.source.jira") },
      { value: "gitlab", label: t("kanban.filters.source.gitlab") },
      { value: "manual", label: t("kanban.filters.source.manual") },
    ],
    [t],
  );
  const isActive = sourceKind !== "all";
  return (
    <View style={styles.sourceKindRow}>
      <SegmentedControl
        options={options}
        value={sourceKind}
        onValueChange={onSourceKindChange}
        size="sm"
        testID={testID}
      />
      {isActive ? (
        <Pressable
          hitSlop={8}
          onPress={onClear}
          accessibilityRole="button"
          accessibilityLabel={t("kanban.filters.source.clear")}
          style={styles.clearButton}
          testID={`${testID}-clear`}
        >
          <ThemedX size={CLEAR_ICON_SIZE} uniProps={mutedColorMapping} />
        </Pressable>
      ) : null}
    </View>
  );
}

interface DateRangeFilterControlProps {
  dateRange: KanbanCardDateRangeFilter;
  onDateRangeChange: (value: KanbanCardDateRangeFilter) => void;
  testID: string;
}

function DateRangeFilterControl({
  dateRange,
  onDateRangeChange,
  testID,
}: DateRangeFilterControlProps): ReactElement {
  const { t } = useTranslation();
  const options = useMemo<SegmentedControlOption<KanbanCardDateRangeFilter>[]>(
    () =>
      KANBAN_DATE_RANGE_OPTIONS.map((value) => ({
        value,
        label: t(`kanban.filters.dateRange.${value}`),
      })),
    [t],
  );
  return (
    <SegmentedControl
      options={options}
      value={dateRange}
      onValueChange={onDateRangeChange}
      size="sm"
      testID={testID}
    />
  );
}

interface AssigneeMenuItemsProps {
  assignee: string | null;
  onAssigneeChange: (value: string | null) => void;
  assigneeOptions: string[];
  hasUnassignedCards: boolean;
  closeOnSelect: boolean;
}

// Shared list of assignee options rendered as DropdownMenuItems — reused by
// the wide-layout chip's own menu and the compact panel's flattened list.
function AssigneeMenuItems({
  assignee,
  onAssigneeChange,
  assigneeOptions,
  hasUnassignedCards,
  closeOnSelect,
}: AssigneeMenuItemsProps): ReactElement {
  const { t } = useTranslation();
  const handleSelectAll = useCallback(() => onAssigneeChange(null), [onAssigneeChange]);
  const handleSelectUnassigned = useCallback(
    () => onAssigneeChange(UNASSIGNED_ASSIGNEE_FILTER),
    [onAssigneeChange],
  );
  return (
    <>
      <DropdownMenuItem
        selected={assignee === null}
        showSelectedCheck
        closeOnSelect={closeOnSelect}
        onSelect={handleSelectAll}
      >
        {t("kanban.filters.assignee.all")}
      </DropdownMenuItem>
      {hasUnassignedCards ? (
        <DropdownMenuItem
          selected={assignee === UNASSIGNED_ASSIGNEE_FILTER}
          showSelectedCheck
          closeOnSelect={closeOnSelect}
          onSelect={handleSelectUnassigned}
        >
          {t("kanban.filters.assignee.unassigned")}
        </DropdownMenuItem>
      ) : null}
      {assigneeOptions.map((name) => (
        <AssigneeMenuItem
          key={name}
          name={name}
          selected={assignee === name}
          closeOnSelect={closeOnSelect}
          onAssigneeChange={onAssigneeChange}
        />
      ))}
    </>
  );
}

function AssigneeMenuItem({
  name,
  selected,
  closeOnSelect,
  onAssigneeChange,
}: {
  name: string;
  selected: boolean;
  closeOnSelect: boolean;
  onAssigneeChange: (value: string | null) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onAssigneeChange(name), [name, onAssigneeChange]);
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      closeOnSelect={closeOnSelect}
      onSelect={handleSelect}
    >
      {name}
    </DropdownMenuItem>
  );
}

interface AssigneeFilterControlProps {
  assignee: string | null;
  onAssigneeChange: (value: string | null) => void;
  assigneeOptions: string[];
  hasUnassignedCards: boolean;
  testID: string;
}

function AssigneeFilterControl({
  assignee,
  onAssigneeChange,
  assigneeOptions,
  hasUnassignedCards,
  testID,
}: AssigneeFilterControlProps): ReactElement {
  const { t } = useTranslation();
  const isActive = assignee !== null;
  let label: string;
  if (assignee === null) {
    label = t("kanban.filters.assignee.all");
  } else if (assignee === UNASSIGNED_ASSIGNEE_FILTER) {
    label = t("kanban.filters.assignee.unassigned");
  } else {
    label = assignee;
  }

  const handleClear = useCallback(() => onAssigneeChange(null), [onAssigneeChange]);

  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.chipTrigger,
      isActive ? styles.chipTriggerActive : null,
      hovered && !pressed ? styles.chipTriggerHovered : null,
      pressed ? styles.chipTriggerPressed : null,
    ],
    [isActive],
  );

  const labelStyle = useMemo(
    () => [styles.chipText, isActive ? styles.chipTextActive : null],
    [isActive],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        accessibilityLabel={t("kanban.filters.assignee.label")}
        style={triggerStyle}
        testID={testID}
      >
        <Text style={labelStyle} numberOfLines={1}>
          {label}
        </Text>
        {isActive ? (
          <Pressable
            hitSlop={8}
            onPress={handleClear}
            accessibilityRole="button"
            accessibilityLabel={t("kanban.filters.assignee.clear")}
            testID={`${testID}-clear`}
          >
            <ThemedX size={CLEAR_ICON_SIZE} uniProps={mutedColorMapping} />
          </Pressable>
        ) : (
          <ThemedChevronDown size={CHEVRON_ICON_SIZE} uniProps={mutedColorMapping} />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" minWidth={200} testID={`${testID}-content`}>
        <AssigneeMenuItems
          assignee={assignee}
          onAssigneeChange={onAssigneeChange}
          assigneeOptions={assigneeOptions}
          hasUnassignedCards={hasUnassignedCards}
          closeOnSelect
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface KanbanCardFiltersProps {
  filters: UseKanbanCardFiltersResult;
}

function InlineFilters({ filters }: KanbanCardFiltersProps): ReactElement {
  const hasAssigneeOptions = filters.assigneeOptions.length > 0 || filters.hasUnassignedCards;
  return (
    <View style={styles.inlineRow}>
      <SearchFilterField
        search={filters.search}
        onSearchChange={filters.setSearch}
        onClear={filters.clearSearch}
        style={styles.searchFieldInline}
        testID="kanban-filter-search"
      />
      <SourceKindFilterControl
        sourceKind={filters.sourceKind}
        onSourceKindChange={filters.setSourceKind}
        onClear={filters.clearSourceKind}
        testID="kanban-filter-source"
      />
      <DateRangeFilterControl
        dateRange={filters.dateRange}
        onDateRangeChange={filters.setDateRange}
        testID="kanban-filter-date-range"
      />
      {hasAssigneeOptions ? (
        <AssigneeFilterControl
          assignee={filters.assignee}
          onAssigneeChange={filters.setAssignee}
          assigneeOptions={filters.assigneeOptions}
          hasUnassignedCards={filters.hasUnassignedCards}
          testID="kanban-filter-assignee"
        />
      ) : null}
    </View>
  );
}

function CompactFilters({ filters }: KanbanCardFiltersProps): ReactElement {
  const { t } = useTranslation();
  const hasAssigneeOptions = filters.assigneeOptions.length > 0 || filters.hasUnassignedCards;

  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.compactTrigger,
      (hovered || pressed) && styles.compactTriggerHovered,
    ],
    [],
  );

  const triggerTextStyle = useMemo(
    () => [styles.compactTriggerText, filters.isActive ? styles.compactTriggerTextActive : null],
    [filters.isActive],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        accessibilityLabel={t("kanban.filters.trigger")}
        style={triggerStyle}
        testID="kanban-filter-trigger"
      >
        <ThemedListFilter
          size={TRIGGER_ICON_SIZE}
          uniProps={filters.isActive ? activeColorMapping : mutedColorMapping}
        />
        <Text style={triggerTextStyle}>{t("kanban.filters.trigger")}</Text>
        {filters.isActive ? <View style={styles.activeDot} /> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        minWidth={260}
        maxWidth={320}
        scrollable
        maxHeight={420}
        testID="kanban-filter-panel"
      >
        <View style={styles.panelSection}>
          <SearchFilterField
            search={filters.search}
            onSearchChange={filters.setSearch}
            onClear={filters.clearSearch}
            style={styles.searchFieldPanel}
            testID="kanban-filter-search"
          />
        </View>
        <DropdownMenuSeparator />
        <View style={styles.panelSection}>
          <Text style={styles.panelLabel}>{t("kanban.filters.source.label")}</Text>
          <SourceKindFilterControl
            sourceKind={filters.sourceKind}
            onSourceKindChange={filters.setSourceKind}
            onClear={filters.clearSourceKind}
            testID="kanban-filter-source"
          />
        </View>
        <DropdownMenuSeparator />
        <View style={styles.panelSection}>
          <Text style={styles.panelLabel}>{t("kanban.filters.dateRange.label")}</Text>
          <DateRangeFilterControl
            dateRange={filters.dateRange}
            onDateRangeChange={filters.setDateRange}
            testID="kanban-filter-date-range"
          />
        </View>
        {hasAssigneeOptions ? (
          <>
            <DropdownMenuSeparator />
            <View style={styles.panelLabelRow}>
              <Text style={styles.panelLabel}>{t("kanban.filters.assignee.label")}</Text>
            </View>
            <AssigneeMenuItems
              assignee={filters.assignee}
              onAssigneeChange={filters.setAssignee}
              assigneeOptions={filters.assigneeOptions}
              hasUnassignedCards={filters.hasUnassignedCards}
              closeOnSelect={false}
            />
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function KanbanCardFilters({ filters }: KanbanCardFiltersProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  return isCompact ? <CompactFilters filters={filters} /> : <InlineFilters filters={filters} />;
}

const styles = StyleSheet.create((theme) => ({
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
  },
  searchFieldActive: {
    borderColor: theme.colors.borderAccent,
  },
  searchFieldInline: {
    width: 200,
  },
  searchFieldPanel: {
    width: "100%",
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  sourceKindRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  clearButton: {
    padding: theme.spacing[1],
  },
  chipTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipTriggerActive: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  chipTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  chipTriggerPressed: {
    backgroundColor: theme.colors.surface3,
  },
  chipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    maxWidth: 120,
  },
  chipTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  compactTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  compactTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  compactTriggerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
  },
  compactTriggerTextActive: {
    color: theme.colors.foreground,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  panelSection: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  panelLabelRow: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
  panelLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
}));

// Resolved lazily — module-scope `styles.*` reads materialize the pre-persistence theme.
const getSearchInputStyle = () => [styles.searchInput, isWeb && { outlineStyle: "none" }];

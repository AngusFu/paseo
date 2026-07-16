import { useMemo, type ReactElement, type ReactNode } from "react";
import type {
  AgentFeature,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@getpaseo/protocol/agent-types";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { Field } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "@/composer/agent-controls/utils";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

type ThinkingOption = NonNullable<AgentModelDefinition["thinkingOptions"]>[number];

export function collectAgentFeatureValues(
  features: AgentFeature[],
): Record<string, unknown> | undefined {
  if (features.length === 0) {
    return undefined;
  }
  const next: Record<string, unknown> = {};
  for (const feature of features) {
    next[feature.id] = feature.value;
  }
  return next;
}

export function AgentModelField({
  label,
  providers,
  selectedProvider,
  selectedModel,
  onSelect,
  isLoading,
  serverId,
  disabled,
  onOpen,
  onRetryProvider,
  isRetryingProvider,
  renderTrigger,
  testID,
}: {
  label: string;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: AgentProvider, modelId: string) => void;
  isLoading: boolean;
  serverId?: string | null;
  disabled?: boolean;
  onOpen?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  renderTrigger: (input: {
    selectedModelLabel: string;
    onPress: () => void;
    disabled: boolean;
    isOpen: boolean;
    hovered: boolean;
    pressed: boolean;
  }) => ReactNode;
  testID?: string;
}): ReactElement {
  return (
    <Field label={label} testID={testID}>
      <CombinedModelSelector
        providers={providers}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        onSelect={onSelect}
        isLoading={isLoading}
        serverId={serverId}
        disabled={disabled}
        onOpen={onOpen}
        onRetryProvider={onRetryProvider}
        isRetryingProvider={isRetryingProvider}
        renderTrigger={renderTrigger}
        triggerFill
      />
    </Field>
  );
}

export function AgentThinkingField({
  options,
  value,
  onChange,
  label,
  placeholder,
  emptyText,
  selectedDisplay,
  size = "sm",
  searchable,
  title,
  triggerTestID,
  testID,
  renderOption,
  getOptionTestId,
}: {
  options: ThinkingOption[];
  value: string | null;
  onChange: (thinkingOptionId: string, display: SelectFieldDisplay) => void;
  label: string;
  placeholder: string;
  emptyText: string;
  selectedDisplay?: SelectFieldDisplay | null;
  size?: FieldControlSize;
  searchable?: boolean;
  title?: string;
  triggerTestID?: string;
  testID?: string;
  renderOption?: (input: SelectFieldRenderOptionInput<string>) => ReactElement;
  getOptionTestId?: (optionId: string) => string;
}): ReactElement | null {
  const selectOptions = useMemo(
    () =>
      options.map((option) => ({
        id: option.id,
        label: formatThinkingOptionLabel(option),
        value: option.id,
        ...(getOptionTestId ? { testID: getOptionTestId(option.id) } : {}),
      })),
    [getOptionTestId, options],
  );
  const resolvedDisplay = useMemo(() => {
    if (selectedDisplay !== undefined) {
      return selectedDisplay;
    }
    const match = selectOptions.find((option) => option.value === value);
    return match ? { label: match.label } : null;
  }, [selectOptions, selectedDisplay, value]);

  if (selectOptions.length === 0) {
    return null;
  }

  return (
    <SelectField
      label={label}
      value={value}
      selectedDisplay={resolvedDisplay}
      options={selectOptions}
      onChange={onChange}
      placeholder={placeholder}
      emptyText={emptyText}
      searchable={searchable ?? selectOptions.length > 6}
      title={title ?? placeholder}
      size={size}
      triggerTestID={triggerTestID}
      testID={testID}
      renderOption={renderOption}
    />
  );
}

export function AgentModeField({
  options,
  value,
  onChange,
  label,
  placeholder,
  emptyText,
  selectedDisplay,
  size = "sm",
  disabled,
  hint,
  searchable,
  title,
  triggerTestID,
  testID,
  allowEmpty = false,
}: {
  options: Array<Pick<AgentMode, "id" | "label"> | { id: string; label: string }>;
  value: string | null;
  onChange: (modeId: string, display: SelectFieldDisplay) => void;
  label: string;
  placeholder: string;
  emptyText: string;
  selectedDisplay?: SelectFieldDisplay | null;
  size?: FieldControlSize;
  disabled?: boolean;
  hint?: string;
  searchable?: boolean;
  title?: string;
  triggerTestID?: string;
  testID?: string;
  /** When true, still render with an empty options list (e.g. schedule unavailable hint). */
  allowEmpty?: boolean;
}): ReactElement | null {
  const selectOptions = useMemo(
    () =>
      options.map((mode) => ({
        id: mode.id,
        label: formatAgentModeLabel(mode),
        value: mode.id,
      })),
    [options],
  );
  const resolvedDisplay = useMemo(() => {
    if (selectedDisplay !== undefined) {
      return selectedDisplay;
    }
    const match = selectOptions.find((option) => option.value === value);
    return match ? { label: match.label } : null;
  }, [selectOptions, selectedDisplay, value]);
  const isEmpty = selectOptions.length === 0;

  if (isEmpty && !allowEmpty) {
    return null;
  }

  return (
    <SelectField
      label={label}
      value={value}
      selectedDisplay={resolvedDisplay}
      options={selectOptions}
      onChange={onChange}
      placeholder={placeholder}
      emptyText={emptyText}
      disabled={disabled ?? isEmpty}
      hint={hint}
      searchable={searchable ?? selectOptions.length > 6}
      title={title ?? placeholder}
      size={size}
      triggerTestID={triggerTestID}
      testID={testID}
    />
  );
}

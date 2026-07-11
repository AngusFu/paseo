import { useCallback, useMemo, useReducer, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import {
  CADENCE_PRESET_OPTIONS,
  CUSTOM_CRON_PRESET_ID,
  normalizeScheduleFormCadence,
  resolveCronPresetId,
} from "@/schedules/schedule-cadence-options";
import { getDeviceTimeZone } from "@/utils/device-timezone";
import { describeCron, validateCron } from "@/utils/schedule-format";

type CronCadence = Extract<ScheduleCadence, { type: "cron" }>;

export interface CadenceEditorProps {
  value: ScheduleCadence;
  onChange: (next: ScheduleCadence) => void;
  error?: string;
  size?: FieldControlSize;
}

// Preset id -> translation key. The English labels on CADENCE_PRESET_OPTIONS
// stay the stable id/fallback; the displayed text is resolved here.
const PRESET_LABEL_KEY: Record<string, string> = {
  "every-minute": "schedule.cadence.presets.everyMinute",
  "every-hour": "schedule.cadence.presets.everyHour",
  "daily-9": "schedule.cadence.presets.daily9",
  "weekdays-9": "schedule.cadence.presets.weekdays9",
  "mondays-9": "schedule.cadence.presets.mondays9",
};

function getCronPreview(expression: string, timezone: string, error: string | null): string | null {
  if (error || !expression) {
    return null;
  }
  return describeCron({ type: "cron", expression, timezone }) ?? expression;
}

function buildCronCadence(expression: string, timezone: string): CronCadence {
  return { type: "cron", expression, timezone };
}

export function CadenceEditor({ value, onChange, error, size = "md" }: CadenceEditorProps) {
  const { t } = useTranslation();
  const deviceTimeZone = useMemo(getDeviceTimeZone, []);
  const normalizedValue = normalizeScheduleFormCadence(value, deviceTimeZone);
  const [cronText, setCronText] = useState(() => normalizedValue.expression);
  const [fieldResetKey, bumpFieldResetKey] = useReducer((key: number) => key + 1, 0);
  const cronTimeZone = normalizedValue.timezone ?? deviceTimeZone;
  const trimmedCron = cronText.trim();
  const localCronError = trimmedCron ? validateCron(trimmedCron) : null;
  const effectiveError = error ?? localCronError;
  const preview = getCronPreview(trimmedCron, cronTimeZone, effectiveError ?? null);
  const currentCadence = useMemo<CronCadence>(
    () => buildCronCadence(trimmedCron, cronTimeZone),
    [cronTimeZone, trimmedCron],
  );
  const presetOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      CADENCE_PRESET_OPTIONS.map((option) => ({
        id: option.id,
        value: option.id,
        label: t(PRESET_LABEL_KEY[option.id] ?? option.label),
        testID: `schedule-cadence-preset-${option.id}`,
      })),
    [t],
  );
  const selectedPresetId = resolveCronPresetId(currentCadence);
  const selectedPresetDisplay = useMemo(
    () => ({
      label:
        selectedPresetId === CUSTOM_CRON_PRESET_ID
          ? t("schedule.cadence.presets.custom")
          : t(PRESET_LABEL_KEY[selectedPresetId] ?? "schedule.cadence.presets.custom"),
    }),
    [selectedPresetId, t],
  );

  const handlePresetChange = useCallback(
    (presetId: string) => {
      const preset = CADENCE_PRESET_OPTIONS.find((option) => option.id === presetId);
      if (!preset) {
        return;
      }
      setCronText(preset.expression);
      bumpFieldResetKey();
      onChange(buildCronCadence(preset.expression, cronTimeZone));
    },
    [cronTimeZone, onChange],
  );

  const handleCronChange = useCallback(
    (text: string) => {
      setCronText(text);
      onChange(buildCronCadence(text.trim(), cronTimeZone));
    },
    [cronTimeZone, onChange],
  );

  let feedback: ReactNode = null;
  if (effectiveError) {
    feedback = <Text style={styles.error}>{effectiveError}</Text>;
  } else if (preview) {
    feedback = <Text style={styles.preview}>{preview}</Text>;
  }

  return (
    <Field label={t("schedule.cadence.label")}>
      <View style={styles.stack}>
        <SelectField
          label={t("schedule.cadence.label")}
          value={selectedPresetId === CUSTOM_CRON_PRESET_ID ? null : selectedPresetId}
          selectedDisplay={selectedPresetDisplay}
          options={presetOptions}
          onChange={handlePresetChange}
          placeholder={t("schedule.cadence.placeholder")}
          emptyText={t("schedule.cadence.empty")}
          searchable={false}
          title={t("schedule.cadence.label")}
          size={size}
          triggerTestID="schedule-cadence-preset-trigger"
          field={false}
        />

        <FormTextInput
          size={size}
          testID="cadence-cron-expression"
          accessibilityLabel={t("schedule.cadence.cronAccessibility")}
          initialValue={cronText}
          resetKey={`cadence-cron-${fieldResetKey}`}
          value={cronText}
          onChangeText={handleCronChange}
          placeholder="0 9 * * *"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={styles.cronInput}
        />
        {feedback}
      </View>
    </Field>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.spacing[3],
  },
  cronInput: {
    fontFamily: theme.fontFamily.mono,
  },
  preview: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  error: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[300],
  },
}));

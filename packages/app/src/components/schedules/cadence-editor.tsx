import { useCallback, useMemo, useReducer, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useLocalLlmCron } from "@/hooks/use-local-llm-cron";
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
  // Enables the natural-language → cron affordance when the host daemon
  // supports the localLlm capability.
  serverId?: string | null;
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

export function CadenceEditor({
  value,
  onChange,
  error,
  size = "md",
  serverId,
}: CadenceEditorProps) {
  const { t } = useTranslation();
  const ai = useLocalLlmCron(serverId);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState("");
  const [aiFailed, setAiFailed] = useState(false);
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

  const handleAiGenerate = useCallback(() => {
    const text = aiText.trim();
    if (!text) {
      return;
    }
    setAiFailed(false);
    void (async () => {
      const expression = await ai.generate(text);
      if (!expression) {
        setAiFailed(true);
        return;
      }
      setCronText(expression);
      bumpFieldResetKey();
      onChange(buildCronCadence(expression, cronTimeZone));
    })();
  }, [ai, aiText, cronTimeZone, onChange]);

  const handleAiOpen = useCallback(() => {
    setAiOpen(true);
  }, []);

  let aiSection: ReactNode = null;
  if (ai.supported) {
    if (!aiOpen) {
      aiSection = (
        <Button
          variant="ghost"
          size="xs"
          style={styles.aiTrigger}
          testID="cadence-ai-trigger"
          onPress={handleAiOpen}
        >
          {t("schedule.cadence.ai.trigger")}
        </Button>
      );
    } else if (ai.model?.status === "downloading") {
      const percent = ai.model.totalBytes
        ? Math.round((ai.model.receivedBytes / ai.model.totalBytes) * 100)
        : 0;
      aiSection = (
        <Text style={styles.preview}>{t("schedule.cadence.ai.downloading", { percent })}</Text>
      );
    } else if (ai.model?.status === "ready") {
      aiSection = (
        <View style={styles.stack}>
          <View style={styles.aiRow}>
            <View style={styles.aiInput}>
              <FormTextInput
                size={size}
                testID="cadence-ai-input"
                accessibilityLabel={t("schedule.cadence.ai.trigger")}
                initialValue={aiText}
                value={aiText}
                onChangeText={setAiText}
                placeholder={t("schedule.cadence.ai.placeholder")}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={handleAiGenerate}
              />
            </View>
            <Button
              size={size === "sm" ? "sm" : "md"}
              testID="cadence-ai-generate"
              loading={ai.isGenerating}
              disabled={ai.isGenerating || !aiText.trim()}
              onPress={handleAiGenerate}
            >
              {t(
                ai.isGenerating ? "schedule.cadence.ai.generating" : "schedule.cadence.ai.generate",
              )}
            </Button>
          </View>
          {aiFailed ? <Text style={styles.error}>{t("schedule.cadence.ai.failed")}</Text> : null}
        </View>
      );
    } else {
      // absent (or error) — offer the model download.
      aiSection = (
        <Button
          variant="ghost"
          size="xs"
          style={styles.aiTrigger}
          testID="cadence-ai-download"
          onPress={ai.startDownload}
        >
          {t("schedule.cadence.ai.download")}
        </Button>
      );
    }
  }

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
        {aiSection}
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
  aiTrigger: {
    alignSelf: "flex-start",
  },
  aiRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  aiInput: {
    flex: 1,
  },
  error: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[300],
  },
}));

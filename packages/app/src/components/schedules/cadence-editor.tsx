import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Text, View, type TextInput } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Info, Sparkles } from "lucide-react-native";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useLocalLlmCron, type CronGenerationResult } from "@/hooks/use-local-llm-cron";
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
  // No fallback to the raw expression — a preview that just echoes the input is
  // noise. Return null when we can't actually humanize it (the AI explanation,
  // when present, is preferred by the caller anyway).
  return describeCron({ type: "cron", expression, timezone });
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
  // The model's plain-language description of its last generated cron, shown as
  // the preview until the user edits the expression away from it.
  const [aiExplained, setAiExplained] = useState<CronGenerationResult | null>(null);
  const deviceTimeZone = useMemo(getDeviceTimeZone, []);
  const normalizedValue = normalizeScheduleFormCadence(value, deviceTimeZone);
  const [cronText, setCronText] = useState(() => normalizedValue.expression);
  const [fieldResetKey, bumpFieldResetKey] = useReducer((key: number) => key + 1, 0);
  const cronTimeZone = normalizedValue.timezone ?? deviceTimeZone;
  const trimmedCron = cronText.trim();
  const localCronError = trimmedCron ? validateCron(trimmedCron) : null;
  const effectiveError = error ?? localCronError;
  const aiPreview =
    aiExplained && aiExplained.expression === trimmedCron && aiExplained.explanation
      ? aiExplained.explanation
      : null;
  const preview = aiPreview ?? getCronPreview(trimmedCron, cronTimeZone, effectiveError ?? null);
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

  const handleAiGenerated = useCallback(
    (result: CronGenerationResult) => {
      setCronText(result.expression);
      setAiExplained(result.explanation ? result : null);
      bumpFieldResetKey();
      onChange(buildCronCadence(result.expression, cronTimeZone));
    },
    [cronTimeZone, onChange],
  );

  const handleExplained = useCallback((expression: string, explanation: string) => {
    setAiExplained({ expression, explanation });
  }, []);

  // When the expression matches a named preset, the dropdown above already says
  // what it does — a preview would just repeat it. Only describe custom crons.
  const isCustomCron = selectedPresetId === CUSTOM_CRON_PRESET_ID;
  const showPreview = Boolean(preview && isCustomCron);
  let feedback: ReactNode = null;
  if (effectiveError) {
    feedback = <Text style={styles.error}>{effectiveError}</Text>;
  } else if (showPreview) {
    feedback = <Text style={styles.preview}>{preview}</Text>;
  }

  // A custom cron with no available description is the only case where an
  // on-demand "explain" is useful (presets and AI-generated crons already have
  // one). Skip while an error is showing.
  const explainTarget =
    isCustomCron && !effectiveError && trimmedCron && !showPreview ? trimmedCron : null;

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
        <CadenceAiControls
          serverId={serverId}
          size={size}
          explainTarget={explainTarget}
          onGenerated={handleAiGenerated}
          onExplained={handleExplained}
        />
      </View>
    </Field>
  );
}

// Natural-language → cron affordance. Owns its own open/input/failed state so the
// parent editor stays simple; calls back with the validated result on success.
function CadenceAiControls({
  serverId,
  size,
  explainTarget,
  onGenerated,
  onExplained,
}: {
  serverId: string | null | undefined;
  size: FieldControlSize;
  // A custom cron the user can ask the model to describe, or null when none.
  explainTarget: string | null;
  onGenerated: (result: CronGenerationResult) => void;
  onExplained: (expression: string, explanation: string) => void;
}): ReactNode {
  const { t } = useTranslation();
  const ai = useLocalLlmCron(serverId);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const handleOpen = useCallback(() => setOpen(true), []);

  const handleExplain = useCallback(() => {
    if (!explainTarget) {
      return;
    }
    void (async () => {
      const explanation = await ai.explain(explainTarget);
      if (explanation) {
        onExplained(explainTarget, explanation);
      }
    })();
  }, [ai, explainTarget, onExplained]);

  // Focus the input once it mounts (open + model ready). autoFocus alone is
  // unreliable for a conditionally-rendered field, so drive it from a ref too.
  const inputReady = open && ai.model?.status === "ready";
  useEffect(() => {
    if (inputReady) {
      inputRef.current?.focus();
    }
  }, [inputReady]);

  const handleGenerate = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    setFailed(false);
    void (async () => {
      const result = await ai.generate(trimmed);
      if (!result) {
        setFailed(true);
        return;
      }
      onGenerated(result);
    })();
  }, [ai, text, onGenerated]);

  if (!ai.supported) {
    return null;
  }

  if (!open) {
    const canExplain = explainTarget !== null && ai.model?.status === "ready";
    return (
      <View style={styles.aiRow}>
        <Button
          variant="ghost"
          size="xs"
          style={styles.aiTrigger}
          leftIcon={Sparkles}
          testID="cadence-ai-trigger"
          onPress={handleOpen}
        >
          {t("schedule.cadence.ai.trigger")}
        </Button>
        {canExplain ? (
          <Button
            variant="ghost"
            size="xs"
            style={styles.aiTrigger}
            leftIcon={Info}
            loading={ai.isExplaining}
            testID="cadence-ai-explain"
            onPress={handleExplain}
          >
            {t("schedule.cadence.ai.explain")}
          </Button>
        ) : null}
      </View>
    );
  }

  if (ai.model?.status === "downloading") {
    const percent = ai.model.totalBytes
      ? Math.round((ai.model.receivedBytes / ai.model.totalBytes) * 100)
      : 0;
    return <Text style={styles.preview}>{t("schedule.cadence.ai.downloading", { percent })}</Text>;
  }

  if (ai.model?.status !== "ready") {
    // absent (or error) — offer the model download.
    return (
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

  return (
    <View style={styles.stack}>
      <View style={styles.aiRow}>
        <View style={styles.aiInput}>
          <FormTextInput
            ref={inputRef}
            size={size}
            testID="cadence-ai-input"
            accessibilityLabel={t("schedule.cadence.ai.trigger")}
            initialValue={text}
            value={text}
            onChangeText={setText}
            placeholder={t("schedule.cadence.ai.placeholder")}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onSubmitEditing={handleGenerate}
          />
        </View>
        <Button
          size={size === "sm" ? "sm" : "md"}
          leftIcon={Sparkles}
          testID="cadence-ai-generate"
          loading={ai.isGenerating}
          disabled={ai.isGenerating || !text.trim()}
          onPress={handleGenerate}
        >
          {t(ai.isGenerating ? "schedule.cadence.ai.generating" : "schedule.cadence.ai.generate")}
        </Button>
      </View>
      {failed ? <Text style={styles.error}>{t("schedule.cadence.ai.failed")}</Text> : null}
    </View>
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

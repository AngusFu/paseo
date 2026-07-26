import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "../persisted-config.js";
import { resolveSpeechConfig } from "./speech-config-resolver.js";
import {
  DEFAULT_LOCAL_TTS_MODEL,
  getLocalSpeechModelDir,
  listLocalSpeechModels,
  LocalTtsModelIdSchema,
  type LocalSpeechModelId,
  type LocalTtsModelId,
} from "./providers/local/models.js";
import type {
  VoiceTtsCurrentSelection,
  VoiceTtsModelInfo,
  VoiceTtsReadiness,
} from "@getpaseo/protocol/messages";
import type { SpeechService } from "./speech-runtime.js";

export interface VoiceTtsSettingsSnapshot {
  models: VoiceTtsModelInfo[];
  current: VoiceTtsCurrentSelection;
  readiness: VoiceTtsReadiness;
}

export interface VoiceTtsSettingsController {
  /** Available local TTS models + the active selection + current speech readiness. */
  getSnapshot: () => Promise<VoiceTtsSettingsSnapshot>;
  /** Persist the chosen voice TTS model and hot-swap the speech stack in place. */
  setModel: (modelId: string) => Promise<VoiceTtsSettingsSnapshot>;
}

const DEFAULT_LOCAL_MODELS_SUBDIR = join("models", "local-speech");

/**
 * Backs the `speech.voice_tts.*` RPCs: lists local TTS models with their supported
 * languages and install state, and switches the active voice TTS model at runtime by
 * persisting it and calling {@link SpeechService.reconfigure} (no daemon restart needed).
 */
export function createVoiceTtsSettingsController(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  speechService: SpeechService;
  logger: Logger;
}): VoiceTtsSettingsController {
  const { paseoHome, env, speechService } = params;
  const logger = params.logger.child({ module: "voice-tts-settings" });

  const resolveModelsDir = (
    persisted: PersistedConfig,
    localModelsDir: string | undefined,
  ): string =>
    localModelsDir ??
    env.PASEO_LOCAL_MODELS_DIR ??
    persisted.providers?.local?.modelsDir ??
    join(paseoHome, DEFAULT_LOCAL_MODELS_SUBDIR);

  const isInstalled = async (
    modelsDir: string,
    modelId: LocalSpeechModelId,
    requiredFiles: readonly string[],
  ): Promise<boolean> => {
    const modelDir = getLocalSpeechModelDir(modelsDir, modelId);
    const checks = await Promise.all(
      requiredFiles.map(async (rel) => {
        try {
          const s = await stat(join(modelDir, rel));
          return s.isDirectory() || (s.isFile() && s.size > 0);
        } catch {
          return false;
        }
      }),
    );
    return checks.every(Boolean);
  };

  const buildSnapshot = async (persisted: PersistedConfig): Promise<VoiceTtsSettingsSnapshot> => {
    const resolved = resolveSpeechConfig({ paseoHome, env, persisted });
    const modelsDir = resolveModelsDir(persisted, resolved.speech.local?.modelsDir);
    const ttsModels = listLocalSpeechModels().filter((m) => m.kind === "tts");
    const ttsModelIds = new Set(ttsModels.map((m) => m.id));

    const r = speechService.getReadiness();
    const progressByModelId = r.download.progressByModelId ?? {};
    const missingIds = new Set(r.missingLocalModelIds);
    const downloadInProgress = r.download.inProgress;
    const ttsMissingIds = [...missingIds].filter((id) => ttsModelIds.has(id));

    const models = await Promise.all(
      ttsModels.map(async (m): Promise<VoiceTtsModelInfo> => {
        const installed = await isInstalled(modelsDir, m.id, m.requiredFiles);
        const modelProgress = progressByModelId[m.id];
        const downloading =
          downloadInProgress && (missingIds.has(m.id) || modelProgress !== undefined);

        const info: VoiceTtsModelInfo = {
          id: m.id,
          description: m.description,
          languages: [...m.languages],
          installed,
          downloading: false,
        };

        if (downloading) {
          info.downloading = true;
          info.downloadProgress =
            modelProgress !== undefined
              ? Math.max(0, Math.min(100, Math.round(modelProgress.percent)))
              : 0;
          info.downloadBytesPerSecond =
            modelProgress !== undefined ? Math.max(0, Math.round(modelProgress.bytesPerSecond)) : 0;
          info.downloadReceivedBytes = modelProgress?.receivedBytes ?? 0;
          info.downloadTotalBytes = modelProgress?.totalBytes ?? null;
        }

        return info;
      }),
    );

    const current: VoiceTtsCurrentSelection = {
      provider: resolved.speech.providers.voiceTts.provider,
      model: resolved.speech.local?.models.voiceTts ?? DEFAULT_LOCAL_TTS_MODEL,
      language: resolved.speech.sttLanguages?.voice ?? "zh",
    };

    const ttsProgressEntries = Object.entries(progressByModelId)
      .filter(([id]) => ttsModelIds.has(id as LocalTtsModelId))
      .map(([, value]) => value);
    const aggregateProgress =
      ttsProgressEntries.length > 0
        ? Math.round(
            ttsProgressEntries.reduce((sum, value) => sum + value.percent, 0) /
              ttsProgressEntries.length,
          )
        : undefined;
    const aggregateSpeed =
      ttsProgressEntries.length > 0
        ? Math.round(
            ttsProgressEntries.reduce((sum, value) => sum + value.bytesPerSecond, 0) /
              ttsProgressEntries.length,
          )
        : undefined;

    const currentModelEntry = models.find((model) => model.id === current.model);
    const ttsAvailable =
      current.provider === "local" &&
      (currentModelEntry?.installed ?? false) &&
      !missingIds.has(current.model as LocalSpeechModelId);

    let reasonCode = "ready";
    let message = "Voice TTS is ready.";
    if (!ttsAvailable) {
      if (ttsMissingIds.includes(current.model as LocalSpeechModelId)) {
        reasonCode = "model_missing";
        message = "Selected voice TTS model is not downloaded yet.";
      } else if (r.realtimeVoice.reasonCode === "tts_unavailable") {
        reasonCode = r.realtimeVoice.reasonCode;
        message = r.realtimeVoice.message;
      } else {
        reasonCode = "starting";
        message = "Voice TTS is starting.";
      }
    }

    const readiness: VoiceTtsReadiness = {
      available: ttsAvailable,
      downloading:
        downloadInProgress && (ttsMissingIds.length > 0 || ttsProgressEntries.length > 0),
      missingModelIds: ttsMissingIds,
      reasonCode,
      message,
      ...(typeof aggregateProgress === "number" ? { downloadProgress: aggregateProgress } : {}),
      ...(typeof aggregateSpeed === "number" ? { downloadBytesPerSecond: aggregateSpeed } : {}),
    };

    return { models, current, readiness };
  };

  return {
    getSnapshot: () => buildSnapshot(loadPersistedConfig(paseoHome, logger)),
    setModel: async (modelId: string) => {
      const parsed = LocalTtsModelIdSchema.parse(modelId);
      const persisted = loadPersistedConfig(paseoHome, logger);
      const next: PersistedConfig = {
        ...persisted,
        features: {
          ...persisted.features,
          voiceMode: {
            ...persisted.features?.voiceMode,
            tts: {
              ...persisted.features?.voiceMode?.tts,
              provider: "local",
              model: parsed,
            },
          },
        },
      };
      savePersistedConfig(paseoHome, next, logger);

      const resolved = resolveSpeechConfig({ paseoHome, env, persisted: next });
      speechService.reconfigure({ speechConfig: resolved.speech, openaiConfig: resolved.openai });
      logger.info({ model: parsed }, "Voice TTS model updated");

      return buildSnapshot(next);
    },
  };
}

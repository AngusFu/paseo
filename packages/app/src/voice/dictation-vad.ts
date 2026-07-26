import { DICTATION_VAD_CONFIG } from "@/voice/dictation-vad-config";

export interface DictationVadConfig {
  volumeThreshold: number;
  silenceThreshold: number;
  silenceDurationMs: number;
  minSpeechMs: number;
  pollIntervalMs: number;
}

export interface DictationVadState {
  hasSpeech: boolean;
  speechStartedAt: number | null;
  lastSpeechAt: number;
}

export const INITIAL_DICTATION_VAD_STATE: DictationVadState = {
  hasSpeech: false,
  speechStartedAt: null,
  lastSpeechAt: 0,
};

export function tickDictationVad(
  state: DictationVadState,
  level: number,
  now: number,
  config: DictationVadConfig = DICTATION_VAD_CONFIG,
): { next: DictationVadState; shouldConfirm: boolean } {
  if (level >= config.volumeThreshold) {
    return {
      next: {
        hasSpeech: true,
        speechStartedAt: state.speechStartedAt ?? now,
        lastSpeechAt: now,
      },
      shouldConfirm: false,
    };
  }

  // Hysteresis band: ignore flutter between silence and speech thresholds.
  if (level >= config.silenceThreshold) {
    return { next: state, shouldConfirm: false };
  }

  if (!state.hasSpeech || state.speechStartedAt === null || state.lastSpeechAt === 0) {
    return { next: state, shouldConfirm: false };
  }

  const speechMs = state.lastSpeechAt - state.speechStartedAt;
  if (speechMs < config.minSpeechMs) {
    return { next: state, shouldConfirm: false };
  }

  if (now - state.lastSpeechAt >= config.silenceDurationMs) {
    return { next: state, shouldConfirm: true };
  }

  return { next: state, shouldConfirm: false };
}

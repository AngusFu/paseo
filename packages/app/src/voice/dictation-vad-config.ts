/** Client-side VAD for dictation: auto-confirm after the user stops speaking. */
export const DICTATION_VAD_CONFIG = {
  volumeThreshold: 0.08,
  /** Below this level counts as silence; between this and volumeThreshold is ignored (hysteresis). */
  silenceThreshold: 0.05,
  /** Silence after last detected speech before auto-confirming (and sending) the transcript. */
  silenceDurationMs: 1800,
  /** Ignore auto-confirm until the user has spoken at least this long. */
  minSpeechMs: 400,
  pollIntervalMs: 200,
} as const;

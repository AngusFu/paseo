/** Client-side VAD for dictation: auto-confirm after the user stops speaking. */
export const DICTATION_VAD_CONFIG = {
  volumeThreshold: 0.08,
  /** Silence after last detected speech before auto-inserting the transcript. */
  silenceDurationMs: 8000,
  /** Ignore auto-confirm until the user has spoken at least this long. */
  minSpeechMs: 400,
  pollIntervalMs: 200,
} as const;

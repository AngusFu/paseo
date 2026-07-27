import { i18n } from "@/i18n/i18next";

export type DictationStatus = "idle" | "recording" | "uploading" | "failed";

export interface DictationTranscriptMeta {
  requestId: string;
  /** True when silence VAD confirmed the turn — composer should insert and send. */
  autoSend?: boolean;
}

export interface UseDictationOptions {
  client: import("@getpaseo/client/internal/daemon-client").DaemonClient | null;
  onTranscript: (text: string, meta: DictationTranscriptMeta) => void;
  onPartialTranscript?: (text: string, meta: { requestId: string }) => void;
  onError?: (error: Error) => void;
  onPermanentFailure?: (error: Error, context: { requestId: string }) => void;
  canStart?: () => boolean;
  canConfirm?: () => boolean;
  enableDuration?: boolean;
  /**
   * Auto-confirm after sustained silence (client-side VAD).
   * Silence confirms report `autoSend: true` on the transcript meta.
   */
  autoConfirmOnSilence?: boolean;
}

export interface ConfirmDictationOptions {
  /** When true, the resulting transcript meta includes `autoSend: true`. */
  autoSend?: boolean;
}

export interface UseDictationResult {
  isRecording: boolean;
  isRecordingActive: () => boolean;
  isProcessing: boolean;
  partialTranscript: string;
  volume: number;
  duration: number;
  error: string | null;
  status: DictationStatus;
  startDictation: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  confirmDictation: (options?: ConfirmDictationOptions) => Promise<void>;
  retryFailedDictation: () => Promise<void>;
  discardFailedDictation: () => void;
  reset: () => void;
}

export const DURATION_TICK_MS = 1000;
export const PCM_DICTATION_FORMAT = "audio/pcm;rate=16000;bits=16";

export const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return new Error(error);
  }
  return new Error(i18n.t("common.errors.unexpectedDictationError"));
};

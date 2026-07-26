export interface DictationAudioSourceConfig {
  onPcmSegment: (pcm16Base64: string) => void;
  onError?: (error: Error) => void;
  onInterruption?: () => void;
  /** Synchronous volume updates for VAD polling (avoid React render coupling). */
  onVolumeLevel?: (level: number) => void;
}

export interface DictationAudioSource {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  volume: number;
}

import { describe, expect, it } from "vitest";
import { DICTATION_VAD_CONFIG } from "@/voice/dictation-vad-config";
import { INITIAL_DICTATION_VAD_STATE, tickDictationVad } from "@/voice/dictation-vad";

describe("tickDictationVad", () => {
  const config = {
    ...DICTATION_VAD_CONFIG,
    silenceDurationMs: 1000,
    minSpeechMs: 200,
  };

  it("does not confirm before speech is detected", () => {
    let state = INITIAL_DICTATION_VAD_STATE;
    const t0 = 1_000;
    for (let i = 0; i < 20; i += 1) {
      const result = tickDictationVad(state, 0.01, t0 + i * config.pollIntervalMs, config);
      state = result.next;
      expect(result.shouldConfirm).toBe(false);
    }
  });

  it("confirms after sustained silence following speech", () => {
    let state = INITIAL_DICTATION_VAD_STATE;
    const t0 = 5_000;

    for (let i = 0; i < 5; i += 1) {
      const result = tickDictationVad(
        state,
        config.volumeThreshold + 0.05,
        t0 + i * config.pollIntervalMs,
        config,
      );
      state = result.next;
    }

    const afterSpeech = state.lastSpeechAt;
    const silenceResult = tickDictationVad(
      state,
      0.01,
      afterSpeech + config.silenceDurationMs,
      config,
    );
    expect(silenceResult.shouldConfirm).toBe(true);
  });

  it("keeps accumulating silence across ticks without resetting speech markers", () => {
    let state = INITIAL_DICTATION_VAD_STATE;
    const t0 = 10_000;
    for (let i = 0; i < 4; i += 1) {
      const speech = tickDictationVad(state, 0.2, t0 + i * config.pollIntervalMs, config);
      state = speech.next;
    }

    const quietAt = t0 + 800;
    const quiet = tickDictationVad(state, 0.01, quietAt, config);
    state = quiet.next;
    expect(quiet.shouldConfirm).toBe(false);

    const confirm = tickDictationVad(state, 0.01, quietAt + config.silenceDurationMs, config);
    expect(confirm.shouldConfirm).toBe(true);
  });
});

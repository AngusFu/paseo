import { describe, expect, it, vi } from "vitest";
import { applyDictationTranscript } from "./apply-dictation-transcript";

describe("applyDictationTranscript", () => {
  it("inserts without sending when autoSend is false", () => {
    const onChangeText = vi.fn();
    const onSubmit = vi.fn();

    applyDictationTranscript("hello", {
      value: "",
      defaultSendBehavior: "interrupt",
      isAgentRunning: false,
      onQueue: undefined,
      onSubmit,
      onChangeText,
      attachments: [],
      cwd: "/tmp",
      autoSend: false,
    });

    expect(onChangeText).toHaveBeenCalledWith("hello");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits when autoSend is true", () => {
    const onChangeText = vi.fn();
    const onSubmit = vi.fn();

    applyDictationTranscript("完了报错", {
      value: "",
      defaultSendBehavior: "interrupt",
      isAgentRunning: false,
      onQueue: undefined,
      onSubmit,
      onChangeText,
      attachments: [],
      cwd: "/tmp",
      autoSend: true,
    });

    expect(onSubmit).toHaveBeenCalledWith({
      text: "完了报错",
      attachments: [],
      cwd: "/tmp",
      forceSend: undefined,
    });
    expect(onChangeText).not.toHaveBeenCalled();
  });
});

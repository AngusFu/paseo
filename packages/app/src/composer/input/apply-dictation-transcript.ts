import type { ComposerAttachment } from "@/attachments/types";
import type { MessagePayload } from "@/composer/types";

export interface DictationTranscriptContext {
  value: string;
  defaultSendBehavior: "interrupt" | "queue";
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onSubmit: (payload: MessagePayload) => void;
  onChangeText: (text: string) => void;
  attachments: ComposerAttachment[];
  cwd: string;
  autoSend: boolean;
}

/** Insert a dictation transcript into the composer, optionally submitting it. */
export function applyDictationTranscript(text: string, ctx: DictationTranscriptContext): void {
  if (!text) return;
  const shouldPad = ctx.value.length > 0 && !/\s$/.test(ctx.value);
  const nextValue = `${ctx.value}${shouldPad ? " " : ""}${text}`;

  if (!ctx.autoSend) {
    ctx.onChangeText(nextValue);
    return;
  }

  if (ctx.defaultSendBehavior === "queue" && ctx.isAgentRunning && ctx.onQueue) {
    ctx.onQueue({ text: nextValue, attachments: ctx.attachments, cwd: ctx.cwd });
    ctx.onChangeText("");
    return;
  }

  ctx.onSubmit({
    text: nextValue,
    attachments: ctx.attachments,
    cwd: ctx.cwd,
    forceSend: ctx.isAgentRunning || undefined,
  });
}

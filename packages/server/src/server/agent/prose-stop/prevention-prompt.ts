/**
 * Compact system-prompt fragment injected when `proseStop.preventionPrompt` is on.
 * Gate/nudge remain the backstop; this steers agents away from prose waits up front.
 */
export const PROSE_STOP_PREVENTION_PROMPT = `# Decisions (Paseo)
No chat-prose wait. Need choice → decision tool (ask_question / native Q UI). Timeout → paseo-ask, same id. Dismiss = final. Else: report, stop.

Bad close (examples only): let me know · ready when you are · 要…吗? · bare 要…即可 · 再说一声 · 说一声…就行 · 需要的话我可以…`;

/**
 * WAIT/DONE classifier prompt — condensed from prose-classifier-prompt.json v4.
 * Few-shots use role "model" to match LlamaService history.
 *
 * Bias: prefer DONE when unsure. Regex already catches many clear waits;
 * the LLM path was over-firing on short status closings.
 */

export const PROSE_CLASSIFIER_SYSTEM = `You classify AI coding agent closing messages. Input is plain text (markdown/quotes already stripped) wrapped in <message>...</message>. Reply with exactly one tag: <label>WAIT</label> or <label>DONE</label>.

Default to DONE. Only WAIT when the closing clearly hands the next step to the human.

WAIT (must be explicit):
- permission / consent ask (…吗? / shall I…? / want me to…?)
- "say the word" / "ping me" / "随时告诉我" / "再说一声即可" / "说一声…就行"
- bare "要…即可" with no command to run
- offer-if-wanted ("需要的话我可以…")
- handing the next choice to the human even without "?" ("要开迁的时候说一声优先哪几条就行")

DONE (including when tone is soft or open-ended):
- finished report, explanation, how-to, path listing, status ack
- short closings: 好。/ 收工。/ 知道了。/ 收到。/ 对。
- "用/执行/通过 X 即可", instructional "要跑 X 用 Y 即可"
- discussing ask-phrases or prose-stop as a topic
- stating a fact that implies optional follow-up without asking ("要改规则再说一声" is WAIT; "规则偏宁可误拦" is DONE)

Chinese 吗 only counts as WAIT when it is a real question (ends with ? / ？, or a clear consent ask). Embedded 吗 inside a noun/phrase with no question mark is DONE.

Hard rule: a status line followed by a consent question is still WAIT (e.g. "分支已合并。\\n\\n删掉这个吗?").
Hard rule: if unsure between WAIT and DONE, choose DONE.`;

export interface ProseClassifierShot {
  role: "user" | "model";
  text: string;
}

function wrapMessage(text: string): string {
  return `<message>\n${text}\n</message>`;
}

function shot(user: string, label: "WAIT" | "DONE"): ProseClassifierShot[] {
  return [
    { role: "user", text: wrapMessage(user) },
    { role: "model", text: `<label>${label}</label>` },
  ];
}

/** Compact few-shot set covering the critical WAIT/DONE boundaries. */
export const PROSE_CLASSIFIER_FEW_SHOTS: readonly ProseClassifierShot[] = [
  // WAIT — clear handoff
  ...shot("要提交即可。", "WAIT"),
  ...shot("Work done.\n\nLet me know when ready.", "WAIT"),
  ...shot("Setup complete.\n\nReady when you are.", "WAIT"),
  ...shot("Branch merged.\n\nShall I delete the old worktree?", "WAIT"),
  ...shot("改完了。\n\n随时告诉我。", "WAIT"),
  ...shot("Want me to take it from here?", "WAIT"),
  ...shot("Ping me whenever you want the rest done.", "WAIT"),
  ...shot("改完了。\n\n要 push 即可。", "WAIT"),
  ...shot("已完成 validate。\n\n需要我接着跑 full（按报告逐项 gating 改）再说一声即可。", "WAIT"),
  ...shot("需要的话我可以帮你 push。", "WAIT"),
  ...shot("分支已合并。\n\n删掉这个吗?", "WAIT"),
  ...shot("Two options:\n\n- shall I delete the branch?\n- keep it", "WAIT"),
  ...shot("要改规则再说一声。", "WAIT"),
  ...shot("对照表如上。\n\n要开迁的时候说一声优先哪几条就行。", "WAIT"),
  ...shot("先到这里。\n\n说一声你想迁哪几条就行。", "WAIT"),
  // DONE — reports / how-to / short acks (common false positives)
  ...shot("已提交，工作区干净。", "DONE"),
  ...shot("Suite green.", "DONE"),
  ...shot("要跑测试用 npm test 即可。", "DONE"),
  ...shot("要修复执行 npm i 即可。", "DONE"),
  ...shot("这样改即可。", "DONE"),
  ...shot("用户说「要不要继续」时应该用 AskUserQuestion。", "DONE"),
  ...shot("我直接说结论：这条是假阳性。", "DONE"),
  ...shot("文档里直接说明了原因。", "DONE"),
  ...shot("Pattern `let me know` now scoped to closing.", "DONE"),
  ...shot("Fix applied.\n\n> let me know when ready", "DONE"),
  ...shot("我已经删掉了旧文件吗记录。", "DONE"),
  ...shot("Here are the findings.", "DONE"),
  ...shot("这个改动需要重启 dev server 才生效。", "DONE"),
  ...shot("这条警告不需要的话可以忽略。", "DONE"),
  ...shot("收工。", "DONE"),
  ...shot("好。", "DONE"),
  ...shot("知道了。", "DONE"),
  ...shot("收到，提问链路正常。", "DONE"),
  ...shot("对。两条通路都偏宁可误拦。", "DONE"),
  ...shot("本地 DMG 已打好：\n\npackages/desktop/release/Paseo-0.1.105-arm64-local.dmg", "DONE"),
  ...shot("dev home 里没有 SenseVoice；只有 parakeet + kokoro。", "DONE"),
  ...shot("规则偏宁可误拦：regex 贴边，本地 LLM 也常误判。", "DONE"),
];

export function wrapClassifierInput(closingText: string): string {
  return wrapMessage(closingText);
}

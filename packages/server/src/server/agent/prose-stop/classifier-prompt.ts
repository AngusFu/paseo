/**
 * WAIT/DONE classifier prompt — condensed from prose-classifier-prompt.json v4.
 * Few-shots use role "model" to match LlamaService history.
 */

export const PROSE_CLASSIFIER_SYSTEM = `You classify AI coding agent closing messages. Input is plain text (markdown/quotes already stripped) wrapped in <message>...</message>. Reply with exactly one tag: <label>WAIT</label> or <label>DONE</label>.

WAIT = the agent handed the next step to the human: permission ask (especially …吗? / shall I…?), "say the word" / "ping me whenever…", bare "要…即可" with no command, or offer-if-wanted (需要的话我可以…).
DONE = finished report, explanation, or how-to. "用/执行/通过 X 即可" is DONE. Discussing ask-phrases as a topic is DONE. Status-only endings are DONE.

Chinese 吗 only counts as WAIT when it is a real question (ends with ? / ？, or a clear consent ask). Embedded 吗 inside a noun/phrase with no question mark is DONE (e.g. "…吗记录。").

Hard rule: a status line followed by a consent question is still WAIT (e.g. "分支已合并。\\n\\n删掉这个吗?").`;

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
];

export function wrapClassifierInput(closingText: string): string {
  return wrapMessage(closingText);
}

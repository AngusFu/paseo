/**
 * Regex turn-end gate — ported from check-prose-stop.sh BLOCKING_PATTERNS.
 * Case-insensitive; multiline so ^/$ anchor per line like grep.
 */

const EN_DESTRUCTIVE =
  "delete|remove|clean(up)?|kill|stop|tear ?down|drop|abort|wipe|nuke|prune|commit|push|merge|rebase|amend|reset|force.?push|cherry.?pick|stash drop|revert|rollback|terminate|destroy|uninstall|erase|format|disable|restart|reboot|undo|purge|squash";

const ZH_DESTRUCTIVE = `删除|清理|清除|杀|杀掉|停止|停掉|删掉|清掉|提交|推送|合入|强推|强推送|丢弃|回滚|撤销|销毁|抹掉|抹除|卸载|终止|格式化|重置|重启|重启动|重新启动|${EN_DESTRUCTIVE}`;

/** Pattern source strings — kept as strings so instructional exemption can inspect them. */
export const BLOCKING_PATTERN_SOURCES: readonly string[] = [
  // zh — standalone verbs
  "删除[^?？]{0,80}[吗?？]",
  "删[^?？]{0,30}吗[?？]",
  // zh — "要 X 吗 / 是否 X / 要不要 X / 需要 X 吗 / 要我 X 吗"
  `要[^?？\\n吗]{1,30}(${ZH_DESTRUCTIVE})[^?？]{0,40}吗[?？]?`,
  // NB: must end in a real question marker — bare "是否 X" is "whether X"
  `是否[^?？]{0,30}(${ZH_DESTRUCTIVE})[^?？]{0,40}[吗?？]`,
  `要不要[^?？]{0,80}(${ZH_DESTRUCTIVE}|删|清|停)[^?？]{0,40}[?？]`,
  `需要[^?？]{0,8}(${ZH_DESTRUCTIVE})[^?？]{0,80}[?？]`,
  `要我[^?？]{0,8}(${ZH_DESTRUCTIVE})[^?？]{0,80}[?？]`,
  // zh — ability / readiness / immediacy
  `(可以|能|可不可以|能不能)[^?？]{0,30}(${ZH_DESTRUCTIVE})[^?？]{0,40}[吗?？]`,
  `(准备|打算)[^?？]{0,20}(${ZH_DESTRUCTIVE})[^?？]{0,40}[吗?？]`,
  `(现在|立刻|马上|这就)[^?？]{0,20}(${ZH_DESTRUCTIVE})[^?？]{0,40}[吗?？]`,
  // zh — 把/将 字句
  `(把|将)[^?？]{1,40}(${ZH_DESTRUCTIVE})[^?？]{0,30}[吗?？]`,
  // zh — 委婉建议
  `(要不|不如|干脆|直接)[^?？]{0,20}(${ZH_DESTRUCTIVE}|删|清|停|杀)[^?？]{0,40}[吗?？]`,
  // zh — 主语权限
  `(我能|我可以|你应该|你需要|你要)[^?？]{0,20}(${ZH_DESTRUCTIVE})[^?？]{0,40}[吗?？]`,
  // zh — 祈使疑问
  `(请|麻烦)[^?？]{0,20}(${ZH_DESTRUCTIVE})[^?？]{0,40}[吗?？]`,
  // en — shall / should / want / ok to
  `\\bshall I (${EN_DESTRUCTIVE})\\b`,
  `\\bshould I (${EN_DESTRUCTIVE})\\b`,
  `\\bshall we (${EN_DESTRUCTIVE})\\b`,
  `\\b(do you want|would you like) (me |us )?to (${EN_DESTRUCTIVE})\\b`,
  `\\bwant me to (${EN_DESTRUCTIVE})\\b`,
  // require ? so declarative "200 OK to continue the upload" does not trip
  `\\bok(ay)? to (${EN_DESTRUCTIVE}|proceed|continue|go ahead)\\b[^.?]{0,30}\\?`,
  // en — first-person / generic consent
  `\\b(shall|should|can|may|could) I (proceed|continue|go ahead|go on|start|begin|run|apply)\\b[^.?]{0,40}\\?`,
  `\\b(do you want|would you like|want) (me to )?(proceed|continue|go ahead|go on|run|apply)\\b`,
  // en — ability / permission
  `\\b(can|may|could) I (${EN_DESTRUCTIVE})\\b`,
  `\\bdo I need to (${EN_DESTRUCTIVE})\\b`,
  `\\bam I (allowed|supposed) to (${EN_DESTRUCTIVE})\\b`,
  // en — directed at agent
  `\\b(can|could|would) you (${EN_DESTRUCTIVE})\\b`,
  `\\bare you (going|about|ready) to (${EN_DESTRUCTIVE})\\b`,
  // en — imperative w/ question
  `\\bplease (${EN_DESTRUCTIVE})[^?]{0,40}\\?`,
  `\\bgo ahead and (${EN_DESTRUCTIVE})\\b`,
  // en — 委婉建议
  `\\bhow about (${EN_DESTRUCTIVE})`,
  `\\bwhat if (we|i|you) (${EN_DESTRUCTIVE})`,
  `\\bwhy don'?t (we|you) (${EN_DESTRUCTIVE})\\b`,
  `\\blet'?s (${EN_DESTRUCTIVE})\\b[^?]{0,40}\\?`,
  // en — colloquial short asks
  `(^|[.!?]\\s+)(${EN_DESTRUCTIVE}) (it|this|that|them|everything|all)[^?]{0,20}\\?`,
  `\\bget rid of [^?]{1,40}\\?`,
  `\\b(take|shut|tear) (it|this|that|them) (down|off|out)\\b[^?]{0,20}\\?`,
  // --- Turn-end gate blacklist phrases ---
  "如需.{0,20}告知",
  "需要继续.{0,8}就",
  "需要继续吗",
  "要不要.{0,30}[?？]",
  // boundary leading 要 so compound-word 要 (主要/需要/重要/必要/只要/想要) can't anchor
  "(^|[^主需重必只想])要[^吗]{1,40}吗[?？]",
  "是否要[^?？]{0,30}[吗?？]",
  "(要|我|请|是否要).{0,10}(确认|确定)[^?？]{0,20}[吗?？]",
  "是否启动",
  "是否需要",
  "告知开启",
  "待你[^a-zA-Z]",
  "\\bping me\\b",
  "(^|[\\p{P}]|\\b(please|so|and|or|then)\\b)\\s*let me know\\b",
  "ready when you are",
  "wait for you",
  "需要我.{0,8}继续",
  "继续就告知",
  // Statement-form waiting (no question mark)
  "需要我.{0,40}(说一声|吱一声|告知|讲一声|说一下)",
  "(说一声|吱一声|告知我|讲一声)即可",
  "需要.{0,30}(再|就)(说一声|告知|吱一声)",
  // bare say-verb + 即可/就行
  "(直接|随时|尽管|就)(说|讲|吱一声|喊我)([^明结论清楚的了]|$)",
  "(直接|随时|尽管)告诉我",
  "(说|讲|告诉我|吱一声)(一声)?(即可|就行|就好)",
  // 5th gap (2026-07-27): 「要开迁的时候说一声优先哪几条就行」— say-verb and
  // soft-close are NOT adjacent (content in between). Adjacent pattern above misses.
  // Keep this on 说一声/吱一声/… quantifier forms — bare 「说…就行」is ordinary narration.
  "(说一声|吱一声|告知我|讲一声).{0,24}(即可|就行|就好)",
  "你?(说|讲)一声我?就",
  // condition-clause-first + 即可 after ACTION
  // Use 想要/要继续/要我… — bare `(想|要)` also matches the 要 inside 需要
  // ("需要时…即可" / "需要时告诉我"), which is a common false positive.
  // `想…告诉我` stays (想 is not a substring of 需要). Bare `要…告诉我` dropped —
  // use 要继续/要我/想要/需要我 instead so 需要时… cannot match.
  "(想要|想|要继续|要我|需要我|如果要|若要)[^。！？]{0,25}(告诉我|跟我说|知会|喊我)",
  "(要继续|要我|想要|想继续|需要我)[^。！？]{0,25}(说一声|吱一声)",
  // Same family with soft-close after a gap, but anchored on condition-要 without
  // matching 需要/只要/…要 (lookbehind). Catches 「要开迁的时候说一声…就行」even if
  // the gap pattern above is later tightened.
  "(?<![主需重必只想])要[^。！？]{0,30}(说一声|吱一声).{0,24}(即可|就行|就好)",
  // Line-local "要 X 即可" handoff. Negative lookbehind so 需要/只要/…要 do not count.
  "^(?:想要|(?<![主需重必只想])要)[^。！？]{0,25}即可[。.！!]?$",
  // offer-if-wanted
  "([^不]|^)需要的话.{0,28}(我可以|帮你|继续|push|提交|推送|告诉我|喊我)",
  "([^不需]|^)要的话.{0,28}(我可以|帮你|继续|push|提交|推送|告诉我|喊我)",
  "如果需要.{0,20}(我可以|帮你)",
  "有需要的话",
  "\\bshall we\\b[^?]{0,40}[?？]",
  "\\bok(ay)? to (proceed|continue|go)\\b[^.?]{0,30}\\?",
];

const INSTRUCTIONAL = /只需|用 |通过|改成|加上|执行|运行|设置|配置|加个|即可解决|即可生效/;

const COMPILED_PATTERNS: Array<{ source: string; regex: RegExp }> = BLOCKING_PATTERN_SOURCES.map(
  (source) => ({
    source,
    // `u` so \p{P} works for the let-me-know boundary; `m` for ^/$ per line.
    regex: new RegExp(source, "imu"),
  }),
);

export interface RegexGateHit {
  blocked: true;
  pattern: string;
}

export interface RegexGateMiss {
  blocked: false;
}

export type RegexGateResult = RegexGateHit | RegexGateMiss;

function isExemptablePattern(source: string): boolean {
  // Only the line-local 「要…即可」handoff pattern is instructional-exemptable.
  return (
    source.includes("即可") &&
    (source.includes("(?<![主需重必只想])要") || source.includes("(想|要)"))
  );
}

export function matchBlockingPatterns(closingText: string): RegexGateResult {
  if (!closingText.trim()) {
    return { blocked: false };
  }

  for (const { source, regex } of COMPILED_PATTERNS) {
    regex.lastIndex = 0;
    if (!regex.test(closingText)) {
      continue;
    }
    if (isExemptablePattern(source) && INSTRUCTIONAL.test(closingText)) {
      continue;
    }
    return { blocked: true, pattern: source };
  }

  return { blocked: false };
}

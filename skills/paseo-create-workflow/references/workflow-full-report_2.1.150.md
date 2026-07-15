# Claude Code Workflow 工具：完整 prompt 与内置 workflow 定义

> 提取自 `@anthropic-ai/claude-code-darwin-arm64@2.1.150` 的 native 二进制 → cli.js → 反混淆后的字面量。
> 这份文档是"参考材料"，不是评论：把 LLM 实际看到的 prompt 和 Anthropic 自己写的 saved workflow 脚本原样摆出来。

---

## 索引

- 一、Workflow 工具的注册元数据与 schema
- 二、Workflow 工具的完整 prompt（Nb8，14580 字符）
- 三、Runtime 注入到 subagent 的 5 段 prompt
- 四、Anthropic 内置的 10 个 saved workflow
  - 4.1 总览（按字符数 / 主题排序）
  - 4.2 每个 workflow 的 meta + 关键结构
- 五、附录：所有文件清单

---

## 一、Workflow 工具的注册元数据与 schema

工具定义（cli.js 中 `gJ3` 变量）：

```ts
{
  name: "Workflow",
  aliases: ["RunWorkflow"],
  searchHint: "orchestrate subagents with deterministic JavaScript workflow",
  maxResultSizeChars: 1e5,        // 100 KB 上限
  isEnabled: () => bp(),          // CLAUDE_CODE_WORKFLOWS=1 + 服务端 flag
  prompt:        Nb8,             // 见第二节，14580 字符
  description:   Nb8,             // 同一字符串复用
  inputSchema:   mJ3,
  outputSchema:  pJ3,
}
```

### 1.1 input schema (mJ3)

```ts
z.strictObject({
  script: z
    .string()
    .max(Mp)
    .optional()
    .describe(
      "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
    ),

  name: z
    .string()
    .optional()
    .describe(
      "Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script.",
    ),

  args: z
    .unknown()
    .optional()
    .describe(
      "Optional input value exposed to the script as the global `args`. Use for parameterized named workflows (e.g. a research question).",
    ),

  scriptPath: z
    .string()
    .optional()
    .describe(
      "Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
    ),

  resumeFromRunId: z
    .string()
    .regex(/^wf_[a-z0-9-]{6,}$/)
    .optional()
    .describe(
      "Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (TaskStop) before resuming.",
    ),
}).refine((H) => H.script || H.name || H.scriptPath, {
  message: "Must provide script, name, or scriptPath",
});
```

### 1.2 output schema (pJ3)

```ts
z.object({
  status: z.enum(["async_launched", "remote_launched"]),
  taskId: z.string(),
  runId: z
    .string()
    .optional()
    .describe(
      "Local workflow run identifier for resumeFromRunId. Absent for remote_launched (the CCR session URL is the resume handle there) and on transcripts written before this field existed.",
    ),
  summary: z.string().optional(),
  transcriptDir: z
    .string()
    .optional()
    .describe("Directory where subagent transcripts are written during execution"),
  scriptPath: z
    .string()
    .optional()
    .describe(
      "Path to the persisted workflow script for this invocation. Editable via Write/Edit; pass back as `scriptPath` to re-run without resending the script.",
    ),
  sessionUrl: z.string().optional().describe("CCR session URL when status is remote_launched"),
  warning: z
    .string()
    .optional()
    .describe(
      "Non-blocking heads-up (e.g. local git state diverges from the pushed branch the remote session will clone)",
    ),
  error: z.string().optional().describe("Set if syntax check failed"),
});
```

---

## 二、Workflow 工具的完整 prompt（Nb8）

完整 14580 字符的 prompt 单独存在附件 `Nb8.final.txt`。下面是结构索引（按 prompt 顺序）：

| 段落标题（我加的） | prompt 内容要点                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **L1-3**           | "Execute a workflow script..." — 工具基础定位                                                                                  |
| **L5-11**          | **opt-in 严格规则** — `ultrawork` 关键词 / 用户原话 / skill 触发 / 调 named workflow，四种之一才能调                           |
| **L11-13**         | 不符合 opt-in 怎么办：用 Agent 工具，或者简要说明 + 询问用户成本                                                               |
| **L13**            | **Hybrid 策略** — scout inline first, then Workflow over the work-list                                                         |
| **L15-30**         | `meta` 字面量约束 + 完整 sample 脚本（`find-flaky-tests`）                                                                     |
| **L31**            | meta 字段：name/description/phases/whenToUse/model；title 匹配规则                                                             |
| **L33-41**         | **8 个原语签名** — agent/pipeline/parallel/log/phase/args/budget/workflow                                                      |
| **L43**            | subagent 返回值约定（return raw data, not human message）                                                                      |
| **L45**            | 禁用 Date.now/Math.random/argless new Date 的理由                                                                              |
| **L47-63**         | **DEFAULT TO pipeline()** + barrier 何时正确（dedup/早退/cross-item ref）                                                      |
| **L65**            | 并发上限 `min(16, cores-2)`，生命周期 1000 agent 硬上限                                                                        |
| **L67-89**         | **多 stage canonical 模板**（pipeline 嵌 parallel verify）+ barrier 正确用法（dedup 例）                                       |
| **L91-105**        | Loop-until-count / Loop-until-budget 模板                                                                                      |
| **L107-120**       | **6 种质量姿势**：adversarial verify / judge panel / loop-until-dry / multi-modal sweep / completeness critic / no silent caps |
| **L118**           | Scale guidance："find any bugs" vs "thoroughly audit"                                                                          |
| **L122**           | "deterministic control flow rather than model-driven" 总结句                                                                   |
| **L124-126**       | **Resume 协议** — runId / unchanged prefix returns cached / Date.now ban / journal fallback                                    |

完整附件文件：`Nb8.final.txt`（已经把模板插值 `${KJ3}='worktree'` 等求值掉了）。

---

## 三、Runtime 注入到 subagent 的 5 段 prompt

每次 `agent()` 启动一个 subagent，Claude Code 会在被调子 agent 的 system prompt 末尾追加一段 workflow-specific 指令。具体追加哪段，按以下决策矩阵：

| 调用形态                        | 追加 prompt                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------- |
| 默认（无 schema、无 agentType） | 使用 workflow-subagent 内置 agentType，**整套 system prompt 是 `rj3`**           |
| 有 `schema`，无 agentType       | 用 workflow-subagent + `aj3` 追加（StructuredOutput 强制）                       |
| 有 `agentType`，无 schema       | 用户自定义 agent 的 prompt + **`oj3` 追加**（verbatim return）                   |
| 有 `agentType`，有 schema       | 用户自定义 agent 的 prompt + **`aj3` 追加** + 把 StructuredOutput 工具加入白名单 |

### 3.1 `rj3` — workflow-subagent 默认 system prompt（590 字符）

```text
You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
- Be concise. The script will parse your output.
```

### 3.2 `aj3` — 当 `opts.schema` 启用时追加（374 字符）

```text


---

NOTE: You are running inside a workflow script. You MUST return your final answer by calling the StructuredOutput tool exactly once — the tool's input schema defines the required shape. Do your work, then call StructuredOutput; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call StructuredOutput again with a corrected shape.
```

### 3.3 `oj3` — 当 `opts.agentType` 自定义但无 schema 时追加（303 字符）

```text


---

NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.
```

### 3.4 `ij3` — agent 调用上限触发时的错误消息（120 字符）

```text
Workflow agent() call cap reached (1000). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.
```

### 3.5 `yw3` / `hw3` — 禁用 API 的错误消息

```text
yw3: Date.now() / new Date() are unavailable in workflow scripts (breaks resume).
     Stamp results after the workflow returns, or pass timestamps via args.

hw3: Math.random() is unavailable in workflow scripts (breaks resume).
     For N independent samples, include the index in the agent label or prompt.
```

---

## 四、Anthropic 内置的 10 个 saved workflow

这 10 个 workflow 由 `k03()` 函数（cli.js 字节 9389886 附近）在启动时注册到 workflow registry，LLM 可以直接 `workflow('name', { args: ... })` 调用，无需自己写脚本。

源码里的注册逻辑：

```js
function k03() {
  if (mH(process.env.CLAUDE_CODE_REMOTE)) (O3K(), w3K(), h3K(), F3K(), n3K()); // remote-only 才注册的 5 个
  (X3K(), L3K(), x3K(), t3K(), OOK()); // standard 永远注册的 5 个
}
```

也就是说：**standard 模式下只能用 5 个 workflow，CLAUDE_CODE_REMOTE=1 时才解锁另外 5 个**。从 register 函数名能精确映射到 workflow（详见 4.3 节的分类发现）。

### 4.1 总览

"模式"列说明：✅ standard = 本地默认就能用；🔒 remote-only = 必须 `CLAUDE_CODE_REMOTE=1` 才注册。

| name              | 模式           | register fn | 字符数 | description                                                                             |
| ----------------- | -------------- | ----------- | ------ | --------------------------------------------------------------------------------------- |
| **autopilot**     | 🔒 remote-only | O3K         | 16,107 | 端到端任务：5 角度 critique → 实现 → bughunt-lite review + completeness → fix → PR      |
| **bugfix**        | 🔒 remote-only | w3K         | 7,798  | Reproduce-first 修 bug：failing repro → root-cause → 最小 fix → 转 regression test → PR |
| **dashboard**     | 🔒 remote-only | h3K         | 8,166  | 自定义仪表盘生成                                                                        |
| **docs**          | 🔒 remote-only | F3K         | 7,512  | 文档生成                                                                                |
| **investigate**   | 🔒 remote-only | n3K         | 8,026  | 多角度调查问题                                                                          |
| **bughunt**       | ✅ standard    | X3K         | 14,505 | Self-respawning finder pool → 5-vote 对抗 pigeonhole 早退 → synthesis                   |
| **bughunt-lite**  | ✅ standard    | L3K         | 11,684 | 固定 3-rapid+2-deep finder stream 进 5-vote 验证 → synthesis（简化版）                  |
| **deep-research** | ✅ standard    | x3K         | 17,170 | Web search fan-out → fetch → 对抗 verify claims → cited report                          |
| **plan-hunter**   | ✅ standard    | t3K         | 8,381  | 4 个 plan（MVP/risk/dep/user 视角）× 4 个 judge 投票 → 综合 + 嫁接亚军                  |
| **review-branch** | ✅ standard    | OOK         | 11,814 | 分支多维度 review（6 dim）→ 每个 finding 对抗验证 → 报告                                |

### 4.2 一条隐藏边界：remote-only 的全是"会改东西"的 workflow

把 4.1 表格按"模式"重排，规律立刻浮出来：

| Remote-only（要在 CCR 沙箱跑）       | Always-on（本地直接跑）     |
| ------------------------------------ | --------------------------- |
| autopilot ← 写代码 + 开 PR           | bughunt ← 只找不修          |
| bugfix ← 改代码 + 写测试 + 开 PR     | bughunt-lite ← 只找不修     |
| dashboard ← 生成 UI 文件             | deep-research ← 只产报告    |
| docs ← 生成文档文件                  | plan-hunter ← 只出 plan     |
| investigate ← 写调查报告并可能改文件 | review-branch ← 只出 review |

分类标准很清楚：**会写文件 / 推 PR / 持久化产物 → 强制 remote**；**只读 / 只产文本报告 → 本地 OK**。这不是按复杂度划，是按副作用大小划。

为什么这么设计？两个推测：

1. **隔离写操作的爆炸半径**。autopilot/bugfix 会触发 Edit/Write/Bash 长链路自动操作，本地仓库被搞坏的代价高；丢到 CCR 远程 sandbox 跑，最坏情况是丢 sandbox，本地仓库纹丝不动。
2. **降低对本地环境的要求**。bugfix/autopilot 要 lint/typecheck/`gh pr create`，本地环境配置参差不齐——远程沙箱有标准化镜像。CCR 那边的 sessionUrl 输出本质就是个 PR 链接。

这条分类参考文章没提，cc-enhanced 的 patch list 也没碰——它是 Anthropic 在 CCR 灰度阶段为安全边界画的一条线。`CLAUDE_CODE_REMOTE=1` 翻成默认开启的那天，5 个"写"类 workflow 才会被普通用户看见。

### 4.3 每个 workflow 的 meta + 关键结构

#### autopilot (16,107 chars)

```js
export const meta = {
  name: "autopilot",
  description:
    "An end-to-end task runner. Builds a plan with a 5-angle adversarial critique, adjusts the plan, implements, uses a bughunt-lite review + feature completeness check, fixes issues, then opens a PR.",
  whenToUse:
    "When the user gives a self-contained coding task they want completed end-to-end without supervision. Best for long-running tasks that require some or large amounts of planning and verification. This workflow scopes the problem, hardens its plan using 5 critics, implements it, runs a bug hunting sweep and a feature completeness check, fixes issues, and then opens a PR.",
  phases: [
    {
      title: "Plan",
      detail: "Scope + draft, 5 critics (scope/simplicity/reuse/verification/correctness), harden",
    },
    { title: "Implement", detail: "Single agent executes the hardened plan" },
    {
      title: "Review",
      detail: "3 rapid + 2 deep finders, 5-vote pigeonhole verify, + completeness vs task",
    },
    { title: "Fix", detail: "Address confirmed issues (skipped if clean)" },
    { title: "PR", detail: "Lint, typecheck, open PR, subscribe to auto-fix" },
  ],
};
```

关键结构：

- **Schemas**：`PLAN_SCHEMA` (summary/files/steps/risks/reuse/verification), `CRITIQUE_SCHEMA` (holes[severity,what,why,fix]), `IMPL_SCHEMA`, `REVIEW_SCHEMA`, `FIX_SCHEMA`, `PR_SCHEMA`
- **Phase 1 Plan**：先 single agent 出 draft plan → `parallel([5 critics])` 各从一个角度找洞 → 把所有 holes 合并 → single agent 出 hardened plan
- **Phase 2 Implement**：single agent 拿 hardened plan 直接实现
- **Phase 3 Review**：等价于内嵌 bughunt-lite：3 rapid + 2 deep finder pipeline → 5-vote pigeonhole verify
- **Phase 4 Fix**：confirmed issues 数 > 0 才触发，single agent 修复
- **Phase 5 PR**：lint + typecheck + open PR + subscribe to auto-fix（如果环境有这个工具）

完整脚本：`autopilot.workflow.ts`

#### bugfix (7,798 chars)

```js
export const meta = {
  name: "bugfix",
  description:
    "Reproduce-first bug fixer. Writes a failing repro, root-causes the fault, applies the minimal fix, converts the repro into a regression test, then opens a PR.",
  whenToUse:
    "When the user reports a specific bug to fix. Best when the bug is concrete enough to reproduce. This workflow writes a failing repro first, traces the root cause, applies the smallest fix that makes the repro pass, locks it in as a regression test, and opens a PR.",
  phases: [
    { title: "Reproduce", detail: "Write a failing script or test that demonstrates the bug" },
    { title: "Root-cause", detail: "Trace the fault, grep callers, identify the minimal culprit" },
    { title: "Fix", detail: "Smallest diff that makes the repro pass" },
    { title: "Regress", detail: "Convert repro into a permanent test, run the touched suite" },
    { title: "PR", detail: "Lint, typecheck, open PR" },
  ],
};
```

关键结构：5 个顺序 phase，每个 phase 一个 agent。Phase 1 出来的 `reproPath` 是后续所有 phase 的依赖参数。

完整脚本：`bugfix.workflow.ts`

#### bughunt (14,505 chars)

```js
export const meta = {
  name: "bughunt",
  description:
    "Multi-agent bug sweep of the current branch. Self-respawning finder pool (3 rapid + deep-until-dry-streak) streams into 5-vote adversarial verification with pigeonhole early-exit, then synthesis.",
  whenToUse:
    "When the user asks to hunt for bugs, audit code quality, or run a high-precision bug sweep on the current branch.",
  phases: [
    { title: "Scope", detail: "Discover diff base, changed files, conventions" },
    { title: "Find", detail: "3 rapid + deep-until-dry-streak(3), self-respawning pool" },
    {
      title: "Verify",
      detail: "5-vote adversarial, pigeonhole early-exit (2 refute → dead, skip 3)",
    },
    { title: "Synthesize", detail: "Semantic dedup on confirmed set, final report" },
  ],
};
```

关键结构（最具教学价值的 workflow 之一）：

- **Phase 1 Scope**：discover diff base + changed files + CLAUDE.md 约定，构造 `CONTEXT_HEADER` 给所有后续 agent 共享
- **Phase 2 Find（self-respawning）**：3 个 rapid finder 并行启动；同时启动 deep finder loop，每次 deep finder 找到 ≥1 bug 计 0 干旱，找到 0 bug 计 +1 干旱；连续 3 轮干旱才停。所有 finder 输出统一进入 `findingQueue`
- **Phase 3 Verify（pigeonhole 5-vote）**：每个 finding 派 5 个 refuter agent 并行，但 `parallel` 改造成"早退"——一旦累计 2 个 refute（majority - 1），剩下 3 个 agent 自动 abort，结论是 "dead"。这就是 "pigeonhole early-exit"
- **Phase 4 Synthesize**：confirmed 集合 → semantic dedup（agent 调用）→ 按 severity rank 排序 → 出最终 markdown 报告

完整脚本：`bughunt.workflow.ts`

#### bughunt-lite (11,684 chars)

```js
export const meta = {
  name: "bughunt-lite",
  description:
    "Lighter bug sweep — fixed 3-rapid+2-deep finders stream into 5-vote adversarial verification (pigeonhole early-exit), then synthesis. Simpler than bughunt: no self-respawning, no dry-streak.",
  whenToUse:
    "When the user wants a faster, bounded bug sweep of the current branch. Prefer over bughunt for small-to-medium diffs where a fixed finder pool is sufficient.",
  phases: [
    { title: "Scope", detail: "Discover diff base, changed files, conventions" },
    { title: "Find", detail: "3 rapid + 2 deep finders — stream into verify as each completes" },
    { title: "Verify", detail: "5 adversarial votes, pigeonhole early-exit (2 refute → skip 3)" },
    { title: "Synthesize", detail: "Semantic dedup on confirmed set, final report" },
  ],
};
```

跟 bughunt 比少了 self-respawning 和 dry-streak，固定 5 个 finder（3 rapid + 2 deep）。streaming 用 pipeline 实现：finder 一吐出 finding 就触发 verify，不等其他 finder。

完整脚本：`bughunt-lite.workflow.ts`

#### dashboard (8,166 chars)

```js
export const meta = {
  name: 'dashboard',
  description: '...',  // 具体值在脚本第一行
  ...
}
```

完整脚本：`dashboard.workflow.ts`

#### deep-research (17,170 chars)

```js
export const meta = {
  name: 'deep-research',
  description: 'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
  whenToUse: '...',
  phases: [
    {title:"Plan",       detail:"Decompose the question into sub-queries"},
    {title:"Search",     detail:"Parallel web searches for each sub-query"},
    {title:"Read",       detail:"Fetch top sources per query"},
    {title:"Synthesize", detail:"Draft answer with inline citations"},
    {title:"Verify",     detail:"Adversarially check each claim against sources"},
    ...
  ],
}
```

关键结构：典型 fan-out → fan-in：plan 出 sub-query 列表 → `pipeline(subqueries, search, fetch)` 每个子查询独立完成搜索和抓取 → 汇总成草稿 → 每条 claim 派对抗 verifier。

完整脚本：`deep-research.workflow.ts`

#### docs (7,512 chars)

文档生成 workflow。详见 `docs.workflow.ts`。

#### investigate (8,026 chars)

多角度调查 workflow。详见 `investigate.workflow.ts`。

#### plan-hunter (8,381 chars)

```js
export const meta = {
  name: "plan-hunter",
  description:
    "Exhaustive planning harness. Generates 4 independent draft plans (MVP-first, risk-first, dependency-first, user-first), scores them with 4 parallel judges, picks the winner by vote, then synthesizes a polished final plan grafting in the best ideas from runners-up.",
  whenToUse:
    "When the user has an idea they want planned thoroughly. BEFORE invoking this workflow, ask 2-3 clarifying questions if the idea is underspecified: (1) scope/timeline, (2) hard constraints or non-goals, (3) success criteria. Then pass the clarified idea as the args string.",
  phases: [
    { title: "Scope", detail: "Understand the idea, extract constraints, note assumptions" },
    { title: "Draft", detail: "4 parallel planners: MVP / Risk / Dependency / User lenses" },
    { title: "Judge", detail: "4 parallel judges rank all 4 drafts" },
    { title: "Synthesize", detail: "Polish the winner, graft best ideas from runners-up" },
  ],
};
```

关键结构（评审团模式的标准实现）：

- **Phase 1 Scope**：单 agent 提取 constraints/assumptions
- **Phase 2 Draft**：`parallel([drafterMVP, drafterRisk, drafterDep, drafterUser])` —— 4 个不同视角 prompt 独立产 plan
- **Phase 3 Judge**：`parallel([judge1, judge2, judge3, judge4])`，每个 judge 看到所有 4 个 draft 打分排名
- **Phase 4 Synthesize**：取得分最高的 draft 作主干，其他 draft 的高分要点嫁接进来

完整脚本：`plan-hunter.workflow.ts`

#### review-branch (11,814 chars)

```js
export const meta = {
  name: "review-branch",
  description:
    "Thoroughly review the current branch for bugs, simplicity, architecture, dead code, best practices, and pattern consistency. Each finding is adversarially verified before reporting.",
  whenToUse:
    "When the user asks to review their branch, do a code review of recent changes, or audit a PR quality before shipping.",
  phases: [
    { title: "Scope", detail: "Discover diff base, changed files, conventions" },
    { title: "Review", detail: "Six dimension reviewers in parallel" },
    { title: "Verify", detail: "Adversarial verification of each finding" },
    { title: "Report", detail: "Dedup, rank, and summarize" },
  ],
};
```

关键结构：

- 6 个 review dimension：bugs / simplicity / architecture / dead-code / best-practices / consistency
- pipeline 而不是 parallel：每个 dimension 完成 review 后直接 stream 进 verify，不等其他 dimension
- verify 是单 vote（不像 bughunt 5-vote）——review-branch 偏向广度而非深度

完整脚本：`review-branch.workflow.ts`

---

---

## 五、附录 A：Workflow 工具完整 prompt（Nb8.final.txt）

_长度 14580 字符。模板插值 (`${KJ3}`='worktree' 等) 已求值。这就是 LLM 调用 Workflow 工具时唯一的指导_。

```text
Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the "ultrawork" keyword (you'll see a system-reminder confirming it).
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call Workflow.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the Agent tool for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can include "ultrawork" in a future message to skip the ask.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the channels, scope the diff) to discover the work-list, then call Workflow to pipeline over it. You don't need to know the shape before the *task* — only before the *orchestration step*.

Every invocation persists its script to a file under the session directory and returns the path in the tool result. To iterate on a workflow, edit that file with Write/Edit and re-invoke Workflow with `{scriptPath: "<path>"}` instead of resending the full script.

Every script must begin with `export const meta = {...}`:
  export const meta = {
    name: 'find-flaky-tests',
    description: 'Find flaky tests and propose fixes',   // one-line, shown in permission dialog
    phases: [                                            // one entry per phase() call
      { title: 'Scan', detail: 'grep test logs for retries' },
      { title: 'Fix', detail: 'one agent per flaky test' },
    ],
  }
  // script body starts here — use agent()/parallel()/pipeline()/phase()/log()
  phase('Scan')
  const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})
  ...

The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: `name`, `description`. Optional: `whenToUse` (shown in the workflow list), `phases`. Use the SAME phase titles in meta.phases as in phase() calls — titles are matched exactly; a phase() call with no matching meta entry just gets its own progress group. Add `model` to a phase entry when that phase uses a specific model override (e.g. `{title: 'Verify', model: 'haiku'}`).

Script body hooks:
- agent(prompt: string, opts?: {label?: string, phase?: string, schema?: object, model?: string, isolation?: 'worktree', agentType?: string}): Promise<any> — spawn a subagent. Without schema, returns its final text as a string. With schema (a JSON Schema), the subagent is forced to call a StructuredOutput tool and agent() returns the validated object — no parsing needed. Returns null if the user skips the agent mid-run (filter with .filter(Boolean)). opts.label overrides the display label. opts.phase explicitly assigns this agent to a progress group (use this inside pipeline()/parallel() stages to avoid races on the global phase() state — same phase string → same group box). opts.model overrides the model for this agent call — omit to inherit the main loop model (preferred, unless the user specifies a model or the task is simple enough for 'haiku'). opts.isolation: 'worktree' runs the agent in a fresh git worktree — EXPENSIVE (~200-500ms setup + disk per agent), use ONLY when agents mutate files in parallel and would otherwise conflict; the worktree is auto-removed if unchanged. opts.agentType uses a custom subagent type (e.g. 'Explore', 'code-reviewer') instead of the default workflow subagent — resolved from the same registry as the Agent tool; composes with schema (the custom agent's system prompt gets a StructuredOutput instruction appended).
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives (prevResult, originalItem, index) — use originalItem/index in later stages to label work without threading context through stage 1's return value. A stage that throws drops that item to `null` and skips its remaining stages.
- parallel(thunks: Array<() => Promise<any>>): Promise<any[]> — run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A thunk that throws (or whose agent errors) resolves to `null` in the result array — the call itself never rejects, so `.filter(Boolean)` before using the results. Use ONLY when you genuinely need all results together.
- log(message: string): void — emit a progress message to the user (shown as a narrator line above the progress tree)
- phase(title: string): void — start a new phase; subsequent agent() calls are grouped under this title in the progress display
- args: any — the value passed as Workflow's `args` input (undefined if not provided). Use this to parameterize named workflows — e.g. pass a research question, target path, or config object directly instead of via a side-channel file.
- budget: {total: number|null, spent(): number, remaining(): number} — the turn's token target from the user's "+500k"-style directive. `budget.total` is null if no target was set. `budget.spent()` returns output tokens spent this turn across the main loop and all workflows — the pool is shared, not per-workflow. `budget.remaining()` returns `max(0, total - spent())`, or `Infinity` if no target. The target is a HARD ceiling, not advisory: once `spent()` reaches `total`, further `agent()` calls throw. Use for dynamic loops: `while (budget.total && budget.remaining() > 50_000) { ... }`, or static scaling: `const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5`.
- workflow(nameOrRef: string | {scriptPath: string}, args?: any): Promise<any> — run another workflow inline as a sub-step and return whatever it returns. Pass a name to invoke a saved workflow (same registry as {name: "..."}), or {scriptPath} to run a script file you Wrote earlier. The child shares this run's concurrency cap, agent counter, abort signal, and token budget — its agents appear under a "â¸ name" group in /workflows and its tokens count toward budget.spent(). The args param becomes the child's `args` global. Nesting is one level only: workflow() inside a child throws. Throws on unknown name / unreadable scriptPath / child syntax error; catch to handle gracefully.

Subagents are told their final text IS the return value (not a human-facing message), so they return raw data. For structured output, use the schema option — validation happens at the tool-call layer so the model retries on mismatch.

The script body runs in an async context — use await directly. Standard JS built-ins (JSON, Math, Array, etc.) are available — EXCEPT `Date.now()`/`Math.random()`/argless `new Date()`, which throw (they would break resume); pass timestamps in via `args`, stamp results after the workflow returns, and for randomness vary the agent prompt/label by index. No filesystem or Node.js API access.

DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely need ALL prior-stage results together.

A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1:
- Dedup/merge across the full result set before expensive downstream work
- Early-exit if the total count is zero ("0 bugs found → skip verification entirely")
- Stage N's prompt references "the other findings" for comparison

A barrier is NOT justified by:
- "I need to flatten/map/filter first" — do it inside a pipeline stage: pipeline(items, stageA, r => transform([r]).flat(), stageB)
- "The stages are conceptually separate" — that's what pipeline() models. Separate stages ≠ synchronized stages.
- "It's cleaner code" — barrier latency is real. If 5 finders run and the slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders' idle time.

Smell test: if you wrote
  const a = await parallel(...)
  const b = transform(a)        // flatten, map, filter — no cross-item dependency
  const c = await parallel(b.map(...))
that middle transform doesn't need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.

Concurrent agent() calls are capped at min(16, cpu cores - 2) per workflow — excess calls queue and run as slots free up. You can still pass 100 items to parallel()/pipeline() and they all complete; only ~10 run at any moment. Total agent count across a workflow's lifetime is capped at 1000 — a runaway-loop backstop set far above any real workflow.

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:
  export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => parallel(review.findings.map(f => () =>
      agent(`Adversarially verify: ${f.title}`, {label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v}))
    ))
  )
  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
  return { confirmed }
  // Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.

When a barrier IS correct — dedup across all findings before expensive verification:
  const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))
  const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // <-- genuinely needs ALL at once
  const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))

Loop-until-count pattern — accumulate to a target:
  const bugs = []
  while (bugs.length < 10) {
    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
    bugs.push(...result.bugs)
    log(`${bugs.length}/10 found`)
  }

Loop-until-budget pattern — scale depth to the user's "+500k" directive. Guard on budget.total: with no target set, remaining() is Infinity and the loop would run straight to the 1000-agent cap.
  const bugs = []
  while (budget.total && budget.remaining() > 50_000) {
    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
    bugs.push(...result.bugs)
    log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining`)
  }

Quality patterns — common shapes; pick by task and compose freely:
- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE. Kill if ≥majority refute. Prevents plausible-but-wrong findings from surviving.
    const votes = await parallel(Array.from({length: 3}, () => () =>
      agent(`Try to refute: ${claim}. Default to refuted=true if uncertain.`, {schema: VERDICT})))
    const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
- Judge panel: generate N independent attempts from different angles (e.g. MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.
- Loop-until-dry: for unknown-size discovery (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new. Simple counters (while count < N) miss the tail.
- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time). Each is blind to what the others surface; useful when one search angle won't find everything.
- Completeness critic: a final agent that asks "what's missing — modality not run, claim unverified, source unread?" What it finds becomes the next round of work.
- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling), `log()` what was dropped — silent truncation reads as "covered everything" when it didn't.

Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify. "thoroughly audit this" or "be comprehensive" → larger finder pool, 3–5 vote adversarial pass, synthesis stage. When unsure, lean toward thoroughness for research/review/audit requests and toward brevity for quick checks.

These patterns aren't exhaustive — compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits).

Use this tool for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.

## Resume

The tool result includes a runId. To resume after a pause, kill, or script edit, relaunch with Workflow({scriptPath, resumeFromRunId}) — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it runs live. Same script + same args → 100% cache hit. Date.now()/Math.random()/new Date() are unavailable in scripts (they would break this) — stamp results after the workflow returns, or pass timestamps via args. Fallback when no journal is available: Read agent-<id>.jsonl files in the transcript directory and hand-author a continuation script.
```

---

## 六、附录 B：内置 workflow MANIFEST（meta 结构化清单）

```json
[
  {
    "name": "autopilot",
    "description": "An end-to-end task runner. Builds a plan with a 5-angle adversarial critique, adjusts the plan, implements, uses a bughunt-lite review + feature completeness check, fixes issues, then opens a PR.",
    "whenToUse": "When the user gives a self-contained coding task they want completed end-to-end without supervision. Best for long-running tasks that require some or large amounts of planning and verification. This workflow scopes the problem, hardens its plan using 5 critics, implements it, runs a bug hunting sweep and a feature completeness check, fixes issues, and then opens a PR.",
    "phases": "[{title:\"Plan\",detail:\"Scope + draft, 5 critics (scope/simplicity/reuse/verification/correctness), harden\"},{title:\"Implement\",detail:\"Single agent executes the hardened plan\"},{title:\"Review\",detail:\"3 rapid + 2 deep finders, 5-vote pigeonhole verify, + completeness vs task\"},{title:\"Fix\",detail:\"Address confirmed issues (skipped if clean)\"},{title:\"PR\",detail:\"Lint, typecheck, open PR, subscribe to auto-fix\"}]",
    "chars": 16107,
    "file": "autopilot.workflow.ts"
  },
  {
    "name": "bugfix",
    "description": "Reproduce-first bug fixer. Writes a failing repro, root-causes the fault, applies the minimal fix, converts the repro into a regression test, then opens a PR.",
    "whenToUse": "When the user reports a specific bug to fix. Best when the bug is concrete enough to reproduce. This workflow writes a failing repro first, traces the root cause, applies the smallest fix that makes the repro pass, locks it in as a regression test, and opens a PR.",
    "phases": "[{title:\"Reproduce\",detail:\"Write a failing script or test that demonstrates the bug\"},{title:\"Root-cause\",detail:\"Trace the fault, grep callers, identify the minimal culprit\"},{title:\"Fix\",detail:\"Smallest diff that makes the repro pass\"},{title:\"Regress\",detail:\"Convert repro into a permanent test, run the touched suite\"},{title:\"PR\",detail:\"Lint, typecheck, open PR\"}]",
    "chars": 7798,
    "file": "bugfix.workflow.ts"
  },
  {
    "name": "bughunt",
    "description": "Multi-agent bug sweep of the current branch. Self-respawning finder pool (3 rapid + deep-until-dry-streak) streams into 5-vote adversarial verification with pigeonhole early-exit, then synthesis.",
    "whenToUse": "When the user asks to hunt for bugs, audit code quality, or run a high-precision bug sweep on the current branch.",
    "phases": "[{title:\"Scope\",detail:\"Discover diff base, changed files, conventions\"},{title:\"Find\",detail:\"3 rapid + deep-until-dry-streak(3), self-respawning pool\"},{title:\"Verify\",detail:\"5-vote adversarial, pigeonhole early-exit (2 refute → dead, skip 3)\"},{title:\"Synthesize\",detail:\"Semantic dedup on confirmed set, final report\"}]",
    "chars": 14505,
    "file": "bughunt.workflow.ts"
  },
  {
    "name": "bughunt-lite",
    "description": "Lighter bug sweep — fixed 3-rapid+2-deep finders stream into 5-vote adversarial verification (pigeonhole early-exit), then synthesis. Simpler than bughunt: no self-respawning, no dry-streak.",
    "whenToUse": "When the user wants a faster, bounded bug sweep of the current branch. Prefer over bughunt for small-to-medium diffs where a fixed finder pool is sufficient.",
    "phases": "[{title:\"Scope\",detail:\"Discover diff base, changed files, conventions\"},{title:\"Find\",detail:\"3 rapid + 2 deep finders — stream into verify as each completes\"},{title:\"Verify\",detail:\"5 adversarial votes, pigeonhole early-exit (2 refute → skip 3)\"},{title:\"Synthesize\",detail:\"Semantic dedup on confirmed set, final report\"}]",
    "chars": 11684,
    "file": "bughunt-lite.workflow.ts"
  },
  {
    "name": "dashboard",
    "description": "Dashboard generator. Discovers data sources and existing dashboard conventions in the repo, designs a panel layout, implements it, dry-runs queries and render-checks the result, then opens a PR.",
    "whenToUse": "When the user wants a dashboard, monitoring view, or metrics page built. This workflow finds the available data and existing dashboard patterns, specs out panels and layout, implements them, validates queries and rendering, and opens a PR.",
    "phases": "[{title:\"Discover\",detail:\"Data sources, existing dashboard libs/patterns in repo\"},{title:\"Design\",detail:\"Panels, metrics, layout spec\"},{title:\"Implement\",detail:\"Build the dashboard\"},{title:\"Verify\",detail:\"Query dry-run, render/screenshot if possible\"},{title:\"PR\",detail:\"Open PR\"}]",
    "chars": 8166,
    "file": "dashboard.workflow.ts"
  },
  {
    "name": "deep-research",
    "description": "Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.",
    "whenToUse": "<I3K>",
    "phases": "[{title:\"Scope\",detail:\"Decompose question (from args) into 5 search angles\"},{title:\"Search\",detail:\"5 parallel WebSearch agents, one per angle\"},{title:\"Fetch\",detail:\"URL-dedup, fetch top 15 sources, extract falsifiable claims\"},{title:\"Verify\",detail:\"3-vote adversarial verification per claim (need 2/3 refutes to kill)\"},{title:\"Synthesize\",detail:\"Merge semantic dupes, rank by confidence, cite sources\"}]",
    "chars": 17170,
    "file": "deep-research.workflow.ts"
  },
  {
    "name": "docs",
    "description": "Documentation generator. Discovers the feature surface and existing doc conventions, outlines for the target audience, writes or updates the docs, verifies code examples and links, then opens a PR.",
    "whenToUse": "When the user wants documentation written or updated for a feature, API, or module. This workflow finds the relevant code and existing doc patterns, drafts an outline, writes the content, checks that examples run and links resolve, and opens a PR.",
    "phases": "[{title:\"Discover\",detail:\"Feature surface, existing docs, location conventions\"},{title:\"Outline\",detail:\"Structure and audience\"},{title:\"Write\",detail:\"Create or update doc files\"},{title:\"Verify\",detail:\"Examples compile/run, links resolve, accuracy vs code\"},{title:\"PR\",detail:\"Open PR\"}]",
    "chars": 7512,
    "file": "docs.workflow.ts"
  },
  {
    "name": "investigate",
    "description": "Root-cause investigation. Gathers evidence, generates competing hypotheses in parallel, adversarially refutes each one, and produces a written root-cause report with a suggested fix.",
    "whenToUse": "When the user wants the root cause of an incident, error, log, trace, or puzzling behavior found — without necessarily fixing it. This workflow collects evidence, runs parallel hypothesis agents, tries to refute each hypothesis, and writes up the surviving root cause with next steps. It produces a report, not a PR.",
    "phases": "[{title:\"Gather\",detail:\"Logs, traces, repro, timeline\"},{title:\"Hypothesize\",detail:\"3 parallel hypothesis agents\"},{title:\"Verify\",detail:\"One adversarial refuter per hypothesis\"},{title:\"Report\",detail:\"Root-cause writeup, suggested fix, next steps\"}]",
    "chars": 8026,
    "file": "investigate.workflow.ts"
  },
  {
    "name": "plan-hunter",
    "description": "Exhaustive planning harness. Generates 4 independent draft plans (MVP-first, risk-first, dependency-first, user-first), scores them with 4 parallel judges, picks the winner by vote, then synthesizes a polished final plan grafting in the best ideas from runners-up.",
    "whenToUse": "When the user has an idea they want planned thoroughly. BEFORE invoking this workflow, ask 2-3 clarifying questions if the idea is underspecified: (1) scope/timeline, (2) hard constraints or non-goals, (3) success criteria. Then pass the clarified idea as the args string.",
    "phases": "[{title:\"Scope\",detail:\"Understand the idea, extract constraints, note assumptions\"},{title:\"Draft\",detail:\"4 parallel planners: MVP / Risk / Dependency / User lenses\"},{title:\"Judge\",detail:\"4 parallel judges rank all 4 drafts\"},{title:\"Synthesize\",detail:\"Polish the winner, graft best ideas from runners-up\"}]",
    "chars": 8381,
    "file": "plan-hunter.workflow.ts"
  },
  {
    "name": "review-branch",
    "description": "Thoroughly review the current branch for bugs, simplicity, architecture, dead code, best practices, and pattern consistency. Each finding is adversarially verified before reporting.",
    "whenToUse": "When the user asks to review their branch, do a code review of recent changes, or audit a PR quality before shipping.",
    "phases": "[{title:\"Scope\",detail:\"Discover diff base, changed files, conventions\"},{title:\"Review\",detail:\"Six dimension reviewers in parallel\"},{title:\"Verify\",detail:\"Adversarial verification of each finding\"},{title:\"Report\",detail:\"Dedup, rank, and summarize\"}]",
    "chars": 11814,
    "file": "review-branch.workflow.ts"
  }
]
```

---

## 七、附录 C：10 个内置 workflow 完整脚本

以下是 Anthropic 内置在 cli.js 里的 10 个 saved workflow 完整源码。每个都是真实可运行的 TypeScript（在 Workflow VM context 里跑）。

### C.1 `autopilot` (16107 chars)

```ts
export const meta = {
  name: "autopilot",
  description:
    "An end-to-end task runner. Builds a plan with a 5-angle adversarial critique, adjusts the plan, implements, uses a bughunt-lite review + feature completeness check, fixes issues, then opens a PR.",
  whenToUse:
    "When the user gives a self-contained coding task they want completed end-to-end without supervision. Best for long-running tasks that require some or large amounts of planning and verification. This workflow scopes the problem, hardens its plan using 5 critics, implements it, runs a bug hunting sweep and a feature completeness check, fixes issues, and then opens a PR.",
  phases: [
    {
      title: "Plan",
      detail: "Scope + draft, 5 critics (scope/simplicity/reuse/verification/correctness), harden",
    },
    { title: "Implement", detail: "Single agent executes the hardened plan" },
    {
      title: "Review",
      detail: "3 rapid + 2 deep finders, 5-vote pigeonhole verify, + completeness vs task",
    },
    { title: "Fix", detail: "Address confirmed issues (skipped if clean)" },
    { title: "PR", detail: "Lint, typecheck, open PR, subscribe to auto-fix" },
  ],
};

const TASK = typeof args === "string" && args.trim() ? args.trim() : "";
if (!TASK) return { error: "No task provided. Pass the task description as args." };

// ═══ Schemas ═══
const PLAN_SCHEMA = {
  type: "object",
  required: ["summary", "files", "steps", "risks"],
  properties: {
    summary: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    reuse: {
      type: "array",
      items: { type: "string" },
      description: "Existing utilities/functions to reuse (file:line)",
    },
    verification: { type: "string" },
  },
};
const CRITIQUE_SCHEMA = {
  type: "object",
  required: ["verdict", "holes"],
  properties: {
    verdict: { enum: ["PASS", "REVISE"] },
    holes: {
      type: "array",
      items: {
        type: "object",
        required: ["issue", "severity"],
        properties: {
          issue: { type: "string" },
          severity: { enum: ["blocker", "major", "minor"] },
          suggestion: { type: "string" },
        },
      },
    },
  },
};
const IMPL_SCHEMA = {
  type: "object",
  required: ["done", "filesChanged", "notes"],
  properties: {
    done: { type: "boolean" },
    filesChanged: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
  },
};
const BUGS_SCHEMA = {
  type: "object",
  required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "description", "severity"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          severity: { enum: ["critical", "high", "medium", "low", "nit"] },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence"],
  properties: { refuted: { type: "boolean" }, evidence: { type: "string" } },
};
const COMPLETENESS_SCHEMA = {
  type: "object",
  required: ["covered", "gaps"],
  properties: {
    covered: { type: "boolean" },
    gaps: {
      type: "array",
      items: {
        type: "object",
        required: ["what", "where"],
        properties: { what: { type: "string" }, where: { type: "string" } },
      },
    },
  },
};
const PR_SCHEMA = {
  type: "object",
  required: ["prUrl", "branch", "summary"],
  properties: {
    prUrl: { type: "string" },
    branch: { type: "string" },
    summary: { type: "string", description: "2-3 sentence summary of what changed and why" },
    lintPassed: { type: "boolean" },
    typecheckPassed: { type: "boolean" },
    autoFixSubscribed: { type: "boolean" },
    notes: { type: "string" },
  },
};

// ═══ Phase 1: Plan ═══
phase("Plan");

const draft = await agent(
  "Scope this task against the codebase and draft an implementation plan.\n\n" +
    "## Task\n" +
    TASK +
    "\n\n" +
    "## Instructions\n" +
    "1. Explore — find relevant files, existing patterns, utilities to reuse. " +
    "Actively search for existing functions and utilities that can be reused; " +
    "avoid proposing new code when suitable implementations already exist.\n" +
    "2. Read CLAUDE.md at project root and in parent dirs of relevant files.\n" +
    "3. Draft a concrete plan: files to touch, what edits, in what order.\n" +
    "4. Call out existing code to reuse with file:line.\n" +
    "5. List risks and describe verification (test command, manual check).\n\n" +
    "Be concrete — file paths and function names, not vague intentions.",
  { label: "plan:draft", schema: PLAN_SCHEMA },
);
if (!draft) return { error: "Plan draft skipped." };
log("Draft: " + draft.files.length + " files, " + draft.steps.length + " steps");

const PLAN_BLOCK =
  "## Task\n" +
  TASK +
  "\n\n" +
  "## Proposed plan\n" +
  draft.summary +
  "\n\n" +
  "**Files:** " +
  draft.files.join(", ") +
  "\n\n" +
  "**Steps:**\n" +
  draft.steps.map((s, i) => i + 1 + ". " + s).join("\n") +
  "\n\n" +
  "**Reuse:** " +
  (draft.reuse && draft.reuse.length ? draft.reuse.join("; ") : "(none listed)") +
  "\n\n" +
  "**Risks:** " +
  (draft.risks.length ? draft.risks.join("; ") : "(none)") +
  "\n\n" +
  "**Verification:** " +
  (draft.verification || "(not specified)") +
  "\n";

// Angle menu from autoPlan (cli#23382) plus a correctness angle.
// Consistency folded into reuse; security/performance/blast-radius left for
// a future conditional pass.
const CRITICS = [
  {
    key: "scope",
    lens: "Is the plan over- or under-scoped vs the ask? Does it do more than needed, or miss part of the request? Is this a spot fix where the underlying problem should be addressed more broadly, or the right-sized change?",
  },
  {
    key: "simplicity",
    lens: "Could this be simpler? Unnecessary abstractions, files that do not need touching, steps that could merge. What is the minimal diff?",
  },
  {
    key: "reuse",
    lens: "Does it call out existing code to reuse with file paths? Grep for similar utilities — is it reinventing something that exists? Does the approach match how neighboring code does similar things?",
  },
  {
    key: "verification",
    lens: "Are the test/verify steps concrete enough to catch a regression? Is there a runnable command, or is it hand-wavy?",
  },
  {
    key: "correctness",
    lens: "Will this plan actually solve the stated problem? Trace the logic — does the proposed change address the root cause? Grep for other code paths with the same pattern — are there sibling call sites that need the same fix?",
  },
];

const critiques = await parallel(
  CRITICS.map(
    (c) => () =>
      agent(
        PLAN_BLOCK +
          "\n## Your angle: " +
          c.key +
          "\n" +
          c.lens +
          "\n\n" +
          "## Instructions\n" +
          "Review this plan from the " +
          c.key +
          " angle ONLY. Other reviewers cover the rest.\n" +
          "Read the actual files it references. Verify claims against the codebase.\n" +
          "Verdict PASS if the plan is good enough to proceed from your angle.\n" +
          "Verdict REVISE with concrete holes otherwise — 'step 3 will not work because X', not 'might have issues'.\n" +
          "Severity: blocker = plan will fail; major = works but poorly; minor = nit.",
        { label: "plan:critic-" + c.key, phase: "Plan", schema: CRITIQUE_SCHEMA },
      ),
  ),
);

const holes = critiques.flatMap((c, i) =>
  c ? c.holes.map((h) => ({ ...h, critic: CRITICS[i].key })) : [],
);
const needsRevise = critiques.filter(Boolean).some((c) => c.verdict === "REVISE");
log(
  holes.length +
    " holes (" +
    holes.filter((h) => h.severity === "blocker").length +
    " blockers), " +
    (needsRevise ? "REVISE" : "PASS"),
);

const plan = !needsRevise
  ? draft
  : await agent(
      PLAN_BLOCK +
        "\n## Critique (" +
        holes.length +
        " holes from " +
        CRITICS.length +
        " critics)\n" +
        holes
          .map(
            (h) =>
              "- [" +
              h.severity +
              ", " +
              h.critic +
              "] " +
              h.issue +
              (h.suggestion ? " → " + h.suggestion : ""),
          )
          .join("\n") +
        "\n\n" +
        "## Instructions\n" +
        "Revise the plan. Blockers MUST be resolved. Majors addressed or explicitly acknowledged as tradeoffs. " +
        "Minors optional. Output the revised plan in the same schema.",
      { label: "plan:harden", phase: "Plan", schema: PLAN_SCHEMA },
    );
if (!plan) return { error: "Plan hardening skipped.", draft, holes };

// ═══ Phase 2: Implement ═══
phase("Implement");

const HARDENED_BLOCK =
  "## Task\n" +
  TASK +
  "\n\n" +
  "## Plan\n" +
  plan.summary +
  "\n\n" +
  "**Files:** " +
  plan.files.join(", ") +
  "\n\n" +
  "**Steps:**\n" +
  plan.steps.map((s, i) => i + 1 + ". " + s).join("\n") +
  "\n\n" +
  "**Reuse:** " +
  (plan.reuse && plan.reuse.length ? plan.reuse.join("; ") : "(none)") +
  "\n\n" +
  "**Risks:** " +
  (plan.risks.length ? plan.risks.join("; ") : "(none)") +
  "\n\n" +
  "**Verification:** " +
  (plan.verification || "(not specified)") +
  "\n";

const impl = await agent(
  HARDENED_BLOCK +
    "\n## Instructions\n" +
    "Execute this plan. Make the edits. Run the verification step.\n" +
    "Adapt if you hit something the plan missed — but note it.\n" +
    "Return done=false with blockers if you cannot proceed.",
  { label: "implement", schema: IMPL_SCHEMA },
);
if (!impl || !impl.done) {
  return {
    error: "Implementation incomplete.",
    plan,
    blockers: impl ? impl.blockers : ["skipped"],
  };
}
log("Implemented: " + impl.filesChanged.length + " files changed");

// ═══ Phase 3: Review (bughunt-lite + completeness) ═══
phase("Review");

const VOTES = 5;
const REFUTE_KILL = 2;
const MAX_VERIFY = 20;
const sevRank = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 };
const dedupKey = (b) => b.file + ":" + (b.line != null ? Math.round(b.line / 5) * 5 : "x");

const DIFF_INSTR =
  "Run 'git diff $(git merge-base HEAD origin/main)' to see all changes (committed + uncommitted). If origin/main doesn't exist, try 'main' or 'origin/HEAD'.";

const RAPID = (i) =>
  "## Rapid scanner " +
  (i + 1) +
  "/3\n" +
  DIFF_INSTR +
  "\n\n" +
  "Quick surface scan. Report 5-10 obvious issues: logic errors, null derefs, " +
  "CLAUDE.md violations, missing awaits. Breadth over depth. " +
  "Bias toward the " +
  ["first", "middle", "last"][i] +
  " third of the diff.\nStructured output only.";

const DEEP = (i) =>
  "## Deep analyst " +
  (i + 1) +
  "/2\n" +
  DIFF_INSTR +
  "\n\n" +
  "Find subtle issues. Read full files, grep callers, trace data flow. " +
  "Invariant violations, races, edge cases (empty/null/concurrent). " +
  "Pick " +
  (i === 0 ? "the most significant change" : "a DIFFERENT area") +
  ". 1-3 findings.\nStructured output only.";

const VERIFY = (b, v) =>
  "## Adversarial verifier " +
  (v + 1) +
  "/" +
  VOTES +
  "\n" +
  "Be SKEPTICAL. Try to REFUTE. ≥" +
  REFUTE_KILL +
  " refutes kill it.\n\n" +
  "**Candidate:** " +
  b.file +
  (b.line != null ? ":" + b.line : "") +
  " — " +
  b.title +
  "\n" +
  b.description +
  "\n\n" +
  DIFF_INSTR +
  " Read the file. Check callers, error handling, conventions.\n" +
  "refuted=true if: unreachable, handled, intentional, pre-existing, wrong.\n" +
  "refuted=false ONLY if real, new, material. Default refuted=true when uncertain.\n" +
  "Evidence must cite file:line.";

const seen = new Map();
let slots = MAX_VERIFY;

function verifyBug(b) {
  const short = b.file.split("/").pop();
  const vote = (v) => () =>
    agent(VERIFY(b, v), { label: "v" + v + ":" + short, phase: "Review", schema: VERDICT_SCHEMA });
  return parallel([0, 1].map(vote)).then((first2) => {
    const r2 = first2.filter(Boolean).filter((v) => v.refuted).length;
    if (r2 >= REFUTE_KILL) return { ...b, votes: first2, refuted: r2, survives: false };
    return parallel([2, 3, 4].map(vote)).then((rest) => {
      const all = first2.concat(rest).filter(Boolean);
      const r = all.filter((v) => v.refuted).length;
      return { ...b, votes: all, refuted: r, survives: r < REFUTE_KILL };
    });
  });
}

const FINDERS = [
  { kind: "rapid", i: 0 },
  { kind: "rapid", i: 1 },
  { kind: "rapid", i: 2 },
  { kind: "deep", i: 0 },
  { kind: "deep", i: 1 },
];

// Completeness check runs in parallel with the bughunt pipeline — it's
// independent of diff-local findings.
const [bugResults, completeness] = await Promise.all([
  pipeline(
    FINDERS,
    (f) =>
      agent(f.kind === "rapid" ? RAPID(f.i) : DEEP(f.i), {
        label: f.kind + "-" + f.i,
        phase: "Review",
        schema: BUGS_SCHEMA,
      }),
    (r) => {
      if (!r) return [];
      const sorted = r.bugs.slice().sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
      const novel = sorted.filter((b) => {
        const k = dedupKey(b);
        if (seen.has(k)) return false;
        if (slots <= 0 && sevRank[b.severity] >= 2) return false;
        seen.set(k, true);
        slots--;
        return true;
      });
      return parallel(novel.map((b) => () => verifyBug(b)));
    },
  ),
  agent(
    "## Completeness check\n\n" +
      "## Original task\n" +
      TASK +
      "\n\n" +
      "## Plan that was executed\n" +
      plan.summary +
      "\n" +
      "Files planned: " +
      plan.files.join(", ") +
      "\n\n" +
      "## Instructions\n" +
      DIFF_INSTR +
      "\n" +
      "Compare the diff against the task. Did the implementation cover everything?\n" +
      "Look for: callers that should have been updated, tests that should exist, " +
      "docs/types that should have changed, parts of the ask that were missed.\n" +
      "covered=true if the task is fully addressed. Otherwise list concrete gaps with file paths.",
    { label: "review:completeness", phase: "Review", schema: COMPLETENESS_SCHEMA },
  ),
]);

const voted = bugResults.flat().filter(Boolean);
const confirmed = voted.filter((b) => b.survives);
const gaps = completeness && !completeness.covered ? completeness.gaps : [];
log(
  "Review: " +
    voted.length +
    " voted → " +
    confirmed.length +
    " confirmed, " +
    gaps.length +
    " completeness gaps",
);

// ═══ Phase 4: Fix ═══
let fixNotes = "(clean — no fixes needed)";
if (confirmed.length > 0 || gaps.length > 0) {
  phase("Fix");
  const bugBlock = confirmed
    .map(
      (b, i) =>
        i +
        1 +
        ". [" +
        b.severity +
        "] " +
        b.file +
        (b.line != null ? ":" + b.line : "") +
        " — " +
        b.title +
        "\n   " +
        b.description,
    )
    .join("\n");
  const gapBlock = gaps.map((g, i) => i + 1 + ". " + g.what + " (at " + g.where + ")").join("\n");
  const fixResult = await agent(
    "Address confirmed review findings.\n\n" +
      (confirmed.length
        ? "## Bugs (" + confirmed.length + ", survived adversarial verify)\n" + bugBlock + "\n\n"
        : "") +
      (gaps.length ? "## Completeness gaps (" + gaps.length + ")\n" + gapBlock + "\n\n" : "") +
      "## Instructions\n" +
      "Fix each item. If one turns out to be a false positive, note why and skip. " +
      "Summarize what you changed.",
    { label: "fix", schema: IMPL_SCHEMA },
  );
  fixNotes = !fixResult
    ? "(fix skipped)"
    : !fixResult.done
      ? "INCOMPLETE — " + (fixResult.blockers || []).join("; ") + ". " + fixResult.notes
      : fixResult.notes;
}

// ═══ Phase 5: PR ═══
phase("PR");

const pr = await agent(
  "Finalize and open a PR.\n\n" +
    "## Task\n" +
    TASK +
    "\n\n## What was done\n" +
    plan.summary +
    "\n\n" +
    "## Instructions\n" +
    "1. Run lint and typecheck. Fix any failures.\n" +
    "2. If on main, create a kebab-case branch from the task.\n" +
    "3. Commit with a clear message. Push. Open a PR (use template if present). Assign reviewers based on CODEOWNERS or recent git blame against the base branch for the touched files.\n" +
    "4. After the PR is created, enable auto-fix by calling the " +
    "mcp__github__subscribe_pr_activity tool with {owner, repo, pullNumber} " +
    "parsed from the PR URL. This subscribes the session to CI failures and " +
    "review comments so they can be addressed automatically. Set " +
    "autoFixSubscribed=true if the call succeeds. If that tool is not " +
    "available in this environment, skip this step and set autoFixSubscribed=false.\n" +
    "5. Return the PR URL, branch name, autoFixSubscribed, and a 2-3 sentence summary of what changed and why.",
  { label: "pr", schema: PR_SCHEMA },
);

return {
  summary: pr ? pr.summary : "PR step incomplete. " + (impl.notes || plan.summary),
  prUrl: pr ? pr.prUrl : null,
  branch: pr ? pr.branch : null,
  autoFixSubscribed: pr ? (pr.autoFixSubscribed ?? null) : null,
  plan: { summary: plan.summary, files: plan.files },
  critique: { holes: holes.length, blockers: holes.filter((h) => h.severity === "blocker").length },
  review: { voted: voted.length, confirmed: confirmed.length, gaps: gaps.length },
  fixNotes,
};
```

---

### C.2 `bugfix` (7798 chars)

```ts
export const meta = {
  name: "bugfix",
  description:
    "Reproduce-first bug fixer. Writes a failing repro, root-causes the fault, applies the minimal fix, converts the repro into a regression test, then opens a PR.",
  whenToUse:
    "When the user reports a specific bug to fix. Best when the bug is concrete enough to reproduce. This workflow writes a failing repro first, traces the root cause, applies the smallest fix that makes the repro pass, locks it in as a regression test, and opens a PR.",
  phases: [
    { title: "Reproduce", detail: "Write a failing script or test that demonstrates the bug" },
    { title: "Root-cause", detail: "Trace the fault, grep callers, identify the minimal culprit" },
    { title: "Fix", detail: "Smallest diff that makes the repro pass" },
    { title: "Regress", detail: "Convert repro into a permanent test, run the touched suite" },
    { title: "PR", detail: "Lint, typecheck, open PR" },
  ],
};

const TASK = typeof args === "string" && args.trim() ? args.trim() : "";
if (!TASK) return { error: "No bug description provided. Pass the bug report as args." };

// ═══ Schemas ═══
const REPRO_SCHEMA = {
  type: "object",
  required: ["reproduced", "reproPath", "expected", "actual", "notes"],
  properties: {
    reproduced: { type: "boolean" },
    reproPath: { type: "string", description: "Path to the failing test or repro script" },
    reproCommand: { type: "string", description: "Command that runs the repro and fails" },
    expected: { type: "string" },
    actual: { type: "string" },
    notes: { type: "string" },
  },
};
const ROOT_CAUSE_SCHEMA = {
  type: "object",
  required: ["rootCause", "culprit", "callers"],
  properties: {
    rootCause: { type: "string" },
    culprit: { type: "string", description: "file:line of the minimal fault" },
    callers: { type: "array", items: { type: "string" } },
    fixApproach: { type: "string" },
  },
};
const IMPL_SCHEMA = {
  type: "object",
  required: ["done", "filesChanged", "notes"],
  properties: {
    done: { type: "boolean" },
    filesChanged: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
  },
};
const REGRESS_SCHEMA = {
  type: "object",
  required: ["testPath", "testPassed", "suitePassed", "notes"],
  properties: {
    testPath: { type: "string" },
    testPassed: { type: "boolean" },
    suitePassed: { type: "boolean" },
    notes: { type: "string" },
  },
};
const PR_SCHEMA = {
  type: "object",
  required: ["prUrl", "branch", "summary"],
  properties: {
    prUrl: { type: "string" },
    branch: { type: "string" },
    summary: { type: "string" },
    lintPassed: { type: "boolean" },
    typecheckPassed: { type: "boolean" },
    notes: { type: "string" },
  },
};

// ═══ Phase 1: Reproduce ═══
phase("Reproduce");

const repro = await agent(
  "Reproduce this bug with a failing test or script.\n\n" +
    "## Bug report\n" +
    TASK +
    "\n\n" +
    "## Instructions\n" +
    "1. Read the relevant code and any linked traces/logs to understand the claimed behavior.\n" +
    "2. Write the SMALLEST failing test or standalone script that demonstrates the bug. " +
    "Prefer a test in the existing test framework; fall back to a script if no framework fits.\n" +
    "3. Run it. Confirm it FAILS with the expected vs actual mismatch.\n" +
    "4. If you cannot reproduce after a genuine attempt, set reproduced=false and explain why in notes.\n\n" +
    "Do NOT fix the bug yet — only reproduce it.",
  { label: "reproduce", schema: REPRO_SCHEMA },
);
if (!repro) return { error: "Reproduce step skipped." };
if (!repro.reproduced) {
  return {
    summary: "Could not reproduce the bug. " + repro.notes,
    reproduced: false,
    repro,
  };
}
log(
  "Reproduced: " + repro.reproPath + " (expected " + repro.expected + ", got " + repro.actual + ")",
);

const REPRO_BLOCK =
  "## Bug report\n" +
  TASK +
  "\n\n" +
  "## Repro\n" +
  "Path: " +
  repro.reproPath +
  "\n" +
  (repro.reproCommand ? "Command: " + repro.reproCommand + "\n" : "") +
  "Expected: " +
  repro.expected +
  "\n" +
  "Actual: " +
  repro.actual +
  "\n" +
  "Notes: " +
  repro.notes +
  "\n";

// ═══ Phase 2: Root-cause ═══
phase("Root-cause");

const rc = await agent(
  REPRO_BLOCK +
    "\n## Instructions\n" +
    "Find the ROOT cause — not the first place the symptom appears.\n" +
    "1. Trace backwards from the failure point. Read the code paths the repro exercises.\n" +
    "2. Grep for callers and sibling code paths that touch the same state — note any that share the fault.\n" +
    "3. Identify the minimal culprit (file:line). Distinguish the root cause from downstream symptoms.\n" +
    "4. Propose the smallest fix approach that addresses the root cause, not a patch over the symptom.",
  { label: "root-cause", schema: ROOT_CAUSE_SCHEMA },
);
if (!rc) return { error: "Root-cause step skipped.", repro };
log("Root cause: " + rc.culprit + " — " + rc.rootCause);

// ═══ Phase 3: Fix ═══
phase("Fix");

const fix = await agent(
  REPRO_BLOCK +
    "\n## Root cause\n" +
    rc.rootCause +
    "\n" +
    "Culprit: " +
    rc.culprit +
    "\n" +
    "Callers sharing the fault: " +
    (rc.callers.length ? rc.callers.join(", ") : "(none)") +
    "\n" +
    "Approach: " +
    (rc.fixApproach || "(not specified)") +
    "\n\n" +
    "## Instructions\n" +
    "Apply the minimal fix at the root cause. Update sibling callers if they share the fault.\n" +
    "Re-run the repro" +
    (repro.reproCommand ? " (" + repro.reproCommand + ")" : "") +
    " — it MUST now pass.\n" +
    "Return done=false with blockers if the repro still fails after your fix.",
  { label: "fix", schema: IMPL_SCHEMA },
);
if (!fix || !fix.done) {
  return {
    error: "Fix incomplete.",
    repro,
    rootCause: rc,
    blockers: fix ? fix.blockers : ["skipped"],
  };
}
log("Fixed: " + fix.filesChanged.length + " files changed");

// ═══ Phase 4: Regress ═══
phase("Regress");

const regress = await agent(
  REPRO_BLOCK +
    "\n## Fix applied\n" +
    fix.notes +
    "\n" +
    "Files changed: " +
    fix.filesChanged.join(", ") +
    "\n\n" +
    "## Instructions\n" +
    "1. Convert the repro at " +
    repro.reproPath +
    " into a permanent regression test in the " +
    "right location for this codebase. If it is already a proper test, tighten the assertion " +
    "and naming so it clearly describes the bug it guards against.\n" +
    "2. Run the regression test — it must PASS.\n" +
    "3. Run the full test suite for the touched module(s) — flag any new failures.\n" +
    "Return testPassed and suitePassed honestly.",
  { label: "regress", schema: REGRESS_SCHEMA },
);
if (!regress) return { error: "Regression step skipped.", repro, rootCause: rc, fix };
log(
  "Regression test: " +
    regress.testPath +
    " (test " +
    (regress.testPassed ? "PASS" : "FAIL") +
    ", suite " +
    (regress.suitePassed ? "PASS" : "FAIL") +
    ")",
);

// ═══ Phase 5: PR ═══
phase("PR");

const pr = await agent(
  "Finalize and open a PR for this bug fix.\n\n" +
    "## Bug\n" +
    TASK +
    "\n\n" +
    "## Root cause\n" +
    rc.rootCause +
    " (at " +
    rc.culprit +
    ")\n\n" +
    "## Regression test\n" +
    regress.testPath +
    (regress.suitePassed
      ? ""
      : "\n\nNOTE: suite had failures — investigate before merging: " + regress.notes) +
    "\n\n" +
    "## Instructions\n" +
    "1. Run lint and typecheck. Fix any failures.\n" +
    "2. If on main, create a kebab-case branch from the bug.\n" +
    "3. Commit with a clear message referencing the symptom and root cause. Push. Open a PR. " +
    "Include the repro steps and regression test path in the PR body.\n" +
    "4. Return the PR URL, branch, and a 2-3 sentence summary.",
  { label: "pr", schema: PR_SCHEMA },
);

return {
  summary: pr ? pr.summary : "PR step incomplete. Fix applied: " + fix.notes,
  prUrl: pr ? pr.prUrl : null,
  branch: pr ? pr.branch : null,
  reproduced: true,
  rootCause: { summary: rc.rootCause, culprit: rc.culprit },
  regressionTest: regress.testPath,
  testPassed: regress.testPassed,
  suitePassed: regress.suitePassed,
};
```

---

### C.3 `bughunt` (14505 chars)

```ts
export const meta = {
  name: "bughunt",
  description:
    "Multi-agent bug sweep of the current branch. Self-respawning finder pool (3 rapid + deep-until-dry-streak) streams into 5-vote adversarial verification with pigeonhole early-exit, then synthesis.",
  whenToUse:
    "When the user asks to hunt for bugs, audit code quality, or run a high-precision bug sweep on the current branch.",
  phases: [
    { title: "Scope", detail: "Discover diff base, changed files, conventions" },
    { title: "Find", detail: "3 rapid + deep-until-dry-streak(3), self-respawning pool" },
    {
      title: "Verify",
      detail: "5-vote adversarial, pigeonhole early-exit (2 refute → dead, skip 3)",
    },
    { title: "Synthesize", detail: "Semantic dedup on confirmed set, final report" },
  ],
};

// ═══ Constants ═══
const FLEET_SIZE = 5;
const VOTES_PER_BUG = 5;
const REFUTATIONS_REQUIRED = 2;
const MAX_VERIFY = 20;
const DRY_STREAK_LIMIT = 3;

// ═══ Schemas ═══
const SCOPE_SCHEMA = {
  type: "object",
  required: ["diffBase", "files", "summary"],
  properties: {
    diffBase: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    conventions: { type: "string" },
  },
};
const BUGS_SCHEMA = {
  type: "object",
  required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "description", "severity"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          severity: { enum: ["critical", "high", "medium", "low", "nit"] },
          category: {
            enum: [
              "logic",
              "security",
              "performance",
              "convention",
              "correctness",
              "resource-leak",
              "race",
              "other",
            ],
          },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    severity: { enum: ["critical", "high", "medium", "low", "nit"] },
  },
};
const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "bugs"],
  properties: {
    summary: { type: "string" },
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "description", "severity", "vote", "evidence"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          severity: { enum: ["critical", "high", "medium", "low", "nit"] },
          vote: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

// ═══ Phase 0: Scope ═══
phase("Scope");

const scope = await agent(
  "Discover the scope of changes on the current branch for a bug hunt.\n\n" +
    "1. Diff base: run 'git rev-parse origin/main', fallback to 'main'. Return whichever exists.\n" +
    "2. Changed files: 'git diff --name-only <diffBase>...HEAD'\n" +
    "3. Summarize what changed in one paragraph.\n" +
    "4. Find CLAUDE.md files (root + parent dirs of changed files); extract relevant conventions.\n" +
    "Structured output only.",
  { label: "scope", schema: SCOPE_SCHEMA },
);
if (!scope) return { summary: "Scope skipped.", bugs: [], stats: {} };
if (scope.files.length === 0)
  return { summary: "No changes on branch vs " + scope.diffBase + ".", bugs: [], stats: {} };

log(scope.files.length + " files changed vs " + scope.diffBase);

// Shared context header for all finder/verifier prompts. Small — each agent
// runs 'git diff' itself to read the actual changes.
const CONTEXT_HEADER =
  "## Branch scope (" +
  scope.diffBase +
  "...HEAD)\n" +
  "Changed files (" +
  scope.files.length +
  "):\n" +
  scope.files
    .map(function (f) {
      return "  - " + f;
    })
    .join("\n") +
  "\n\n" +
  "## What changed\n" +
  scope.summary +
  "\n\n" +
  "## Conventions (CLAUDE.md)\n" +
  (scope.conventions || "(none)") +
  "\n\n";

// ═══ Shared state (single-threaded JS — all mutations atomic) ═══
const dedupKey = function (b) {
  return b.file + ":" + (b.line != null ? Math.round(b.line / 5) * 5 : "x");
};
const sevRank = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 };
const confRank = { high: 0, medium: 1, low: 2 };

const seen = new Map();
const naiveDupes = [];
const budgetDropped = [];
const verifyJobs = [];
let verifySlots = MAX_VERIFY;
let rapidSpawned = 0;
let deepSpawned = 0;
let dryStreak = 0;
let bugFindingDone = false;

// ═══ Prompt builders ═══
function rapidPrompt(idx, skipKeys) {
  const partition = ["first third", "middle third", "last third"][idx % 3];
  return (
    CONTEXT_HEADER +
    "## Role: Rapid Surface Scanner (rapid-" +
    idx +
    ")\n\n" +
    "Quickly scan the changes. Report obvious issues. Do NOT deep-dive.\n\n" +
    "## Look for\n" +
    "**P1** CLAUDE.md violations · **P2** Logic errors (copy-paste, wrong conditions, null derefs) · " +
    "**P3** Resource issues (unbounded growth, missing await)\n\n" +
    "## Instructions\n" +
    "1. Run 'git diff " +
    scope.diffBase +
    "...HEAD' to see the changes.\n" +
    "2. Read changed files as needed for surrounding context.\n" +
    "3. Report 5-12 bugs. Breadth > depth. OK to be wrong.\n" +
    "4. Bias toward the " +
    partition +
    " of the file list.\n" +
    (skipKeys.length > 0
      ? "5. SKIP these locations (already found): " + skipKeys.join(", ") + "\n"
      : "") +
    "\nStructured output only."
  );
}

function deepPrompt(idx, skipKeys) {
  return (
    CONTEXT_HEADER +
    "## Role: Deep Analyst (deep-" +
    idx +
    ")\n\n" +
    "Find subtle bugs requiring deep analysis.\n\n" +
    "## Process\n" +
    "Run 'git diff " +
    scope.diffBase +
    "...HEAD' · Read full files · Grep callers of modified functions · Trace callees · Trace data flow\n\n" +
    "## Look for\n" +
    "Invariant violations · Races · State mutation · Edge cases (empty/null/concurrent)\n\n" +
    "## Instructions\n" +
    "Pick " +
    (idx === 0 ? "the most significant change" : "a DIFFERENT subsystem from prior deep passes") +
    ". " +
    "Go DEEP. Return 1-3 high-confidence findings.\n" +
    (skipKeys.length > 0
      ? "SKIP these locations (already found): " + skipKeys.join(", ") + "\n"
      : "") +
    "\nStructured output only."
  );
}

function verifyPrompt(bug, v) {
  return (
    CONTEXT_HEADER +
    "## Role: Adversarial Verifier (voter " +
    (v + 1) +
    "/" +
    VOTES_PER_BUG +
    ")\n\n" +
    "Be SKEPTICAL. Try to REFUTE. Find ANY reason this is not a real bug. " +
    "≥" +
    REFUTATIONS_REQUIRED +
    " refutations of " +
    VOTES_PER_BUG +
    " kill it.\n\n" +
    "## Candidate\n" +
    "File: " +
    bug.file +
    (bug.line != null ? ":" + bug.line : "") +
    "\n" +
    "Title: " +
    bug.title +
    "\n" +
    "Severity: " +
    bug.severity +
    "\n" +
    "Description: " +
    bug.description +
    "\n\n" +
    "## Checklist\n" +
    "1. Run 'git diff " +
    scope.diffBase +
    "...HEAD -- " +
    bug.file +
    "' and read the file — does the issue exist?\n" +
    "2. Check callers — reachable? Preconditions guaranteed?\n" +
    "3. Check handling — validation/error handling elsewhere?\n" +
    "4. Conventions — intentional per CLAUDE.md (above)?\n" +
    "5. Git history — pre-existing ≠ new bug. Already fixed/reverted?\n\n" +
    "**refuted=true** if: not reachable / handled elsewhere / intentional / pre-existing / wrong.\n" +
    "**refuted=false** ONLY if: real, reachable, new, material.\n" +
    "Default to refuted=true if uncertain.\n\n" +
    "Structured output only. Evidence MUST cite file:line."
  );
}

// ═══ Pigeonhole verification: 2 votes first; if both refute, skip the other 3 ═══
function verifyBug(bug) {
  const shortName = bug.file.split("/").pop();
  return parallel(
    [0, 1].map(function (v) {
      return function () {
        return agent(verifyPrompt(bug, v), {
          label: "v" + v + ":" + shortName,
          phase: "Verify",
          schema: VERDICT_SCHEMA,
        });
      };
    }),
  ).then(function (first2) {
    const r2 = first2.filter(Boolean).filter(function (v) {
      return v.refuted;
    }).length;
    if (r2 >= REFUTATIONS_REQUIRED) {
      log(shortName + ' "' + bug.title + '": 0-2 ✗ (early kill)');
      return { bug: bug, verdicts: first2, refutedVotes: r2, survives: false };
    }
    // Outcome undecided — need 3 more votes.
    return parallel(
      [2, 3, 4].map(function (v) {
        return function () {
          return agent(verifyPrompt(bug, v), {
            label: "v" + v + ":" + shortName,
            phase: "Verify",
            schema: VERDICT_SCHEMA,
          });
        };
      }),
    ).then(function (rest) {
      const all = first2.concat(rest).filter(Boolean);
      const r = all.filter(function (v) {
        return v.refuted;
      }).length;
      const survives = r < REFUTATIONS_REQUIRED;
      log(
        shortName +
          ' "' +
          bug.title +
          '": ' +
          (all.length - r) +
          "-" +
          r +
          " " +
          (survives ? "✓" : "✗"),
      );
      return { bug: bug, verdicts: all, refutedVotes: r, survives: survives };
    });
  });
}

// ═══ Harvest: dedup, budget, dry-streak ═══
function harvest(result, role) {
  if (!result) {
    // user-skip or agent failure — count deep skips as dry
    if (role.type === "deep") {
      dryStreak++;
      if (dryStreak >= DRY_STREAK_LIMIT) bugFindingDone = true;
    }
    return [];
  }
  // Sort by severity so high-priority bugs claim budget slots first
  const sorted = result.bugs.slice().sort(function (a, b) {
    return sevRank[a.severity] - sevRank[b.severity];
  });
  const novel = [];
  for (const b of sorted) {
    const key = dedupKey(b);
    if (seen.has(key)) {
      naiveDupes.push(Object.assign({}, b, { finder: role.label, dupOf: seen.get(key) }));
      continue;
    }
    // Budget cap — critical/high always pass
    if (verifySlots <= 0 && sevRank[b.severity] >= 2) {
      budgetDropped.push(Object.assign({}, b, { finder: role.label }));
      continue;
    }
    seen.set(key, { finder: role.label, title: b.title });
    verifySlots--;
    novel.push(Object.assign({}, b, { finder: role.label }));
  }

  if (role.type === "deep") {
    dryStreak = novel.length > 0 ? 0 : dryStreak + 1;
    if (dryStreak >= DRY_STREAK_LIMIT) bugFindingDone = true;
  }
  log(
    role.label +
      ": " +
      result.bugs.length +
      " raw → " +
      novel.length +
      " novel" +
      (role.type === "deep" ? " (dryStreak=" + dryStreak + ")" : ""),
  );
  return novel;
}

// ═══ Role assignment (Python decide_agent_type) ═══
function decideNextRole() {
  if (bugFindingDone) return null;
  if (rapidSpawned < 3) {
    const idx = rapidSpawned++;
    return { type: "rapid", idx: idx, label: "rapid-" + idx };
  }
  const idx = deepSpawned++;
  return { type: "deep", idx: idx, label: "deep-" + idx };
}

// ═══ Self-respawning slot ═══
function slot() {
  const role = decideNextRole();
  if (!role) return Promise.resolve();
  const skipKeys = Array.from(seen.keys());
  const prompt =
    role.type === "rapid" ? rapidPrompt(role.idx, skipKeys) : deepPrompt(role.idx, skipKeys);
  return agent(prompt, { label: role.label, phase: "Find", schema: BUGS_SCHEMA }).then(
    function (result) {
      const novel = harvest(result, role);
      // Fire verification NOW — do not await. Respawn immediately.
      novel.forEach(function (bug) {
        verifyJobs.push(verifyBug(bug));
      });
      return slot();
    },
  );
}

// ═══ Run: find + verify overlap (no barrier until synthesis) ═══
phase("Find");
await parallel(
  Array.from({ length: FLEET_SIZE }, function () {
    return function () {
      return slot();
    };
  }),
);

log(
  "Dry-streak hit. " +
    seen.size +
    " unique bugs found. Draining " +
    verifyJobs.length +
    " verifications...",
);
const allVoted = (await Promise.all(verifyJobs)).filter(Boolean);

const confirmed = allVoted.filter(function (r) {
  return r.survives;
});
const killed = allVoted.filter(function (r) {
  return !r.survives;
});

log(
  "Voting done: " +
    allVoted.length +
    " voted → " +
    confirmed.length +
    " confirmed, " +
    killed.length +
    " killed · " +
    naiveDupes.length +
    " naive-dupes · " +
    budgetDropped.length +
    " budget-dropped",
);

// ═══ Early return if nothing confirmed ═══
if (confirmed.length === 0) {
  return {
    summary:
      "Clean. " +
      allVoted.length +
      " voted, all killed by 5-vote adversarial. " +
      deepSpawned +
      " deep finders ran before dry-streak.",
    bugs: [],
    killed: killed.map(function (r) {
      return {
        file: r.bug.file,
        title: r.bug.title,
        vote: r.verdicts.length - r.refutedVotes + "-" + r.refutedVotes,
      };
    }),
    stats: {
      rapidSpawned: rapidSpawned,
      deepSpawned: deepSpawned,
      voted: allVoted.length,
      confirmed: 0,
      killed: killed.length,
      naiveDupes: naiveDupes.length,
      budgetDropped: budgetDropped.length,
    },
  };
}

// ═══ Phase 3: Synthesis (semantic dedup + final report) ═══
phase("Synthesize");

function bestEvidence(r) {
  const confirms = r.verdicts.filter(Boolean).filter(function (v) {
    return !v.refuted;
  });
  confirms.sort(function (a, b) {
    return confRank[a.confidence] - confRank[b.confidence];
  });
  return confirms[0] || { evidence: "(no confirming verdict)", confidence: "low" };
}

const block = confirmed
  .map(function (r, i) {
    const best = bestEvidence(r);
    const vote = r.verdicts.length - r.refutedVotes + "-" + r.refutedVotes;
    return (
      "### [" +
      i +
      "] " +
      r.bug.title +
      " (" +
      r.bug.severity +
      ", " +
      r.bug.finder +
      ")\n" +
      "Vote: " +
      vote +
      " · File: " +
      r.bug.file +
      (r.bug.line != null ? ":" + r.bug.line : "") +
      "\n" +
      r.bug.description +
      "\n" +
      "Evidence (" +
      best.confidence +
      "): " +
      best.evidence +
      "\n"
    );
  })
  .join("\n");

const report = await agent(
  "## Synthesis: semantic dedup + final report\n\n" +
    confirmed.length +
    " bugs survived adversarial verification. " +
    "Semantic duplicates are likely (naive dedup only caught file:line matches).\n\n" +
    block +
    "\n\n" +
    "## Instructions\n" +
    "1. Identify semantic duplicates (same root cause, different location/wording). Merge into one entry.\n" +
    "2. Order by severity: critical → high → medium → low → nit.\n" +
    "3. Tighten titles/descriptions. Pick the best evidence per bug.\n" +
    "4. Write a 2-3 sentence summary.\n\n" +
    "Structured output only.",
  { label: "synthesize", schema: REPORT_SCHEMA },
);

const reportResult = report || { summary: "(synthesis skipped)", bugs: [] };

return {
  summary: reportResult.summary,
  bugs: reportResult.bugs,
  killed: killed.map(function (r) {
    return {
      file: r.bug.file,
      title: r.bug.title,
      vote: r.verdicts.length - r.refutedVotes + "-" + r.refutedVotes,
    };
  }),
  stats: {
    rapidSpawned: rapidSpawned,
    deepSpawned: deepSpawned,
    voted: allVoted.length,
    confirmed: confirmed.length,
    killed: killed.length,
    afterSemanticDedup: reportResult.bugs.length,
    naiveDupes: naiveDupes.length,
    budgetDropped: budgetDropped.length,
    agentCalls:
      1 +
      (rapidSpawned + deepSpawned) +
      allVoted.reduce(function (s, r) {
        return s + r.verdicts.length;
      }, 0) +
      1,
  },
};
```

---

### C.4 `bughunt-lite` (11684 chars)

```ts
export const meta = {
  name: "bughunt-lite",
  description:
    "Lighter bug sweep — fixed 3-rapid+2-deep finders stream into 5-vote adversarial verification (pigeonhole early-exit), then synthesis. Simpler than bughunt: no self-respawning, no dry-streak.",
  whenToUse:
    "When the user wants a faster, bounded bug sweep of the current branch. Prefer over bughunt for small-to-medium diffs where a fixed finder pool is sufficient.",
  phases: [
    { title: "Scope", detail: "Discover diff base, changed files, conventions" },
    { title: "Find", detail: "3 rapid + 2 deep finders — stream into verify as each completes" },
    { title: "Verify", detail: "5 adversarial votes, pigeonhole early-exit (2 refute → skip 3)" },
    { title: "Synthesize", detail: "Semantic dedup on confirmed set, final report" },
  ],
};

// ═══ Constants ═══
const VOTES_PER_BUG = 5;
const REFUTATIONS_REQUIRED = 2;
const MAX_VERIFY = 20;

// ═══ Schemas ═══
const SCOPE_SCHEMA = {
  type: "object",
  required: ["diffBase", "files", "summary"],
  properties: {
    diffBase: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    conventions: { type: "string" },
  },
};
const BUGS_SCHEMA = {
  type: "object",
  required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "description", "severity"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          severity: { enum: ["critical", "high", "medium", "low", "nit"] },
          category: {
            enum: [
              "logic",
              "security",
              "performance",
              "convention",
              "correctness",
              "resource-leak",
              "race",
              "other",
            ],
          },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    severity: { enum: ["critical", "high", "medium", "low", "nit"] },
  },
};
const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "bugs"],
  properties: {
    summary: { type: "string" },
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "description", "severity", "vote", "evidence"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          severity: { enum: ["critical", "high", "medium", "low", "nit"] },
          vote: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

// ═══ Phase 0: Scope ═══
phase("Scope");

const scope = await agent(
  "Discover the scope of changes on the current branch for a bug hunt.\n\n" +
    "1. Diff base: 'git rev-parse origin/main', fallback to 'main'.\n" +
    "2. Changed files: 'git diff --name-only <diffBase>...HEAD'\n" +
    "3. Summarize what changed in one paragraph.\n" +
    "4. Find CLAUDE.md files (root + parent dirs of changed files), extract relevant conventions.\n\n" +
    "Return ONLY structured output.",
  { label: "scope", schema: SCOPE_SCHEMA },
);
if (!scope) return { summary: "Scope skipped.", bugs: [], stats: {} };
if (scope.files.length === 0)
  return { summary: "No changes on branch vs " + scope.diffBase + ".", bugs: [], stats: {} };

log(scope.files.length + " files changed vs " + scope.diffBase);

const SCOPE_BLOCK =
  "## Scope\nDiff base: " +
  scope.diffBase +
  "\n" +
  "Changed files (" +
  scope.files.length +
  "):\n" +
  scope.files.map((f) => "  - " + f).join("\n") +
  "\n\n" +
  "## What changed\n" +
  scope.summary +
  "\n\n" +
  "## Conventions (CLAUDE.md)\n" +
  (scope.conventions || "(none)") +
  "\n";

// ═══ Prompt builders ═══
const RAPID_PROMPT = (idx) =>
  "## Rapid Surface Scanner (" +
  (idx + 1) +
  "/3)\n\n" +
  "Quickly scan the change set. Report obvious issues. Do NOT deep-dive.\n\n" +
  SCOPE_BLOCK +
  "\n" +
  "## Look for\n**P1 CLAUDE.md violations** · **P2 Logic errors** (copy-paste, wrong conditions, null derefs) · **P3 Resource** (unbounded growth, missing await)\n\n" +
  "## Instructions\n1. Run 'git diff " +
  scope.diffBase +
  "...HEAD'\n2. Read changed files as needed\n" +
  "3. Report 5-12 bugs. Breadth > depth. OK to be wrong.\n" +
  "4. Bias toward " +
  ["first third", "middle third", "last third"][idx] +
  " of files.\n\nStructured output only.";

const DEEP_PROMPT = (idx) =>
  "## Deep Analyst (" +
  (idx + 1) +
  "/2)\n\n" +
  "Find subtle bugs requiring deep analysis.\n\n" +
  SCOPE_BLOCK +
  "\n" +
  "## Process\nRun 'git diff " +
  scope.diffBase +
  "...HEAD' · Read full files · Grep callers of modified functions · Trace callees · Trace data flow\n\n" +
  "## Look for\nInvariant violations · Races · State mutation · Edge cases (empty/null/concurrent)\n\n" +
  "Pick " +
  (idx === 0 ? "the most significant change" : "a DIFFERENT subsystem") +
  ". Go DEEP. 1-3 findings.\n\nStructured output only.";

const VERIFY_PROMPT = (bug, v) =>
  "## Adversarial Verifier (voter " +
  (v + 1) +
  "/" +
  VOTES_PER_BUG +
  ")\n\n" +
  "Be SKEPTICAL. Try to REFUTE. Find ANY reason this is not a real bug. " +
  "≥" +
  REFUTATIONS_REQUIRED +
  " refutations of " +
  VOTES_PER_BUG +
  " kill it.\n\n" +
  "## Candidate\nFile: " +
  bug.file +
  (bug.line != null ? ":" + bug.line : "") +
  "\n" +
  "Title: " +
  bug.title +
  "\nSeverity: " +
  bug.severity +
  "\nDescription: " +
  bug.description +
  "\n\n" +
  "## Checklist\n" +
  "1. Run 'git diff " +
  scope.diffBase +
  "...HEAD -- " +
  bug.file +
  "' and read the file — does the issue exist?\n" +
  "2. Check callers — reachable? Preconditions guaranteed?\n" +
  "3. Check handling — validation/error handling elsewhere?\n" +
  "4. Conventions — intentional per CLAUDE.md (above)?\n" +
  "5. Git history — pre-existing ≠ new bug. Already fixed/reverted?\n\n" +
  "**refuted=true** if: not reachable / handled / intentional / pre-existing / wrong.\n" +
  "**refuted=false** ONLY if: real, reachable, new, material.\n" +
  "Default to refuted=true if uncertain.\n\nStructured output only. Evidence MUST cite file:line.";

// ═══ Naive dedup state (accumulates across finders as they complete) ═══
const dedupKey = (b) => b.file + ":" + (b.line != null ? Math.round(b.line / 5) * 5 : "x");
const sevRank = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 };
const seen = new Map();
const naiveDupes = [];
const budgetDropped = [];
let verifySlots = MAX_VERIFY;

// ═══ Pigeonhole verification: 2 votes first; if both refute, skip 3 ═══
function verifyBug(bug, finderName) {
  const shortName = bug.file.split("/").pop();
  const vote = (v) => () =>
    agent(VERIFY_PROMPT(bug, v), {
      label: "v" + v + ":" + shortName,
      phase: "Verify",
      schema: VERDICT_SCHEMA,
    });
  return parallel([0, 1].map(vote)).then((first2) => {
    const r2 = first2.filter(Boolean).filter((v) => v.refuted).length;
    if (r2 >= REFUTATIONS_REQUIRED) {
      log(shortName + ' "' + bug.title + '": 0-' + r2 + " ✗ (early kill)");
      return { ...bug, finder: finderName, verdicts: first2, refutedVotes: r2, survives: false };
    }
    return parallel([2, 3, 4].map(vote)).then((rest) => {
      const all = first2.concat(rest).filter(Boolean);
      const r = all.filter((v) => v.refuted).length;
      const survives = r < REFUTATIONS_REQUIRED;
      log(
        shortName +
          ' "' +
          bug.title +
          '": ' +
          (all.length - r) +
          "-" +
          r +
          " " +
          (survives ? "✓" : "✗"),
      );
      return { ...bug, finder: finderName, verdicts: all, refutedVotes: r, survives };
    });
  });
}

// ═══ Pipeline: find → naive-dedup → pigeonhole-verify (no barrier) ═══
const FINDERS = [
  { type: "rapid", idx: 0 },
  { type: "rapid", idx: 1 },
  { type: "rapid", idx: 2 },
  { type: "deep", idx: 0 },
  { type: "deep", idx: 1 },
];

const results = await pipeline(
  FINDERS,

  (f) =>
    agent(f.type === "rapid" ? RAPID_PROMPT(f.idx) : DEEP_PROMPT(f.idx), {
      label: f.type + "-" + f.idx,
      phase: "Find",
      schema: BUGS_SCHEMA,
    }).then((r) => {
      if (!r) return { finder: f.type + "-" + f.idx, bugs: [] };
      log(f.type + "-" + f.idx + ": " + r.bugs.length + " raw");
      return { finder: f.type + "-" + f.idx, bugs: r.bugs };
    }),

  (findResult) => {
    // Sort by severity so high-priority bugs claim budget slots first
    const sorted = findResult.bugs
      .slice()
      .sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
    const novel = sorted.filter((b) => {
      const key = dedupKey(b);
      if (seen.has(key)) {
        naiveDupes.push({ ...b, finder: findResult.finder, dupOf: seen.get(key) });
        return false;
      }
      if (verifySlots <= 0 && sevRank[b.severity] >= 2) {
        budgetDropped.push({ ...b, finder: findResult.finder });
        return false;
      }
      seen.set(key, { finder: findResult.finder, title: b.title });
      verifySlots--;
      return true;
    });
    if (novel.length < findResult.bugs.length) {
      log(
        findResult.finder +
          ": " +
          novel.length +
          " novel (" +
          (findResult.bugs.length - novel.length) +
          " filtered)",
      );
    }
    return parallel(novel.map((bug) => () => verifyBug(bug, findResult.finder)));
  },
);

const allVoted = results.flat().filter(Boolean);
const confirmed = allVoted.filter((b) => b.survives);
const killed = allVoted.filter((b) => !b.survives);

log(
  "Pipeline done: " +
    allVoted.length +
    " voted → " +
    confirmed.length +
    " confirmed, " +
    killed.length +
    " killed · " +
    naiveDupes.length +
    " naive dupes · " +
    budgetDropped.length +
    " budget-dropped",
);

if (confirmed.length === 0) {
  return {
    summary:
      "Clean. " +
      allVoted.length +
      " voted, all killed. " +
      naiveDupes.length +
      " naive dupes filtered pre-verify.",
    bugs: [],
    killed: killed.map((b) => ({
      file: b.file,
      title: b.title,
      vote: b.verdicts.length - b.refutedVotes + "-" + b.refutedVotes,
    })),
    stats: {
      voted: allVoted.length,
      confirmed: 0,
      killed: killed.length,
      naiveDupes: naiveDupes.length,
      budgetDropped: budgetDropped.length,
    },
  };
}

// ═══ Phase 3: Synthesis ═══
phase("Synthesize");

const confRank = { high: 0, medium: 1, low: 2 };
const block = confirmed
  .map((b, i) => {
    const confirms = b.verdicts
      .filter(Boolean)
      .filter((v) => !v.refuted)
      .sort((a, b) => confRank[a.confidence] - confRank[b.confidence]);
    const best = confirms[0] || { evidence: "(no confirming verdict)", confidence: "low" };
    return (
      "### [" +
      i +
      "] " +
      b.title +
      " (" +
      b.severity +
      ", " +
      b.finder +
      ")\n" +
      "Vote: " +
      (b.verdicts.length - b.refutedVotes) +
      "-" +
      b.refutedVotes +
      " · File: " +
      b.file +
      (b.line != null ? ":" + b.line : "") +
      "\n" +
      b.description +
      "\nEvidence (" +
      best.confidence +
      "): " +
      best.evidence +
      "\n"
    );
  })
  .join("\n");

const report = await agent(
  "## Synthesis: semantic dedup + final report\n\n" +
    confirmed.length +
    " bugs survived adversarial verification. " +
    "Semantic duplicates are likely (naive dedup only caught file:line matches).\n\n" +
    block +
    "\n\n" +
    "## Instructions\n" +
    "1. Identify semantic duplicates (same root cause, different location/wording). Merge into one entry.\n" +
    "2. Order by severity: critical → high → medium → low → nit\n" +
    "3. Tighten titles/descriptions. Best evidence per bug.\n" +
    "4. 2-3 sentence summary.\n\nStructured output only.",
  { label: "synthesize", schema: REPORT_SCHEMA },
);

const reportResult = report || { summary: "(synthesis skipped)", bugs: [] };

return {
  summary: reportResult.summary,
  bugs: reportResult.bugs,
  killed: killed.map((b) => ({
    file: b.file,
    title: b.title,
    vote: b.verdicts.length - b.refutedVotes + "-" + b.refutedVotes,
  })),
  stats: {
    voted: allVoted.length,
    confirmed: confirmed.length,
    killed: killed.length,
    afterSemanticDedup: reportResult.bugs.length,
    naiveDupes: naiveDupes.length,
    budgetDropped: budgetDropped.length,
    agentCalls: 1 + FINDERS.length + allVoted.reduce((s, b) => s + b.verdicts.length, 0) + 1,
  },
};
```

---

### C.5 `dashboard` (8166 chars)

```ts
export const meta = {
  name: "dashboard",
  description:
    "Dashboard generator. Discovers data sources and existing dashboard conventions in the repo, designs a panel layout, implements it, dry-runs queries and render-checks the result, then opens a PR.",
  whenToUse:
    "When the user wants a dashboard, monitoring view, or metrics page built. This workflow finds the available data and existing dashboard patterns, specs out panels and layout, implements them, validates queries and rendering, and opens a PR.",
  phases: [
    { title: "Discover", detail: "Data sources, existing dashboard libs/patterns in repo" },
    { title: "Design", detail: "Panels, metrics, layout spec" },
    { title: "Implement", detail: "Build the dashboard" },
    { title: "Verify", detail: "Query dry-run, render/screenshot if possible" },
    { title: "PR", detail: "Open PR" },
  ],
};

const TASK = typeof args === "string" && args.trim() ? args.trim() : "";
if (!TASK) return { error: "No dashboard description provided. Pass what to build as args." };

const DISCOVER_SCHEMA = {
  type: "object",
  required: ["dataSources", "framework", "examplePath", "targetPath"],
  properties: {
    dataSources: {
      type: "array",
      items: { type: "string" },
      description: "Tables, metrics, APIs, or log streams available",
    },
    framework: {
      type: "string",
      description: "Dashboard system in use (Grafana JSON, Hex, React+charts lib, Streamlit, etc.)",
    },
    examplePath: { type: "string", description: "Path to an existing dashboard to pattern-match" },
    targetPath: { type: "string" },
    conventions: { type: "string" },
  },
};
const DESIGN_SCHEMA = {
  type: "object",
  required: ["title", "panels"],
  properties: {
    title: { type: "string" },
    panels: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "metric", "viz"],
        properties: {
          name: { type: "string" },
          metric: { type: "string", description: "Query or metric expression" },
          viz: { type: "string", description: "timeseries, stat, table, bar, etc." },
          why: { type: "string" },
        },
      },
    },
    layout: { type: "string" },
  },
};
const IMPL_SCHEMA = {
  type: "object",
  required: ["done", "filesChanged", "notes"],
  properties: {
    done: { type: "boolean" },
    filesChanged: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
  },
};
const VERIFY_SCHEMA = {
  type: "object",
  required: ["queriesOk", "rendered", "issues"],
  properties: {
    queriesOk: { type: "boolean" },
    rendered: { type: "boolean" },
    screenshotPath: { type: "string" },
    issues: { type: "array", items: { type: "string" } },
  },
};
const PR_SCHEMA = {
  type: "object",
  required: ["prUrl", "branch", "summary"],
  properties: {
    prUrl: { type: "string" },
    branch: { type: "string" },
    summary: { type: "string" },
    notes: { type: "string" },
  },
};

// ═══ Phase 1: Discover ═══
phase("Discover");

const disc = await agent(
  "Discover the dashboard stack and available data for this request.\n\n" +
    "## Request\n" +
    TASK +
    "\n\n" +
    "## Instructions\n" +
    "1. Identify the dashboard framework this repo uses: Grafana-as-code, Hex, Datadog JSON, " +
    "Streamlit, a React page with a charting library, or similar. Grep for existing dashboards.\n" +
    "2. Find an existing dashboard file to pattern-match against (examplePath).\n" +
    "3. List concrete data sources relevant to the request: table names, metric names, API " +
    "endpoints, or log queries. Verify they exist where possible.\n" +
    "4. Decide where the new dashboard file(s) should live (targetPath) and note conventions.",
  { label: "discover", schema: DISCOVER_SCHEMA },
);
if (!disc) return { error: "Discover step skipped." };
log(
  "Framework: " +
    disc.framework +
    ", " +
    disc.dataSources.length +
    " data sources, target: " +
    disc.targetPath,
);

const CONTEXT =
  "## Request\n" +
  TASK +
  "\n\n" +
  "## Framework\n" +
  disc.framework +
  " (pattern: " +
  disc.examplePath +
  ")\n\n" +
  "## Data sources\n" +
  disc.dataSources.map((d) => "- " + d).join("\n") +
  "\n\n" +
  "## Conventions\n" +
  (disc.conventions || "(none noted)") +
  "\n";

// ═══ Phase 2: Design ═══
phase("Design");

const design = await agent(
  CONTEXT +
    "\n## Instructions\n" +
    "Design the dashboard. For each panel specify: name, the exact metric/query expression, " +
    "visualization type, and a one-line reason it earns a spot.\n\n" +
    "Best practices:\n" +
    "- Top row = the headline numbers (what is the state right now). Below = breakdowns and trends.\n" +
    "- Prefer rates and percentiles over raw counts. Pair every latency panel with a volume panel.\n" +
    "- Every panel should answer a question someone would actually ask. Cut anything that does not.\n" +
    "- 6-12 panels is usually right. More than that and nothing gets looked at.\n" +
    "Describe layout as a brief grid spec.",
  { label: "design", schema: DESIGN_SCHEMA },
);
if (!design) return { error: "Design step skipped.", discover: disc };
log("Design: " + design.panels.length + " panels");

// ═══ Phase 3: Implement ═══
phase("Implement");

const impl = await agent(
  CONTEXT +
    "\n## Design\n" +
    "Title: " +
    design.title +
    "\n" +
    "Layout: " +
    (design.layout || "(default grid)") +
    "\n" +
    "Panels:\n" +
    design.panels
      .map((p, i) => i + 1 + ". " + p.name + " [" + p.viz + "] — " + p.metric)
      .join("\n") +
    "\n\n" +
    "## Instructions\n" +
    "Implement the dashboard at " +
    disc.targetPath +
    " using " +
    disc.framework +
    ".\n" +
    "Match the structure of " +
    disc.examplePath +
    " exactly — same JSON schema, component " +
    "patterns, or DSL. Wire up each panel to its data source.\n" +
    "Register the dashboard in any index/nav file the framework requires.",
  { label: "implement", schema: IMPL_SCHEMA },
);
if (!impl || !impl.done) {
  return {
    error: "Implementation incomplete.",
    discover: disc,
    design,
    blockers: impl ? impl.blockers : ["skipped"],
  };
}
log("Implemented: " + impl.filesChanged.length + " files");

// ═══ Phase 4: Verify ═══
phase("Verify");

const verify = await agent(
  "Verify the dashboard.\n\n" +
    "Files: " +
    impl.filesChanged.join(", ") +
    "\n" +
    "Framework: " +
    disc.framework +
    "\n\n" +
    "## Instructions\n" +
    "1. Dry-run or validate every query/metric expression — confirm syntax and that the " +
    "referenced tables/metrics exist. Set queriesOk accordingly.\n" +
    "2. If the framework supports local rendering, render the dashboard and screenshot it. " +
    "Otherwise validate the file against its schema/linter. Set rendered accordingly.\n" +
    "3. List concrete issues (empty if clean).",
  { label: "verify", schema: VERIFY_SCHEMA },
);
const issues = verify ? verify.issues : [];
log(
  "Verify: queries " +
    (verify && verify.queriesOk ? "OK" : "FAIL") +
    ", rendered " +
    (verify && verify.rendered ? "yes" : "no") +
    ", " +
    issues.length +
    " issues",
);

let fixNotes = "(clean)";
if (issues.length > 0) {
  const fixed = await agent(
    "Fix these dashboard issues:\n" +
      issues.map((i, n) => n + 1 + ". " + i).join("\n") +
      "\n\nFiles: " +
      impl.filesChanged.join(", "),
    { label: "verify:fix", phase: "Verify", schema: IMPL_SCHEMA },
  );
  fixNotes = fixed ? fixed.notes : "(fix skipped)";
}

// ═══ Phase 5: PR ═══
phase("PR");

const pr = await agent(
  "Open a PR for this dashboard.\n\n" +
    "## Request\n" +
    TASK +
    "\n\n" +
    "Files: " +
    impl.filesChanged.join(", ") +
    "\n" +
    (verify && verify.screenshotPath ? "Screenshot: " + verify.screenshotPath + "\n" : "") +
    "\n" +
    "## Instructions\n" +
    "1. Run any repo lint/format on the dashboard files.\n" +
    "2. Commit, push, open a PR. Include the panel list and screenshot (if any) in the body.\n" +
    "3. Return PR URL, branch, and a 2-3 sentence summary.",
  { label: "pr", schema: PR_SCHEMA },
);

return {
  summary: pr ? pr.summary : "PR step incomplete. Dashboard at " + disc.targetPath,
  prUrl: pr ? pr.prUrl : null,
  branch: pr ? pr.branch : null,
  framework: disc.framework,
  targetPath: disc.targetPath,
  panels: design.panels.map((p) => p.name),
  filesChanged: impl.filesChanged,
  verify: verify
    ? {
        queriesOk: verify.queriesOk,
        rendered: verify.rendered,
        screenshot: verify.screenshotPath || null,
      }
    : null,
  fixNotes,
};
```

---

### C.6 `deep-research` (17170 chars)

```ts
export const meta = {
  name: "deep-research",
  description:
    "Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.",
  whenToUse: "<I3K>",
  phases: [
    { title: "Scope", detail: "Decompose question (from args) into 5 search angles" },
    { title: "Search", detail: "5 parallel WebSearch agents, one per angle" },
    { title: "Fetch", detail: "URL-dedup, fetch top 15 sources, extract falsifiable claims" },
    {
      title: "Verify",
      detail: "3-vote adversarial verification per claim (need 2/3 refutes to kill)",
    },
    { title: "Synthesize", detail: "Merge semantic dupes, rank by confidence, cite sources" },
  ],
};

// deep-research: Scope → pipeline(Search → URL-dedup → Fetch+Extract) → 3-vote Verify → Synthesize
// Ported from bughunter architecture. WebSearch/WebFetch instead of git/grep.
// Question is passed via Workflow({name: 'deep-research', args: '<question>'}).

const VOTES_PER_CLAIM = 3;
const REFUTATIONS_REQUIRED = 2;
const MAX_FETCH = 15;
const MAX_VERIFY_CLAIMS = 25;

// ─── Schemas ───
const SCOPE_SCHEMA = {
  type: "object",
  required: ["question", "angles", "summary"],
  properties: {
    question: { type: "string" },
    summary: { type: "string" },
    angles: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        required: ["label", "query"],
        properties: {
          label: { type: "string" },
          query: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
  },
};
const SEARCH_SCHEMA = {
  type: "object",
  required: ["results"],
  properties: {
    results: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        required: ["url", "title", "relevance"],
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          snippet: { type: "string" },
          relevance: { enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};
const EXTRACT_SCHEMA = {
  type: "object",
  required: ["claims", "sourceQuality"],
  properties: {
    sourceQuality: { enum: ["primary", "secondary", "blog", "forum", "unreliable"] },
    publishDate: { type: "string" },
    claims: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["claim", "quote", "importance"],
        properties: {
          claim: { type: "string" },
          quote: { type: "string" },
          importance: { enum: ["central", "supporting", "tangential"] },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    counterSource: { type: "string" },
  },
};
const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "findings", "caveats"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "confidence", "sources", "evidence"],
        properties: {
          claim: { type: "string" },
          confidence: { enum: ["high", "medium", "low"] },
          sources: { type: "array", items: { type: "string" } },
          evidence: { type: "string" },
          vote: { type: "string" },
        },
      },
    },
    caveats: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
  },
};

// ─── Phase 0: Scope — decompose question into search angles ───
phase("Scope");
const QUESTION = (typeof args === "string" && args.trim()) || "";
if (!QUESTION) {
  return {
    error:
      "No research question provided. Pass it as args: Workflow({name: 'deep-research', args: '<question>'}).",
  };
}
const scope = await agent(
  "Decompose this research question into complementary search angles.\n\n" +
    "## Question\n" +
    QUESTION +
    "\n\n" +
    "## Task\n" +
    "Generate 5 distinct web search queries that together cover the question from different angles. Pick angles that suit the question's domain. Examples:\n" +
    "- broad/primary  · academic/technical  · recent news  · contrarian/skeptical  · practitioner/implementation\n" +
    "- For medical: anatomy · common causes · serious differentials · authoritative refs · red flags\n" +
    "- For tech: state-of-art · benchmarks · limitations · industry adoption · cost/tradeoffs\n\n" +
    "Make queries specific enough to surface high-signal results. Avoid redundancy.\n" +
    "Return: the question (verbatim or lightly normalized), a 1-2 sentence decomposition strategy, and the angles.\n\nStructured output only.",
  { label: "scope", schema: SCOPE_SCHEMA },
);
if (!scope) {
  return { error: "Scope agent returned no result — cannot decompose the research question." };
}
log("Q: " + QUESTION.slice(0, 80) + (QUESTION.length > 80 ? "…" : ""));
log(
  "Decomposed into " +
    scope.angles.length +
    " angles: " +
    scope.angles.map((a) => a.label).join(", "),
);

// ─── Dedup state — accumulates across searchers as they complete ───
const normURL = (u) => {
  try {
    const p = new URL(u);
    return (p.hostname.replace(/^www\./, "") + p.pathname.replace(/\/$/, "")).toLowerCase();
  } catch {
    return u.toLowerCase();
  }
};
const seen = new Map();
const dupes = [];
const budgetDropped = [];
const relRank = { high: 0, medium: 1, low: 2 };
let fetchSlots = MAX_FETCH;

// ─── Prompts ───
const SEARCH_PROMPT = (angle) =>
  "## Web Searcher: " +
  angle.label +
  "\n\n" +
  'Research question: "' +
  QUESTION +
  '"\n\n' +
  "Your angle: **" +
  angle.label +
  "** — " +
  (angle.rationale || "") +
  "\n" +
  "Search query: \`" +
  angle.query +
  "\`\n\n" +
  "## Task\nUse WebSearch with the query above (or a refined version). Return the top 4-6 most relevant results.\n" +
  "Rank by relevance to the ORIGINAL question, not just the search query. Skip obvious SEO spam/content farms.\n" +
  "Include a short snippet capturing why each result is relevant.\n\nStructured output only.";

const FETCH_PROMPT = (source, angle) =>
  "## Source Extractor\n\n" +
  'Research question: "' +
  QUESTION +
  '"\n\n' +
  "Fetch and extract key claims from this source:\n" +
  "**URL:** " +
  source.url +
  "\n**Title:** " +
  source.title +
  "\n**Found via:** " +
  angle +
  " search\n\n" +
  "## Task\n1. Use WebFetch to retrieve the page content.\n" +
  "2. Assess source quality: primary research/institution? secondary reporting? blog/opinion? forum? unreliable?\n" +
  "3. Extract 2-5 FALSIFIABLE claims that bear on the research question. Each claim must:\n" +
  "   - be a concrete, checkable statement (not vague generalities)\n" +
  "   - include a direct quote from the source as support\n" +
  "   - be rated central/supporting/tangential to the research question\n" +
  "4. Note publish date if available.\n\n" +
  'If the fetch fails or the page is irrelevant/paywalled, return claims: [] and sourceQuality: "unreliable".\n\nStructured output only.';

const VERIFY_PROMPT = (claim, v) =>
  "## Adversarial Claim Verifier (voter " +
  (v + 1) +
  "/" +
  VOTES_PER_CLAIM +
  ")\n\n" +
  "Be SKEPTICAL. Try to REFUTE this claim. ≥" +
  REFUTATIONS_REQUIRED +
  "/" +
  VOTES_PER_CLAIM +
  " refutations kill it.\n\n" +
  "## Research question\n" +
  QUESTION +
  "\n\n" +
  '## Claim under review\n"' +
  claim.claim +
  '"\n\n' +
  "**Source:** " +
  claim.sourceUrl +
  " (" +
  claim.sourceQuality +
  ")\n" +
  '**Supporting quote:** "' +
  claim.quote +
  '"\n\n' +
  "## Checklist\n" +
  "1. Is the claim actually supported by the quote, or is it an overreach/misread?\n" +
  "2. WebSearch for contradicting evidence — does any credible source dispute or heavily qualify this?\n" +
  "3. Is the source quality sufficient for the claim's strength? (extraordinary claims need primary sources)\n" +
  "4. Is the claim outdated? (check dates — old claims about fast-moving fields are suspect)\n" +
  "5. Is this a marketing claim / press release / cherry-picked benchmark / forum speculation?\n\n" +
  "**refuted=true** if: unsupported by quote / contradicted / low-quality source for strong claim / outdated / marketing fluff.\n" +
  "**refuted=false** ONLY if: claim is well-supported, current, and source quality matches claim strength.\n" +
  "Default to refuted=true if uncertain.\n\nStructured output only. Evidence MUST be specific.";

// ─── Pipeline: search → dedup → fetch+extract (no barrier) ───
const searchResults = await pipeline(
  scope.angles,

  (angle) =>
    agent(SEARCH_PROMPT(angle), {
      label: "search:" + angle.label,
      phase: "Search",
      schema: SEARCH_SCHEMA,
    }).then((r) => {
      if (!r) return null;
      log(angle.label + ": " + r.results.length + " results");
      return { angle: angle.label, results: r.results };
    }),

  (searchResult) => {
    const sorted = [...searchResult.results].sort(
      (a, b) => relRank[a.relevance] - relRank[b.relevance],
    );
    const novel = sorted.filter((r) => {
      const key = normURL(r.url);
      if (seen.has(key)) {
        dupes.push({ ...r, angle: searchResult.angle, dupOf: seen.get(key) });
        return false;
      }
      if (fetchSlots <= 0 && relRank[r.relevance] >= 1) {
        budgetDropped.push({ ...r, angle: searchResult.angle });
        return false;
      }
      seen.set(key, { angle: searchResult.angle, title: r.title });
      fetchSlots--;
      return true;
    });
    if (novel.length < searchResult.results.length) {
      log(
        searchResult.angle +
          ": " +
          novel.length +
          " novel (" +
          (searchResult.results.length - novel.length) +
          " filtered)",
      );
    }
    return parallel(
      novel.map((source) => () => {
        let host = "unknown";
        try {
          host = new URL(source.url).hostname.replace(/^www\./, "");
        } catch {}
        return agent(FETCH_PROMPT(source, searchResult.angle), {
          label: "fetch:" + host,
          phase: "Fetch",
          schema: EXTRACT_SCHEMA,
        })
          .then((ext) => {
            // User-skip → null; drop it (filtered by searchResults.flat().filter(Boolean))
            // rather than throwing into .catch() and mislabeling it "unreliable".
            if (!ext) return null;
            return {
              url: source.url,
              title: source.title,
              angle: searchResult.angle,
              sourceQuality: ext.sourceQuality,
              publishDate: ext.publishDate,
              claims: ext.claims.map((c) => ({
                ...c,
                sourceUrl: source.url,
                sourceQuality: ext.sourceQuality,
              })),
            };
          })
          .catch((e) => {
            log("fetch failed: " + source.url + " — " + (e.message || e));
            return {
              url: source.url,
              title: source.title,
              angle: searchResult.angle,
              sourceQuality: "unreliable",
              claims: [],
            };
          });
      }),
    );
  },
);

const allSources = searchResults.flat().filter(Boolean);
const allClaims = allSources.flatMap((s) => s.claims);
const impRank = { central: 0, supporting: 1, tangential: 2 };
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 };

const rankedClaims = [...allClaims]
  .sort(
    (a, b) =>
      impRank[a.importance] - impRank[b.importance] ||
      qualRank[a.sourceQuality] - qualRank[b.sourceQuality],
  )
  .slice(0, MAX_VERIFY_CLAIMS);

log(
  "Fetched " +
    allSources.length +
    " sources → " +
    allClaims.length +
    " claims → verifying top " +
    rankedClaims.length,
);

if (rankedClaims.length === 0) {
  return {
    question: QUESTION,
    summary:
      "No claims extracted. " +
      allSources.length +
      " sources fetched, all empty/failed. " +
      dupes.length +
      " URL dupes, " +
      budgetDropped.length +
      " budget-dropped.",
    findings: [],
    refuted: [],
    sources: allSources.map((s) => ({ url: s.url, quality: s.sourceQuality })),
    stats: {
      angles: scope.angles.length,
      sources: allSources.length,
      claims: 0,
      dupes: dupes.length,
    },
  };
}

// ─── Verify: 3-vote adversarial ───
// Barrier here is intentional — claim pool must be fully assembled before ranking/verification.
phase("Verify");
const voted = (
  await parallel(
    rankedClaims.map(
      (claim) => () =>
        parallel(
          Array.from(
            { length: VOTES_PER_CLAIM },
            (_, v) => () =>
              agent(VERIFY_PROMPT(claim, v), {
                label: "v" + v + ":" + claim.claim.slice(0, 40),
                phase: "Verify",
                schema: VERDICT_SCHEMA,
              }),
          ),
        ).then((verdicts) => {
          // A vote can be null (user-skip or agent error) — treat as abstain.
          const valid = verdicts.filter(Boolean);
          const refuted = valid.filter((v) => v.refuted).length;
          // Survive only if the claim was actually adjudicated: a quorum of
          // valid votes AND fewer than REFUTATIONS_REQUIRED refuting. Too many
          // abstentions = unverified, which must NOT pass into the report
          // (otherwise all-abstain → refuted=0 → false survive).
          const abstained = VOTES_PER_CLAIM - valid.length;
          const survives = valid.length >= REFUTATIONS_REQUIRED && refuted < REFUTATIONS_REQUIRED;
          log(
            '"' +
              claim.claim.slice(0, 50) +
              '…": ' +
              (valid.length - refuted) +
              "-" +
              refuted +
              (abstained > 0 ? " (" + abstained + " abstain)" : "") +
              " " +
              (survives ? "✓" : "✗"),
          );
          return { ...claim, verdicts: valid, refutedVotes: refuted, survives };
        }),
    ),
  )
).filter(Boolean);

const confirmed = voted.filter((c) => c.survives);
const killed = voted.filter((c) => !c.survives);
log(
  "Verify done: " +
    voted.length +
    " claims → " +
    confirmed.length +
    " confirmed, " +
    killed.length +
    " killed",
);

if (confirmed.length === 0) {
  return {
    question: QUESTION,
    summary:
      "All " +
      voted.length +
      " claims refuted by adversarial verification. Research inconclusive — sources may be low-quality or claims overstated.",
    findings: [],
    refuted: killed.map((c) => ({
      claim: c.claim,
      vote: c.verdicts.length - c.refutedVotes + "-" + c.refutedVotes,
      source: c.sourceUrl,
    })),
    sources: allSources.map((s) => ({
      url: s.url,
      quality: s.sourceQuality,
      claimCount: s.claims.length,
    })),
    stats: {
      angles: scope.angles.length,
      sources: allSources.length,
      claims: allClaims.length,
      verified: voted.length,
      confirmed: 0,
      killed: killed.length,
    },
  };
}

// ─── Synthesize ───
phase("Synthesize");
const confRank = { high: 0, medium: 1, low: 2 };
const block = confirmed
  .map((c, i) => {
    const best = c.verdicts
      .filter((v) => !v.refuted)
      .sort((a, b) => confRank[a.confidence] - confRank[b.confidence])[0];
    return (
      "### [" +
      i +
      "] " +
      c.claim +
      "\n" +
      "Vote: " +
      (c.verdicts.length - c.refutedVotes) +
      "-" +
      c.refutedVotes +
      " · Source: " +
      c.sourceUrl +
      " (" +
      c.sourceQuality +
      ")\n" +
      'Quote: "' +
      c.quote +
      '"\nVerifier evidence (' +
      best.confidence +
      "): " +
      best.evidence +
      "\n"
    );
  })
  .join("\n");

const killedBlock =
  killed.length > 0
    ? "\n## Refuted claims (for transparency)\n" +
      killed
        .map(
          (c) =>
            '- "' +
            c.claim +
            '" (' +
            c.sourceUrl +
            ", vote " +
            (c.verdicts.length - c.refutedVotes) +
            "-" +
            c.refutedVotes +
            ")",
        )
        .join("\n")
    : "";

const report = await agent(
  "## Synthesis: research report\n\n" +
    "**Question:** " +
    QUESTION +
    "\n\n" +
    confirmed.length +
    " claims survived " +
    VOTES_PER_CLAIM +
    "-vote adversarial verification. Merge semantic duplicates and synthesize.\n\n" +
    "## Confirmed claims\n" +
    block +
    "\n" +
    killedBlock +
    "\n\n" +
    "## Instructions\n" +
    "1. Identify claims that say the same thing — merge them, combine their sources.\n" +
    "2. Group related claims into coherent findings. Each finding should directly address the research question.\n" +
    "3. Assign confidence per finding: high (multiple primary sources, unanimous votes), medium (secondary sources or split votes), low (single source or blog-quality).\n" +
    "4. Write a 3-5 sentence executive summary answering the research question.\n" +
    "5. Note caveats: what's uncertain, what sources were weak, what time-sensitivity applies.\n" +
    "6. List 2-4 open questions that emerged but weren't answered.\n\nStructured output only.",
  { label: "synthesize", schema: REPORT_SCHEMA },
);

if (!report) {
  // Synthesis skipped/errored — salvage the verified claims raw rather
  // than throwing on report.findings and discarding the whole run.
  return {
    question: QUESTION,
    summary:
      "Synthesis step was skipped or failed — returning " +
      confirmed.length +
      " verified claims unmerged.",
    findings: [],
    confirmed: confirmed.map((c) => ({
      claim: c.claim,
      source: c.sourceUrl,
      quote: c.quote,
      vote: c.verdicts.length - c.refutedVotes + "-" + c.refutedVotes,
    })),
    refuted: killed.map((c) => ({
      claim: c.claim,
      vote: c.verdicts.length - c.refutedVotes + "-" + c.refutedVotes,
      source: c.sourceUrl,
    })),
    sources: allSources.map((s) => ({
      url: s.url,
      quality: s.sourceQuality,
      claimCount: s.claims.length,
    })),
    stats: {
      angles: scope.angles.length,
      sources: allSources.length,
      claims: allClaims.length,
      verified: voted.length,
      confirmed: confirmed.length,
      killed: killed.length,
      afterSynthesis: 0,
    },
  };
}

return {
  question: QUESTION,
  ...report,
  refuted: killed.map((c) => ({
    claim: c.claim,
    vote: c.verdicts.length - c.refutedVotes + "-" + c.refutedVotes,
    source: c.sourceUrl,
  })),
  sources: allSources.map((s) => ({
    url: s.url,
    quality: s.sourceQuality,
    angle: s.angle,
    claimCount: s.claims.length,
  })),
  stats: {
    angles: scope.angles.length,
    sourcesFetched: allSources.length,
    claimsExtracted: allClaims.length,
    claimsVerified: voted.length,
    confirmed: confirmed.length,
    killed: killed.length,
    afterSynthesis: report.findings.length,
    urlDupes: dupes.length,
    budgetDropped: budgetDropped.length,
    agentCalls: 1 + scope.angles.length + allSources.length + voted.length * VOTES_PER_CLAIM + 1,
  },
};
```

---

### C.7 `docs` (7512 chars)

```ts
export const meta = {
  name: "docs",
  description:
    "Documentation generator. Discovers the feature surface and existing doc conventions, outlines for the target audience, writes or updates the docs, verifies code examples and links, then opens a PR.",
  whenToUse:
    "When the user wants documentation written or updated for a feature, API, or module. This workflow finds the relevant code and existing doc patterns, drafts an outline, writes the content, checks that examples run and links resolve, and opens a PR.",
  phases: [
    { title: "Discover", detail: "Feature surface, existing docs, location conventions" },
    { title: "Outline", detail: "Structure and audience" },
    { title: "Write", detail: "Create or update doc files" },
    { title: "Verify", detail: "Examples compile/run, links resolve, accuracy vs code" },
    { title: "PR", detail: "Open PR" },
  ],
};

const TASK = typeof args === "string" && args.trim() ? args.trim() : "";
if (!TASK) return { error: "No subject provided. Pass what to document as args." };

const DISCOVER_SCHEMA = {
  type: "object",
  required: ["surface", "existingDocs", "targetPath", "audience", "conventions"],
  properties: {
    surface: {
      type: "array",
      items: { type: "string" },
      description: "file:symbol entries that make up the public surface",
    },
    existingDocs: { type: "array", items: { type: "string" } },
    targetPath: { type: "string", description: "Where the new/updated doc should live" },
    audience: { type: "string" },
    conventions: {
      type: "string",
      description: "Tone, format, and structure conventions from sibling docs",
    },
  },
};
const OUTLINE_SCHEMA = {
  type: "object",
  required: ["title", "sections"],
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        required: ["heading", "covers"],
        properties: { heading: { type: "string" }, covers: { type: "string" } },
      },
    },
  },
};
const IMPL_SCHEMA = {
  type: "object",
  required: ["done", "filesChanged", "notes"],
  properties: {
    done: { type: "boolean" },
    filesChanged: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
  },
};
const VERIFY_SCHEMA = {
  type: "object",
  required: ["examplesOk", "linksOk", "accurate", "issues"],
  properties: {
    examplesOk: { type: "boolean" },
    linksOk: { type: "boolean" },
    accurate: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
  },
};
const PR_SCHEMA = {
  type: "object",
  required: ["prUrl", "branch", "summary"],
  properties: {
    prUrl: { type: "string" },
    branch: { type: "string" },
    summary: { type: "string" },
    notes: { type: "string" },
  },
};

// ═══ Phase 1: Discover ═══
phase("Discover");

const disc = await agent(
  "Discover what needs documenting and where it should live.\n\n" +
    "## Subject\n" +
    TASK +
    "\n\n" +
    "## Instructions\n" +
    "1. Grep/read the code to map the public surface: exported functions, types, CLI flags, " +
    "config keys — whatever a user of this feature touches. List as file:symbol.\n" +
    "2. Find existing docs for this or adjacent features (README, docs/, CLAUDE.md, mdx). " +
    "Note their location, format, and tone.\n" +
    "3. Decide the target path: update an existing doc if one covers this area, otherwise " +
    "pick a path that matches the existing doc layout.\n" +
    "4. Identify the audience (end user, API consumer, contributor) and the conventions to follow.",
  { label: "discover", schema: DISCOVER_SCHEMA },
);
if (!disc) return { error: "Discover step skipped." };
log(
  "Surface: " +
    disc.surface.length +
    " items, target: " +
    disc.targetPath +
    " (" +
    disc.audience +
    ")",
);

const CONTEXT =
  "## Subject\n" +
  TASK +
  "\n\n" +
  "## Surface\n" +
  disc.surface.map((s) => "- " + s).join("\n") +
  "\n\n" +
  "## Target\n" +
  disc.targetPath +
  " (audience: " +
  disc.audience +
  ")\n\n" +
  "## Conventions\n" +
  disc.conventions +
  "\n";

// ═══ Phase 2: Outline ═══
phase("Outline");

const outline = await agent(
  CONTEXT +
    "\n## Instructions\n" +
    "Draft a section outline for " +
    disc.targetPath +
    ".\n" +
    "Match the structure of sibling docs. Cover: what it is, when to use it, how to use it " +
    "(with at least one runnable example), key options/API, and gotchas. Keep it lean — " +
    "no section that does not earn its place.",
  { label: "outline", schema: OUTLINE_SCHEMA },
);
if (!outline) return { error: "Outline step skipped.", discover: disc };
log("Outline: " + outline.sections.length + " sections");

// ═══ Phase 3: Write ═══
phase("Write");

const impl = await agent(
  CONTEXT +
    "\n## Outline\n" +
    outline.sections.map((s, i) => i + 1 + ". " + s.heading + " — " + s.covers).join("\n") +
    "\n\n" +
    "## Existing docs to reference\n" +
    (disc.existingDocs.length ? disc.existingDocs.join(", ") : "(none)") +
    "\n\n" +
    "## Instructions\n" +
    "Write the documentation at " +
    disc.targetPath +
    " following the outline.\n" +
    "- Code examples must be REAL — copy from working code or tests, not invented.\n" +
    "- Match the tone and format of sibling docs.\n" +
    "- If updating an existing file, preserve unrelated sections.\n" +
    "- Update any nav/index files if the doc layout requires it.",
  { label: "write", schema: IMPL_SCHEMA },
);
if (!impl || !impl.done) {
  return {
    error: "Write incomplete.",
    discover: disc,
    outline,
    blockers: impl ? impl.blockers : ["skipped"],
  };
}
log("Wrote: " + impl.filesChanged.join(", "));

// ═══ Phase 4: Verify ═══
phase("Verify");

const verify = await agent(
  "Verify the documentation just written.\n\n" +
    "Files: " +
    impl.filesChanged.join(", ") +
    "\n\n" +
    "## Instructions\n" +
    "1. Extract every code example and run/compile it (or typecheck it). Flag any that fail.\n" +
    "2. Check every relative link and cross-reference resolves to a real file or anchor.\n" +
    "3. Spot-check accuracy: pick 3 claims about behavior and verify them against the code at\n" +
    disc.surface
      .slice(0, 5)
      .map((s) => "   - " + s)
      .join("\n") +
    "\n" +
    "4. List concrete issues found (empty if clean).",
  { label: "verify", schema: VERIFY_SCHEMA },
);
const issues = verify ? verify.issues : [];
log(
  "Verify: examples " +
    (verify && verify.examplesOk ? "OK" : "FAIL") +
    ", links " +
    (verify && verify.linksOk ? "OK" : "FAIL") +
    ", " +
    issues.length +
    " issues",
);

let fixNotes = "(clean)";
if (issues.length > 0) {
  const fixed = await agent(
    "Fix these documentation issues:\n" +
      issues.map((i, n) => n + 1 + ". " + i).join("\n") +
      "\n\nFiles: " +
      impl.filesChanged.join(", "),
    { label: "verify:fix", phase: "Verify", schema: IMPL_SCHEMA },
  );
  fixNotes = fixed ? fixed.notes : "(fix skipped)";
}

// ═══ Phase 5: PR ═══
phase("PR");

const pr = await agent(
  "Open a PR for this documentation change.\n\n" +
    "## Subject\n" +
    TASK +
    "\n\n" +
    "Files: " +
    impl.filesChanged.join(", ") +
    "\n\n" +
    "## Instructions\n" +
    "1. Run lint/format on the doc files if the repo has a docs linter.\n" +
    "2. Commit, push, open a PR. Summarize what was documented and why.\n" +
    "3. Return PR URL, branch, and a 2-3 sentence summary.",
  { label: "pr", schema: PR_SCHEMA },
);

return {
  summary: pr ? pr.summary : "PR step incomplete. Docs written to " + impl.filesChanged.join(", "),
  prUrl: pr ? pr.prUrl : null,
  branch: pr ? pr.branch : null,
  targetPath: disc.targetPath,
  filesChanged: impl.filesChanged,
  outline: outline.sections.map((s) => s.heading),
  verify: verify
    ? { examplesOk: verify.examplesOk, linksOk: verify.linksOk, issues: issues.length }
    : null,
  fixNotes,
};
```

---

### C.8 `investigate` (8026 chars)

```ts
export const meta = {
  name: "investigate",
  description:
    "Root-cause investigation. Gathers evidence, generates competing hypotheses in parallel, adversarially refutes each one, and produces a written root-cause report with a suggested fix.",
  whenToUse:
    "When the user wants the root cause of an incident, error, log, trace, or puzzling behavior found — without necessarily fixing it. This workflow collects evidence, runs parallel hypothesis agents, tries to refute each hypothesis, and writes up the surviving root cause with next steps. It produces a report, not a PR.",
  phases: [
    { title: "Gather", detail: "Logs, traces, repro, timeline" },
    { title: "Hypothesize", detail: "3 parallel hypothesis agents" },
    { title: "Verify", detail: "One adversarial refuter per hypothesis" },
    { title: "Report", detail: "Root-cause writeup, suggested fix, next steps" },
  ],
};

const TASK = typeof args === "string" && args.trim() ? args.trim() : "";
if (!TASK)
  return {
    error: "No incident description provided. Pass the incident, error, or question as args.",
  };

const GATHER_SCHEMA = {
  type: "object",
  required: ["timeline", "evidence", "scope"],
  properties: {
    timeline: { type: "string", description: "What happened, in order" },
    evidence: {
      type: "array",
      items: { type: "string" },
      description: "Concrete observations with file:line or log refs",
    },
    scope: { type: "string", description: "What is affected and what is not" },
    reproSteps: { type: "string" },
  },
};
const HYPOTHESIS_SCHEMA = {
  type: "object",
  required: ["hypothesis", "mechanism", "predicts"],
  properties: {
    hypothesis: { type: "string", description: "One-sentence root cause claim" },
    mechanism: { type: "string", description: "How this cause produces the observed symptom" },
    predicts: {
      type: "array",
      items: { type: "string" },
      description: "Testable predictions if this is true",
    },
    suspectCode: { type: "string", description: "file:line if applicable" },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence"],
  properties: { refuted: { type: "boolean" }, evidence: { type: "string" } },
};
const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "rootCause", "suggestedFix", "nextSteps"],
  properties: {
    summary: { type: "string" },
    rootCause: { type: "string" },
    suggestedFix: { type: "string" },
    nextSteps: { type: "array", items: { type: "string" } },
    confidence: { enum: ["high", "medium", "low"] },
  },
};

// ═══ Phase 1: Gather ═══
phase("Gather");

const gather = await agent(
  "Gather evidence for this investigation. Do NOT theorize yet — just collect facts.\n\n" +
    "## Incident\n" +
    TASK +
    "\n\n" +
    "## Instructions\n" +
    "1. Read any referenced logs, traces, error messages, or files. Pull out concrete " +
    "observations — quote exact lines with their source.\n" +
    "2. Establish a timeline: what happened first, what followed.\n" +
    "3. Establish scope: what is broken, what still works, when it started.\n" +
    "4. If reproducible, note the minimal repro steps.\n\n" +
    "Stick to observations. No conclusions.",
  { label: "gather", schema: GATHER_SCHEMA },
);
if (!gather) return { error: "Gather step skipped." };
log("Gathered " + gather.evidence.length + " pieces of evidence");

const EVIDENCE_BLOCK =
  "## Incident\n" +
  TASK +
  "\n\n" +
  "## Timeline\n" +
  gather.timeline +
  "\n\n" +
  "## Scope\n" +
  gather.scope +
  "\n\n" +
  "## Evidence\n" +
  gather.evidence.map((e, i) => i + 1 + ". " + e).join("\n") +
  "\n" +
  (gather.reproSteps ? "\n## Repro\n" + gather.reproSteps + "\n" : "");

// ═══ Phase 2: Hypothesize (3 parallel) ═══
phase("Hypothesize");

const ANGLES = [
  {
    key: "recent-change",
    lens: "Assume a recent code or config change caused this. Check git log, recent deploys, flag flips.",
  },
  {
    key: "data-edge-case",
    lens: "Assume the code is fine and a particular input, state, or environment value triggered a latent edge case.",
  },
  {
    key: "infra-timing",
    lens: "Assume a race, timeout, resource limit, dependency outage, or ordering issue — not the application logic itself.",
  },
];

const hypotheses = await parallel(
  ANGLES.map(
    (a) => () =>
      agent(
        EVIDENCE_BLOCK +
          "\n## Your angle: " +
          a.key +
          "\n" +
          a.lens +
          "\n\n" +
          "## Instructions\n" +
          "Propose ONE concrete root-cause hypothesis from this angle. Read the relevant code. " +
          "Explain the mechanism — how this cause produces EVERY observation in the evidence list. " +
          "List 2-3 testable predictions: things that would be true if and only if this hypothesis holds.",
        { label: "hypothesis:" + a.key, phase: "Hypothesize", schema: HYPOTHESIS_SCHEMA },
      ),
  ),
);
const hyps = hypotheses.map((h, i) => (h ? { ...h, angle: ANGLES[i].key } : null)).filter(Boolean);
if (hyps.length === 0) return { error: "No hypotheses generated.", gather };
log(hyps.length + " hypotheses: " + hyps.map((h) => h.angle).join(", "));

// ═══ Phase 3: Verify (adversarial refutation) ═══
phase("Verify");

const verdicts = await parallel(
  hyps.map(
    (h) => () =>
      agent(
        EVIDENCE_BLOCK +
          "\n## Hypothesis under test (" +
          h.angle +
          ")\n" +
          h.hypothesis +
          "\n\nMechanism: " +
          h.mechanism +
          "\n" +
          "Predictions: " +
          h.predicts.join("; ") +
          "\n" +
          (h.suspectCode ? "Suspect: " + h.suspectCode + "\n" : "") +
          "\n" +
          "## Instructions\n" +
          "Try to REFUTE this hypothesis. Check each prediction against the codebase and evidence. " +
          "Look for evidence the hypothesis CANNOT explain.\n" +
          "refuted=true if any prediction fails or any evidence contradicts the mechanism.\n" +
          "refuted=false ONLY if every prediction checks out and nothing contradicts it.\n" +
          "Evidence must cite file:line or a specific observation number.",
        { label: "refute:" + h.angle, phase: "Verify", schema: VERDICT_SCHEMA },
      ).then((v) => ({ ...h, verdict: v })),
  ),
);

const survived = verdicts.filter((v) => v && v.verdict && !v.verdict.refuted);
const refuted = verdicts.filter((v) => v && v.verdict && v.verdict.refuted);
log("Verify: " + survived.length + " survived, " + refuted.length + " refuted");

// ═══ Phase 4: Report ═══
phase("Report");

const survivedBlock =
  survived.length > 0
    ? survived
        .map(
          (h) =>
            "### " +
            h.hypothesis +
            " (" +
            h.angle +
            ")\n" +
            "Mechanism: " +
            h.mechanism +
            "\n" +
            (h.suspectCode ? "Suspect: " + h.suspectCode + "\n" : "") +
            "Verifier evidence: " +
            h.verdict.evidence +
            "\n",
        )
        .join("\n")
    : "(none survived — all hypotheses refuted)";

const refutedBlock = refuted
  .map((h) => "- " + h.hypothesis + " (" + h.angle + ") — refuted: " + h.verdict.evidence)
  .join("\n");

const report = await agent(
  "Write the root-cause report.\n\n" +
    EVIDENCE_BLOCK +
    "\n" +
    "## Surviving hypotheses (" +
    survived.length +
    ")\n" +
    survivedBlock +
    "\n\n" +
    "## Refuted hypotheses (" +
    refuted.length +
    ")\n" +
    (refutedBlock || "(none)") +
    "\n\n" +
    "## Instructions\n" +
    (survived.length === 1
      ? "One hypothesis survived — that is the root cause. "
      : survived.length > 1
        ? "Multiple hypotheses survived — pick the one that best explains ALL evidence, or note they may compound. "
        : "No hypothesis survived — synthesize the most likely cause from what was learned during refutation, with low confidence. ") +
    "Write: a 2-3 sentence summary, the root cause, a concrete suggested fix (file:line where " +
    "possible), confidence level, and next steps (further verification, monitoring, follow-ups).",
  { label: "report", schema: REPORT_SCHEMA },
);
if (!report) return { error: "Report step skipped.", gather, survived, refuted };

return {
  summary: report.summary,
  rootCause: report.rootCause,
  suggestedFix: report.suggestedFix,
  confidence:
    report.confidence || (survived.length === 1 ? "high" : survived.length > 1 ? "medium" : "low"),
  nextSteps: report.nextSteps,
  hypotheses: {
    survived: survived.map((h) => ({
      angle: h.angle,
      hypothesis: h.hypothesis,
      suspect: h.suspectCode || null,
    })),
    refuted: refuted.map((h) => ({
      angle: h.angle,
      hypothesis: h.hypothesis,
      reason: h.verdict.evidence,
    })),
  },
  evidence: gather.evidence,
};
```

---

### C.9 `plan-hunter` (8381 chars)

```ts
export const meta = {
  name: "plan-hunter",
  description:
    "Exhaustive planning harness. Generates 4 independent draft plans (MVP-first, risk-first, dependency-first, user-first), scores them with 4 parallel judges, picks the winner by vote, then synthesizes a polished final plan grafting in the best ideas from runners-up.",
  whenToUse:
    "When the user has an idea they want planned thoroughly. BEFORE invoking this workflow, ask 2-3 clarifying questions if the idea is underspecified: (1) scope/timeline, (2) hard constraints or non-goals, (3) success criteria. Then pass the clarified idea as the args string.",
  phases: [
    { title: "Scope", detail: "Understand the idea, extract constraints, note assumptions" },
    { title: "Draft", detail: "4 parallel planners: MVP / Risk / Dependency / User lenses" },
    { title: "Judge", detail: "4 parallel judges rank all 4 drafts" },
    { title: "Synthesize", detail: "Polish the winner, graft best ideas from runners-up" },
  ],
};

// ═══ Lenses ═══
const LENSES = [
  {
    key: "mvp",
    label: "MVP-first",
    focus:
      "What is the smallest thing that ships and delivers value? Phase the plan so each phase is independently shippable. Defer everything non-essential.",
  },
  {
    key: "risk",
    label: "Risk-first",
    focus:
      "What could go wrong? Identify the riskiest assumptions and unknowns. Structure the plan to de-risk early — spike the hard parts before committing.",
  },
  {
    key: "dep",
    label: "Dependency-first",
    focus:
      "What must exist before what? Build a dependency graph. Sequence work so nothing blocks on something not yet built. Surface hidden dependencies.",
  },
  {
    key: "user",
    label: "User-first",
    focus:
      "What does the end user actually need? Work backward from the user journey. Every task should trace to a user-visible outcome.",
  },
];

// ═══ Schemas ═══
const SCOPE_SCHEMA = {
  type: "object",
  required: ["idea", "constraints", "goals", "assumptions", "openQuestions"],
  properties: {
    idea: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
    goals: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
  },
};
const DRAFT_SCHEMA = {
  type: "object",
  required: ["plan", "risks", "gaps"],
  properties: {
    plan: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
  },
};
const JUDGE_SCHEMA = {
  type: "object",
  required: ["rankings"],
  properties: {
    rankings: {
      type: "array",
      items: {
        type: "object",
        required: ["lens", "score", "rationale"],
        properties: {
          lens: { type: "string" },
          score: { type: "number" },
          rationale: { type: "string" },
        },
      },
    },
  },
};

// ═══ Phase 0: Scope ═══
phase("Scope");

const IDEA = typeof args === "string" && args.trim() ? args.trim() : "";
if (!IDEA) {
  return { error: "No idea provided. Pass the idea as the args parameter." };
}

const scope = await agent(
  "Understand this idea and extract structure for planning.\n\n" +
    "## Idea\n" +
    IDEA +
    "\n\n" +
    "## Task\n" +
    "1. Restate the idea clearly (normalize vague wording).\n" +
    "2. Extract explicit constraints mentioned. If none, leave empty.\n" +
    "3. Extract goals/success criteria. If implicit, infer reasonable ones.\n" +
    "4. Note assumptions you are making to fill gaps.\n" +
    "5. List open questions the user should answer for a tighter plan.\n\n" +
    "Keep everything concise. Structured output only.",
  { label: "scope", schema: SCOPE_SCHEMA },
);
if (!scope) return { error: "Scope skipped." };

log(
  "Idea scoped: " +
    scope.goals.length +
    " goals, " +
    scope.constraints.length +
    " constraints, " +
    scope.assumptions.length +
    " assumptions",
);

// Shared context block for all planners and judges.
const CONTEXT =
  "## Idea\n" +
  scope.idea +
  "\n\n" +
  "## Goals\n" +
  scope.goals.map((g) => "- " + g).join("\n") +
  "\n\n" +
  "## Constraints\n" +
  (scope.constraints.length ? scope.constraints.map((c) => "- " + c).join("\n") : "(none stated)") +
  "\n\n" +
  "## Assumptions (made by scope)\n" +
  (scope.assumptions.length ? scope.assumptions.map((a) => "- " + a).join("\n") : "(none)") +
  "\n\n";

// ═══ Phase 1: Draft — 4 parallel planners ═══
phase("Draft");

const drafts = await parallel(
  LENSES.map(
    (lens) => () =>
      agent(
        CONTEXT +
          "## Your lens: " +
          lens.label +
          "\n" +
          lens.focus +
          "\n\n" +
          "## Task\n" +
          "Write a complete implementation plan from the " +
          lens.label +
          " perspective.\n" +
          "- Use numbered phases/steps.\n" +
          "- Be concrete: file paths, commands, decisions to make.\n" +
          "- List risks: things that could derail this plan.\n" +
          "- List gaps: things this plan doesn't address.\n\n" +
          "Structured output only.",
        { label: "draft:" + lens.key, phase: "Draft", schema: DRAFT_SCHEMA },
      ).then((d) => (d ? { lens: lens.key, label: lens.label, ...d } : null)),
  ),
);

const validDrafts = drafts.filter(Boolean);
if (validDrafts.length === 0) {
  return { error: "All drafts skipped.", scope };
}
log(validDrafts.length + " drafts ready");

// ═══ Phase 2: Judge — 4 parallel judges rank all drafts ═══
phase("Judge");

const draftsBlock = validDrafts
  .map(
    (d) =>
      "### " +
      d.label +
      " (key: " +
      d.lens +
      ")\n" +
      d.plan +
      "\n\n" +
      "Risks: " +
      d.risks.join("; ") +
      "\n" +
      "Gaps: " +
      d.gaps.join("; "),
  )
  .join("\n\n---\n\n");

const JUDGE_PROMPT =
  CONTEXT +
  "## Your task: rank these " +
  validDrafts.length +
  " plans\n\n" +
  draftsBlock +
  "\n\n" +
  "## Scoring\n" +
  "Score each plan 1-10 on overall quality for THIS idea. Consider:\n" +
  "- Completeness (does it cover the goals?)\n" +
  "- Practicality (can this actually be executed?)\n" +
  "- Risk awareness (are the risks real and addressed?)\n" +
  "- Sequencing (does the order make sense?)\n\n" +
  "Return rankings for ALL plans. Use the 'lens' key exactly as shown.\n" +
  "Structured output only.";

const judges = await parallel(
  [0, 1, 2, 3].map(
    (i) => () =>
      agent(JUDGE_PROMPT, {
        label: "judge-" + i,
        phase: "Judge",
        schema: JUDGE_SCHEMA,
      }),
  ),
);

const validJudges = judges.filter(Boolean);

// ═══ JS: aggregate scores ═══
const scores = {};
validDrafts.forEach((d) => {
  scores[d.lens] = { total: 0, votes: 0, rationales: [] };
});

validJudges.forEach((j) => {
  j.rankings.forEach((r) => {
    if (scores[r.lens]) {
      scores[r.lens].total += r.score;
      scores[r.lens].votes += 1;
      scores[r.lens].rationales.push(r.rationale);
    }
  });
});

const ranked = validDrafts
  .map((d) => ({
    ...d,
    avgScore: scores[d.lens].votes > 0 ? scores[d.lens].total / scores[d.lens].votes : 0,
  }))
  .sort((a, b) => b.avgScore - a.avgScore);

const winner = ranked[0];
const runnersUp = ranked.slice(1);

log("Winner: " + winner.label + " (avg " + winner.avgScore.toFixed(1) + "/10)");

// ═══ Phase 3: Synthesize — polish winner, graft best from runners-up ═══
phase("Synthesize");

const final = await agent(
  CONTEXT +
    "## Winning plan: " +
    winner.label +
    " (avg score " +
    winner.avgScore.toFixed(1) +
    "/10 across " +
    validJudges.length +
    " judges)\n\n" +
    winner.plan +
    "\n\n" +
    "## Judge rationales\n" +
    scores[winner.lens].rationales.map((r) => "- " + r).join("\n") +
    "\n\n" +
    "## Other plans (for grafting good ideas)\n" +
    runnersUp
      .map((d) => "### " + d.label + " (" + d.avgScore.toFixed(1) + "/10)\n" + d.plan)
      .join("\n\n") +
    "\n\n" +
    "## Task\n" +
    "Produce the FINAL plan.\n" +
    "1. Start from the winning plan's structure.\n" +
    "2. Graft in any clearly-better ideas from the runners-up.\n" +
    "3. Incorporate the risks/gaps all plans surfaced.\n" +
    "4. Open with any assumptions and open questions from scope — the user should confirm these.\n\n" +
    "Write it as a document the user can act on immediately. No preamble.",
  { label: "synthesize" },
);

return {
  plan: final,
  winner: { lens: winner.lens, label: winner.label, score: winner.avgScore },
  scoreboard: ranked.map((d) => ({ lens: d.lens, label: d.label, avgScore: d.avgScore })),
  scope: {
    idea: scope.idea,
    assumptions: scope.assumptions,
    openQuestions: scope.openQuestions,
  },
  stats: {
    drafts: validDrafts.length,
    judges: validJudges.length,
    agentCalls: 1 + validDrafts.length + validJudges.length + 1,
  },
};
```

---

### C.10 `review-branch` (11814 chars)

```ts
export const meta = {
  name: "review-branch",
  description:
    "Thoroughly review the current branch for bugs, simplicity, architecture, dead code, best practices, and pattern consistency. Each finding is adversarially verified before reporting.",
  whenToUse:
    "When the user asks to review their branch, do a code review of recent changes, or audit a PR quality before shipping.",
  phases: [
    { title: "Scope", detail: "Discover diff base, changed files, conventions" },
    { title: "Review", detail: "Six dimension reviewers in parallel" },
    { title: "Verify", detail: "Adversarial verification of each finding" },
    { title: "Report", detail: "Dedup, rank, and summarize" },
  ],
};

// ===== Phase 0: Scope =====
phase("Scope");

const MAX_VERIFY = 25;

const SCOPE_SCHEMA = {
  type: "object",
  required: ["files", "diffBase", "stats", "conventions"],
  properties: {
    files: { type: "array", items: { type: "string" } },
    diffBase: { type: "string" },
    stats: { type: "string" },
    conventions: { type: "string" },
  },
};

const scope = await agent(
  "Discover the scope of changes on the current branch.\n\n" +
    "1. Find the diff base: try 'git rev-parse origin/main' first. If that fails, " +
    "fall back to 'main'. Use the one that exists as diffBase.\n" +
    "2. Run 'git diff <diffBase>...HEAD --name-only' for the file list.\n" +
    "3. Run 'git diff <diffBase>...HEAD --stat' for stats summary.\n" +
    "4. Read CLAUDE.md at the project root if it exists. Extract a brief summary " +
    "(under 500 words) of coding conventions, patterns, and rules. Empty string if no CLAUDE.md.\n\n" +
    "Return the structured scope.",
  { label: "scope:discover", schema: SCOPE_SCHEMA },
);

if (!scope || scope.files.length === 0) {
  log(
    scope
      ? "No changes vs " + scope.diffBase + " — nothing to review."
      : "Scope discovery skipped.",
  );
  return { report: "No changes to review.", stats: { filesReviewed: 0 } };
}

log(scope.files.length + " files changed vs " + scope.diffBase);

// Shared context header — diff base, files, stats, conventions.
// Each reviewer/verifier runs 'git diff <diffBase>...HEAD' itself.
const CONTEXT_HEADER =
  "<context>\n" +
  "## Diff base: " +
  scope.diffBase +
  "\n\n" +
  "## Changed files (" +
  scope.files.length +
  ")\n" +
  scope.files
    .map(function (f) {
      return "  - " + f;
    })
    .join("\n") +
  "\n\n" +
  "## Stats\n" +
  scope.stats +
  "\n\n" +
  (scope.conventions ? "## Conventions (CLAUDE.md)\n" + scope.conventions + "\n" : "") +
  "</context>\n\n";

// ===== Phase 1+2: Review → Verify (pipeline, no barrier) =====

const DIMENSIONS = [
  {
    key: "bugs",
    title: "Bugs",
    focus:
      "correctness issues: null/undefined handling, off-by-one errors, race conditions, " +
      "incorrect error handling, resource leaks (unclosed handles, unbounded caches), " +
      "type confusion, logic errors. Be precise about WHY it's a bug — what input triggers it?",
  },
  {
    key: "simplicity",
    title: "Simplicity",
    focus:
      "unnecessary complexity: over-engineering, premature abstraction, unnecessary " +
      "indirection, overly clever code, redundant conditionals, configuration for " +
      "hypothetical needs. Ask: can this be simpler without losing functionality?",
  },
  {
    key: "architecture",
    title: "Architecture",
    focus:
      "structural issues: tight coupling, poor cohesion, layering violations, misplaced " +
      "responsibilities, leaky abstractions, modules doing too many things. Is each " +
      "module/function doing one thing well?",
  },
  {
    key: "dead-code",
    title: "Dead Code",
    focus:
      "unreachable or unused code: unused exports, unreachable branches, stale feature " +
      "flags, commented-out code, debug leftovers, defensive checks for impossible states. " +
      "Use grep/LSP to verify zero callers before flagging an export as dead.",
  },
  {
    key: "best-practices",
    title: "Best Practices",
    focus:
      "hygiene: error handling patterns, type safety (avoid 'any', narrow types), " +
      "async/await correctness (unhandled rejections, missing awaits), resource cleanup, " +
      "naming clarity, avoiding common pitfalls.",
  },
  {
    key: "patterns",
    title: "Existing Patterns",
    focus:
      "consistency with existing codebase conventions. Grep for similar existing code and " +
      "compare: does the new code follow the same patterns for state management, error " +
      "handling, file layout, naming? Check CLAUDE.md rules. Flag divergence, not " +
      "stylistic preference.",
  },
];

const FINDING_SCHEMA = {
  type: "object",
  required: ["file", "line", "severity", "title", "description", "suggestion"],
  properties: {
    file: { type: "string" },
    line: { type: "number" },
    severity: { enum: ["high", "medium", "low"] },
    title: { type: "string" },
    description: { type: "string" },
    suggestion: { type: "string" },
  },
};

const REVIEW_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: { type: "array", items: FINDING_SCHEMA },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "confidence", "reasoning"],
  properties: {
    verdict: { enum: ["confirmed", "rejected", "unclear"] },
    confidence: { enum: ["high", "medium", "low"] },
    reasoning: { type: "string" },
  },
};

function reviewPrompt(dim) {
  return (
    CONTEXT_HEADER +
    "## Role: " +
    dim.title +
    " Reviewer\n\n" +
    "You are reviewing the code changes on this branch for ONE concern: **" +
    dim.title +
    "**.\n\n" +
    "Focus: " +
    dim.focus +
    "\n\n" +
    "Run 'git diff " +
    scope.diffBase +
    "...HEAD' to see the changes. Read files in full " +
    "context as needed.\n\n" +
    "Ground rules:\n" +
    "- Only report REAL issues in the " +
    dim.title +
    " category. No nitpicks, no style opinions " +
    "unless they violate explicit project conventions.\n" +
    "- Each finding MUST cite a specific file:line.\n" +
    "- Be thorough but precise. Ten good findings beat fifty vague ones.\n" +
    "- Empty findings is a valid result if the code is clean in this dimension.\n\n" +
    "Return ONLY findings in the " +
    dim.title +
    " category."
  );
}

function verifyPrompt(dim, f) {
  return (
    CONTEXT_HEADER +
    "## Role: Adversarial Verifier\n\n" +
    "Your PRIMARY job is to REJECT false positives.\n\n" +
    "A reviewer claims this is a " +
    dim.title +
    " issue:\n\n" +
    "File: " +
    f.file +
    ":" +
    f.line +
    "\n" +
    "Severity: " +
    f.severity +
    "\n" +
    "Claim: " +
    f.title +
    "\n\n" +
    "Their reasoning:\n" +
    f.description +
    "\n\n" +
    "Their suggested fix:\n" +
    f.suggestion +
    "\n\n" +
    "Your task:\n" +
    "1. Run 'git diff " +
    scope.diffBase +
    "...HEAD -- " +
    f.file +
    "' and read " +
    f.file +
    " around line " +
    f.line +
    ".\n" +
    "2. Try HARD to find a reason this is NOT a real issue:\n" +
    "   - Is there code elsewhere that handles this case?\n" +
    "   - Is this intentional behavior (check comments, git blame, related tests)?\n" +
    "   - Is the reviewer misreading the code?\n" +
    "   - Is this theoretically possible but practically irrelevant?\n" +
    "3. Only confirm if the issue clearly survives scrutiny.\n\n" +
    "Reject freely. False positives waste human time. If you're unsure after investigation, " +
    "return 'unclear' — do NOT default to 'confirmed'."
  );
}

// Shared verify budget — sorted-by-severity allocation as each dimension completes.
// First-come gets slots but severity-sorted within each dimension → high sev always passes.
const sevRank = { high: 0, medium: 1, low: 2 };
let verifySlots = MAX_VERIFY;
const budgetDropped = [];

const results = await pipeline(
  DIMENSIONS,
  // Stage 1: review — each dimension independently reads diff and returns findings.
  async (d) => {
    const review = await agent(reviewPrompt(d), {
      label: "review:" + d.key,
      phase: "Review",
      schema: REVIEW_SCHEMA,
    });
    if (!review) return null; // user-skip: propagate null through pipeline
    log(d.title + ": " + review.findings.length + " findings");
    return { dim: d, findings: review.findings };
  },
  // Stage 2: budget + verify — starts AS SOON AS each review finishes (no barrier).
  (r) => {
    if (!r || r.findings.length === 0) return Promise.resolve([]);
    // Severity-sort so high-priority findings claim budget first within this dimension.
    const sorted = r.findings.slice().sort(function (a, b) {
      return sevRank[a.severity] - sevRank[b.severity];
    });
    const toVerify = sorted.filter(function (f) {
      if (verifySlots <= 0 && sevRank[f.severity] >= 1) {
        // high always passes
        budgetDropped.push(Object.assign({}, f, { dimension: r.dim.key }));
        return false;
      }
      verifySlots--;
      return true;
    });
    if (toVerify.length < r.findings.length) {
      log(r.dim.title + ": " + toVerify.length + "/" + r.findings.length + " within budget");
    }
    return parallel(
      toVerify.map(
        (f) => () =>
          agent(verifyPrompt(r.dim, f), {
            label: "verify:" + f.file.split("/").pop() + ":" + f.line,
            phase: "Verify",
            schema: VERDICT_SCHEMA,
          }).then((v) => (v ? Object.assign({}, f, { dimension: r.dim.key, verdict: v }) : null)),
      ),
    );
  },
);

// ===== Phase 3: Report =====
phase("Report");

const allFindings = results.flat().filter(Boolean);
const confirmed = allFindings.filter((f) => f.verdict.verdict === "confirmed");
const unclear = allFindings.filter((f) => f.verdict.verdict === "unclear");
const rejected = allFindings.filter((f) => f.verdict.verdict === "rejected");

log(
  confirmed.length + " confirmed, " + unclear.length + " unclear, " + rejected.length + " rejected",
);

// Sort confirmed for synthesis input (severity desc, then confidence desc).
const confOrder = { high: 0, medium: 1, low: 2 };
confirmed.sort((a, b) => {
  const s = sevRank[a.severity] - sevRank[b.severity];
  if (s !== 0) return s;
  return confOrder[a.verdict.confidence] - confOrder[b.verdict.confidence];
});

let report;
if (confirmed.length === 0) {
  report =
    "No confirmed issues. " +
    (unclear.length > 0
      ? unclear.length + " unclear findings may warrant a manual look."
      : "Branch looks clean across all six dimensions.");
} else {
  // Synthesis agent: semantic dedup + report. JS dedup by file:line/5 misses
  // cross-dimension dupes (same root cause flagged by both 'bugs' and 'architecture').
  report = await agent(
    "Write a concise code review report from these " +
      confirmed.length +
      " verified findings. They are sorted by severity but MAY contain semantic duplicates " +
      "— the same underlying issue flagged by multiple review dimensions.\n\n" +
      "Findings (JSON):\n" +
      JSON.stringify(confirmed, null, 2) +
      "\n\n" +
      "Instructions:\n" +
      "1. FIRST merge semantic duplicates: findings at the same/nearby file:line with " +
      "overlapping root cause are ONE issue. Combine their descriptions.\n" +
      "2. Group merged findings by severity (high / medium / low).\n" +
      "3. For each: file:line, one-line title, brief description, suggested fix. " +
      "Include verifier reasoning if it adds clarity. Note which dimensions flagged it.\n" +
      "4. End with a summary line: N high, M medium, K low (after dedup).\n\n" +
      "Keep it tight. No preamble. Start directly with the findings.",
    { label: "report:synthesize" },
  );
}

return {
  report,
  stats: {
    filesReviewed: scope.files.length,
    diffBase: scope.diffBase,
    dimensionsReviewed: DIMENSIONS.length,
    totalFindings: allFindings.length,
    confirmed: confirmed.length,
    budgetDropped: budgetDropped.length,
    unclear: unclear.length,
    rejected: rejected.length,
  },
  confirmed: confirmed,
  unclear: unclear.map((f) => ({
    file: f.file,
    line: f.line,
    title: f.title,
    dimension: f.dimension,
    reasoning: f.verdict.reasoning,
  })),
};
```

---

## 备注

- **版本**：所有内容基于 `@anthropic-ai/claude-code-darwin-arm64@2.1.150`。Anthropic 的 description 和 saved workflow 脚本在 minor 版本之间持续修改（例如参考文章引用的 2.1.147 sample `react-quality-improvement` 在 2.1.150 已被 `review-changes` 替换）。
- **`workflow()` 内置 vs 用户自定义**：用户可以在 `.claude/workflows/` 目录放自己的 workflow 脚本，registry 会和内置 10 个混在一起。`workflow('name')` 调用时优先级：built-in > user-dir。
- **`CLAUDE_CODE_REMOTE`**：见 4.2 节。Standard 模式仅 5 个 workflow 注册（bughunt / bughunt-lite / deep-research / plan-hunter / review-branch，全是只读分析类）；`CLAUDE_CODE_REMOTE=1` 才解锁另外 5 个写操作类（autopilot / bugfix / dashboard / docs / investigate），强制走 CCR 远程 sandbox 跑。

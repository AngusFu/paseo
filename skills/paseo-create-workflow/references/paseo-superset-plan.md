# Paseo × Claude Dynamic Workflow：构建「动态工作流超集」研究与规划

> 研究对象：`getpaseo/paseo`（v0.1.107，npm `@getpaseo/cli` / `@getpaseo/server`）。
> 目标：以 paseo 的 daemon + CLI 作为 agent 编排/调度后端，实现一个 **Claude dynamic workflow 的超集**——完整复用 Claude 的提示词、编排原理、质量姿势，以及我们已提取的 10 个内置 workflow 脚本。
> 本文是研究与规划文档（不是代码）。第一部分讲清楚 paseo 是什么、能做什么；第二部分把 Claude 动态工作流逐条映射到 paseo；第三部分给出超集架构设计；第四部分是落地计划与头脑风暴。

---

## ▲ 架构修订与实现现状（2026-07-13，重要 —— 优先读这节）

第一版规划把 runner 叫 "paseo-flow"，并以 paseo 为默认后端来设计。**落地时做了一次方向性修正：核心引擎与 paseo 彻底解耦。** 这节取代第三/四部分中与之冲突的内容。

### 修正 1：面向接口编程，引擎不认识 paseo

核心引擎只依赖**一个抽象接口 `AgentBackend`**，对 paseo / daemon / CLI 一无所知：

```
        workflow 脚本（meta + 8 全局）
                    │
            ┌───────▼────────┐
            │     engine     │  沙箱 · 提示词装配 · 结构化契约 · 并发 · 上限 · 预算 · journal
            └───────┬────────┘
                    │  AgentBackend（接口，唯一契约）
        ┌───────────┼─────────────┬──────────────┐
   MockBackend  PaseoBackend   <任意 backend>   …
   （参考实现）   （只是其中一种；现在不建）
```

- `AgentBackend` 全部契约：`name` / `run(spec)→{text?,error?,usage?}` / `dispose()`。
- `spec` 字段（`prompt,label,phase,model,effort,provider,isolation,labels`）backend 看懂就用、看不懂就忽略。`provider` 是超集的多提供商字段，引擎只负责透传。
- **`PaseoBackend` 只是 implementation 之一，且刻意"现在不建"**——核心是用零 paseo 概念写出来的。要接 paseo 时实现 `AgentBackend` 即插即用，引擎与脚本都不用动。

### 修正 2：结构化输出是引擎自己的事（提示词照复用）

Claude 的 `D0y/L0y` 依赖 provider 侧的 "StructuredOutput" 工具。我们的 backend（mock、未来 paseo-via-cli、任意 LLM）**没有那个工具**，所以**结构化契约由引擎自己负责**：

```
agent(prompt,{schema}) → structuredPersona(schema)（指示输出裸 JSON）
                       → backend.run()
                       → tryParseJson + validate(schema)（引擎内置）
                       → 失败重试（引擎内置）→ 解析值或 null
```

于是 `I0y/D0y/L0y/R0y` 这些提示词**原样复用**（收进 `src/prompt-library.ts` 并注入每个 agent），只是**结构化的"机制"不依赖任何 backend**——所以在连 schema 概念都没有的"哑" MockBackend 上也成立。这正是"提示词复用，只是我们这 provider 不用（工具）"。

### 修正 3：TypeScript

既然已经在写 JSDoc，直接上 TS。引擎全部转为 TypeScript（strict 模式），`AgentSpec/AgentResult/Engine/WorkflowMeta/...` 都是真类型。

### 实现现状：flowkit（已落地，33 测试全绿）

代码在 `flowkit/`。已完成：

| 模块                    | 内容                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/backend.ts`        | `AgentBackend` 抽象基类 + `AgentSpec/AgentResult/Effort` 类型                                                     |
| `src/prompt-library.ts` | 复用的提示词 + 错误类（`WorkflowAgentCapError`/`WorkflowBudgetExceededError`/`S0y`/`v0y`）+ `structuredPersona()` |
| `src/schema.ts`         | JSON-Schema 校验器 + 容错 JSON 解析 + `synthesize()`（按 schema 生成最小合法实例，供 dry-run）                    |
| `src/concurrency.ts`    | 有界并发限制器（只约束 `backend.run`）                                                                            |
| `src/journal.ts`        | resume 缓存（`sha256(prompt,opts)`，可镜像 JSONL）                                                                |
| `src/engine.ts`         | `createEngine`：沙箱 + 8 全局 + 编排（agent/parallel/pipeline/phase/log/budget/args/meta）                        |
| `src/registry.ts`       | workflow 注册表：按名/路径解析，优先级 project > user > builtin                                                   |
| `src/cli.ts`            | `flowkit list / run / backends`（backend 工厂，paseo 即插位已留）                                                 |
| `src/backends/mock.ts`  | `MockBackend`（参考实现：`scripted()`/`auto()` 两种 responder）                                                   |
| `workflows/builtin/`    | **11 个真实 workflow**（10 个经典 + code-review），全部 parse 通过、可跑                                          |

验证结果：

- **33 个测试全绿**：schema/并发/引擎（文本+结构化+上限+预算+journal resume+strict 禁用 Date/Math+并发峰值证明）+ 一个真实 bughunt-lite 端到端。
- **`flowkit list`** 列出全部 11 个内置 workflow。
- **`flowkit run code-review` / `run deep-research`** 在 mock 上端到端跑通（含 Scope→Find→Verify→…→Synthesize，结构化零重试）。

> 过程中修了一个数据质量问题：code-review / deep-research 两个 2.1.207 脚本原本是 cli.js 模板字面量的**未反转义原文**（`\\/`、`\\n`、7 个 `${}` 插值），不能当 JS 跑。已用"单趟模板渲染器"忠实重建（反转义字面量段 + 原样插入 `${}` 值），现在 11 个全部可运行。

### 修正后的路线图（interface-first）

- **P0 引擎内核** ✅ 已完成（沙箱 + 8 全局 + 结构化契约 + 并发/上限/预算/journal，MockBackend，33 测试）。
- **P1 注册表 + CLI + 真实 workflow** ✅ 已完成（registry、cli、11 个内置、端到端 dry-run）。
- **P2 PaseoBackend**（下一块）：实现 `AgentBackend`，内部 shell `paseo run --output-schema`，先单 provider 把一个真实 workflow 跑真。引擎/脚本零改动。
- **P3 多提供商路由**：`opts.provider` + `--provider-map` + 读 paseo orchestration-preferences。
- **P4 Daemon-API 后端（可选优化）+ App 可观测**。
- **P5 产品化**：编排器技能、schedule/loop 集成、分发。

> 第一版第三/四部分里的"paseo-flow 组件分解/差距清单/风险"在概念上仍成立，但凡是把 runner 与 paseo 绑定的表述，以本节 interface-first 为准。

---

---

## 目录

- 一、Paseo 是什么（研究结论）
  - 1.1 一句话定位
  - 1.2 架构总览：daemon / CLI / providers / 数据模型
  - 1.3 daemon 的 agent 编排能力（关键）
  - 1.4 CLI 编排面（我们主要使用的接口）
  - 1.5 结构化输出 `--output-schema`（schema 原语的落点）
  - 1.6 已有的编排技能与其天花板
- 二、Claude 动态工作流 → Paseo 的映射
  - 2.1 八个全局原语映射
  - 2.2 `agent()` 的 opts 映射
  - 2.3 提示词复用（Workflow prompt + subagent prompt）
  - 2.4 原理/质量姿势复用
- 三、超集架构设计（paseo-flow）
  - 3.1 核心决策：VM 跑在哪
  - 3.2 组件分解
  - 3.3 为什么这是"超集"（Claude 做不到的 9 件事）
  - 3.4 多提供商路由（杀手锏）
  - 3.5 需要新建的东西（差距清单）
- 四、落地计划
  - 4.1 分阶段路线图
  - 4.2 关键技术决策点（待验证）
  - 4.3 风险与开放问题
- 五、头脑风暴（进阶玩法）
- 附录 A：paseo CLI 编排命令速查
- 附录 B：Claude 原语 ↔ paseo 对照卡

---

## 一、Paseo 是什么（研究结论）

### 1.1 一句话定位

Paseo 是一个**自托管的 coding agent 编排器**：它在你机器上跑一个 daemon，把 Claude Code、Codex、Copilot、OpenCode、Pi 等 agent 当作**本地子进程**拉起并监管，再通过 WebSocket 把控制权暴露给手机 App、桌面 App、Web 和 **CLI**。你的代码不出本机，无遥测、无强制登录（AGPL-3.0）。

对我们的用途而言，最关键的一点：**paseo 已经内置了"一个 agent 通过工具/CLI 去创建、投喂、等待、监管其他 agent"的完整能力**——这正是 Claude 动态工作流里 `agent()` 原语所需要的后端。

### 1.2 架构总览

```
手机App(Expo)   CLI(Commander)   桌面App(Electron)
      \              |                /
       \        WebSocket (直连 或 经 relay E2EE)
        \            |               /
                 ┌───▼────────────┐
                 │    Daemon      │  Node.js
                 │ (packages/     │  · agent 生命周期状态机
                 │    server)     │  · WebSocket API + MCP server
                 └───┬────────────┘  · agent↔agent 工具目录
        ┌────────────┼──────────┬─────────┐
   Claude Code    Codex     Copilot/    OpenCode / Pi …
   (Agent SDK)  (app-server) Cursor(ACP)   （30+ via 目录/ACP）
```

- **daemon（`packages/server`）**：核心。拉起/监管 agent 进程、维护时间线（timeline）、提供 agent-to-agent 工具目录（`create_agent`、`send_agent_prompt`、`create_worktree`、`list_agents`…，MCP 只是其中一种适配器）、可选 relay 远程、可选自托管 Web UI。子模块还有 `schedule/`（cron 定时 agent）、`loop-service.ts`（循环重试直到退出条件）、`chat/`（agent 间消息）。
- **CLI（`packages/cli`）**：Commander.js，Docker 风格命令。与 App 走**同一条 WebSocket 协议**，是 daemon API 的薄封装——App 能做的 CLI 都能做。
- **providers**：每个 provider 实现 `AgentClient` 接口。Claude 走 Anthropic Agent SDK，Codex 走 `codex-app-server`，Copilot/Cursor/通用走 ACP，OpenCode/Pi 各自适配。各自管自己的鉴权（paseo 不碰 API key）。
- **数据模型**：文件型 JSON，全在 `$PASEO_HOME`（默认 `~/.paseo`）。agent 记录按 `cwd` 分目录存，所有权挂在 `workspaceId` 上；时间线与 agent 记录同文件。无数据库，Zod 校验，原子写。

### 1.3 daemon 的 agent 编排能力（关键）

这是整个方案的地基。daemon 暴露的**工具目录**（agent 可通过 MCP 或原生工具调用，CLI 走同一能力）：

| 工具                                                      | 作用                                                                                                                                | 对工作流的意义                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `create_agent`                                            | 创建并启动一个 agent。必填 `relationship`/`workspace`/`title`/`provider`/`initialPrompt`；可选 `notifyOnFinish`/`settings`/`labels` | 就是 `agent()` 的"创建"半边          |
| `send_agent_prompt`                                       | 给已有 agent 发后续 prompt，可同步（`background:false`）或异步                                                                      | 多轮追问、verifier 复核              |
| `list_agents` / `get_agent_status`                        | 按 cwd/status/时间过滤                                                                                                              | 状态汇总（但官方建议别轮询，靠通知） |
| `archive_agent` / `update_agent`                          | 归档 / 改运行时设置（model/mode/thinking/features）                                                                                 | 清理、动态调参                       |
| `create_worktree` / `list_worktrees` / `archive_worktree` | git worktree 生命周期                                                                                                               | `isolation:'worktree'` 的落点        |
| `create_schedule` / `create_heartbeat`                    | cron 定时起新 agent / 定时给自己发 prompt                                                                                           | 定时工作流、隔夜跑                   |
| `list_providers` / `list_models` / `inspect_provider`     | 提供商与模型发现                                                                                                                    | 多提供商路由的依据                   |

两个极其重要的机制：

1. **`relationship: subagent` + `paseo.parent-agent-id` 标签**：用 `create_agent` 以 subagent 关系创建子 agent 时，daemon 自动打上父 agent id 标签。父 agent 被归档时**级联归档所有子 agent**——这就是 Claude workflow 里"subagent 生命周期属于主任务"的语义，paseo 原生就有。
2. **`notifyOnFinish` 回调**：agent 创建/后台 prompt 默认 `notifyOnFinish=true`，子 agent 完成/报错/需要权限时会**主动通知**父 agent。官方明确"**别轮询 `list_agents`，等通知**"。这是一个基于回调的完成原语——比 Claude workflow 的"阻塞等 `agent()` 返回"更适合大规模并发。

**agent 生命周期**：`initializing → idle ⇄ running → error → closed`。每个 agent 是一个 OS 进程（不是 Claude 那种进程内 subagent），所以**并发上限是机器/速率限制，不是 `min(16, cores-2)`**——这是超集的第一块基石。

### 1.4 CLI 编排面（我们主要使用的接口）

CLI 是为"被 agent/脚本调用"而设计的，有完整的 `--json` / `-q` / `--format yaml` 输出和退出码。核心编排命令：

```bash
# 起 agent（默认阻塞等完成；--detach 后台）
paseo run --provider codex/gpt-5.4 --model M --thinking high \
          --mode full-access --worktree feat/x --cwd . \
          --label phase=verify --env K=V \
          --output-schema '<json-schema>' "<prompt>"

paseo run --detach --title finder-1 "<prompt>"   # 后台，返回 agentId
paseo send <id> "<follow-up>"                    # 追问（--no-wait 异步）
paseo wait <id> [--timeout 60]                   # 阻塞等完成
paseo logs <id> [--tail N --filter tools --json] # 时间线/最终文本
paseo ls [-a -g --json -q]                       # 列出
paseo stop <id>                                  # 停止
paseo agent archive <id> | agent mode <id> plan  # 归档/切模式
paseo loop run … | paseo schedule create …       # 循环/定时
paseo --host workstation:6767 …                  # 远程 daemon / relay
```

`paseo run` 的返回（`AgentRunResult`）：`{ agentId, status, provider, cwd, title }`。注意——**阻塞式 `run` 默认只回元数据，不回最终文本**；要拿最终文本走 `paseo logs` 或下面的 `--output-schema`。

### 1.5 结构化输出 `--output-schema`（schema 原语的落点）

这是整个映射里**最漂亮的一块**。`paseo run --output-schema <schema>` 会：

- 阻塞运行 agent；
- 取最后一条 assistant 消息，按 JSON schema 校验，**不匹配自动重试（maxRetries:2）**；
- 把校验后的 JSON 直接打印到 stdout，退出码区分成功/失败。

也就是说，Claude workflow 里 `opts.schema`（依赖一个 `StructuredOutput` 工具 + 专门的 D0y/L0y 提示词让 subagent 调工具）在 paseo 里**一行 CLI 就解决了**，而且校验+重试是 paseo 代劳的。这让我们的引擎实现大幅简化：

- **结构化 agent** → 直接把 workflow 的 schema 传给 `--output-schema`。
- **纯文本 agent**（Claude 里是 I0y "原样返回文本"）→ 包一层 `{"type":"object","properties":{"result":{"type":"string"}},"required":["result"]}`，同样走 `--output-schema`，拿到干净 JSON。

### 1.6 已有的编排技能与其天花板

paseo 自带一套"编排技能"（教 agent 用 paseo CLI 去管别的 agent）：`/paseo`（参考）、`/paseo-handoff`（交接）、`/paseo-loop`（worker/verifier 循环）、`/paseo-advisor`（单顾问）、`/paseo-committee`（双 agent 根因+计划）、以及更新的 `/paseo-epic`、`/paseo-orchestrator`。

它们证明了"用 paseo 编排多 agent"完全可行，但有一个**共同天花板**：**编排逻辑写在一个 lead agent 的提示词里，由 LLM 现场解释执行**。控制流（循环、条件、去重、预算、扇出）活在 LLM 的脑子里，不是确定性的——LLM 可能偷工减料、漏掉某个 verifier、提前收工。这正是 Claude 动态工作流要解决、而 paseo 技能没解决的问题。

> **我们的超集 = 把"确定性编排"从 LLM 脑子里搬进一个真正的 runner，把 paseo 降级成纯粹的 agent 调度后端。** 这是两者能力的交集，也是各自都缺的另一半。

---

## 二、Claude 动态工作流 → Paseo 的映射

Claude 动态工作流（2.1.207，见我们的 `workflow-full-report`）的本质：一个**确定性 JS VM**，在沙箱里提供 8 个全局原语，脚本是纯 JavaScript，通过 `export const meta` 声明元数据。`agent()` 是阻塞原语，后端是 Claude Code 进程内的 subagent VM。

把后端换成 paseo，其余全部保留——这就是超集的全部秘密。

### 2.1 八个全局原语映射

| Claude 原语                  | 语义                                                   | paseo 实现                                                                                                         | 难度                |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `agent(prompt, opts)`        | 拉起 subagent，阻塞，返回最终文本/结构化值             | `paseo run [flags] --output-schema <S> "<prompt>"` 阻塞 → JSON；或 `--detach` + `paseo wait` + `paseo logs` 取文本 | 低（CLI 一行）      |
| `parallel(fns)`              | N 个 agent 调用并发，全部完成才返回                    | runner 内 `Promise.all`，每个 fn 一次 paseo run（真 OS 进程并发）                                                  | 低                  |
| `pipeline(items, ...stages)` | 按 stage 映射，控制并发，stage 间是 barrier            | runner 循环：每个 stage 对 items 做有界并发 map                                                                    | 低                  |
| `phase(name)`                | 进度分组/标记                                          | runner 日志 + 给该阶段 agent 打 `--label phase=<name>`                                                             | 低                  |
| `log(msg)`                   | 进度日志                                               | runner stdout + 写入 journal                                                                                       | 低                  |
| `budget`                     | token 预算 + 到顶硬停（`WorkflowBudgetExceededError`） | runner 侧记账（agent 数 / 估算 token），到顶抛错                                                                   | 中（见 3.5 差距#3） |
| `args`                       | 脚本输入值                                             | runner 从 CLI `--args <json>` 注入全局 `args`                                                                      | 低                  |
| `meta`                       | name/description/whenToUse/phases                      | runner 解析 `export const meta` 做注册表 + phase 计划                                                              | 低                  |

结论：**8 个原语里 7 个是"低"难度**，只有 `budget` 因为 paseo 不直接暴露 token 用量需要额外处理。原语层面 paseo 完全够用。

### 2.2 `agent()` 的 opts 映射

Claude 2.1.207 的 `agent()` opts：`label / phase / schema / model / effort / isolation / agentType`。
Paseo 超集另加 `provider` / `mode` / `fast` / `featureValues`（已贯通 `PaseoHostBackend` +
`paseo run` + `paseo workflow run` + UI dispatch；见 `docs/workflow.md`）。

| opts                             | Claude 行为                   | paseo 落点                                               |
| -------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `label`                          | UI 标签                       | `--title` / `--label`                                    |
| `phase`                          | 阶段归组                      | `--label phase=<x>` + runner 分组                        |
| `schema`                         | StructuredOutput 工具 + 校验  | 引擎侧 JSON Schema 校验+重试（非 CLI `--output-schema`） |
| `model`                          | 选模型                        | `--model`（+ `--provider` 可跨家）                       |
| `effort`                         | low/med/high/xhigh/max        | `--thinking <id>` / createAgent `thinking`               |
| `mode`（超集）                   | —                             | `--mode` / createAgent `mode`                            |
| `fast` / `featureValues`（超集） | —                             | `--feature fast_mode=true` / createAgent `features`      |
| `isolation:'worktree'`           | worktree 隔离                 | `--worktree <slug>`                                      |
| `agentType`                      | 自定义人格（子 agent prompt） | 把人格文本拼进 prompt 前缀                               |
| **`provider`（新增）**           | —（Claude 只有 Claude）       | **`--provider`** ← 超集核心                              |

### 2.3 提示词复用

我们已提取的提示词几乎全部可直接复用，只是"注入方式"从"Claude 内部 system prompt"变成"拼进 paseo agent 的 prompt/系统提示"：

| 提示词（2.1.207 变量名）                            | 原用途                      | 在 paseo-flow 中的角色                                                                                     |
| --------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `G0s`（Workflow 工具完整 prompt，19k 字符）         | 教 LLM 何时/如何写 workflow | 拆成两半：①"原理/质量姿势"部分 → 引擎的**模式库文档 + 编排器技能提示**；②"opt-in/ultracode"部分 → 触发配置 |
| `I0y`（subagent 默认：原样返回文本）                | 文本 agent system prompt    | 文本 agent 的 prompt 前缀（或仅靠 `--output-schema {result}` 兜底）                                        |
| `D0y` / `L0y`（带 schema：必须调 StructuredOutput） | 结构化 agent system prompt  | **被 `--output-schema` 取代**，无需 StructuredOutput 工具                                                  |
| `R0y`（自定义 agentType 注记）                      | 自定义人格 agent 追加       | 拼进对应 agent 的 prompt                                                                                   |
| `k0y`（1000 agent 上限错误）                        | 运行时错误                  | runner 的 agent 上限错误文案                                                                               |
| `wAd`（token 预算超限错误）                         | 运行时错误                  | runner 的预算错误文案                                                                                      |
| `S0y`/`v0y`（禁用 Date.now/Math.random）            | 确定性约束                  | runner 沙箱的同名单禁用错误（strict 模式）                                                                 |

### 2.4 原理 / 质量姿势复用

G0s 里最值钱的不是语法，是**编排方法论**。这些在 paseo-flow 里原样成立，甚至因为多提供商而更强：

- **DEFAULT TO pipeline()**、barrier 正确用法（dedup 必须在 barrier 之后）→ runner 的 pipeline 语义保证。
- **loop-until-count / loop-until-budget / loop-until-dry** → runner 原生支持（真循环，不依赖 LLM 自觉）。
- **对抗验证三态（CONFIRMED/PLAUSIBLE/REFUTED）、recall 偏向、pigeonhole 早退、judge panel、self-respawning finder pool** → 这些是脚本级逻辑，10 个脚本里都有，直接跑。
- **Perspective-diverse verify（给每个 verifier 不同 lens）** → 升级为 **跨提供商 diverse verify**：finder 用 claude/opus，verifier 用 codex/gpt-5.4，天然不同"视角"。paseo-loop 技能 already 主张"worker 和 verifier 用不同 provider 互相抓盲点"——我们把它变成一等公民。
- **dedup vs `seen` 而非 `confirmed`**（否则永不收敛）→ 脚本逻辑，保留。
- **规模治理（small/medium/large = 5/15/50 agents 软上限）** → runner 的 `--max-agents` / budget 配置。

---

## 三、超集架构设计（paseo-flow）

工作名 **paseo-flow**：一个确定性 workflow 引擎，加载 Claude 风格的工作流脚本（`export const meta` + 8 个全局原语），把每个 `agent()` 翻译成对 paseo 的调度。

### 3.1 核心决策：VM 跑在哪

有两条路，必须先想清楚：

**方案 A — 编排器 agent 解释执行（paseo 现有技能的路子）**
把工作流脚本喂给一个 lead agent，让它读脚本、现场发 paseo CLI 命令。
❌ 非确定性：控制流在 LLM 脑子里，循环/去重/预算/扇出全靠它自觉。这正是要避免的。
✅ 零基础设施，适合即兴、一次性的小编排。
→ 保留为补充形态（一个 `/paseo-flow` 技能），但**不作为主力**。

**方案 B — 外部确定性 runner（推荐，真正的超集）**
一个独立 Node.js 进程当 VM：解析脚本、提供 8 个全局、用真实 JS 跑控制流，`agent()` 时调 paseo。
✅ 确定性、可恢复、可预算、可审计——和 Claude 的 Workflow 工具同构。
✅ 把 paseo 降级为纯调度后端，正是两者能力的交集。
→ **主力方案。**

```
┌──────────────────────────────────────────────────────────────┐
│  paseo-flow runner (Node.js, 确定性 VM)                       │
│                                                              │
│  加载 workflow 脚本 → 沙箱执行，提供 8 全局:                   │
│  agent/parallel/pipeline/phase/log/budget/args/meta          │
│                                                              │
│  agent(prompt,opts) ──┐                                      │
│  并发限制器 / 上限 / 预算记账 / journal(resume)               │
└───────────────────────┼──────────────────────────────────────┘
                        │  PaseoBackend 接口（可插拔）
            ┌───────────┴────────────┐
     CliBackend                DaemonClientBackend（优化项）
     shell `paseo run …`       @getpaseo/client WebSocket
            └───────────┬────────────┘
                        ▼
                  paseo daemon ──► Claude / Codex / Copilot / OpenCode / Pi
                        │
                  手机/桌面/Web 实时监控 + 权限审批 + 中途介入
```

### 3.2 组件分解

1. **DSL 沙箱**：用 Node `vm` 模块（或 `Function` 构造）执行脚本，注入 8 个全局。strict 模式下禁用 `Date.now`/`Math.random`（抛 `S0y`/`v0y`），保证 resume 确定性。
2. **`PaseoBackend` 接口**：`spawn(spec)→handle`、`wait(handle)→result`、`result(handle)→text|json`、`stop(handle)`。两个实现：
   - `CliBackend`（首选，贴合"用 paseo cli"）：每条 `agent()` shell 一次 `paseo run --output-schema …`。简单、可观测、天然支持 `--host` 远程。
   - `DaemonClientBackend`（性能优化）：用 `@getpaseo/client` 直连 WebSocket，省掉每次 spawn 的进程开销，还能用 `notifyOnFinish` 回调替代轮询。
3. **并发限制器 + 上限**：p-limit 风格。默认并发可配（建议起点 `min(32, cores*2)`，已高于 Claude 的 16）；保留 1000 agent 终身上限、4096 单次扇出上限（`k0y`）。
4. **预算记账器**：`budget` 全局。累计 agent 数 + 估算 token（若 provider 在时间线里吐 usage 就用真值），到顶抛 `WorkflowBudgetExceededError`（`wAd`），在途 agent 跑完保留结果。
5. **journal / resume**：`journal.jsonl` 记录每个完成的 `agent()`（key = hash(prompt,opts)）。resume 时未变前缀直接命中缓存。因为 daemon 拥有 agent，runner 崩了也能从 journal + `paseo ls` 重建状态。
6. **注册表**：内置 10 个脚本（我们已归档的 `workflows-2.1.150/` + `workflows-2.1.207/`）+ `~/.paseo-flow/workflows/` + 项目 `./workflows/`。按 `meta.name` 解析。
7. **CLI 入口**：`paseo-flow run <name|path> [--args JSON] [--provider-map role=prov] [--resume runId] [--max-agents N] [--dry-run]`。
8. **（可选）编排器技能 `/paseo-flow`**：让 lead agent 也能用自然语言触发已注册的工作流（方案 A 作为入口，方案 B 作为执行）。

### 3.3 为什么这是"超集"（Claude 做不到的 9 件事）

1. **多提供商**：每个 agent/phase 可指定 Claude/Codex/Copilot/OpenCode/Pi。对抗验证天然跨模型。
2. **真并发**：OS 进程级并行，突破 `min(16, cores-2)`；上限只受机器与速率限制。
3. **跨设备监控**：手机上看 bughunt 实况、在手机上批权限、中途给某个 agent 发指令。
4. **远程/分布式**：`--host` 或 relay，把大工作流扔到一台高配 dev box 上跑。
5. **持久化与解耦**：daemon 拥有 agent，工作流与编排器上下文解耦——编排器（甚至 runner）重启后可 resume；隔夜跑不怕会话丢失。
6. **worktree 隔离**：每个 agent 一个 git worktree，并行改代码不打架（Claude 的 `isolation:'worktree'` 在 paseo 是一等能力）。
7. **定时 + 循环内建**：`paseo schedule`（cron）、`paseo loop`（worker/verifier）与工作流组合，实现"每天凌晨跑一次 deep-research"。
8. **人在环中**：通过 App 审批权限、给运行中的 agent 转向——比纯自动更可控。
9. **成本优化**：finder 用便宜的 haiku，judge 用 opus；按角色选性价比最高的模型。

### 3.4 多提供商路由（杀手锏）

- 扩展 `agent()` opts 增加 `provider`；读 `~/.paseo/orchestration-preferences.json`（paseo 已有的 `impl/ui/research/planning/audit` → provider 映射）做角色默认值。
- 工作流脚本可以按角色硬编码 provider，例如 code-review 的 finder 用 `claude/opus`、verifier 用 `codex/gpt-5.4`——直接落地"Perspective-diverse verify + 跨模型抓盲点"。
- 提供 `--provider-map finder=claude/opus verifier=codex/gpt-5.4 judge=claude/opus` 覆盖脚本默认。
- 新内建变体：`code-review-xprov`（finders 与 verifiers 强制不同 provider）、`deep-research-xprov`。

### 3.5 需要新建的东西（差距清单，诚实版）

| #   | 差距                      | 说明 / 对策                                                                                                                                           |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **runner 本体**           | 最大的一块。沙箱 + 8 全局 + backend。                                                                                                                 |
| 2   | **取最终文本**            | `paseo run` 阻塞默认只回元数据。对策：统一走 `--output-schema`（文本包 `{result:string}`），或 `paseo logs --tail`。**需在真机验证确切行为。**        |
| 3   | **token 预算**            | paseo 不直接暴露每 agent token 用量。对策：先用 agent 计数近似；若 provider 时间线含 usage 则解析真值。`WorkflowBudgetExceededError` 用我们自己的账。 |
| 4   | **确定性**                | 决定 strict（禁 Date.now/Math.random，保 resume）vs fast（放开）。默认 strict。                                                                       |
| 5   | **错误语义映射**          | paseo 的 `error`/`closed` 状态 → Claude 的"agent() 返回 null"语义。                                                                                   |
| 6   | **速率限制/成本**         | 50 个 Claude agent 并发会撞 Anthropic 限流。对策：合理默认并发 + 指数退避 + 按 provider 分别限速。                                                    |
| 7   | **StructuredOutput 工具** | Claude 的 D0y 依赖该工具；paseo 用 `--output-schema` 替代 → 翻译层。                                                                                  |

---

## 四、落地计划

### 4.1 分阶段路线图

**P0 — 概念验证（1 天）**
目标：证明"paseo CLI 能当 `agent()` 后端"。

- 装 paseo（`npm i -g @getpaseo/cli`，配好至少一个 provider，如已装的 claude-code 2.1.207）。
- 起一个 daemon，手写最小 runner：硬编码跑 `deep-research` 的 Scope 阶段（单 agent，`--output-schema`），拿到结构化结果。
- 验证：结构化输出回 stdout 的确切格式、退出码、并发两个 agent 的行为。**（对应差距#2，必须先做）**

**P1 — DSL 沙箱 + 8 全局（2–3 天）**

- 实现沙箱与 8 全局，`CliBackend`。
- 把 10 个脚本**原样**跑通（先单 provider）。里程碑：`paseo-flow run bughunt-lite` 端到端出报告。

**P2 — 并发/上限/预算/journal（2–3 天）**

- 并发限制器、1000/4096 上限（`k0y`）、budget 记账（`wAd`）、journal + `--resume`。里程碑：能跑 `bughunt`（self-respawning + dry-streak + 5-vote），可中途 Ctrl+C 再 resume。

**P3 — 多提供商路由（1–2 天）**

- `opts.provider`、读 orchestration-preferences、`--provider-map`。里程碑：`code-review-xprov`（finder=claude/opus、verifier=codex）跑通。

**P4 — Daemon-API 后端 + 可观测（2–3 天，优化）**

- `DaemonClientBackend`（`@getpaseo/client`），`notifyOnFinish` 回调替代轮询；phase 标签打进 paseo，App 的 subagents track 里能看到整棵树。里程碑：手机上实时看工作流展开。

**P5 — 产品化（持续）**

- `/paseo-flow` 编排器技能、注册表 UX、schedule/loop 集成、打包分发（npm bin + 可选打成 paseo provider/插件）。

### 4.2 关键技术决策点（需先在真机拍板）

1. **取结果方式**：`--output-schema` 统一（推荐）vs `logs --tail`。→ P0 验证。
2. **backend 默认**：CLI（简单/远程友好）vs daemon WS（快/回调）。→ 先 CLI，P4 加 WS。
3. **确定性档位**：strict 默认是否可接受。→ 看 resume 需求强度。
4. **预算口径**：agent 计数 vs 真 token。→ 取决于 provider 是否吐 usage。
5. **并发默认**：起始 `min(32, cores*2)`，按 provider 限流微调。→ 实测限流阈值。

### 4.3 风险与开放问题

- **速率限制/成本**：大规模并发直撞各 provider 限流与账单。→ 限流器 + 预算护栏是 P2 必须，不是可选项。
- **paseo 成熟度**：v0.1.x，单人维护，CLI 个别边界（如 `--output-schema` 与 `--detach` 互斥）需绕开（我们已经知道：结构化就走阻塞、文本才考虑 detach）。
- **工作流脚本里的 Claude 假设**：10 个脚本大多只用 8 全局（可移植），但开 PR 类（autopilot/bugfix/dashboard/docs）假设 agent 有 `gh`/写权限——paseo agent 全工具访问，OK，但要注意权限审批会打断无人值守跑。→ 可用 `--mode full-access` 或预先 permit。
- **resume 语义差异**：Claude 的 resume 是"同会话内未变前缀命中缓存"；paseo-flow 是"journal + daemon agent 列表"。语义略不同，文档里要讲清。
- **安全**：给 agent `full-access` + 大规模自动扇出 = 高风险。→ 默认保守 mode，危险操作走 App 审批。

---

## 五、头脑风暴（进阶玩法）

1. **工作流即 agent**：把 runner 本身包成一个 paseo agent。手机上发起一个 bughunt，它在 daemon 里展开成一支 fleet，你坐地铁都能看它打怪、批权限。
2. **跨提供商对抗验证一等公民**：`verify({ claim, refuters:['claude/opus','codex/gpt-5.4'], quorum:2 })` 作为新原语，脚本可直接调用。
3. **成本路由器**：按角色自动选"够用且最便宜"的模型（haiku 找、sonnet 验、opus 判）。
4. **录制/回放做 A/B**：journal 全记录，同一份工作流换 provider 重放，横向对比模型质量与成本。
5. **工作流市场**：像 paseo skills 一样分享脚本；我们的 10 个就是首批"官方剧本"。
6. **与 paseo-epic 合体**：epic 是多小时、带人工 gate 的大流程；paseo-flow 当它每个阶段的确定性执行引擎。
7. **用 paseo chat 做 agent 间对话**：某些阶段需要 agent 互相讨论而非只返回值（如 committee 的多轮共识），用 chat 房间承载。
8. **"ultracode" 触发**：复刻 Claude 的关键字触发——在编排器技能里识别"ultracode"/"通宵跑"等口令，自动切到 paseo-flow 大规模模式。
9. **失败自愈循环**：工作流外层套 `paseo loop`，验收标准不过就自动重跑失败阶段。
10. **多机 fleet**：`--host` 指向多台 daemon，runner 按 provider/负载把工作流的不同 agent 分发到不同机器。

---

## 附录 A：paseo CLI 编排命令速查

| 需求                     | 命令                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| 起 agent（阻塞，结构化） | `paseo run --provider P --output-schema '<schema>' "<prompt>"`     |
| 起 agent（后台）         | `paseo run --detach --title T "<prompt>"` → agentId                |
| 追问                     | `paseo send <id> "<msg>"`（`--no-wait` 异步）                      |
| 等完成                   | `paseo wait <id> [--timeout 60]`                                   |
| 取时间线/文本            | `paseo logs <id> --tail N --json`                                  |
| 列出                     | `paseo ls -a -g --json`                                            |
| 停止/归档                | `paseo stop <id>` / `paseo agent archive <id>`                     |
| 切模式                   | `paseo agent mode <id> full-access`                                |
| worktree                 | `paseo run --worktree <slug> …` / `paseo worktree ls`              |
| 循环/定时                | `paseo loop run …` / `paseo schedule create --cron … "<prompt>"`   |
| 提供商/模型发现          | `paseo provider ls` / `paseo provider models <p>`                  |
| 远程                     | `paseo --host host:6767 …` 或 `--host '<offer-url>'`（relay E2EE） |
| 输出格式                 | `--json` / `--format yaml` / `-q`                                  |

## 附录 B：Claude 原语 ↔ paseo 对照卡

| Claude (2.1.207)                         | paseo                                                        |
| ---------------------------------------- | ------------------------------------------------------------ |
| `agent(prompt, {schema})`                | `paseo run --output-schema <schema> "<prompt>"`              |
| `agent(prompt, {model, effort})`         | `paseo run --model M --thinking E "<prompt>"`                |
| `agent(prompt, {mode, fast})`（超集）    | `paseo run --mode M --feature fast_mode=true "<prompt>"`     |
| `agent(prompt, {isolation:'worktree'})`  | `paseo run --worktree <slug> "<prompt>"`                     |
| `agent(prompt, {provider})`（新增）      | `paseo run --provider P "<prompt>"`                          |
| workflow dispatch defaults               | `paseo workflow run … --thinking/--mode/--fast` → `args`     |
| `parallel(fns)`                          | `Promise.all` × N 次 `paseo run`（或 detach+wait）           |
| `pipeline(items, …stages)`               | runner 有界并发 map                                          |
| `phase(name)`                            | runner 日志 + `--label phase=name`                           |
| `budget` / `WorkflowBudgetExceededError` | runner 预算记账 + 抛错（`wAd`）                              |
| 1000 agent 上限（`k0y`）                 | runner 上限                                                  |
| `min(16, cores-2)` 并发上限              | runner 可配并发（可 >16）                                    |
| subagent 生命周期/级联                   | `relationship:subagent` + `paseo.parent-agent-id` + 级联归档 |
| `StructuredOutput` 工具                  | `--output-schema`（原生校验+重试）                           |
| resume（runId + 前缀缓存）               | journal.jsonl + `--resume`                                   |
| `ultracode` 触发                         | 编排器技能口令 → paseo-flow                                  |

---

_研究对象 getpaseo/paseo v0.1.107；Claude 动态工作流基线 2.1.207（见 workflow-full-report_2.1.207.md）。本文为规划文档，落地前请先完成 P0 真机验证。_

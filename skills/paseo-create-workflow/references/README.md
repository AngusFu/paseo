# Kimi 交付物 — agents-workflow 参考材料（裁剪后）

来源：Kimi Agent 对话（研究 Claude Code Workflow + paseo 超集）。当年存这当 flow2 的参考零件，**不是**直接依赖。

## 结局（2026-07-15 收尾）

方向早已拍板 + 落地：**采纳 flowkit 引擎**——它就是今天 `.claude/tools/agents-workflow/src/` 里的 agents-workflow（8 全局 + interface-first `AgentBackend` + 引擎侧 journal + budget + 并发 + `node:vm` 真沙箱 + `validator.ts` 静态 belt）。当年评估里说要补的「两层 artifact 闸 + FlowPolicy 排序闸」**建了、又在 2026-07-14 退休了**——agents-workflow 现在对 vanilla Claude Workflow **零新增**，纯忠实超集，安全层只剩 flow 内 à-la-carte verifier + 静态 validator（决策见 `.claude/tools/agents-workflow/PLAN.md` #10/#11 + `.claude/tools/agents-workflow/docs/paseo-workflow-tech-proposal.md` 归档注记）。

**已删（2026-07-15，用途已尽，git 历史留档）**：

- `flowkit/` —— 引擎源；已并成 `.claude/tools/agents-workflow/src/`，留副本无意义。
- `workflows-2.1.207/` + `workflows-2.1.150/` —— 11 内置的重建源；模式参考（pipeline/judge-panel/loop-until-dry）已内化进 `.claude/tools/agents-workflow/workflows/builtin/*.flow.js`。
- `cli-analyzer-skill/` —— 已成宿主技能 `.claude/skills/claude-code-cli-analyzer`。

## 留下的文件

| 路径                              | 是什么                                                                        | 为何留                                                           |
| --------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `workflow-full-report_2.1.207.md` | Claude Code **2.1.207** Workflow 工具逆向（prompt/schema/原语/10+1 内置全源） | **权威原语契约** —— `agents-workflow-authoring` 技能 STEP 0 引它 |
| `workflow-full-report_2.1.150.md` | 同上 2.1.150 版                                                               | 版本 diff 参考（较旧）                                           |
| `G0s.final.txt`                   | Workflow 工具完整 prompt（19k 字符，2.1.207）                                 | 编排方法论原文 —— 授权技能 STEP 0 引它                           |
| `paseo-superset-plan.md`          | Kimi 的规划文档（paseo 映射 + interface-first 修订 + 路线图）                 | 设计记录                                                         |

> 注：两份 `workflow-full-report_*.md` 里对 `workflows-2.1.{150,207}/*.ts` 的路径引用是**历史引文**（那些源目录已删），非活链接；已登记进 refcheck-ignore。

## 历史评估存档（flowkit vs 当年 flow2 —— 已落地，仅留记录）

当年对 flowkit 的四条批评都采纳了：schema 用 zod（一源三用，非手写校验器）；`p-limit` 用社区库不自造；沙箱用 `node:vm` 真隔离（flowkit 的 `new AsyncFunction` 跑全局作用域、能碰 `process`/`require`，只 shadow Date/Math = 确定性非隔离，是读 engine.ts 实证的真洞）；导出模板体的转义修复归进了 cli-analyzer 抽取脚本。

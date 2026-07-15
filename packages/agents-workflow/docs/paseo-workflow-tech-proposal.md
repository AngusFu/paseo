# 技术方案 — 自驱 TS workflow + paseo（弃 mission-pilot）

> **归档注记(2026-07-13 收官)**:本文 = 动工前的原始技术方案(设计记录)。as-built 记录 + 决策记录见 `../PLAN.md`。保留此文当设计源。
>
> ⚠️ **as-built 反转两处(见 `../PLAN.md` 决策 #10/#11)—— 下文相关章节是动工前设计,非现态**:
>
> 1. **结构化输出**:引擎自持 —— paseo 跑 `paseo run --json`,**不**传 `--output-schema`(persona 注 JSON schema + 引擎侧校验/重试)。§0/§2/§4 的 `--output-schema` 论点已不成立。
> 2. **两层闸**(尤其 layer② artifact gate,伪码 `throw new Blocked(...)`)+ FlowPolicy 排序闸**全退休**:`gate.ts`/`policy.ts`/`BlockedError`/`SkippedError` 已删,`errors.ts` 只剩 `WorkflowError`。安全层现只剩 flow 内 à-la-carte verifier + `validator.ts` 静态 belt。

日期 2026-07-13。状态 = 技术方案,未动码。v2(拍板后重写)。
关联:plan `2026-07-09-claude-refactor-tech-design.md` §1.3/§1.4(skippable + 引擎天花板)。

---

## 0. 一句话结论

**弃 mission-pilot。一个 TS driver 程序 = 引擎本身**,`paseo run --output-schema` 当 agent-exec 原语。
控制流/状态/闸全在 **TS 代码**里 —— 比 mission-pilot 静态 DAG 更强(真代码分支)。
**白捡**:conditional skip = 脚本一个 `if`,plan §1.4 引擎天花板**消失**;§1.3 pre-code 盲判**治好**(tier 在 RCA 看完代码后现判)。
**hooks**:这个 workflow **不需要任何 Claude Code hook**(详见 §6)。

---

## 1. 架构 —— Level C-pure

```
TS driver（引擎）
  ├── 相序 + conditional skip（if / 三元）
  ├── checkpoint / resume（steps/*.json）
  ├── 闸（人工 approval / autopilot 投票）
  ├── 副作用纪律（先 checkpoint 后执行 + egress secret-scan）
  └── retry cap（driver 计数）
        │
        ▼  唯一 shell 触点: spawn('paseo', ...)
  paseo run --output-schema  →  agent-exec 原语
        ├── --provider claude|codex|...   每相挑模型
        ├── --worktree                    隔离 git 环境
        └── 返回验证过的 JSON             schema-out
```

对比历史选项:

- ~~A(paseo 当 mission-pilot 底座)~~ —— §1.4 天花板还在,否。
- ~~B(paseo committee/loop skills 当顶层,model-driven)~~ —— 丢确定性,否。
- **C-pure(本方案)** —— TS 脚本编排,确定性最强,SACRED 完美符合。

---

## 2. 相产物契约 —— schema 信封 + 两层闸

每相 output = 一个 schema,含**公共信封** + 相特有字段:

```ts
// 公共信封（每相都有）
{ phase: string,
  status: "done" | "skipped" | "blocked",
  artifact: string,            // 固定路径, e.g. "outputs/rca.md"
  ...phaseSpecificFields }
```

**完成闸 = 两层都过**(替 mission-pilot 的 output_files 闸,更强):

1. **schema 层** —— `paseo run --output-schema` 已验证 JSON;driver 再用 zod 复校(白拿 TS 类型 + 防 paseo 侧漏)。
2. **产物层** —— driver `fs.existsSync(json.artifact)` **且非空**。缺/空 → 判 `blocked` → 重派或升级。

产物写**固定路径**(`<RT>/<KEY>/outputs/<phase>.md`)—— 幂等 + 中断重跑不歧义。

### 相 schema 目录(示例)

```
triage → { …信封, tier: enum[trivial,standard,complex], rationale }
rca    → { …信封, attribution: enum[fe,be_only,mixed_bandaid,mixed_cofix],
           root_cause, evidence[], fix_directions[], fix_plan? }
plan   → { …信封, files:[{path,change,why}], contract_touchpoints[], risks[], out_of_scope[] }
diff-review → { …信封, verdict: enum[PASS,FAIL_IMPL,FAIL_PLAN], blockers[], nits[] }
str    → { …信封, criteria:[{n, statement, verdict:enum[pass,fail,unverified], evidence}] }
```

---

## 3. conditional skip —— 脚本 `if`,天花板消失

**现在(mission-pilot)**:静态 DAG 快照 + 相 `allow_skip:true` + prompt 读 `meta.triage` 调 `flow-state.sh skip`;中途发现 trivial 换不了更瘦 config（§1.4 引擎债）。前几轮为此打了一堆补丁(plan.md:3 硬化 inline-plan 前提、报告漂移、autopilot carve-out)。

**C-pure**:控制流是真代码 —— skip 就是 `if`/三元。

```ts
const triage = await step("triage", TriageSchema, promptTriage());
const rca = await step("rca", RcaSchema, promptRca(triage));
if (rca.attribution !== "fe") return reportOnlyExit(rca); // be_only 退出 = return

const plan =
  triage.tier === "trivial"
    ? rca.fix_plan // trivial: RCA 内联 plan
    : await step("plan", PlanSchema, promptPlan(rca)); // skip = 三元, 无 allow_skip
if (triage.tier === "complex") await planReview(plan);
```

- **skip 决策时机对了**(§1.3 老病):tier 在 RCA 看完代码后现判,不是 TRIAGE pre-code 盲判 —— 脚本可在任意点分支。
- **中途自适应瘦身**(§1.4 defer 的引擎功能):**免费**。
- 前几轮为 skip 打的补丁(inline-plan 前提、meta 双写、carve-out)**大半不再需要** —— 数据在脚本变量里,不走"prompt 写 meta → 另一 prompt 读 → 引擎跳相"那条脆弱链。

---

## 4. JS/TS 栈（shell 只剩一处）

- **zod 一源三用**:定义相 schema → ① TS 类型 ② 运行时校验 paseo 返回 ③ `zod-to-json-schema` 生成 `--output-schema` 喂 paseo。**单一真相源**。
- **`child_process.spawn('paseo', [...])`** —— 唯一碰 shell 处(调 paseo CLI)。捕获 stdout → `JSON.parse` → zod 校验 → 查产物。
- **git 副作用** 用 `spawn('git',...)` 或 `simple-git` 库,归 driver。
- **`fs`** 管 checkpoint(`steps/<phase>.json`)+ 产物。
- **无 jq、无 bash 脚本。**

### driver 骨架

```ts
const step = async <T>(
  phase: string,
  schema: ZodType<T>,
  prompt: string,
  provider = "claude",
  worktree = false,
): Promise<T> => {
  const ck = `${RT}/${KEY}/steps/${phase}.json`;
  if (fs.existsSync(ck)) return schema.parse(JSON.parse(fs.readFileSync(ck, "utf8"))); // resume
  const args = [
    "run",
    "--output-schema",
    schemaFile(phase),
    "--provider",
    provider,
    ...(worktree ? ["--worktree"] : []),
    prompt,
  ];
  const out = await run("paseo", args); // 唯一 shell 触点
  const json = schema.parse(JSON.parse(out)); // 闸① schema 层
  if (!fs.existsSync(json.artifact) || empty(json.artifact))
    throw new Blocked(phase, "artifact missing/empty"); // 闸② 产物层
  fs.writeFileSync(ck, JSON.stringify(json)); // checkpoint
  return json;
};
```

bug flow 主体 = §3 的 if 链 + setup(worktree)→implement(loop)→validate→STR→diff-review→gate→deliver。

---

## 5. 多 agent 模式（paseo 原语直接给）

| 需求                     | paseo                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| RCA 2 独立 investigator  | 2× `paseo run --detach --provider <各异>` + `wait` + driver reconcile(committee 形状)       |
| autopilot 3-voter 投票   | 3× `paseo run --detach` 不同 provider/lens + driver 数票                                    |
| IMPLEMENT dev-loop ≤3 轮 | driver `for` 循环 + `paseo run`(worker/verifier)                                            |
| STR                      | `paseo run --worktree --provider <视觉最强> --output-schema str.json`;`paseo attach` 手机看 |
| plan→implement 交棒      | `--provider` 换厂(plan=claude, implement=codex)                                             |

---

## 6. 还需要 hooks 吗 —— hook 与 workflow 是两个不重叠的世界

关键澄清:**hook 不删,flow 不触发。** hook 管的是**人开的互动 Claude Code 会话**(Stop / SessionStart / PreCompact 等);workflow 是个**自驱 JS 进程,没有 Claude 会话**,所以 hook 天然在它身上不 fire。不是"hook 消失",是"flow 跑在 hook 作用面之外"。

| Hook                                                    | 类                             | 命运                                                                                 |
| ------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| check-prose-stop（逼 AskUserQuestion）                  | 管互动会话(Stop)               | **留在项目** —— 继续管人开的 dev 会话;flow 是 JS 进程不触发                          |
| precompact-anchor / session-anchor-inject               | 管会话(compaction/resume 简报) | **留在项目** —— flow 无 context window、不 fire                                      |
| sync-base-branch / session-title / kb-telemetry         | 管会话                         | **留在项目** —— 与 flow 无关                                                         |
| guard-flow-runtime-subagent（禁 subagent 写 state）     | 防状态腐坏                     | **flow 用不上** —— worker 只写 outputs/ + 返 JSON,状态只 driver 写,架构上碰不到      |
| block-secret-echo / scan-output-leak / glab-strip-token | 安全(egress)                   | **flow 自落** —— paseo worker 也在 hook 作用面外,driver 在 egress 前自己 secret-scan |
| block-protected-branch-edit / guard-write               | 安全(git)                      | **flow 自落** —— git 只 driver 碰,代码里永不 checkout 保护分支                       |

**结论**:

- **会话/compaction/prose 的 hook：留在项目,继续管互动会话** —— 只是 flow(JS 进程)不触发它们。零删除。
- **安全不变量：flow 得 driver 自落** —— 不是因为 hook 没了,是因为 **paseo worker 也在 Claude Code hook 作用面外**(独立进程),指望不上 hook 兜。三条落成 driver 代码:**egress 前 secret-scan · git 只 driver 碰 · worker 写沙箱在 outputs/**。
- **状态腐坏:架构上消解** —— worker 无状态写权。
- 净结果:**workflow 既不需要、也不删除 Claude Code hook** —— 两个世界不重叠。paseo 的 `permit`/`agent mode` 可选给 worker 加防御纵深。

---

## 7. driver 必须自建（mission-pilot 替换清单）

弃 mission-pilot = 丢它的 harness,这些 driver 补:

- 相序 + conditional skip（if,天生有）
- **checkpoint / resume**（`steps/` 扫已完成相续跑 —— **最大自建块**）
- **中断检测**（相跑一半被杀 → 重启时该相无 `.json` → 幂等重跑;固定产物路径保证不歧义）
- **闸**：人工 approval（driver 阻塞等输入 / paseo mobile 手机批）· autopilot 投票（多 `paseo run --detach` 数票）
- **副作用纪律**：deliver 前先写 checkpoint 再执行 + egress secret-scan
- **retry cap**（driver 计数,替 max_retries）

SACRED 三条全保:状态落盘(driver 写 steps/)· 先存后执行+闸控(deliver 前 checkpoint)· 客观闸拥有副作用(driver 拥 git/glab/jira,worker 只产 outputs/)。

---

## 8. 诚实的坑

1. **input-schema 非原生** —— schema-in 靠 driver 把上游 JSON 拼进 prompt + 一道 zod 校验闸,不是 paseo 特性。别宣称"原生 schema in"。
2. **resume/interrupt 全自建** —— 丢 mission-pilot 的中断推断 + compaction-anchor + `/flow-resume`。§7 checkpoint 是最大工作量。
3. **daemon 多一个活动件** —— 挂了 flow 停,supervise `paseo daemon status`。
4. **多 provider = 多凭证/配额** —— committee/投票跨厂的价值要实测。

---

## 9. 分期

| #   | 事项                                                                                                     | 定位            |
| --- | -------------------------------------------------------------------------------------------------------- | --------------- |
| P0  | TS 脚手架:zod 相 schema + `step()` runner + 1 相(triage 或 STR)跑通 `paseo run --output-schema`,验两层闸 | 半天            |
| P1  | **bug 单模式 driver**:context→triage→rca→[if]plan→…→deliver,conditional skip 用 if                       | 核心验证        |
| P2  | committee-RCA(2 provider)+ loop-implement + STR worktree                                                 | 多 agent 模式   |
| P3  | resume/checkpoint + 中断语义（§7）                                                                       | 补 harness 短板 |
| P4  | feature/review driver + autopilot 跨-provider 投票                                                       | 铺开            |

**纪律**:先 bug 单模式跑通、量 vs 老流程(可靠性/延迟/token),数据说话再铺开。

---

## 10. 决策点

1. **driver 语言**:TS(定)。runner 库:纯 `child_process` vs execa(倾向 execa,spawn 体验好)。
2. **schema 校验**:zod(定,一源三用)。
3. **checkpoint 格式**:每相一 `steps/<phase>.json`(定)。skip 留 `<phase>.SKIPPED` sentinel 记原因。
4. **provider 组合**:committee/投票先同厂多实例还是真跨厂(Claude+Codex)—— P2 再拍。

---

## 11. 终态 —— agent 自 author 编排（paseo 版 Claude Workflow）

**目标**:不人手写死每个 mode 的 driver,而是让 **agent 按票 author 编排脚本** —— 正是 Claude Workflow 的形状(harness 给原语,模型当场 author JS,runtime 确定性跑)。搬到 paseo 上。

### 11.1 两层 —— 闸在库里,不在 agent 手里（命门）

能不能安全放手,全看这条:

- **① 原语库（人写、稳定 = SDK）**:`step()` runner、schema 信封 + 两层闸、checkpoint/resume、闸助手 `approval()` / `vote()` / `committee()` / `loop()`、paseo spawn 包装、`secretScan()`、git 副作用。**SACRED 全焊死在这层。**
- **② 编排脚本（agent author、按票）**:bug/feature/review 实际流程 = 用库原语拼,含 conditional skip。**agent 只决定"何时跑什么 + 怎么分支",碰不到"闸怎么实现"。**

类比我写 workflow:能调 `agent(prompt,{schema})`,但没法让它跳校验(校验在 runtime)。同理 agent author 的 flow **无法绕过 approval 前 deliver、无法跳 STR、无法跳过 secret-scan** —— 那些是库函数、脚本改不了。

### 11.2 放手护栏 —— 脚本 validator（执行前闸）

agent 写的脚本跑之前过一道 validator(类比现配置的 `validate.py`,但查生成的编排 —— AST/类型层面):

- 必调 `approval()` 才能到 `deliver()`
- `str()` 不可被 skip/条件包裹(STR 硬跑)
- egress(MR/upload)前必有 `secretScan()`
- 副作用相前必有 checkpoint 写盘
- 未定义相/未知原语 → 拒

不过 → 拒跑 + 退回 author agent 重写。**agent 自由拼顺序,越不过硬闸。**

### 11.3 别每票从零写

- **默认 = mode 模板**(`bug-template.ts` 等,人写、validator 预过)。
- **agent 只在票古怪时改分支/加相**(这票多一个 migration 检查、那票跳 X)。
- 常规票直接跑模板 → 省 author 成本 + 降风险。**模板兜底 + agent override。**

### 11.4 渐进路径（并入 §9）

| 阶段 | 事项                                                                               |
| ---- | ---------------------------------------------------------------------------------- |
| P1   | 人手写死 `driver.ts` / mode 模板,证明原语库                                        |
| P2   | 抽稳定部分成 **SDK**(闸焊死)                                                       |
| P3   | 加 **flow-author agent**(输入 mode+ticket → 输出 `flow.ts`)+ 脚本 **validator** 闸 |
| P4   | agent 按票自适应 author,validator 兜安全                                           |

**本质**:paseo 版 Claude Workflow —— agent 拿 SDK 当积木、按票搭流程,库焊死安全,validator 把关。这才是"conditional skip 免费 + 自适应瘦身"的完全体:连"跑哪些相"都由 agent 按票现搭,而不止 `if`。

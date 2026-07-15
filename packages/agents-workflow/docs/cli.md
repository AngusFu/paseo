# agents-workflow CLI 使用说明

agents-workflow = 确定性 workflow 运行器。跑 Claude-Workflow 脚本(`export const meta` + 8 原语)against 一个可插拔 backend(mock / paseo)。

## 装 + 入口

```
cd .claude/tools/agents-workflow && pnpm install && pnpm build     # 出 dist/
node dist/cli.js <命令> [参数]
```

- **没配全局 bin** —— 入口就是 `node dist/cli.js`。嫌长自己 alias:`alias aw='node /abs/.../tools/agents-workflow/dist/cli.js'`(下文用 `aw` 代指)。
- `dist/` 是 gitignore 的构建产物,改了源码要重 `pnpm build`。
- CLI 自称 "flowkit"(usage 文本里),无所谓,入口不变。

## 命令

| 命令                         | 干啥                                        | 退出码                                |
| ---------------------------- | ------------------------------------------- | ------------------------------------- |
| `aw list`                    | 列所有可发现的 workflow(名 + origin + 描述) | 0                                     |
| `aw validate <name\|path>`   | §11 静态检查一个脚本(禁危险 token)          | clean=0 / 有违规=1 / 缺参=2           |
| `aw run <name\|path> [opts]` | 跑一个 workflow                             | 成功=0 / 运行错=1 / 缺参或坏 --args=2 |
| `aw backends`                | 列可用 backend                              | 0                                     |
| `aw help` / `--help` / 空    | 打 usage                                    | 0                                     |

`<name|path>` = 注册表里的名字(`list` 能看到)或一个 `.flow.js` 文件路径。
注册表发现顺序(高→低优先):`project > user > builtin`。registry 只认 `.flow.js`(`.workflow.js` 已废,从 `FLOW_EXTS` 删了)。builtin = 10 个通用 Anthropic flow,全同一目录 `workflows/builtin/`(全内联 JSON Schema):autopilot/bugfix/bughunt/bughunt-lite/code-review/dashboard/deep-research/docs/investigate/plan-hunter。**scif-\* 已移出 agents-workflow** —— 搬到宿主 repo `.claude/workflows/scif-{bug,feature,review}.flow.js`,不在 registry 按名解析,只能按路径跑(见下)。agents-workflow 内零 sciforum 数据。

## `run` 参数(全表)

| 参数                         | 作用                                                                 | 默认             |
| ---------------------------- | -------------------------------------------------------------------- | ---------------- |
| `--<key> <value>`            | **命名参数**,合并进脚本的 `args` 全局(见下一节),key 冲突时命名参数赢 | 无               |
| `--args <json>`              | `args` 的 base 值(**必须合法 JSON**,坏则 exit 2)                     | null             |
| `--backend <name>`           | `mock` 或 `paseo`                                                    | mock             |
| `--mock <auto\|empty\|echo>` | mock 应答模式(见下)                                                  | auto             |
| `--provider <p>`             | paseo:默认 provider                                                  | claude           |
| `--wait-timeout <dur>`       | paseo:`--wait-timeout`(`30s`/`5m`/`1h`)                              | 无限             |
| `--cwd <path>`               | paseo:agent 工作目录                                                 | 当前             |
| `--journal <path>`           | journal 写到这个路径(每次 fresh 覆盖)                                | **默认开**(见下) |
| `--no-journal`               | 关掉 journal 写入                                                    | 关(即默认写)     |
| `--resume <path>`            | 从 journal 重放未变的 `agent()` 调用(该路径**不会**被清空)           | 不续             |
| `--max-concurrency <n>`      | 并发 `backend.run` 上限                                              | auto(≈CPU)       |
| `--max-agents <n>`           | 全程 `agent()` 调用总上限                                            | 1000             |
| `--budget <n>`               | token 预算;超了 `agent()` 抛错                                       | 无               |
| `--no-strict`                | 允许脚本用 `Date.now()`/`Math.random()`                              | 默认禁           |
| `--trace`                    | 每个 `agent()` 派发打到 stderr                                       | 关               |
| `--quiet`                    | 压掉 phase/log 进度(也压掉 `▸ journal: ...` 那行)                    | 关               |

参数语法(`yargs-parser` 解析,社区常规约定,`--key value`/`--key=value` 都行):

- **kebab-case == camelCase**:`--runtime-dir X` 跟 `--runtimeDir X` 是同一个参数(camel-case-expansion),脚本 `args` 里只落 camelCase 那份。
- **数字自动转**:`--budget 500` → `args.budget` 是 number `500`,不是字符串。**前导零例外**保持字符串:`--key 007` → `"007"`(约定俗成,票号/key 这种不该被当数字)。
- **`"true"`/`"false"` 自动转布尔**:`--dryRun true` → `args.dryRun === true`(不是字符串 `"true"`)。
- **`--no-x` 取反**:`--no-journal`/`--no-strict` 直接把对应的 base key 置为 `false`(`journal:false`/`strict:false`),不是造一个新 key。
- **身份类 key 强制字符串**:`ticketId`/`key`/`runtimeDir` 就算值是纯数字(如 `--key 123`)也**始终**是字符串,不会被数字转换坑到。
- valueless `--key`(没跟值)→ 布尔 `true`。

## 传参给脚本:命名参数(推荐) vs `--args json`

scif-_ 三 flow 的入参**推荐用命名参数**,`runtimeDir`/`key` 现在**可选**(见下一节默认值),最简可以只给 ticketId。scif-_ 不在 registry,**按路径跑**(下文路径都从 repo 根写 `.claude/workflows/scif-*.flow.js`;要是 cwd 在 agents-workflow 目录里,换成相对 `../../workflows/scif-bug.flow.js`):

```
aw run .claude/workflows/scif-bug.flow.js --ticketId SCIF-1234
```

任何不在保留集里的 `--<key> <value>` 都会收进 `args` 对象(camelCase key,值按上面的规则转 number/boolean;valueless `--<key>` → `args[key] = true`)。**保留集**(不会漏进 `args`,是 CLI 自己的旗标,camelCase):`backend, mock, provider, waitTimeout, cwd, journal, noJournal, resume, maxConcurrency, maxAgents, budget, strict, noStrict, trace, quiet, args`。kebab 形式(`--wait-timeout` 等)一样有效,只是落地后是 camelCase key。

`--args <json>` 仍然有效,作为 **base**:先解析这个 JSON,再叠命名参数上去(**命名参数赢**,key 冲突时覆盖 base 里的同名字段)。等价例子:

```
aw run .claude/workflows/scif-bug.flow.js --args '{"ticketId":"OLD","runtimeDir":"/tmp/r"}' --ticketId SCIF-1234
#   -> args = { ticketId: "SCIF-1234", runtimeDir: "/tmp/r" }   (ticketId 被命名参数覆盖)
```

`--args` 坏 JSON → exit 2(不变)。`--args` 是**裸字符串/数组**(比如 deep-research 那种)时:

- **没有**命名参数一起给 → 原样透传(跟以前一样,`deep-research` 吃裸字符串这种用法保留)。
- **有**命名参数一起给 → 报错 exit 2(裸字符串/数组没法跟命名参数合并成一个对象)。

## journal:默认开

journal(断点续跑用的 `agent()` 调用记录)现在**默认开**,不用手动加 `--journal`:

- 有 `runtimeDir` + `key`(命名参数或 `--args` 里给的)→ journal 落在 `<runtimeDir>/<key>/journal.jsonl`(跟 agent 产物 `outputs/` 同目录,下游相位 READ 用,无闸 stat)。
- 没有 → 落在 `<cwd>/.aw/journal/<workflow名>.jsonl`。
- 每次跑新的都是 fresh 写(路径稳定,不带时间戳,方便下次 `--resume` 同一个路径)。
- `--no-journal` 关掉这个默认行为(完全不写)。
- `--journal <path>` 显式指定路径(行为不变:每次 fresh 覆盖)。
- `--resume <path>` 独立给的时候,沿用**那个路径**当 journal(读缓存 + 继续 append),**不会**清空它 —— 清空了就没法续跑了。
- 启动时(除非 `--quiet`)打一行 `▸ journal: <path>` 到 stderr。

## backends

- **`mock`(默认,离线免费)** —— 应答模式 `--mock`:
  - `auto`(默认):从 prompt 里的 JSON Schema 合成一个 valid 实例(让任意 workflow 干跑到底)。
  - `empty`:回空串。
  - `echo`:回 `[echo] <label>`。
  - **注意**:agents-workflow 无引擎闸(详见下 § 引擎闸:没了),`--backend mock` 靠 flow 自身 `if` 控制流跑通 scif-\* 到底,不再第一道闸 Block。
- **`paseo`(真跑,真 LLM)** —— 每个 agent 走 `paseo run` 打本地 daemon。先 `paseo status` 确认 daemon 在。用 `--provider`/`--wait-timeout`/`--cwd`。

## `args` 与 scif-\* flow 的入参

命名参数或 `--args` JSON 合并后,成为脚本的 `args` 全局。scif-\* 三 flow 要:

```json
{ "ticketId": "SCIF-1234", "runtimeDir": "/tmp/aw/scif-1234", "key": "scif-1234" }
```

- `runtimeDir`/`key` 定沙箱:agent 产物落 `<runtimeDir>/<key>/outputs/`(下游相位 READ,已无闸 stat);journal 默认也落在这个目录(见上)。
- scif-\* flow **永远自动化** —— 没有人工闸、没有 autopilot 旗标。scif-bug flow 永远跑双投手 RCA。

### `runtimeDir`/`key` 现在是**可选**的

只要 `args` 是个对象(命名参数或 `--args` JSON object,不是裸字符串/数组那种),CLI 会在缺的地方自动补上默认值(已给的永远不覆盖):

- **`key`** 没给 → 有 `ticketId` 就拿它 slug 一下(小写、非 `[a-z0-9]` 的字符段落压成一个 `-`,首尾 `-` 修掉):`SCIF-1234` → `scif-1234`;没有 `ticketId` → `run-<时间戳>`。
- **`runtimeDir`** 没给 → 依次找:环境变量 `AW_RUNTIME_DIR` → `$XDG_STATE_HOME/aw` → 兜底 `<当前目录>/.aw`。
- 补完后开跑前打一行(除非 `--quiet`)`▸ runtime: <runtimeDir>/<key>` 到 stderr。

裸字符串/数组 `args`(deep-research 那种)不受影响 —— 那种 flow 压根不吃 `{runtimeDir,key}` 这种入参形状,不会硬塞。

结果:`aw run .claude/workflows/scif-bug.flow.js --ticketId SCIF-1234` 不用再手写 `--runtimeDir`/`--key`,产物落 `./.aw/scif-1234/outputs/`,journal 落 `./.aw/scif-1234/journal.jsonl`。想固定路径(比如接自动化脚本)照样能显式给 `--runtimeDir`/`--key`。

## 引擎闸:没了

- agents-workflow **无任何运行时排序闸**。artifact 闸 + FlowPolicy 都已退休(2026-07-14),agents-workflow 现在对 vanilla Claude Workflow **零新增**,纯忠实超集。
- 交付顺序(STR 先于 deliver、secret-scan 先于 egress)就是 scif-\* flow 里 `agent()` 调用的**书写顺序** —— 顺序=代码顺序,不再有 host 侧强制带。
- 关键产物(MR)靠 flow 内 à-la-carte verifier(deterministic glab 核验)点对点补。

## 断点续跑

journal 默认开,不用手动指定路径也能续 —— 默认路径本身就稳定(见上一节):

```
aw run .claude/workflows/scif-bug.flow.js --ticketId X --runtimeDir /tmp/r --key k   # 记录到 /tmp/r/k/journal.jsonl(默认)
aw run .claude/workflows/scif-bug.flow.js --ticketId X --runtimeDir /tmp/r --key k \
  --resume /tmp/r/k/journal.jsonl                                       # 重放未变的 agent() 调用(幂等,不清空)
```

想用自定义路径,老写法照旧:

```
aw run .claude/workflows/scif-bug.flow.js --journal /tmp/j.jsonl --args '{...}'   # 记录到指定路径(每次 fresh)
aw run .claude/workflows/scif-bug.flow.js --resume  /tmp/j.jsonl --args '{...}'   # 重放未变的 agent() 调用(幂等)
```

## 输出

- **stderr**(除非 `--quiet`):`▸ workflow`、`═══ Phase: X ═══`、log 行、收尾 `✔ done in Nms · agents=.. cacheHits=.. retries=.. · tokens=x/y`、`meta.phases`。
- **stdout**:最终结果 JSON `{ workflow, meta, result, stats, budget }`(可 `| jq`)。

## 例子

```
aw list                                            # 看有哪些 flow(只列 registry 内的 .flow.js;scif-* 不在里头)
aw validate .claude/workflows/scif-bug.flow.js    # 静态检查(必过,按路径)
aw run code-review --backend mock                  # 内置 flow 干跑(免费,按名解析)
aw run .claude/workflows/scif-bug.flow.js --backend mock --ticketId SCIF-1234
#   ^ scif-* 按路径跑(不在 registry);runtimeDir/key 自动默认 -> ./.aw/scif-1234/
#   无引擎闸 -> plain mock 现在跑通到底(flow 自身 if 驱动,顺序=代码顺序;真跑用 paseo)
aw run .claude/workflows/scif-bug.flow.js --backend mock --runtime-dir /tmp/r --key k --budget 500
#   ^ kebab --runtime-dir 等价 --runtimeDir;--budget 落地是 number 不是字符串
aw run .claude/workflows/scif-bug.flow.js --backend paseo \
  --ticketId SCIF-1234 --runtimeDir /tmp/aw/x --key x \
  --wait-timeout 10m --trace                          # 真机跑一张票(永远自动化)
aw run deep-research --backend paseo --budget 500000 --args '"我的研究问题"'
#   ^ 裸字符串入参,没有命名参数一起给,原样透传
```

## 常见坑

- 改源码没重 `pnpm build` → 跑的是旧 dist。
- `--args` 不是合法 JSON → exit 2(注意 shell 引号:`--args '{"a":1}'`)。
- 单引号字符串入参也要合法 JSON:`--args '"just a string"'`(带内层引号)。
- 裸字符串/数组 `--args` **不能**跟命名参数一起给(没法合并成对象)→ exit 2。
- agents-workflow 无引擎闸(详见 § 引擎闸:没了);plain mock 把 scif-\* 跑通到底。
- paseo 真跑前先 `paseo status`;daemon 没起来 backend 返 `{error}` → `agent()===null`。
- journal **默认开**,每次跑都会在磁盘留一个 `journal.jsonl`(路径见上);嫌占地方或不想续跑就 `--no-journal`。
- `--key 007`/`--ticketId 007` 这种前导零的值**不会**被转成数字(一直是字符串);其它纯数字值(`--budget 500`)会转。别指望票号/key 也保持数字,反过来也别指望普通数字参数保持字符串。
- `--no-journal`/`--no-strict` 落地是把 `journal`/`strict` 置 `false`,**不是**造一个 `noJournal` key —— 自己写脚本读 `args`/CLI 输出时留意这点。

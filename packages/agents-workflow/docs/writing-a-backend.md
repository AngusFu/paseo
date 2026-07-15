# 写一个 AgentBackend

agents-workflow 引擎不知道 agent 怎么跑 —— 本地子进程 / 远程 daemon / LLM API / 测试替身,全靠一个接口。`agent(prompt, opts)` 每次调用,引擎把归一化的 `AgentSpec` 交给 backend,等回一个 `AgentResult`。

## 契约(`src/backend.ts`)

```ts
abstract class AgentBackend {
  abstract get name(): string; // 稳定 id, 如 'mock' / 'paseo'
  abstract run(spec: AgentSpec): Promise<AgentResult>; // 跑一个 agent 到底
  async dispose(): Promise<void> {} // 可选, 引擎拆时调一次
}
```

`AgentSpec` 进(引擎已拼好 persona+task 的 `prompt` + `label`/`phase`/`model`/`effort`/`provider`/`isolation`/`labels`)。
`AgentResult` 出:`{ text?, error?, usage?: { outputTokens? } }`。

## 三条铁律

1. **run() 只 RESOLVE, 从不 reject。** 普通失败(超时/非零退出/daemon 挂)→ 返回 `{ error: "..." }`,引擎把它映射成 `agent()===null`。抛异常 = 破坏引擎的 null 语义。包 try/catch,catch 里 return `{error}`。
2. **结构化输出不是 backend 的事。** 引擎自持:它往 prompt 塞 "返回 JSON 匹配 schema" 的指令 + 引擎侧 zod 校验 + 重试。backend 只管**跑 prompt 返回原始 text**(text 可能是 JSON 串,不用管)。"笨" backend 也能工作。
3. **usage 供 budget。** 有 token 计数就填 `usage.outputTokens`(引擎按此扣 budget);没有则引擎按 512/agent 估。

## 最小实现

```ts
import { AgentBackend, type AgentSpec, type AgentResult } from "../backend.js";

export class MyBackend extends AgentBackend {
  override get name(): string {
    return "mybackend";
  }

  override async run(spec: AgentSpec): Promise<AgentResult> {
    try {
      const text = await callMyAgentSomehow(spec.prompt, {
        model: spec.model,
        provider: spec.provider, // 自解释 spec 字段
      });
      return { text, usage: { outputTokens: countTokens(text) } };
    } catch (e) {
      // 普通失败 -> {error}, 绝不 throw
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  override async dispose(): Promise<void> {
    // 持有 socket/进程池的才 override; 一次性调用的留空
  }
}
```

## 注入式 exec seam(可测)

真 backend 别把 spawn 写死进 run()。抽个 `exec` 注入进构造器(见 `src/backends/paseo.ts`):

```ts
constructor(opts: { exec?: (args: string[]) => Promise<string>; ... } = {}) {
  super();
  this.exec = opts.exec ?? defaultPaseoExec;   // 默认真 spawn; 测试传 mock
}
```

这样单测不碰真 daemon(paseo 的测试就全走注入 exec)。

## 接进引擎

两条路:

- **直接注入**:`createEngine({ backend: new MyBackend() })`。
- **CLI 工厂**:`src/cli.ts` 的 `createBackend()` switch 加一个 `case "mybackend": return new MyBackend(...)`,然后 `aw run <wf> --backend mybackend`。

## 参考实现

- `src/backends/mock.ts` —— 测试替身。`MockBackend.auto()` 从 prompt 里的 JSON Schema 合成 valid 实例(让任意 workflow 干跑到底);`.scripted({kw:reply})` 关键字映射。
- `src/backends/paseo.ts` —— 真子进程(`paseo run --json` + logs 抓文本 + inspect 取 usage)。展示注入 exec、never-throws、多字段映射、flag 注入守卫。

## 多 provider(P3+)

`spec.provider` 已端到端穿好。一个 backend 内按 `spec.provider` 分发到不同厂(claude/codex/…),或每厂一个 backend + 上层选。跨厂 diverse-verify 就靠这个。

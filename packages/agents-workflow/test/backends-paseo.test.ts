// PaseoBackend — all deterministic, via the INJECTED exec seam. NO real daemon
// is ever spawned here. proves arg construction, --json envelope parsing, the
// logs-fallback text recovery, and the "run() never throws — always { error }"
// failure contract, plus an engine-level e2e that the backend satisfies the
// engine's AgentBackend contract end-to-end.
import { describe, expect, it, vi } from "vitest";

// mock execa so the DEFAULT exec seam (the real execa("paseo", args) wrapper)
// can be exercised without a live daemon — mirrors test/paseo.test.ts's realExec
// coverage. every OTHER test in this file injects its own exec, so this mock is
// inert for them.
vi.mock("execa", () => ({
  execa: vi.fn(async () => ({
    stdout: JSON.stringify({ agentId: "def", status: "completed", text: "from-default-exec" }),
  })),
}));
import { execa } from "execa";
import { PaseoBackend, parsePaseoJson, extractLogsText } from "../src/backends/paseo.js";
import { createEngine } from "../src/engine.js";
import type { AgentSpec } from "../src/backend.js";

// a canned `paseo run --json` completion envelope (the REAL shape: agentId +
// status, no text/usage). callers add fields as a given test needs.
const ENVELOPE = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    agentId: "ag-1",
    status: "completed",
    provider: "claude",
    cwd: "/x",
    title: "t",
    ...extra,
  });

// build a mock exec that dispatches on the paseo subcommand (args[0]).
function mockExec(map: {
  run?: string;
  logs?: string;
  onRun?: (args: string[]) => void;
}): (a: string[]) => Promise<string> {
  return async (args: string[]) => {
    if (args[0] === "run") {
      map.onRun?.(args);
      return map.run ?? ENVELOPE();
    }
    if (args[0] === "logs") return map.logs ?? "";
    return "";
  };
}

describe("PaseoBackend name + dispose", () => {
  it("is an AgentBackend named 'paseo'", () => {
    const b = new PaseoBackend({ exec: async () => ENVELOPE() });
    expect(b.name).toBe("paseo");
    expect(typeof b.run).toBe("function");
  });

  it("dispose() is a no-op lifecycle hook (one-shot run holds no handle)", async () => {
    await expect(new PaseoBackend().dispose()).resolves.toBeUndefined();
  });

  it("default exec shells out to execa('paseo', args) when no exec is injected", async () => {
    vi.mocked(execa).mockClear();
    const r = await new PaseoBackend().run({ prompt: "p" });
    expect(execa).toHaveBeenCalledWith("paseo", expect.arrayContaining(["run", "--json"]));
    expect(r.text).toBe("from-default-exec");
  });
});

describe("PaseoBackend.buildArgs", () => {
  const spec = (o: Partial<AgentSpec> = {}): AgentSpec => ({ prompt: "do it", ...o });

  it("defaults provider to claude and puts `--` right before the prompt", () => {
    const b = new PaseoBackend();
    const args = b.buildArgs(spec({ prompt: "hello" }));
    expect(args.slice(0, 4)).toEqual(["run", "--json", "--provider", "claude"]);
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("hello");
  });

  it("honors an explicit provider and defaultProvider option", () => {
    expect(new PaseoBackend().buildArgs(spec({ provider: "codex" }))[3]).toBe("codex");
    expect(new PaseoBackend({ defaultProvider: "gemini" }).buildArgs(spec())[3]).toBe("gemini");
  });

  it("passes --model through when set, omits it otherwise", () => {
    const withModel = new PaseoBackend().buildArgs(spec({ model: "claude-opus-4-8" }));
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    expect(new PaseoBackend().buildArgs(spec()).includes("--model")).toBe(false);
  });

  it("adds --worktree with a deterministic slug ONLY for isolation=worktree", () => {
    const wt = new PaseoBackend().buildArgs(spec({ isolation: "worktree", phase: "Deep RCA" }));
    expect(wt[wt.indexOf("--worktree") + 1]).toBe("flow2-deep-rca");
    expect(
      new PaseoBackend()
        .buildArgs(spec({ isolation: "worktree", label: "Fix It!" }))
        .includes("flow2-fix-it"),
    ).toBe(true);
    // no phase/label -> stable fallback name
    expect(
      new PaseoBackend().buildArgs(spec({ isolation: "worktree" })).includes("flow2-agent"),
    ).toBe(true);
    // non-worktree isolation -> no flag
    expect(new PaseoBackend().buildArgs(spec({ isolation: "none" })).includes("--worktree")).toBe(
      false,
    );
  });

  it("passes --wait-timeout and --cwd through when configured", () => {
    const b = new PaseoBackend({ waitTimeout: "5m", cwd: "/repo" });
    const args = b.buildArgs(spec());
    expect(args[args.indexOf("--wait-timeout") + 1]).toBe("5m");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/repo");
  });

  it("flattens labels as repeated --label k=v", () => {
    const args = new PaseoBackend().buildArgs(spec({ labels: { ticket: "SCIF-1", kind: "bug" } }));
    expect(args).toContain("--label");
    expect(args).toContain("ticket=SCIF-1");
    expect(args).toContain("kind=bug");
  });

  it("protects a prompt that starts with '-' (kept last, after `--`)", () => {
    const args = new PaseoBackend().buildArgs(spec({ prompt: "-h flag missing from header" }));
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("-h flag missing from header");
  });
});

describe("PaseoBackend.run — happy paths", () => {
  it("returns text from an envelope that embeds it (single exec, no logs call)", async () => {
    const seen: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      seen.push(args);
      return ENVELOPE({ text: '{"ok":true}', usage: { output_tokens: 42 } });
    };
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.text).toBe('{"ok":true}');
    expect(r.usage?.outputTokens).toBe(42);
    expect(seen.length).toBe(1); // never fell back to `logs`
    expect(seen[0][0]).toBe("run");
  });

  it("real live path: envelope lacks text -> recovers it from the logs transcript", async () => {
    const exec = mockExec({ run: ENVELOPE(), logs: '[User] say hi\n{"greeting":"hello"}' });
    const r = await new PaseoBackend({ exec }).run({ prompt: "say hi" });
    expect(r.text).toBe('{"greeting":"hello"}');
  });

  it("logs fallback strips the [User] echo for a plain-text reply", async () => {
    const exec = mockExec({ run: ENVELOPE(), logs: "[User] say hi\nhello world" });
    const r = await new PaseoBackend({ exec }).run({ prompt: "say hi" });
    expect(r.text).toBe("hello world");
  });

  it("carries usage from the envelope even when text comes from logs", async () => {
    const exec = mockExec({ run: ENVELOPE({ usage: { outputTokens: 7 } }), logs: "hello" });
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.text).toBe("hello");
    expect(r.usage?.outputTokens).toBe(7);
  });
});

describe("PaseoBackend.run — failure contract (RESOLVES with { error }, never throws)", () => {
  it("exec that throws (non-zero exit / daemon down) -> { error }", async () => {
    const exec = async (): Promise<string> => {
      throw new Error("spawn paseo ENOENT");
    };
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.error).toMatch(/exec failed/);
    expect(r.error).toMatch(/ENOENT/);
    expect(r.text).toBeUndefined();
  });

  it("unparseable stdout -> { error }", async () => {
    const exec = async (): Promise<string> => "not json at all";
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.error).toMatch(/could not parse/);
  });

  it("clips a very long unparseable stdout in the error message", async () => {
    const exec = async (): Promise<string> => "x".repeat(500);
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.error).toMatch(/could not parse/);
    expect(r.error).toContain("...");
    expect(r.error!.length).toBeLessThan(200);
  });

  it("a failure status in the envelope -> { error }", async () => {
    for (const status of ["error", "timeout", "permission", "failed", "cancelled"]) {
      const exec = async (): Promise<string> => ENVELOPE({ status });
      const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
      expect(r.error).toContain(status);
    }
  });

  it("envelope with neither text nor agentId -> { error }", async () => {
    const exec = async (): Promise<string> => JSON.stringify({ status: "completed" });
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.error).toMatch(/neither text nor agentId/);
  });

  it("empty logs transcript (no assistant text) -> { error }", async () => {
    const exec = mockExec({ run: ENVELOPE(), logs: "   " });
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.error).toMatch(/no assistant text/);
  });

  it("a logs exec that throws is still caught -> { error } (never throws)", async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === "logs") throw new Error("logs boom");
      return ENVELOPE();
    };
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.error).toMatch(/exec failed/);
  });
});

// ── Fix H (MED) — a sandboxed script controls spec.provider/spec.model. A
// flag-like value would inject a bare argv flag into `paseo run`. run() rejects
// it BEFORE shelling out.
describe("PaseoBackend.run — Fix H: reject flag-like provider/model (no argv injection)", () => {
  it("a provider that starts with '-' is rejected and never shelled out", async () => {
    let seen: string[] | null = null;
    const exec = async (a: string[]): Promise<string> => {
      seen = a;
      return ENVELOPE({ text: "x" });
    };
    const r = await new PaseoBackend({ exec }).run({ prompt: "p", provider: "--worktree" });
    expect(r.error).toMatch(/unsafe provider\/model/);
    expect(r.text).toBeUndefined();
    expect(seen).toBeNull(); // exec never called -> no injected flag reached paseo
  });

  it("a model that starts with '-' is rejected", async () => {
    const exec = async (): Promise<string> => ENVELOPE({ text: "x" });
    const r = await new PaseoBackend({ exec }).run({ prompt: "p", model: "-x" });
    expect(r.error).toMatch(/unsafe provider\/model/);
  });

  it("a provider with an invalid char (not [A-Za-z0-9._/-]) is rejected", async () => {
    const exec = async (): Promise<string> => ENVELOPE({ text: "x" });
    const r = await new PaseoBackend({ exec }).run({ prompt: "p", provider: "cla ude" });
    expect(r.error).toMatch(/unsafe provider\/model/);
  });

  it("a normal provider/model (e.g. codex/gpt-5.4) still runs fine", async () => {
    const exec = mockExec({ run: ENVELOPE({ text: "ok" }) });
    const r = await new PaseoBackend({ exec }).run({
      prompt: "p",
      provider: "codex/gpt-5.4",
      model: "gpt-5.4",
    });
    expect(r.text).toBe("ok");
  });
});

// ── Fix I (MED) — `paseo run --json` carries no usage, so budget could only
// bound agent-COUNT. Recover REAL usage from `paseo inspect --json <id>`
// (LastUsage.OutputTokens), best-effort + toggleable.
describe("PaseoBackend.run — Fix I: real usage via `paseo inspect`", () => {
  it("fetches usage from inspect after a logs-recovered run", async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === "run") return ENVELOPE(); // envelope: no usage
      if (args[0] === "logs") return "[User] q\nhello";
      if (args[0] === "inspect") return JSON.stringify({ LastUsage: { OutputTokens: 123 } });
      return "";
    };
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.text).toBe("hello");
    expect(r.usage?.outputTokens).toBe(123);
  });

  it("inspect failure omits usage but the run still returns text (never throws)", async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === "run") return ENVELOPE();
      if (args[0] === "logs") return "hello";
      if (args[0] === "inspect") throw new Error("inspect boom");
      return "";
    };
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.text).toBe("hello");
    expect(r.usage).toBeUndefined();
  });

  it("fetchUsage:false skips the inspect exec entirely", async () => {
    const seen: string[] = [];
    const exec = async (args: string[]): Promise<string> => {
      seen.push(args[0]);
      if (args[0] === "run") return ENVELOPE();
      if (args[0] === "logs") return "hi";
      return "";
    };
    const r = await new PaseoBackend({ exec, fetchUsage: false }).run({ prompt: "p" });
    expect(r.text).toBe("hi");
    expect(seen).not.toContain("inspect");
  });

  it("an envelope that already carries usage does NOT trigger an inspect exec", async () => {
    const seen: string[] = [];
    const exec = async (args: string[]): Promise<string> => {
      seen.push(args[0]);
      if (args[0] === "run") return ENVELOPE({ usage: { outputTokens: 9 } });
      if (args[0] === "logs") return "hello";
      return "";
    };
    const r = await new PaseoBackend({ exec }).run({ prompt: "p" });
    expect(r.usage?.outputTokens).toBe(9);
    expect(seen).not.toContain("inspect");
  });
});

describe("PaseoBackend.run — timeout flag threads through to exec", () => {
  it("passes --wait-timeout on the actual run invocation", async () => {
    let runArgs: string[] = [];
    const exec = mockExec({ run: ENVELOPE({ text: "ok" }), onRun: (a) => (runArgs = a) });
    await new PaseoBackend({ exec, waitTimeout: "1h" }).run({ prompt: "p" });
    expect(runArgs[runArgs.indexOf("--wait-timeout") + 1]).toBe("1h");
  });
});

describe("parsePaseoJson — defensive field probing", () => {
  it("returns null when stdout is not JSON", () => {
    expect(parsePaseoJson("banner\nno json here")).toBeNull();
  });

  it("returns null when stdout is a non-object JSON value (a bare number)", () => {
    expect(parsePaseoJson("123")).toBeNull();
  });

  it("extracts a JSON object embedded after a stray banner line", () => {
    const env = parsePaseoJson('some banner\n{"status":"completed","agentId":"z"}');
    expect(env?.status).toBe("completed");
    expect(env?.agentId).toBe("z");
  });

  it("returns null for an unbalanced brace after a banner (matchBrace gives up)", () => {
    expect(parsePaseoJson('banner\n{"unclosed": 1')).toBeNull();
  });

  it("returns null for a balanced but non-JSON brace group after a banner", () => {
    expect(parsePaseoJson("banner {a b c}")).toBeNull();
  });

  it("probes result/output/text/response/content/message + messages[]", () => {
    expect(parsePaseoJson(JSON.stringify({ result: "R" }))?.text).toBe("R");
    expect(parsePaseoJson(JSON.stringify({ output: "O" }))?.text).toBe("O");
    expect(parsePaseoJson(JSON.stringify({ response: "S" }))?.text).toBe("S");
    expect(parsePaseoJson(JSON.stringify({ content: "C" }))?.text).toBe("C");
    expect(parsePaseoJson(JSON.stringify({ message: "M" }))?.text).toBe("M");
    expect(parsePaseoJson(JSON.stringify({ lastMessage: "L" }))?.text).toBe("L");
    const withMsgs = parsePaseoJson(
      JSON.stringify({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", text: "bye" },
        ],
      }),
    );
    expect(withMsgs?.text).toBe("bye");
    // a messages array with a null entry + a content-less entry yields no text
    const noText = parsePaseoJson(
      JSON.stringify({ agentId: "a", messages: [null, { role: "assistant" }] }),
    );
    expect(noText?.text).toBeUndefined();
  });

  it("probes usage output-token fields (snake, camel, tokens.output, inspect LastUsage)", () => {
    expect(
      parsePaseoJson(JSON.stringify({ usage: { output_tokens: 3 } }))?.usage?.outputTokens,
    ).toBe(3);
    expect(
      parsePaseoJson(JSON.stringify({ usage: { outputTokens: 4 } }))?.usage?.outputTokens,
    ).toBe(4);
    expect(parsePaseoJson(JSON.stringify({ tokens: { output: 5 } }))?.usage?.outputTokens).toBe(5);
    expect(
      parsePaseoJson(JSON.stringify({ LastUsage: { OutputTokens: 6 } }))?.usage?.outputTokens,
    ).toBe(6);
    // real envelope: no usage field -> undefined
    expect(parsePaseoJson(ENVELOPE())?.usage).toBeUndefined();
  });
});

describe("extractLogsText", () => {
  it("returns null for an empty transcript", () => {
    expect(extractLogsText("   ")).toBeNull();
  });

  it("grabs the LAST balanced JSON value, ignoring role prefixes", () => {
    const transcript = '[User] find bugs\n{"first":1}\n[User] again\n{"final":true}';
    expect(extractLogsText(transcript)).toBe('{"final":true}');
  });

  it("handles a JSON object whose string values contain braces", () => {
    const transcript = '[User] q\n{"code":"if (x) { y }"}';
    expect(extractLogsText(transcript)).toBe('{"code":"if (x) { y }"}');
  });

  it("falls back to stripping [Role] echo lines for a plain reply", () => {
    expect(extractLogsText("[User] say hi\nhello")).toBe("hello");
  });

  it("keeps the raw transcript when nothing else survives the strip", () => {
    // only a role-prefixed line and no JSON -> strip empties -> return raw.
    expect(extractLogsText("[User] only an echo")).toBe("[User] only an echo");
  });
});

// ---- engine-level e2e: prove the backend satisfies the engine contract ----
describe("engine e2e over PaseoBackend (injected exec, no daemon)", () => {
  it("runs a 1-agent workflow: real two-exec path (run envelope -> logs text)", async () => {
    const exec = mockExec({ run: ENVELOPE(), logs: "[User] say hi\nhello from paseo" });
    const engine = createEngine({ backend: new PaseoBackend({ exec }) });
    const wf =
      'export const meta = { name: "t" };\nreturn await agent("say hi", { label: "greet" });';
    const { result, stats } = await engine.run(wf);
    expect(result).toBe("hello from paseo");
    expect(stats.agentCalls).toBe(1);
  });

  it("runs a structured 1-agent workflow: engine parses+validates the logs JSON", async () => {
    const exec = mockExec({
      run: ENVELOPE(),
      logs: '[User] scope\n{"diffBase":"main","files":["a.js"]}',
    });
    const engine = createEngine({ backend: new PaseoBackend({ exec }) });
    const wf = [
      'export const meta = { name: "s" };',
      'const SCHEMA = { type: "object", required: ["diffBase"], properties: { diffBase: { type: "string" } } };',
      'const r = await agent("scope the change", { label: "scope", schema: SCHEMA });',
      "return r.diffBase;",
    ].join("\n");
    const { result } = await engine.run(wf);
    expect(result).toBe("main");
  });

  it("a failed run maps to agent()===null in the engine", async () => {
    const exec = async (): Promise<string> => {
      throw new Error("daemon down");
    };
    const engine = createEngine({ backend: new PaseoBackend({ exec }) });
    const wf =
      'export const meta = { name: "n" };\nreturn (await agent("x")) === null ? "was-null" : "not-null";';
    const { result } = await engine.run(wf);
    expect(result).toBe("was-null");
  });
});

// NOTE: the REAL-daemon live smoke lives in test/backends-paseo.live.test.ts,
// NOT here. this file module-mocks execa, so a "live" test here would silently
// get the MOCKED execa (never the real daemon) — a false-green trap. the live
// file has NO execa mock.

/* eslint-disable max-nested-callbacks -- fake spawn + event collectors nest naturally */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  CURSOR_PRINT_AGENTS_BLOCK_BEGIN,
  CURSOR_PRINT_AGENTS_BLOCK_END,
  CURSOR_PRINT_DEFAULT_MODE_ID,
  CURSOR_PRINT_PROVIDER_ID,
  CURSOR_PRINT_RUNTIME_GUIDANCE,
  CursorPrintAgentClient,
  buildCursorPrintAutoAcceptFeature,
  buildCursorPrintAgentsBlock,
  buildCursorPrintCliPrompt,
  buildTurnArgs,
  readCursorPrintGuidanceMarkdown,
  convertCursorPrintPrompt,
  formatCursorPrintModelRejection,
  isCursorEmptyModelCatalogFailure,
  normalizeCursorPrintSessionConfig,
  resolveCursorPrintGlobalAgentsPath,
  writeCursorPrintGuidanceFileForDaemon,
  writeCursorPrintGlobalAgentsBlock,
  type CursorPrintLaunch,
  type CursorPrintSpawn,
} from "./cursor-print-agent.js";
import {
  CURSOR_PRINT_FAST_MODE_FEATURE_ID,
  groupCursorPrintModels,
} from "./cursor-print-models.js";
import { ACP_AUTO_ACCEPT_FEATURE_ID } from "./acp-agent.js";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** Distinct 1×1 red PNG so content-hash paths differ from ONE_BY_ONE_PNG_BASE64. */
const RED_ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const GROK_MODELS_STDOUT = [
  "Available models",
  "cursor-grok-4.5-high - Cursor Grok 4.5",
  "cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast",
  "cursor-grok-4.5-low - Cursor Grok 4.5 Low",
  "cursor-grok-4.5-low-fast - Cursor Grok 4.5 Low Fast",
  "composer-2.5 - Composer 2.5",
  "composer-2.5-fast - Composer 2.5 Fast",
].join("\n");

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }
}

function createFakeSpawn(script: (child: FakeChild, launch: CursorPrintLaunch) => void): {
  spawn: CursorPrintSpawn;
  launches: CursorPrintLaunch[];
} {
  const launches: CursorPrintLaunch[] = [];
  const spawn: CursorPrintSpawn = (launch) => {
    launches.push(launch);
    const child = new FakeChild();
    queueMicrotask(() => {
      script(child, launch);
    });
    return child as unknown as ReturnType<CursorPrintSpawn>;
  };
  return { spawn, launches };
}

async function collectUntil(
  session: Awaited<ReturnType<CursorPrintAgentClient["createSession"]>>,
  predicate: (events: Array<{ type: string }>) => boolean,
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for events: ${events.map((e) => e.type).join(",")}`));
    }, 2_000);
    const unsubscribe = session.subscribe((event) => {
      events.push(event as { type: string; [key: string]: unknown });
      if (predicate(events)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(events);
      }
    });
  });
}

describe("CursorPrintAgentClient", () => {
  test("fetchCatalog groups effort/fast variants into base models", async () => {
    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      execModels: async () =>
        [
          "Available models",
          "composer-2.5 - Composer 2.5  (current)",
          "composer-2.5-fast - Composer 2.5 Fast",
          "cursor-grok-4.5-high - Cursor Grok 4.5",
          "cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast",
          "cursor-grok-4.5-low - Cursor Grok 4.5 Low",
          "gpt-5.4-medium - GPT-5.4 1M",
          "gpt-5.4-high - GPT-5.4 1M High",
          "Tip: use --model",
        ].join("\n"),
    });

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/project",
      force: false,
    });
    expect(catalog.defaultModeId).toBe(CURSOR_PRINT_DEFAULT_MODE_ID);
    expect(catalog.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "cursor-grok-4.5",
      "gpt-5.4",
    ]);
    expect(catalog.models[0]).toMatchObject({
      provider: CURSOR_PRINT_PROVIDER_ID,
      id: "composer-2.5",
      label: "Composer 2.5",
      isDefault: true,
      thinkingOptions: undefined,
      metadata: { cursorPrintSupportsFast: true },
    });
    expect(catalog.models.find((model) => model.id === "cursor-grok-4.5")).toMatchObject({
      label: "Cursor Grok 4.5",
      defaultThinkingOptionId: "high",
      metadata: { cursorPrintSupportsFast: true },
    });
    expect(
      catalog.models
        .find((model) => model.id === "cursor-grok-4.5")
        ?.thinkingOptions?.map((o) => o.id),
    ).toEqual(["low", "high"]);
  });

  test("startTurn launches print/stream-json with force + resume", async () => {
    const { spawn, launches } = createFakeSpawn((child) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "chat-1",
          model: "composer-2.5",
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
          session_id: "chat-1",
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "hi",
          session_id: "chat-1",
          usage: { inputTokens: 10, outputTokens: 2 },
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
      execModels: async () => GROK_MODELS_STDOUT,
      runtimeSettings: {
        command: { mode: "replace", argv: ["/bin/agent"] },
      },
    });

    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
      model: "composer-2.5",
    });

    // Seed a chat id as if a prior turn completed.
    (session as unknown as { chatId: string }).chatId = "chat-1";

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("hello");
    const events = await eventsPromise;

    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      command: "/bin/agent",
      cwd: "/tmp/project",
    });
    const args = launches[0]?.args ?? [];
    expect(args.at(-1)).toBe(buildCursorPrintCliPrompt("hello"));
    expect(args.at(-1)).toBe("hello");
    // No MCP servers → no temp plugin-dir (guidance is Cursor-global at daemon boot).
    expect(args).not.toContain("--plugin-dir");
    expect(args).not.toContain("--approve-mcps");
    expect(args.slice(0, -1)).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--force",
      "--resume",
      "chat-1",
      "--model",
      "composer-2.5",
      "--workspace",
      "/tmp/project",
      "--",
    ]);

    expect(events.some((event) => event.type === "turn_started")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "timeline" &&
          (event.item as { type?: string; text?: string })?.type === "assistant_message" &&
          (event.item as { text?: string }).text === "hi",
      ),
    ).toBe(true);
    expect(session.id).toBe("chat-1");
  });

  test("default mode emits permission_requested and writes stdin response", async () => {
    let childRef: FakeChild | null = null;
    const { spawn } = createFakeSpawn((child) => {
      childRef = child;
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "chat-2",
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "interaction_query",
          subtype: "request",
          query_type: "shellRequestQuery",
          query: {
            id: 7,
            shellRequestQuery: {
              args: { command: "ls" },
            },
          },
        })}\n`,
      );
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "default",
    });

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "permission_requested"),
    );
    await session.startTurn("run ls");
    const events = await eventsPromise;
    const permission = events.find((event) => event.type === "permission_requested") as {
      request: { id: string };
    };

    const stdinChunks: string[] = [];
    childRef?.stdin.on("data", (chunk: Buffer | string) => {
      stdinChunks.push(String(chunk));
    });

    await session.respondToPermission(permission.request.id, { behavior: "allow" });
    await vi.waitFor(() => {
      expect(stdinChunks.join("")).toContain('"subtype":"response"');
    });
    expect(stdinChunks.join("")).toContain('"approved"');
  });

  test("second turn resumes with --resume and absolute workspace", async () => {
    const { spawn, launches } = createFakeSpawn((child, launch) => {
      const resumeIdx = launch.args.indexOf("--resume");
      const sessionId = resumeIdx >= 0 ? String(launch.args[resumeIdx + 1]) : "chat-multi";
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: sessionId,
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          session_id: sessionId,
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          session_id: sessionId,
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
    });

    const firstDone = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("first");
    await firstDone;
    expect(session.id).toBe("chat-multi");
    expect(session.describePersistence()?.sessionId).toBe("chat-multi");
    expect(launches[0]?.args).not.toContain("--resume");
    expect(launches[0]?.args).toContain("--workspace");
    expect(launches[0]?.args).toContain("/tmp/project");

    const secondDone = collectUntil(
      session,
      (events) => events.filter((event) => event.type === "turn_completed").length >= 1,
    );
    await session.startTurn("second");
    await secondDone;
    expect(launches).toHaveLength(2);
    expect(launches[1]?.args).toContain("--resume");
    expect(launches[1]?.args).toContain("chat-multi");
  });

  test("resume failure clears chat id and retries fresh once", async () => {
    let attempt = 0;
    const { spawn, launches } = createFakeSpawn((child) => {
      attempt += 1;
      if (attempt === 1) {
        child.stderr.write("Unable to resume session: chat not found\n");
        child.emit("exit", 1, null);
        return;
      }
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "fresh-after-resume-fail",
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "recovered",
          session_id: "fresh-after-resume-fail",
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
    });
    (session as unknown as { chatId: string }).chatId = "stale-chat";

    const done = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("recover");
    await done;

    expect(launches).toHaveLength(2);
    expect(launches[0]?.args).toContain("--resume");
    expect(launches[1]?.args).not.toContain("--resume");
    expect(session.id).toBe("fresh-after-resume-fail");
  });

  test("empty model catalog rejection retries the turn once", async () => {
    let attempt = 0;
    const { spawn, launches } = createFakeSpawn((child) => {
      attempt += 1;
      if (attempt === 1) {
        child.stderr.write("Cannot use this model: cursor-grok-4.5-high-fast. Available models:\n");
        child.emit("exit", 1, null);
        return;
      }
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "chat-after-model-retry",
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok after retry",
          session_id: "chat-after-model-retry",
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
      execModels: async () => GROK_MODELS_STDOUT,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
      model: "cursor-grok-4.5",
      thinkingOptionId: "high",
      featureValues: { [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: true },
    });
    (session as unknown as { chatId: string }).chatId = "chat-resume";

    const done = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("retry me");
    await done;

    expect(launches).toHaveLength(2);
    expect(launches[0]?.args).toContain("--resume");
    expect(launches[0]?.args).toContain("chat-resume");
    expect(launches[1]?.args).toContain("--resume");
    expect(launches[1]?.args).toContain("chat-resume");
    expect(launches[1]?.args).toContain("cursor-grok-4.5-high-fast");
  });

  test("empty model catalog rejection formats the final error after retry fails", async () => {
    const { spawn } = createFakeSpawn((child) => {
      child.stderr.write("Cannot use this model: cursor-grok-4.5-high-fast. Available models:\n");
      child.emit("exit", 1, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
      execModels: async () => GROK_MODELS_STDOUT,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
      model: "cursor-grok-4.5",
      thinkingOptionId: "high",
      featureValues: { [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: true },
    });

    const done = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_failed"),
    );
    await session.startTurn("still broken");
    const events = await done;
    const failed = events.find((event) => event.type === "turn_failed") as {
      error?: string;
    };
    expect(failed.error).toContain("empty model catalog");
    expect(failed.error).toContain("cursor-grok-4.5-high-fast");
  });

  test("listFeatures exposes composer-managed auto_accept", async () => {
    const client = new CursorPrintAgentClient({ logger: createTestLogger() });
    await expect(
      client.listFeatures({
        provider: CURSOR_PRINT_PROVIDER_ID,
        cwd: "/tmp/project",
        featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: true },
      }),
    ).resolves.toEqual([
      buildCursorPrintAutoAcceptFeature({
        provider: CURSOR_PRINT_PROVIDER_ID,
        cwd: "/tmp/project",
        featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: true },
      }),
    ]);
  });

  test("listFeatures exposes fast_mode when the selected model has fast variants", async () => {
    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      execModels: async () => GROK_MODELS_STDOUT,
    });
    const features = await client.listFeatures({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      model: "cursor-grok-4.5",
      featureValues: {
        [ACP_AUTO_ACCEPT_FEATURE_ID]: false,
        [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: true,
      },
    });
    expect(features.map((feature) => feature.id)).toEqual([
      ACP_AUTO_ACCEPT_FEATURE_ID,
      CURSOR_PRINT_FAST_MODE_FEATURE_ID,
    ]);
    expect(features[1]).toMatchObject({
      type: "toggle",
      id: CURSOR_PRINT_FAST_MODE_FEATURE_ID,
      value: true,
    });
  });

  test("startTurn passes the concrete wire model for effort + fast", async () => {
    const { spawn, launches } = createFakeSpawn((child) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "chat-wire",
          model: "cursor-grok-4.5-low-fast",
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          session_id: "chat-wire",
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
      execModels: async () => GROK_MODELS_STDOUT,
      runtimeSettings: {
        command: { mode: "replace", argv: ["/bin/agent"] },
      },
    });

    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "auto-review",
      model: "cursor-grok-4.5",
      thinkingOptionId: "low",
      featureValues: { [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: true },
    });

    const done = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("go");
    await done;

    expect(launches[0]?.args).toContain("--model");
    expect(launches[0]?.args[launches[0]!.args.indexOf("--model") + 1]).toBe(
      "cursor-grok-4.5-low-fast",
    );
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      model: "cursor-grok-4.5",
      thinkingOptionId: "low",
    });
  });

  test("system/init display label must not become --model on the next turn", async () => {
    const { spawn, launches } = createFakeSpawn((child, launch) => {
      const resumeIdx = launch.args.indexOf("--resume");
      const sessionId = resumeIdx >= 0 ? String(launch.args[resumeIdx + 1]) : "chat-label";
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: sessionId,
          // Real Cursor CLI reports the human label here, not the wire id.
          model: "Cursor Grok 4.5 High Fast",
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          session_id: sessionId,
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
      execModels: async () => GROK_MODELS_STDOUT,
      runtimeSettings: {
        command: { mode: "replace", argv: ["/bin/agent"] },
      },
    });

    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "auto-review",
      model: "cursor-grok-4.5",
      thinkingOptionId: "high",
      featureValues: { [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: true },
    });

    const firstDone = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("first");
    await firstDone;

    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      model: "cursor-grok-4.5",
      thinkingOptionId: "high",
    });
    expect(session.describePersistence()?.metadata).toMatchObject({
      model: "cursor-grok-4.5",
    });

    const secondDone = collectUntil(
      session,
      (events) => events.filter((event) => event.type === "turn_completed").length >= 1,
    );
    await session.startTurn("second");
    await secondDone;

    expect(launches).toHaveLength(2);
    for (const launch of launches) {
      const modelIdx = launch.args.indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(launch.args[modelIdx + 1]).toBe("cursor-grok-4.5-high-fast");
      expect(launch.args[modelIdx + 1]).not.toMatch(/Cursor Grok/);
    }
  });

  test("normalizeCursorPrintSessionConfig recovers display labels via catalog", () => {
    const catalog = groupCursorPrintModels(
      [
        { id: "cursor-grok-4.5-high", label: "Cursor Grok 4.5" },
        { id: "cursor-grok-4.5-high-fast", label: "Cursor Grok 4.5 Fast" },
      ],
      CURSOR_PRINT_PROVIDER_ID,
    );
    expect(
      normalizeCursorPrintSessionConfig(
        {
          provider: CURSOR_PRINT_PROVIDER_ID,
          cwd: "/tmp/project",
          model: "Cursor Grok 4.5 High Fast",
        },
        catalog[0],
        catalog,
      ),
    ).toMatchObject({
      model: "cursor-grok-4.5",
      thinkingOptionId: "high",
      featureValues: { [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: true },
    });
  });

  test("setModel rejects after the cursor-print session has started", async () => {
    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      execModels: async () => GROK_MODELS_STDOUT,
      spawn: createFakeSpawn(() => undefined).spawn,
      runtimeSettings: {
        command: { mode: "replace", argv: ["/bin/agent"] },
      },
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      model: "composer-2.5",
    });
    await session.setModel("cursor-grok-4.5");
    expect(await session.getRuntimeInfo()).toMatchObject({ model: "cursor-grok-4.5" });

    (session as unknown as { chatId: string }).chatId = "chat-locked";
    await expect(session.setModel("composer-2.5")).rejects.toThrow(
      /does not support changing the model after the session has started/,
    );
    await expect(session.setThinkingOption?.("low")).rejects.toThrow(
      /does not support changing thinking\/effort after the session has started/,
    );
    await expect(session.setFeature(CURSOR_PRINT_FAST_MODE_FEATURE_ID, true)).rejects.toThrow(
      /does not support changing fast mode after the session has started/,
    );
  });

  test("normalizeCursorPrintSessionConfig collapses legacy wire ids", () => {
    const [catalogModel] = groupCursorPrintModels(
      [
        { id: "cursor-grok-4.5-high", label: "Cursor Grok 4.5" },
        { id: "cursor-grok-4.5-high-fast", label: "Cursor Grok 4.5 Fast" },
        { id: "cursor-grok-4.5-low", label: "Cursor Grok 4.5 Low" },
      ],
      CURSOR_PRINT_PROVIDER_ID,
    );
    expect(
      normalizeCursorPrintSessionConfig(
        {
          provider: CURSOR_PRINT_PROVIDER_ID,
          cwd: "/tmp/project",
          model: "cursor-grok-4.5-high-fast",
        },
        catalogModel,
      ),
    ).toMatchObject({
      model: "cursor-grok-4.5",
      thinkingOptionId: "high",
      featureValues: { [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: true },
    });
  });

  test("setModel clears stale fast_mode when switching to a non-fast wire id", async () => {
    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      execModels: async () => GROK_MODELS_STDOUT,
      spawn: createFakeSpawn(() => undefined).spawn,
      runtimeSettings: {
        command: { mode: "replace", argv: ["/bin/agent"] },
      },
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      model: "composer-2.5-fast",
    });
    expect(
      session.features.some(
        (f) => f.id === CURSOR_PRINT_FAST_MODE_FEATURE_ID && f.type === "toggle" && f.value,
      ),
    ).toBe(true);

    await session.setModel("cursor-grok-4.5-high");
    const fast = session.features.find((f) => f.id === CURSOR_PRINT_FAST_MODE_FEATURE_ID);
    expect(fast).toMatchObject({ type: "toggle", value: false });
    expect(await session.getRuntimeInfo()).toMatchObject({
      model: "cursor-grok-4.5",
      thinkingOptionId: "high",
    });
  });

  test("describePersistence stores base model + thinking + fast after wire normalize", async () => {
    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      execModels: async () => GROK_MODELS_STDOUT,
      spawn: createFakeSpawn(() => undefined).spawn,
      runtimeSettings: {
        command: { mode: "replace", argv: ["/bin/agent"] },
      },
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      model: "cursor-grok-4.5-low-fast",
    });
    (session as unknown as { chatId: string }).chatId = "persist-1";
    expect(session.describePersistence()).toMatchObject({
      sessionId: "persist-1",
      metadata: {
        cwd: "/tmp/project",
        model: "cursor-grok-4.5",
        thinkingOptionId: "low",
        featureValues: { [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: true },
      },
    });
  });

  test("auto_accept feature auto-approves interaction_query in default mode", async () => {
    const stdinChunks: string[] = [];
    const { spawn } = createFakeSpawn((child) => {
      child.stdin.on("data", (chunk: Buffer | string) => {
        stdinChunks.push(String(chunk));
      });
      child.stdout.write(
        `${JSON.stringify({
          type: "interaction_query",
          subtype: "request",
          query_type: "shellRequestQuery",
          query: {
            id: 9,
            shellRequestQuery: { args: { command: "pwd" } },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          session_id: "chat-auto",
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "default",
      featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: true },
    });

    expect(session.features).toEqual([
      buildCursorPrintAutoAcceptFeature({
        provider: CURSOR_PRINT_PROVIDER_ID,
        cwd: "/tmp/project",
        featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: true },
      }),
    ]);

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("pwd");
    const events = await eventsPromise;

    expect(events.some((event) => event.type === "permission_requested")).toBe(false);
    await vi.waitFor(() => {
      expect(stdinChunks.join("")).toContain('"approved"');
    });
  });

  test("setFeature enables mid-session auto-approve before the next turn", async () => {
    const stdinChunks: string[] = [];
    const { spawn } = createFakeSpawn((child) => {
      child.stdin.on("data", (chunk: Buffer | string) => {
        stdinChunks.push(String(chunk));
      });
      child.stdout.write(
        `${JSON.stringify({
          type: "interaction_query",
          subtype: "request",
          query_type: "shellRequestQuery",
          query: {
            id: 11,
            shellRequestQuery: { args: { command: "ls" } },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          session_id: "chat-set-feature",
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "default",
    });
    await session.setFeature?.(ACP_AUTO_ACCEPT_FEATURE_ID, true);

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("ls");
    const events = await eventsPromise;

    expect(events.some((event) => event.type === "permission_requested")).toBe(false);
    await vi.waitFor(() => {
      expect(stdinChunks.join("")).toContain('"approved"');
    });
  });

  test("buildCursorPrintCliPrompt keeps only per-agent systemPrompt (no guidance body)", () => {
    const prompt = buildCursorPrintCliPrompt("do the thing", {
      systemPrompt: "Agent system",
      daemonAppendSystemPrompt: "Daemon append",
    });
    expect(CURSOR_PRINT_RUNTIME_GUIDANCE).toContain("--plugin-dir");
    expect(CURSOR_PRINT_RUNTIME_GUIDANCE).toContain("ask_question");
    expect(CURSOR_PRINT_RUNTIME_GUIDANCE).toContain("paseo question wait");
    expect(CURSOR_PRINT_RUNTIME_GUIDANCE).toContain("paseo question create");
    expect(CURSOR_PRINT_RUNTIME_GUIDANCE).toContain("$PASEO_AGENT_ID");
    expect(CURSOR_PRINT_RUNTIME_GUIDANCE).toContain("AskUserQuestion");
    expect(CURSOR_PRINT_RUNTIME_GUIDANCE).toContain("do not call ask_question again");
    // Host guidance is injected via ~/AGENTS.md managed block at daemon boot.
    expect(prompt).toBe("Agent system\n\ndo the thing");
    expect(prompt).not.toContain(CURSOR_PRINT_RUNTIME_GUIDANCE);
    expect(prompt).not.toContain("Daemon append");
    expect(prompt).not.toContain("paseo_guidance");
  });

  test("global AGENTS.md path defaults under home", () => {
    const prev = process.env.PASEO_CURSOR_PRINT_AGENTS_FILE;
    delete process.env.PASEO_CURSOR_PRINT_AGENTS_FILE;
    try {
      expect(resolveCursorPrintGlobalAgentsPath()).toMatch(/AGENTS\.md$/);
    } finally {
      if (prev === undefined) {
        delete process.env.PASEO_CURSOR_PRINT_AGENTS_FILE;
      } else {
        process.env.PASEO_CURSOR_PRINT_AGENTS_FILE = prev;
      }
    }
  });

  test("writeCursorPrintGlobalAgentsBlock upserts managed block without clobbering other content", () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-agents-"));
    const agentsPath = join(dir, "AGENTS.md");
    try {
      writeFileSync(agentsPath, "# Keep me\n\nUser notes.\n", "utf8");
      writeCursorPrintGlobalAgentsBlock("first body", agentsPath);
      const once = readFileSync(agentsPath, "utf8");
      expect(once).toContain("# Keep me");
      expect(once).toContain("User notes.");
      expect(once).toContain(CURSOR_PRINT_AGENTS_BLOCK_BEGIN);
      expect(once).toContain("first body");
      expect(once).toContain(CURSOR_PRINT_AGENTS_BLOCK_END);

      writeCursorPrintGlobalAgentsBlock("second body", agentsPath);
      const twice = readFileSync(agentsPath, "utf8");
      expect(twice).toContain("# Keep me");
      expect(twice).toContain("second body");
      expect(twice).not.toContain("first body");
      expect(twice).toBe(
        `# Keep me\n\nUser notes.\n\n${buildCursorPrintAgentsBlock("second body")}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("daemon boot writes AGENTS.md managed block; CLI has no pointer", async () => {
    const prevAgents = process.env.PASEO_CURSOR_PRINT_AGENTS_FILE;
    const dir = mkdtempSync(join(tmpdir(), "paseo-cursor-prompt-"));
    const agentsPath = join(dir, "AGENTS.md");
    process.env.PASEO_CURSOR_PRINT_AGENTS_FILE = agentsPath;
    try {
      const written = await writeCursorPrintGuidanceFileForDaemon({
        appendSystemPrompt: "Host append",
        includeProseStopPrevention: true,
        agentsPath,
      });
      expect(written.agentsPath).toBe(agentsPath);
      const agents = readFileSync(agentsPath, "utf8");
      expect(agents).toContain(CURSOR_PRINT_RUNTIME_GUIDANCE);
      expect(agents).toContain("Host append");
      expect(agents).toContain("Knowledge bases (read-only)");
      expect(agents).toContain("/paseo-vfs/<mountSlug>/");
      expect(agents).toContain("Mount knowledge bases");
      expect(agents).toContain("Decisions (Paseo)");
      expect(agents).toContain(CURSOR_PRINT_AGENTS_BLOCK_BEGIN);
      expect(readCursorPrintGuidanceMarkdown(agentsPath)).toContain("Host append");

      const { spawn, launches } = createFakeSpawn((child) => {
        child.stdout.write(
          `${JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
            session_id: "chat-guidance",
          })}\n`,
        );
        child.emit("exit", 0, null);
      });

      const client = new CursorPrintAgentClient({
        logger: createTestLogger(),
        spawn,
      });
      const session = await client.createSession({
        provider: CURSOR_PRINT_PROVIDER_ID,
        cwd: "/tmp/project",
        modeId: "force",
        systemPrompt: "Be concise.",
      });

      const before = readFileSync(agentsPath, "utf8");
      const eventsPromise = collectUntil(session, (events) =>
        events.some((event) => event.type === "turn_completed"),
      );
      await session.startTurn("list files");
      const events = await eventsPromise;

      expect(readFileSync(agentsPath, "utf8")).toBe(before);
      expect(launches[0]?.args.at(-1)).toBe(
        buildCursorPrintCliPrompt("list files", { systemPrompt: "Be concise." }),
      );
      expect(launches[0]?.args.at(-1)).toContain("Be concise.");
      expect(launches[0]?.args.at(-1)).not.toContain("paseo_guidance");
      expect(launches[0]?.args.at(-1)).not.toContain("Paseo cursor-print");
      expect(before).not.toContain("Be concise.");

      const args = launches[0]?.args ?? [];
      expect(args).not.toContain("--plugin-dir");
      expect(args).not.toContain("--approve-mcps");

      const userEvent = events.find(
        (event) =>
          event.type === "timeline" && (event.item as { type?: string }).type === "user_message",
      ) as { item: { text: string } };
      expect(userEvent.item.text).toBe("list files");
      expect(userEvent.item.text).not.toContain("Paseo cursor-print");

      await session.close();
    } finally {
      if (prevAgents === undefined) {
        delete process.env.PASEO_CURSOR_PRINT_AGENTS_FILE;
      } else {
        process.env.PASEO_CURSOR_PRINT_AGENTS_FILE = prevAgents;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("startTurn emits canonical user_message with clientMessageId", async () => {
    const { spawn } = createFakeSpawn((child) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          session_id: "chat-user",
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
    });

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("please read note", { clientMessageId: "client-msg-1" });
    const events = await eventsPromise;

    const userEvent = events.find(
      (event) =>
        event.type === "timeline" && (event.item as { type?: string }).type === "user_message",
    ) as {
      item: { type: string; text: string; messageId?: string; clientMessageId?: string };
    };
    expect(userEvent?.item).toMatchObject({
      type: "user_message",
      text: "please read note",
      clientMessageId: "client-msg-1",
    });
    expect(typeof userEvent?.item.messageId).toBe("string");
  });

  test("CreatePlan completion emits an execute question after turn completes", async () => {
    const { spawn } = createFakeSpawn((child) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "tool_call",
          subtype: "completed",
          call_id: "call-create-plan",
          tool_call: {
            createPlanToolCall: {
              args: {
                name: "hooks parity",
                plan: "- Step one\n- Step two",
              },
              result: { success: {} },
            },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "chat-plan-1",
          result: "ok",
        })}\n`,
      );
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
    });

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "permission_requested"),
    );
    await session.startTurn("draft a plan");
    const events = await eventsPromise;

    const toolEvent = events.find(
      (event) =>
        event.type === "timeline" &&
        (event.item as { type?: string; name?: string }).type === "tool_call" &&
        (event.item as { name?: string }).name === "CreatePlan",
    ) as {
      item: { type: string; name: string; detail: { type: string; text?: string } };
    };
    expect(toolEvent?.item).toMatchObject({
      name: "CreatePlan",
      detail: { type: "plan", text: "- Step one\n- Step two" },
    });

    const permission = events.find((event) => event.type === "permission_requested") as {
      request: { id: string; kind: string; name: string; input: { plan?: string } };
    };
    expect(permission.request).toMatchObject({
      kind: "question",
      name: "AskUserQuestion",
      id: expect.stringMatching(/^plan-execute-question-/),
    });
    expect(permission.request.input.plan).toContain("Step one");
    expect(session.getPendingPermissions()).toHaveLength(1);

    const result = await session.respondToPermission(permission.request.id, {
      behavior: "allow",
      updatedInput: {
        answers: { Execute: "Execute" },
      },
    });
    expect(result?.followUpPrompt).toEqual(expect.stringContaining("Step one"));
    expect(await session.getCurrentMode()).toBe("force");
    expect(session.getPendingPermissions()).toHaveLength(0);
  });

  test("CreatePlan execute from plan mode switches to auto-review", async () => {
    const { spawn } = createFakeSpawn((child) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "tool_call",
          subtype: "completed",
          call_id: "call-create-plan-2",
          tool_call: {
            createPlanToolCall: {
              args: { plan: "- Do the thing" },
              result: { success: {} },
            },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "chat-plan-2",
          result: "ok",
        })}\n`,
      );
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "plan",
    });

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "permission_requested"),
    );
    await session.startTurn("plan first");
    const events = await eventsPromise;
    const permission = events.find((event) => event.type === "permission_requested") as {
      request: { id: string };
    };

    await session.respondToPermission(permission.request.id, {
      behavior: "allow",
      updatedInput: { answers: { Execute: "Execute" } },
    });
    expect(await session.getCurrentMode()).toBe("auto-review");
  });

  test("a later user message dismisses an unanswered plan-execute question", async () => {
    let launches = 0;
    const { spawn } = createFakeSpawn((child) => {
      launches += 1;
      if (launches === 1) {
        child.stdout.write(
          `${JSON.stringify({
            type: "tool_call",
            subtype: "completed",
            call_id: "call-create-plan-3",
            tool_call: {
              createPlanToolCall: {
                args: { plan: "- Sweep paths" },
                result: { success: {} },
              },
            },
          })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "chat-plan-3",
            result: "ok",
          })}\n`,
        );
        return;
      }
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "chat-plan-3",
          result: "ok",
        })}\n`,
      );
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event as { type: string; [key: string]: unknown });
    });

    const firstPromise = collectUntil(session, (collected) =>
      collected.some((event) => event.type === "permission_requested"),
    );
    await session.startTurn("draft");
    await firstPromise;
    expect(session.getPendingPermissions()).toHaveLength(1);

    const secondPromise = collectUntil(
      session,
      (collected) => collected.filter((event) => event.type === "turn_completed").length >= 1,
    );
    await session.startTurn("do something else");
    await secondPromise;
    unsubscribe();

    expect(session.getPendingPermissions()).toHaveLength(0);
    expect(
      events.some(
        (event) =>
          event.type === "permission_resolved" &&
          (event.resolution as { behavior?: string })?.behavior === "deny" &&
          String(event.requestId).startsWith("plan-execute-question-"),
      ),
    ).toBe(true);
  });

  test("plan mode surfaces interaction_query even when auto_accept is on", async () => {
    let childRef: FakeChild | null = null;
    const { spawn } = createFakeSpawn((child) => {
      childRef = child;
      child.stdout.write(
        `${JSON.stringify({
          type: "interaction_query",
          subtype: "request",
          query_type: "webFetchRequestQuery",
          query: {
            id: 4,
            webFetchRequestQuery: {
              args: { url: "https://example.com" },
            },
          },
        })}\n`,
      );
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "plan",
      featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: true },
    });

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "permission_requested"),
    );
    await session.startTurn("fetch example");
    const events = await eventsPromise;
    const permission = events.find((event) => event.type === "permission_requested") as {
      request: { id: string; name: string; detail: { type: string; url?: string } };
    };
    expect(permission.request).toMatchObject({
      name: "WebFetch",
      detail: { type: "fetch", url: "https://example.com" },
    });
    expect(session.getPendingPermissions()).toHaveLength(1);

    const stdinChunks: string[] = [];
    childRef?.stdin.on("data", (chunk: Buffer | string) => {
      stdinChunks.push(String(chunk));
    });
    await session.respondToPermission(permission.request.id, { behavior: "allow" });
    await vi.waitFor(() => {
      expect(stdinChunks.join("")).toContain('"approved"');
    });
    expect(session.getPendingPermissions()).toHaveLength(0);
  });

  test("keeps concurrent interaction_query permissions until each is resolved", async () => {
    let childRef: FakeChild | null = null;
    const { spawn } = createFakeSpawn((child) => {
      childRef = child;
      child.stdout.write(
        `${JSON.stringify({
          type: "interaction_query",
          subtype: "request",
          query_type: "shellRequestQuery",
          query: {
            id: 1,
            shellRequestQuery: { args: { command: "echo one" } },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "interaction_query",
          subtype: "request",
          query_type: "shellRequestQuery",
          query: {
            id: 2,
            shellRequestQuery: { args: { command: "echo two" } },
          },
        })}\n`,
      );
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "default",
    });

    const eventsPromise = collectUntil(
      session,
      (events) => events.filter((event) => event.type === "permission_requested").length >= 2,
    );
    await session.startTurn("run two shells");
    await eventsPromise;
    expect(
      session
        .getPendingPermissions()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["shellRequestQuery:1", "shellRequestQuery:2"]);

    const stdinChunks: string[] = [];
    childRef?.stdin.on("data", (chunk: Buffer | string) => {
      stdinChunks.push(String(chunk));
    });
    await session.respondToPermission("shellRequestQuery:2", { behavior: "allow" });
    await session.respondToPermission("shellRequestQuery:1", {
      behavior: "deny",
      message: "nope",
    });
    await vi.waitFor(() => {
      const joined = stdinChunks.join("");
      expect(joined).toContain('"id":2');
      expect(joined).toContain('"id":1');
      expect(joined).toContain('"approved"');
      expect(joined).toContain('"rejected"');
    });
    expect(session.getPendingPermissions()).toHaveLength(0);
  });

  test("interrupt denies pending permissions and emits permission_resolved", async () => {
    const { spawn } = createFakeSpawn((child) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "interaction_query",
          subtype: "request",
          query_type: "shellRequestQuery",
          query: {
            id: 8,
            shellRequestQuery: { args: { command: "sleep 30" } },
          },
        })}\n`,
      );
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "default",
    });

    const pendingPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "permission_requested"),
    );
    await session.startTurn("sleep");
    await pendingPromise;

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event as { type: string; [key: string]: unknown });
    });
    await session.interrupt();
    unsubscribe();

    expect(events.some((event) => event.type === "permission_resolved")).toBe(true);
    expect(events.some((event) => event.type === "turn_canceled")).toBe(true);
    expect(session.getPendingPermissions()).toHaveLength(0);
  });

  test("force mode auto-approves interaction_query without emitting permission", async () => {
    const stdinChunks: string[] = [];
    const { spawn } = createFakeSpawn((child) => {
      child.stdin.on("data", (chunk: Buffer | string) => {
        stdinChunks.push(String(chunk));
      });
      child.stdout.write(
        `${JSON.stringify({
          type: "interaction_query",
          subtype: "request",
          query_type: "shellRequestQuery",
          query: {
            id: 3,
            shellRequestQuery: { args: { command: "pwd" } },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          session_id: "chat-3",
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
    });

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("pwd");
    const events = await eventsPromise;

    expect(events.some((event) => event.type === "permission_requested")).toBe(false);
    await vi.waitFor(() => {
      expect(stdinChunks.join("")).toContain('"approved"');
    });
  });

  test("convertCursorPrintPrompt prefers an existing wire path over rematerializing", () => {
    const onDisk = convertCursorPrintPrompt([
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);
    expect(onDisk.imagePaths).toHaveLength(1);
    const existingPath = onDisk.imagePaths[0]!;

    const reused = convertCursorPrintPrompt([
      {
        type: "image",
        data: "not-the-same-bytes",
        mimeType: "image/png",
        path: existingPath,
      },
    ]);
    expect(reused.imagePaths).toEqual([existingPath]);
    expect(reused.timelineText).toBe("");
    expect(reused.wireText).toBe(`@${existingPath}`);
  });

  test("convertCursorPrintPrompt keeps timeline text raw and puts @path only on the wire", () => {
    const first = convertCursorPrintPrompt([
      { type: "text", text: "look at these" },
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
      { type: "image", data: RED_ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);

    expect(first.imagePaths).toHaveLength(2);
    expect(first.imagePaths[0]).not.toEqual(first.imagePaths[1]);
    expect(first.timelineText).toBe("look at these");
    expect(first.wireText).toBe(
      ["look at these", `@${first.imagePaths[0]}`, `@${first.imagePaths[1]}`].join("\n\n"),
    );
    for (const imagePath of first.imagePaths) {
      expect(existsSync(imagePath)).toBe(true);
      expect(imagePath).toMatch(/paseo-attachments(?:-[^/\\]+)?[/\\].+\.png$/);
    }

    const second = convertCursorPrintPrompt([
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);
    expect(second.imagePaths).toEqual([first.imagePaths[0]]);
    expect(second.timelineText).toBe("");
    expect(second.wireText).toBe(`@${first.imagePaths[0]}`);
  });

  test("isCursorEmptyModelCatalogFailure / formatCursorPrintModelRejection", () => {
    expect(
      isCursorEmptyModelCatalogFailure(
        "Cannot use this model: cursor-grok-4.5-high-fast. Available models:",
      ),
    ).toBe(true);
    expect(
      isCursorEmptyModelCatalogFailure(
        "Cannot use this model: cursor-grok-4.5-high-fast. Available models: auto, composer-2.5",
      ),
    ).toBe(false);
    expect(isCursorEmptyModelCatalogFailure("network timeout")).toBe(false);

    expect(
      formatCursorPrintModelRejection(
        "Cannot use this model: cursor-grok-4.5-high-fast. Available models:",
      ),
    ).toContain("empty model catalog");
    expect(
      formatCursorPrintModelRejection(
        "Cannot use this model: Cursor Grok 4.5 High Fast. Available models: auto, composer-2.5, gpt-5.5",
      ),
    ).toMatch(/^Cursor rejected model Cursor Grok 4\.5 High Fast\. Available:/);
  });

  test("buildTurnArgs repeats --image for each materialized path", () => {
    const args = buildTurnArgs({
      extraArgs: [],
      modeId: "force",
      model: "composer-2.5",
      resumeChatId: null,
      workspace: "/tmp/project",
      prompt: "see images",
      imagePaths: ["/tmp/a.png", "/tmp/b.png"],
    });

    expect(args).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--force",
      "--model",
      "composer-2.5",
      "--image",
      "/tmp/a.png",
      "--image",
      "/tmp/b.png",
      "--workspace",
      "/tmp/project",
      "--",
      "see images",
    ]);
  });

  test("buildTurnArgs adds --plugin-dir and optional --approve-mcps", () => {
    expect(
      buildTurnArgs({
        extraArgs: [],
        modeId: "auto-review",
        model: "composer-2.5",
        resumeChatId: null,
        workspace: "/tmp/project",
        prompt: "hi",
        pluginDirs: ["/tmp/plugin-a", "/tmp/plugin-b"],
        approveMcps: true,
      }),
    ).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--auto-review",
      "--plugin-dir",
      "/tmp/plugin-a",
      "--plugin-dir",
      "/tmp/plugin-b",
      "--approve-mcps",
      "--model",
      "composer-2.5",
      "--workspace",
      "/tmp/project",
      "--",
      "hi",
    ]);

    expect(
      buildTurnArgs({
        extraArgs: [],
        modeId: "auto-review",
        model: "composer-2.5",
        resumeChatId: null,
        workspace: "/tmp/project",
        prompt: "hi",
        pluginDirs: ["/tmp/plugin-rules-only"],
      }),
    ).not.toContain("--approve-mcps");
  });

  test("startTurn materializes MCP plugin-dir from config.mcpServers and cleans up on close", async () => {
    const { spawn, launches } = createFakeSpawn((child) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "chat-mcp",
          model: "composer-2.5",
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          session_id: "chat-mcp",
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
      execModels: async () => GROK_MODELS_STDOUT,
      runtimeSettings: {
        command: { mode: "replace", argv: ["/bin/agent"] },
      },
    });
    expect(client.capabilities.supportsMcpServers).toBe(true);

    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
      model: "composer-2.5",
      mcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("use ask_question");
    await eventsPromise;

    expect(launches).toHaveLength(1);
    const args = launches[0]?.args ?? [];
    const pluginDirIndex = args.indexOf("--plugin-dir");
    expect(pluginDirIndex).toBeGreaterThanOrEqual(0);
    const pluginDir = args[pluginDirIndex + 1];
    expect(typeof pluginDir).toBe("string");
    expect(args).toContain("--approve-mcps");
    expect(existsSync(join(pluginDir!, ".mcp.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(pluginDir!, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });
    expect(existsSync(join(pluginDir!, "rules"))).toBe(false);

    await session.close();
    expect(existsSync(pluginDir!)).toBe(false);
  });

  test("startTurn passes --image paths for prompt image blocks", async () => {
    const { spawn, launches } = createFakeSpawn((child) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "chat-img",
          model: "composer-2.5",
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          session_id: "chat-img",
        })}\n`,
      );
      child.emit("exit", 0, null);
    });

    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      spawn,
      execModels: async () => GROK_MODELS_STDOUT,
      runtimeSettings: {
        command: { mode: "replace", argv: ["/bin/agent"] },
      },
    });
    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
      model: "composer-2.5",
    });

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn([
      { type: "text", text: "what tickets are in the screenshot?" },
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
      { type: "image", data: RED_ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);
    const events = await eventsPromise;

    expect(launches).toHaveLength(1);
    const args = launches[0]?.args ?? [];
    const imageFlags = args.flatMap((arg, index) =>
      arg === "--image" && typeof args[index + 1] === "string" ? [args[index + 1]!] : [],
    );
    expect(imageFlags).toHaveLength(2);
    expect(imageFlags[0]).not.toEqual(imageFlags[1]);
    const promptArg = args.at(-1) ?? "";
    expect(promptArg).toContain("what tickets are in the screenshot?");
    expect(promptArg).toContain(`@${imageFlags[0]}`);
    expect(promptArg).toContain(`@${imageFlags[1]}`);
    expect(JSON.stringify(args)).not.toContain(ONE_BY_ONE_PNG_BASE64);

    const userEvent = events.find(
      (event) =>
        event.type === "timeline" && (event.item as { type?: string }).type === "user_message",
    ) as { item: { text: string } };
    expect(userEvent.item.text).toBe("what tickets are in the screenshot?");
    expect(userEvent.item.text).not.toContain("@");
    expect(userEvent.item.text).not.toContain(imageFlags[0]!);
  });
});

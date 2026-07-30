/* eslint-disable max-nested-callbacks -- fake spawn + event collectors nest naturally */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  CURSOR_PRINT_DEFAULT_MODE_ID,
  CURSOR_PRINT_PROVIDER_ID,
  CURSOR_PRINT_RUNTIME_GUIDANCE,
  CursorPrintAgentClient,
  buildCursorPrintAutoAcceptFeature,
  buildCursorPrintCliPrompt,
  type CursorPrintLaunch,
  type CursorPrintSpawn,
} from "./cursor-print-agent.js";
import { ACP_AUTO_ACCEPT_FEATURE_ID } from "./acp-agent.js";

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
  test("fetchCatalog parses agent models output", async () => {
    const client = new CursorPrintAgentClient({
      logger: createTestLogger(),
      execModels: async () =>
        [
          "Available models",
          "composer-2 - Composer 2  (current)",
          "gpt-5.4 - GPT-5.4",
          "Tip: use --model",
        ].join("\n"),
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/project", force: false }),
    ).resolves.toMatchObject({
      defaultModeId: CURSOR_PRINT_DEFAULT_MODE_ID,
      models: [
        {
          provider: CURSOR_PRINT_PROVIDER_ID,
          id: "composer-2",
          label: "Composer 2",
          isDefault: true,
        },
        {
          provider: CURSOR_PRINT_PROVIDER_ID,
          id: "gpt-5.4",
          label: "GPT-5.4",
        },
      ],
    });
  });

  test("startTurn launches print/stream-json with force + resume", async () => {
    const { spawn, launches } = createFakeSpawn((child) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "chat-1",
          model: "composer-2",
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
      runtimeSettings: {
        command: { mode: "replace", argv: ["/bin/agent"] },
      },
    });

    const session = await client.createSession({
      provider: CURSOR_PRINT_PROVIDER_ID,
      cwd: "/tmp/project",
      modeId: "force",
      model: "composer-2",
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
    expect(launches[0]?.args.slice(0, -1)).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--force",
      "--resume",
      "chat-1",
      "--model",
      "composer-2",
      "--workspace",
      "/tmp/project",
      "--",
    ]);
    expect(launches[0]?.args.at(-1)).toBe(buildCursorPrintCliPrompt("hello"));

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

  test("buildCursorPrintCliPrompt prepends runtime guidance and system prompts", () => {
    const prompt = buildCursorPrintCliPrompt("do the thing", {
      systemPrompt: "Agent system",
      daemonAppendSystemPrompt: "Daemon append",
    });
    expect(prompt.startsWith(CURSOR_PRINT_RUNTIME_GUIDANCE)).toBe(true);
    expect(prompt).toContain("Agent system");
    expect(prompt).toContain("Daemon append");
    expect(prompt.endsWith("do the thing")).toBe(true);
  });

  test("CLI prompt includes guidance but timeline user_message stays raw", async () => {
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

    const eventsPromise = collectUntil(session, (events) =>
      events.some((event) => event.type === "turn_completed"),
    );
    await session.startTurn("list files");
    const events = await eventsPromise;

    expect(launches[0]?.args.at(-1)).toBe(
      buildCursorPrintCliPrompt("list files", { systemPrompt: "Be concise." }),
    );
    const userEvent = events.find(
      (event) =>
        event.type === "timeline" && (event.item as { type?: string }).type === "user_message",
    ) as { item: { text: string } };
    expect(userEvent.item.text).toBe("list files");
    expect(userEvent.item.text).not.toContain("Paseo cursor-print");
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
});

import pino from "pino";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { Session, __resetInFlightDifftInstallForTests } from "./session.js";
import type { SessionOptions } from "./session.js";
import {
  asAgentManager,
  asAgentStorage,
  asDownloadTokenStore,
  asPushTokenStore,
  asChatService,
  asScheduleService,
  asLoopService,
  asCheckoutDiffManager,
  asGitHubService,
  asWorkspaceGitService,
  asDaemonConfigStore,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";

const installerMocks = vi.hoisted(() => ({
  installDifft: vi.fn(),
}));

vi.mock("../utils/difftastic-installer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/difftastic-installer.js")>();
  return { ...actual, installDifft: installerMocks.installDifft };
});

function createSessionForTest(messages: unknown[]): Session {
  const logger = pino({ level: "silent" });
  return new Session({
    clientId: "test-client",
    onMessage: (message) => messages.push(message),
    logger,
    downloadTokenStore: asDownloadTokenStore(),
    pushTokenStore: asPushTokenStore(),
    paseoHome: "/tmp/paseo-home",
    agentManager: asAgentManager({
      listAgents: vi.fn(() => []),
      subscribe: vi.fn(() => () => {}),
    }),
    agentStorage: asAgentStorage({
      list: vi.fn().mockResolvedValue([]),
    }),
    projectRegistry: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      upsert: vi.fn(),
      archive: vi.fn(),
      remove: vi.fn(),
      initialize: vi.fn(),
      existsOnDisk: vi.fn(),
    } as unknown as SessionOptions["projectRegistry"],
    workspaceRegistry: {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as SessionOptions["workspaceRegistry"],
    chatService: asChatService(),
    scheduleService: asScheduleService(),
    loopService: asLoopService(),
    checkoutDiffManager: asCheckoutDiffManager({ scheduleRefreshForCwd: vi.fn() }),
    github: asGitHubService({ invalidate: vi.fn() }),
    workspaceGitService: asWorkspaceGitService({}),
    daemonConfigStore: asDaemonConfigStore({
      get: vi.fn(() => ({ mcp: { injectIntoAgents: false }, providers: {} })),
      onChange: vi.fn(() => () => {}),
    }),
    stt: null,
    tts: null,
    terminalManager: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  });
}

interface InstallResponseMessage {
  type: string;
  payload: {
    requestId: string;
    success: boolean;
    error: string | null;
    version: string | null;
  };
}

function installResponses(messages: unknown[]): InstallResponseMessage[] {
  return (messages as InstallResponseMessage[]).filter(
    (message) => message.type === "install_difftastic_response",
  );
}

describe("handleInstallDifftasticRequest dedup", () => {
  beforeEach(() => {
    installerMocks.installDifft.mockReset();
    __resetInFlightDifftInstallForTests();
  });

  test("concurrent requests share one install and each gets its own response", async () => {
    let resolveInstall: (result: { path: string; version: string }) => void = () => {};
    installerMocks.installDifft.mockImplementation(
      () =>
        new Promise<{ path: string; version: string }>((resolve) => {
          resolveInstall = resolve;
        }),
    );

    const messagesA: unknown[] = [];
    const messagesB: unknown[] = [];
    const sessionA = createSessionForTest(messagesA);
    const sessionB = createSessionForTest(messagesB);

    const pendingA = sessionA.handleMessage({
      type: "install_difftastic_request",
      requestId: "req-a",
    });
    const pendingB = sessionB.handleMessage({
      type: "install_difftastic_request",
      requestId: "req-b",
    });

    resolveInstall({ path: "/tmp/paseo-home/bin/difft", version: "0.69.0" });
    await Promise.all([pendingA, pendingB]);

    // Only one real install ran; the second request joined the in-flight promise.
    expect(installerMocks.installDifft).toHaveBeenCalledTimes(1);

    const responsesA = installResponses(messagesA);
    const responsesB = installResponses(messagesB);
    expect(responsesA).toHaveLength(1);
    expect(responsesB).toHaveLength(1);
    expect(responsesA[0].payload).toMatchObject({
      requestId: "req-a",
      success: true,
      version: "0.69.0",
    });
    expect(responsesB[0].payload).toMatchObject({
      requestId: "req-b",
      success: true,
      version: "0.69.0",
    });
  });

  test("a failed install rejects all joined requests and clears the in-flight slot", async () => {
    let rejectInstall: (error: Error) => void = () => {};
    installerMocks.installDifft.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectInstall = reject;
        }),
    );

    const messagesA: unknown[] = [];
    const messagesB: unknown[] = [];
    const sessionA = createSessionForTest(messagesA);
    const sessionB = createSessionForTest(messagesB);

    const pendingA = sessionA.handleMessage({
      type: "install_difftastic_request",
      requestId: "req-a",
    });
    const pendingB = sessionB.handleMessage({
      type: "install_difftastic_request",
      requestId: "req-b",
    });

    rejectInstall(new Error("network unreachable"));
    await Promise.all([pendingA, pendingB]);

    expect(installerMocks.installDifft).toHaveBeenCalledTimes(1);
    for (const [messages, requestId] of [
      [messagesA, "req-a"],
      [messagesB, "req-b"],
    ] as const) {
      const responses = installResponses(messages);
      expect(responses).toHaveLength(1);
      expect(responses[0].payload).toMatchObject({
        requestId,
        success: false,
        error: "network unreachable",
      });
    }

    // The shared slot is cleared, so a retry starts a fresh install.
    installerMocks.installDifft.mockResolvedValueOnce({
      path: "/tmp/paseo-home/bin/difft",
      version: "0.69.0",
    });
    await sessionA.handleMessage({
      type: "install_difftastic_request",
      requestId: "req-retry",
    });
    expect(installerMocks.installDifft).toHaveBeenCalledTimes(2);
    const retryResponses = installResponses(messagesA);
    expect(retryResponses[1].payload).toMatchObject({
      requestId: "req-retry",
      success: true,
      version: "0.69.0",
    });
  });
});

// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { useInstallDifftastic } from "./use-install-difftastic";

type Handler = (message: SessionOutboundMessage) => void;

// Minimal fake matching the slice of DaemonClient this hook touches: the generic push
// listener plus the installDifftastic RPC (omitted to simulate an older client build).
function createFakeClient(options: { withInstallMethod: boolean }) {
  const handlers: Record<string, Handler[]> = {};
  const installCalls: Array<{ requestId: string }> = [];
  let resolveInstall: (() => void) | null = null;

  const base = {
    on(type: string, handler: Handler) {
      handlers[type] = [...(handlers[type] ?? []), handler];
      return () => {
        handlers[type] = (handlers[type] ?? []).filter((candidate) => candidate !== handler);
      };
    },
    emit(message: SessionOutboundMessage) {
      for (const handler of handlers[message.type] ?? []) {
        handler(message);
      }
    },
  };

  const client = options.withInstallMethod
    ? {
        ...base,
        installDifftastic(input: { requestId: string }) {
          installCalls.push(input);
          return new Promise((resolve) => {
            resolveInstall = () =>
              resolve({
                requestId: input.requestId,
                success: true,
                error: null,
                version: "0.69.0",
              });
          });
        },
      }
    : base;

  return {
    client: client as unknown as DaemonClient,
    emit: base.emit,
    installCalls,
    resolveInstall: () => resolveInstall?.(),
  };
}

describe("useInstallDifftastic", () => {
  it("reports unsupported when the client build has no installDifftastic RPC", () => {
    const fake = createFakeClient({ withInstallMethod: false });
    const { result } = renderHook(() => useInstallDifftastic(fake.client));

    expect(result.current.isSupported).toBe(false);
    expect(result.current.status).toBe("idle");

    act(() => {
      result.current.install();
    });

    // install() no-ops when unsupported — status never leaves idle.
    expect(result.current.status).toBe("idle");
    expect(fake.installCalls).toHaveLength(0);
  });

  it("tracks progress pushes and the final response for the active request", async () => {
    const fake = createFakeClient({ withInstallMethod: true });
    const { result } = renderHook(() => useInstallDifftastic(fake.client));

    expect(result.current.isSupported).toBe(true);

    act(() => {
      result.current.install();
    });

    expect(result.current.status).toBe("starting");
    const requestId = fake.installCalls[0]?.requestId;
    expect(requestId).toBeTruthy();

    act(() => {
      fake.emit({
        type: "install_difftastic_progress",
        payload: { requestId: requestId!, phase: "downloading" },
      });
    });
    expect(result.current.status).toBe("downloading");

    act(() => {
      fake.emit({
        type: "install_difftastic_response",
        payload: { requestId: requestId!, success: true, error: null, version: "0.69.0" },
      });
      fake.resolveInstall();
    });

    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.error).toBeNull();
  });

  it("blocks re-entrant install() during every in-flight phase", () => {
    const fake = createFakeClient({ withInstallMethod: true });
    const { result } = renderHook(() => useInstallDifftastic(fake.client));

    act(() => {
      result.current.install();
    });
    const requestId = fake.installCalls[0]?.requestId;
    expect(fake.installCalls).toHaveLength(1);

    for (const phase of ["starting", "downloading", "verifying", "installing"] as const) {
      if (phase !== "starting") {
        act(() => {
          fake.emit({
            type: "install_difftastic_progress",
            payload: { requestId: requestId!, phase },
          });
        });
      }
      expect(result.current.status).toBe(phase);
      act(() => {
        result.current.install();
      });
      // Still exactly one RPC call — the guard covers the whole in-flight install.
      expect(fake.installCalls).toHaveLength(1);
    }
  });

  it("surfaces the server-reported error on failure", async () => {
    const fake = createFakeClient({ withInstallMethod: true });
    const { result } = renderHook(() => useInstallDifftastic(fake.client));

    act(() => {
      result.current.install();
    });
    const requestId = fake.installCalls[0]?.requestId;

    act(() => {
      fake.emit({
        type: "install_difftastic_response",
        payload: {
          requestId: requestId!,
          success: false,
          error: "network unreachable",
          version: null,
        },
      });
      fake.resolveInstall();
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("network unreachable");
  });

  it("ignores progress pushes tagged with a requestId from a previous request", async () => {
    const fake = createFakeClient({ withInstallMethod: true });
    const { result } = renderHook(() => useInstallDifftastic(fake.client));

    act(() => {
      result.current.install();
    });
    const firstRequestId = fake.installCalls[0]?.requestId;
    act(() => {
      fake.emit({
        type: "install_difftastic_response",
        payload: { requestId: firstRequestId!, success: true, error: null, version: "0.69.0" },
      });
      fake.resolveInstall();
    });
    await waitFor(() => expect(result.current.status).toBe("success"));

    // A late progress push from the now-finished first request must not regress status.
    act(() => {
      fake.emit({
        type: "install_difftastic_progress",
        payload: { requestId: firstRequestId!, phase: "installing" },
      });
    });
    expect(result.current.status).toBe("success");
  });
});

import { describe, expect, it } from "vitest";

import {
  applyDaemonAcpAutoAcceptDefault,
  applyOrchestratedAcpAutoAccept,
  isDaemonManagedAcpAutoAcceptProvider,
} from "./acp-auto-approve-default.js";
import { ACP_AUTO_ACCEPT_FEATURE_ID } from "./providers/acp-agent.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

describe("isDaemonManagedAcpAutoAcceptProvider", () => {
  it("includes copilot and custom extends:acp providers", () => {
    expect(isDaemonManagedAcpAutoAcceptProvider("copilot", {})).toBe(true);
    expect(isDaemonManagedAcpAutoAcceptProvider("cursor", { cursor: { extends: "acp" } })).toBe(
      true,
    );
  });

  it("excludes opencode and non-acp providers", () => {
    expect(isDaemonManagedAcpAutoAcceptProvider("opencode", {})).toBe(false);
    expect(isDaemonManagedAcpAutoAcceptProvider("codex", {})).toBe(false);
    expect(isDaemonManagedAcpAutoAcceptProvider("cursor", {})).toBe(false);
  });
});

describe("applyDaemonAcpAutoAcceptDefault", () => {
  it("adds auto_accept when daemon default is on and feature was omitted", () => {
    expect(
      applyDaemonAcpAutoAcceptDefault("cursor", { fast: "true" }, true, {
        cursor: { extends: "acp" },
      }),
    ).toEqual({ fast: "true", [ACP_AUTO_ACCEPT_FEATURE_ID]: true });
  });

  it("does not override an explicit auto_accept value", () => {
    expect(
      applyDaemonAcpAutoAcceptDefault("cursor", { [ACP_AUTO_ACCEPT_FEATURE_ID]: false }, true, {
        cursor: { extends: "acp" },
      }),
    ).toEqual({ [ACP_AUTO_ACCEPT_FEATURE_ID]: false });
  });

  it("no-ops when daemon default is unset", () => {
    expect(
      applyDaemonAcpAutoAcceptDefault("cursor", { fast: "true" }, undefined, {
        cursor: { extends: "acp" },
      }),
    ).toEqual({ fast: "true" });
  });
});

describe("applyOrchestratedAcpAutoAccept", () => {
  it("adds auto_accept for delegated agents even when daemon default is off", () => {
    expect(
      applyOrchestratedAcpAutoAccept(
        "cursor",
        { fast: "true" },
        { [PARENT_AGENT_ID_LABEL]: "parent-1" },
        { cursor: { extends: "acp" } },
      ),
    ).toEqual({ fast: "true", [ACP_AUTO_ACCEPT_FEATURE_ID]: true });
  });

  it("no-ops for foreground agents", () => {
    expect(
      applyOrchestratedAcpAutoAccept(
        "cursor",
        { fast: "true" },
        {},
        {
          cursor: { extends: "acp" },
        },
      ),
    ).toEqual({ fast: "true" });
  });
});

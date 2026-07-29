import { describe, expect, it } from "vitest";
import {
  acceptAgentDirectoryUpdate,
  prepareLiveAgentDirectoryUpdate,
} from "./agent-directory-update-policy";

describe("agent directory update policy", () => {
  it("accepts fresher snapshots wholesale", () => {
    const current = {
      status: "running",
      updatedAt: "2026-07-12T10:00:00.000Z",
    };
    const incoming = {
      status: "idle",
      updatedAt: "2026-07-12T11:00:00.000Z",
    };

    expect(acceptAgentDirectoryUpdate(current, incoming)).toEqual(incoming);
  });

  it("prepares stale idle resume updates so lifecycle settlement can apply", () => {
    const current = {
      status: "running",
      updatedAt: "2026-07-12T11:00:00.000Z",
    };
    const incoming = {
      status: "idle",
      updatedAt: "2026-07-12T10:00:00.000Z",
      archivedAt: null,
    };

    const prepared = prepareLiveAgentDirectoryUpdate(current, incoming);
    expect(acceptAgentDirectoryUpdate(current, prepared)).toEqual({
      status: "idle",
      updatedAt: "2026-07-12T11:00:00.000Z",
      archivedAt: null,
    });
  });

  it("does not rewrite archived stale upserts", () => {
    const current = {
      status: "running",
      updatedAt: "2026-07-12T11:00:00.000Z",
    };
    const incoming = {
      status: "idle",
      updatedAt: "2026-07-12T10:00:00.000Z",
      archivedAt: "2026-07-12T10:00:00.000Z",
    };

    expect(prepareLiveAgentDirectoryUpdate(current, incoming)).toBe(incoming);
    expect(acceptAgentDirectoryUpdate(current, incoming).status).toBe("running");
  });
});

import { describe, expect, it } from "vitest";
import { normalizePermissionPreset, toSessionRow } from "./proxy.js";

describe("normalizePermissionPreset", () => {
  it("maps aliases to live presets", () => {
    expect(normalizePermissionPreset("write")).toBe("workspace-write");
    expect(normalizePermissionPreset("yolo")).toBe("danger-full-access");
    expect(normalizePermissionPreset("read")).toBe("read-only");
    expect(normalizePermissionPreset("workspace-write")).toBe("workspace-write");
  });
});

describe("toSessionRow", () => {
  it("projects list items into wire rows", () => {
    const row = toSessionRow({
      sessionId: "session-abcdef12",
      running: true,
      blank: false,
      cwd: "/tmp/demo",
      agentPreset: "code",
      updatedAt: 1,
      projections: {
        values: {
          title: "Demo",
          sessionStats: { turns: 3 },
          contextTimeline: { model: "m", provider: "p" },
        },
      },
    });
    expect(row).toEqual({
      sessionId: "session-abcdef12",
      title: "Demo",
      status: "running",
      blank: false,
      cwd: "/tmp/demo",
      agentPreset: "code",
      model: "m",
      provider: "p",
      updatedAt: 1,
      turns: 3,
    });
  });

  it("falls back title to cwd basename", () => {
    const row = toSessionRow({
      sessionId: "session-deadbeef",
      cwd: "/tmp/project",
      blank: true,
    });
    expect(row.title).toBe("project");
    expect(row.status).toBe("idle");
    expect(row.blank).toBe(true);
  });
});

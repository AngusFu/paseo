import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  compileEveryPresetToCron,
  parseScheduleCreateInput,
  parseScheduleUpdateInput,
} from "./shared.js";

const baseOptions = {
  prompt: "do the thing",
  every: "5m",
  provider: "claude",
};

const baseCron = {
  prompt: "do the thing",
  cron: "0 9 * * *",
  provider: "claude",
};

describe("parseScheduleCreateInput cwd/host validation", () => {
  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue("/local/project");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("no host, no cwd → defaults to process.cwd()", () => {
    const input = parseScheduleCreateInput(baseOptions);
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/local/project" },
    });
  });

  test("no host, with cwd → uses provided cwd", () => {
    const input = parseScheduleCreateInput({ ...baseOptions, cwd: "/some/other/path" });
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/some/other/path" },
    });
  });

  test("host with cwd → uses provided cwd", () => {
    const input = parseScheduleCreateInput({
      ...baseOptions,
      host: "dev:6767",
      cwd: "/remote/project",
    });
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/remote/project" },
    });
  });

  test("host without cwd → throws MISSING_CWD", () => {
    expect(() => parseScheduleCreateInput({ ...baseOptions, host: "dev:6767" })).toThrow(
      expect.objectContaining({
        code: "MISSING_CWD",
        message: expect.stringContaining("--cwd is required when --host is specified"),
      }),
    );
  });

  test("host with whitespace-only cwd → throws MISSING_CWD", () => {
    expect(() =>
      parseScheduleCreateInput({ ...baseOptions, host: "dev:6767", cwd: "   " }),
    ).toThrow(expect.objectContaining({ code: "MISSING_CWD" }));
  });
});

describe("parseScheduleCreateInput first-run timing", () => {
  test("--every compiles to cron and waits for the next slot", () => {
    const input = parseScheduleCreateInput(baseOptions);
    expect(input.cadence).toEqual({ type: "cron", expression: "*/5 * * * *" });
    expect(input.runOnCreate).toBe(false);
  });

  test("--cron with no run-now flag waits for the next cron slot", () => {
    const input = parseScheduleCreateInput(baseCron);
    expect(input.runOnCreate).toBe(false);
  });

  test("--cron with --run-now fires immediately on creation", () => {
    const input = parseScheduleCreateInput({ ...baseCron, runNow: true });
    expect(input.runOnCreate).toBe(true);
  });

  test("--cron with --timezone stores a timezone-aware cadence", () => {
    const input = parseScheduleCreateInput({
      ...baseCron,
      timezone: "  America/New_York  ",
    });

    expect(input.cadence).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });

  test("--run-now is orthogonal to a compiled preset", () => {
    const input = parseScheduleCreateInput({ ...baseOptions, runNow: true });
    expect(input.runOnCreate).toBe(true);
  });

  test("--timezone without --cron is rejected", () => {
    expect(() => parseScheduleCreateInput({ ...baseOptions, timezone: "Europe/Zurich" })).toThrow(
      expect.objectContaining({
        code: "INVALID_TIME_ZONE",
        message: "--timezone can only be used with --cron",
      }),
    );
  });
});

describe("parseScheduleCreateInput command target", () => {
  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue("/local/project");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("--command builds a command target with default cwd and prompt", () => {
    const input = parseScheduleCreateInput({ every: "5m", command: "  npm test  " });
    expect(input.target).toEqual({
      type: "command",
      command: "npm test",
      cwd: "/local/project",
    });
    expect(input.prompt).toBe("npm test");
  });

  test("--command with --env and --timeout", () => {
    const input = parseScheduleCreateInput({
      every: "5m",
      command: "npm test",
      cwd: "/repo",
      env: ["FOO=bar", "BAZ=qux=1"],
      timeout: "5000",
    });
    expect(input.target).toEqual({
      type: "command",
      command: "npm test",
      cwd: "/repo",
      env: { FOO: "bar", BAZ: "qux=1" },
      timeoutMs: 5000,
    });
  });

  test("--command rejects combining with target flags", () => {
    expect(() =>
      parseScheduleCreateInput({ every: "5m", command: "npm test", provider: "claude" }),
    ).toThrow(expect.objectContaining({ code: "CONFLICTING_TARGET" }));
  });

  test("empty --command is rejected", () => {
    expect(() => parseScheduleCreateInput({ every: "5m", command: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_COMMAND" }),
    );
  });

  test("malformed --env entry is rejected", () => {
    expect(() =>
      parseScheduleCreateInput({ every: "5m", command: "npm test", env: ["NOEQUALS"] }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ENV" }));
  });
});

describe("parseScheduleUpdateInput command target", () => {
  test("--command/--env/--timeout/--cwd build a commandConfig", () => {
    expect(
      parseScheduleUpdateInput({
        id: "abc",
        command: "  npm run e2e  ",
        env: ["FOO=bar"],
        timeout: "1000",
        cwd: "/repo",
      }),
    ).toEqual({
      id: "abc",
      commandConfig: {
        command: "npm run e2e",
        cwd: "/repo",
        env: { FOO: "bar" },
        timeoutMs: 1000,
      },
    });
  });

  test("--clear-env sets env to null", () => {
    expect(parseScheduleUpdateInput({ id: "abc", clearEnv: true })).toEqual({
      id: "abc",
      commandConfig: { env: null },
    });
  });

  test("--clear-env with --env is rejected", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", clearEnv: true, env: ["FOO=bar"] })).toThrow(
      expect.objectContaining({ code: "CONFLICTING_ENV" }),
    );
  });

  test("mixing command flags with new-agent flags is rejected", () => {
    expect(() =>
      parseScheduleUpdateInput({ id: "abc", command: "npm test", provider: "claude" }),
    ).toThrow(expect.objectContaining({ code: "CONFLICTING_TARGET" }));
  });

  test("--cwd alone still routes to newAgentConfig", () => {
    expect(parseScheduleUpdateInput({ id: "abc", cwd: "/repo" })).toEqual({
      id: "abc",
      newAgentConfig: { cwd: "/repo" },
    });
  });

  test("empty --command is rejected", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", command: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_COMMAND" }),
    );
  });
});

describe("parseScheduleUpdateInput", () => {
  test("rejects calls with no fields to update", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc" })).toThrow(
      expect.objectContaining({ code: "NO_UPDATES" }),
    );
  });

  test("parses prompt and name updates", () => {
    expect(parseScheduleUpdateInput({ id: "abc", prompt: "  hello  ", name: "  named  " })).toEqual(
      {
        id: "abc",
        name: "named",
        prompt: "hello",
      },
    );
  });

  test("name set to empty string clears the name", () => {
    expect(parseScheduleUpdateInput({ id: "abc", name: "" })).toEqual({
      id: "abc",
      name: null,
    });
  });

  test("rejects empty prompt", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", prompt: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_PROMPT" }),
    );
  });

  test("compiles --every cadence to cron", () => {
    expect(parseScheduleUpdateInput({ id: "abc", every: "5m" })).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "*/5 * * * *" },
    });
  });

  test("parses --cron cadence", () => {
    expect(parseScheduleUpdateInput({ id: "abc", cron: "30 9 * * *" })).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "30 9 * * *" },
    });
  });

  test("parses --cron cadence with --timezone", () => {
    expect(
      parseScheduleUpdateInput({
        id: "abc",
        cron: "30 9 * * *",
        timezone: "Europe/Zurich",
      }),
    ).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "30 9 * * *", timezone: "Europe/Zurich" },
    });
  });

  test("rejects passing both --every and --cron", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", every: "5m", cron: "0 9 * * *" })).toThrow(
      expect.objectContaining({ code: "INVALID_CADENCE" }),
    );
  });

  test("rejects --timezone without --cron", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", timezone: "Europe/Zurich" })).toThrow(
      expect.objectContaining({ code: "INVALID_TIME_ZONE" }),
    );
  });

  test("parses provider/model shorthand and explicit mode", () => {
    expect(
      parseScheduleUpdateInput({
        id: "abc",
        provider: "codex/gpt-5",
        mode: "full-access",
        cwd: "/tmp/proj",
      }),
    ).toEqual({
      id: "abc",
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5",
        modeId: "full-access",
        cwd: "/tmp/proj",
      },
    });
  });

  test("--mode with empty value clears the modeId", () => {
    expect(parseScheduleUpdateInput({ id: "abc", mode: "" })).toEqual({
      id: "abc",
      newAgentConfig: { modeId: null },
    });
  });

  test("rejects empty --cwd", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", cwd: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_CWD" }),
    );
  });

  test("--max-runs sets a positive integer; --no-max-runs clears", () => {
    expect(parseScheduleUpdateInput({ id: "abc", maxRuns: "3" })).toEqual({
      id: "abc",
      maxRuns: 3,
    });
    expect(parseScheduleUpdateInput({ id: "abc", clearMaxRuns: true })).toEqual({
      id: "abc",
      maxRuns: null,
    });
  });

  test("rejects passing both --max-runs and --no-max-runs", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", maxRuns: "3", clearMaxRuns: true })).toThrow(
      expect.objectContaining({ code: "CONFLICTING_MAX_RUNS" }),
    );
  });

  test("--expires-in computes an absolute timestamp; --no-expires-in clears", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      expect(parseScheduleUpdateInput({ id: "abc", expiresIn: "1h" })).toEqual({
        id: "abc",
        expiresAt: "2026-01-01T01:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }

    expect(parseScheduleUpdateInput({ id: "abc", clearExpires: true })).toEqual({
      id: "abc",
      expiresAt: null,
    });
  });

  test("rejects passing both --expires-in and --no-expires-in", () => {
    expect(() =>
      parseScheduleUpdateInput({ id: "abc", expiresIn: "1h", clearExpires: true }),
    ).toThrow(expect.objectContaining({ code: "CONFLICTING_EXPIRES" }));
  });
});

describe("compileEveryPresetToCron", () => {
  test.each([
    ["1m", "*/1 * * * *"],
    ["15m", "*/15 * * * *"],
    ["1h", "0 * * * *"],
    ["6h", "0 */6 * * *"],
    ["1d", "0 0 * * *"],
  ])("compiles %s", (value, expected) => {
    expect(compileEveryPresetToCron(value)).toBe(expected);
  });

  test.each(["30s", "7m", "5h", "2d"])("rejects rolling interval %s", (value) => {
    expect(() => compileEveryPresetToCron(value)).toThrow(
      expect.objectContaining({ code: "UNREPRESENTABLE_CADENCE" }),
    );
  });

  test.each(["15minutes", "junk15m", "1h-nope"])("rejects malformed preset %s", (value) => {
    expect(() => compileEveryPresetToCron(value)).toThrow("Invalid duration format");
  });
});

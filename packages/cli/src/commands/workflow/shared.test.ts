import { describe, expect, test } from "vitest";

import {
  parseArgFlags,
  parseWorkflowCreateInput,
  parseWorkflowDispatchInput,
  parseWorkflowUpdateInput,
} from "./shared.js";

describe("parseWorkflowCreateInput", () => {
  test("builds a definition from inline source", () => {
    expect(
      parseWorkflowCreateInput({
        name: "  Bug sweep  ",
        source: "export const meta = { name: 'x' };",
        description: "desc",
        id: "wf_custom",
      }),
    ).toEqual({
      name: "Bug sweep",
      source: "export const meta = { name: 'x' };",
      description: "desc",
      id: "wf_custom",
    });
  });

  test("rejects an empty name", () => {
    expect(() => parseWorkflowCreateInput({ name: "   ", source: "x" })).toThrow(
      expect.objectContaining({ code: "INVALID_NAME" }),
    );
  });

  test("rejects missing source", () => {
    expect(() => parseWorkflowCreateInput({ name: "Bug sweep" })).toThrow(
      expect.objectContaining({ code: "INVALID_SOURCE" }),
    );
  });
});

describe("parseWorkflowUpdateInput", () => {
  test("builds a partial update", () => {
    expect(parseWorkflowUpdateInput("wf_1", { name: "  Renamed  " })).toEqual({
      id: "wf_1",
      name: "Renamed",
    });
  });

  test("clears description with empty string", () => {
    expect(parseWorkflowUpdateInput("wf_1", { description: "   " })).toEqual({
      id: "wf_1",
      description: null,
    });
  });

  test("rejects empty definition id", () => {
    expect(() => parseWorkflowUpdateInput("   ", { name: "x" })).toThrow(
      expect.objectContaining({ code: "INVALID_DEFINITION_ID" }),
    );
  });

  test("rejects updates with no fields", () => {
    expect(() => parseWorkflowUpdateInput("wf_1", {})).toThrow(
      expect.objectContaining({ code: "NO_UPDATES" }),
    );
  });
});

describe("parseArgFlags", () => {
  test("parses string and JSON values", () => {
    expect(parseArgFlags(["title=hello", "count=3", 'labels=["a","b"]', "flag=true"])).toEqual({
      title: "hello",
      count: 3,
      labels: ["a", "b"],
      flag: true,
    });
  });

  test("rejects malformed flags", () => {
    expect(() => parseArgFlags(["=no-key"])).toThrow(
      expect.objectContaining({ code: "INVALID_ARG" }),
    );
    expect(() => parseArgFlags(["nokey"])).toThrow(
      expect.objectContaining({ code: "INVALID_ARG" }),
    );
  });
});

describe("parseWorkflowDispatchInput", () => {
  test("builds a dispatch payload", () => {
    expect(
      parseWorkflowDispatchInput("wf_1", {
        arg: ["cardId=ABC-1"],
        cwd: "/tmp/work",
        repoPath: "/repo",
      }),
    ).toEqual({
      definitionId: "wf_1",
      args: { cardId: "ABC-1" },
      cwd: "/tmp/work",
      repoPath: "/repo",
    });
  });
});

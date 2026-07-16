import { describe, expect, test } from "vitest";
import { parentDirectoryPath } from "./workflow-directory-path.js";

describe("parentDirectoryPath", () => {
  test("walks posix paths up to root", () => {
    expect(parentDirectoryPath("/Users/yywl/Documents")).toBe("/Users/yywl");
    expect(parentDirectoryPath("/Users")).toBe("/");
    expect(parentDirectoryPath("/")).toBeNull();
  });

  test("maps ~ to / and stops at drive roots", () => {
    expect(parentDirectoryPath("~")).toBe("/");
    expect(parentDirectoryPath("C:\\Users\\yywl")).toBe("C:\\Users");
    expect(parentDirectoryPath("C:\\")).toBeNull();
  });
});

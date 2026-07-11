import { describe, expect, it } from "vitest";
import { tokenizeShellCommand, type ShellToken } from "./shell-highlight";

// Reassemble tokens to prove nothing is dropped or reordered.
function reassemble(tokens: ShellToken[]): string {
  return tokens.map((t) => t.text).join("");
}

// Only the non-whitespace tokens, as [style, text] pairs, for readable asserts.
function significant(tokens: ShellToken[]): Array<[ShellToken["style"], string]> {
  return tokens.filter((t) => t.text.trim().length > 0).map((t) => [t.style, t.text]);
}

describe("tokenizeShellCommand", () => {
  it("is lossless (tokens reassemble to the input)", () => {
    const input = 'cd /a/b && git commit -m "hi there"';
    expect(reassemble(tokenizeShellCommand(input))).toBe(input);
  });

  it("marks the first word as the command", () => {
    expect(significant(tokenizeShellCommand("ls -la"))).toEqual([
      ["command", "ls"],
      ["flag", "-la"],
    ]);
  });

  it("resets to a command after a separator", () => {
    expect(significant(tokenizeShellCommand("cd /tmp && git status"))).toEqual([
      ["command", "cd"],
      ["path", "/tmp"],
      ["operator", "&&"],
      ["command", "git"],
      ["plain", "status"],
    ]);
  });

  it("treats a pipe as a command separator", () => {
    expect(significant(tokenizeShellCommand("cat f | grep x"))).toEqual([
      ["command", "cat"],
      ["plain", "f"],
      ["operator", "|"],
      ["command", "grep"],
      ["plain", "x"],
    ]);
  });

  it("keeps quoted strings (with spaces) as one string token", () => {
    expect(significant(tokenizeShellCommand('git commit -m "keep it hoverable"'))).toEqual([
      ["command", "git"],
      ["plain", "commit"],
      ["flag", "-m"],
      ["string", '"keep it hoverable"'],
    ]);
  });

  it("handles escaped quotes inside double quotes", () => {
    const tokens = tokenizeShellCommand('echo "a \\" b"');
    expect(significant(tokens)).toEqual([
      ["command", "echo"],
      ["string", '"a \\" b"'],
    ]);
  });

  it("classifies flags and paths off the command position", () => {
    expect(significant(tokenizeShellCommand("run --port=8081 ./scripts/x.sh"))).toEqual([
      ["command", "run"],
      ["flag", "--port=8081"],
      ["path", "./scripts/x.sh"],
    ]);
  });

  it("colors redirections as operators without resetting the command", () => {
    expect(significant(tokenizeShellCommand("npm run typecheck > out.log"))).toEqual([
      ["command", "npm"],
      ["plain", "run"],
      ["plain", "typecheck"],
      ["operator", ">"],
      ["plain", "out.log"],
    ]);
  });

  it("resets the command after a newline", () => {
    expect(significant(tokenizeShellCommand("cd /a\nls"))).toEqual([
      ["command", "cd"],
      ["path", "/a"],
      ["command", "ls"],
    ]);
  });
});

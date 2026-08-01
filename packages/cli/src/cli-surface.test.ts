import { describe, expect, it } from "vitest";
import { createCli } from "./cli.js";

describe("canonical CLI surface", () => {
  it("shows workspace and heartbeat commands while hiding worktree compatibility", () => {
    const cli = createCli();
    const help = cli.helpInformation();
    expect(help).toContain("workspace");
    expect(help).toContain("heartbeat");
    expect(help).toContain("markdown");
    expect(help).toContain("kb");
    // COMPAT(worktreeCli): hidden from top-level help
    expect(help).not.toContain("worktree");
    expect(help).not.toMatch(/(^|\n)\s*docs\b/);
  });

  it("exposes kb explore + manage subcommands", () => {
    const kb = createCli().commands.find((command) => command.name() === "kb");
    const names = kb?.commands.map((command) => command.name()) ?? [];
    expect(names).toEqual(
      expect.arrayContaining([
        "ls",
        "cat",
        "grep",
        "index",
        "search",
        "import",
        "export",
        "list",
        "delete",
        "mounts",
        "mount",
        "unmount",
      ]),
    );
    expect(names).not.toContain("create");
    expect(names).not.toContain("kbs");
    const help = kb?.helpInformation() ?? "";
    expect(help).toContain("import");
    expect(help).toContain("list");
    expect(help).toContain("mount");
  });

  it("does not register a top-level docs command", () => {
    const docs = createCli().commands.find((command) => command.name() === "docs");
    expect(docs).toBeUndefined();
  });

  it("exposes markdown render options", () => {
    const markdown = createCli().commands.find((command) => command.name() === "markdown");
    const help = markdown?.helpInformation();
    expect(help).toContain("[md]");
    expect(help).toContain("--stdout");
    expect(help).toContain("--serve");
    expect(help).toContain("--template");
    expect(help).toContain("--no-cache");
    expect(help).toContain("--clear-all");
    expect(help).toContain("--cache-dir");
  });

  it("names explicit workspace creation without exposing older syntax", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--new-workspace <local|worktree>");
    expect(help).not.toContain("--isolation");
    expect(help).not.toContain("--worktree <name>");
  });

  it("offers the worktree creation options on run", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--worktree-mode <mode>");
    expect(help).toContain("--worktree-slug <slug>");
    expect(help).toContain("--new-branch <name>");
    expect(help).toContain("--branch <name>");
    expect(help).toContain("--pr-number <n>");
    expect(help).toContain("--forge <forge>");
  });

  it("uses background for execution and reserves detach for ownership", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    expect(run?.helpInformation()).toContain("--background");
    expect(run?.helpInformation()).not.toContain("--detach");
  });

  it("offers thinking configuration when running, updating, and scheduling agents", () => {
    const cli = createCli();
    const run = cli.commands.find((command) => command.name() === "run");
    const agent = cli.commands.find((command) => command.name() === "agent");
    const update = agent?.commands.find((command) => command.name() === "update");
    const schedule = cli.commands.find((command) => command.name() === "schedule");
    const scheduleCreate = schedule?.commands.find((command) => command.name() === "create");

    expect(run?.helpInformation()).toContain("--thinking <id>");
    expect(update?.helpInformation()).toContain("--thinking <id>");
    expect(scheduleCreate?.helpInformation()).toContain("--thinking <id>");
  });

  it("offers opening an existing agent in the desktop app", () => {
    const agent = createCli().commands.find((command) => command.name() === "agent");
    const open = agent?.commands.find((command) => command.name() === "open");

    expect(open?.helpInformation()).toContain("<agent-id>");
    expect(open?.helpInformation()).toContain("--server <server-id>");
  });
});

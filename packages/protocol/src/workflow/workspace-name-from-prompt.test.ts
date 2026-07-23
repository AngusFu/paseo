import { describe, expect, it } from "vitest";
import {
  MAX_WORKFLOW_WORKSPACE_NAME_CHARS,
  extractJiraTicketId,
  workflowWorkspaceNameFromPrompt,
} from "./workspace-name-from-prompt.js";

describe("extractJiraTicketId", () => {
  it("matches a ticket URL on its own", () => {
    expect(extractJiraTicketId("https://mdpi.atlassian.net/browse/SCIF-5129")).toBe("SCIF-5129");
  });

  it("matches a ticket URL surrounded by prose", () => {
    expect(
      extractJiraTicketId("Fix https://mdpi.atlassian.net/browse/SCIF-5129 before the release"),
    ).toBe("SCIF-5129");
    expect(extractJiraTicketId("see https://mdpi.atlassian.net/browse/SCIF-5129")).toBe(
      "SCIF-5129",
    );
  });

  it("tolerates a lowercase or mixed-case host", () => {
    expect(extractJiraTicketId("HTTPS://MDPI.Atlassian.NET/browse/SCIF-5129")).toBe("SCIF-5129");
  });

  it("accepts project keys containing digits", () => {
    expect(extractJiraTicketId("https://x.atlassian.net/browse/AB1-23")).toBe("AB1-23");
  });

  it("ignores non-atlassian hosts", () => {
    expect(extractJiraTicketId("https://jira.example.com/browse/SCIF-5129")).toBeNull();
    expect(extractJiraTicketId("https://notatlassian.net/browse/SCIF-5129")).toBeNull();
    expect(extractJiraTicketId("https://atlassian.net.evil.com/browse/SCIF-5129")).toBeNull();
  });

  it("ignores lowercase ticket keys — Jira keys are uppercase", () => {
    expect(extractJiraTicketId("https://mdpi.atlassian.net/browse/scif-5129")).toBeNull();
  });

  it("takes the first ticket when several are linked", () => {
    expect(
      extractJiraTicketId(
        "https://mdpi.atlassian.net/browse/SCIF-5129 depends on https://mdpi.atlassian.net/browse/SCIF-4000",
      ),
    ).toBe("SCIF-5129");
  });
});

describe("workflowWorkspaceNameFromPrompt", () => {
  it("prefers the ticket id over the prompt text", () => {
    expect(
      workflowWorkspaceNameFromPrompt("Investigate https://mdpi.atlassian.net/browse/SCIF-5129"),
    ).toBe("SCIF-5129");
  });

  it("falls back to the prompt's first non-empty line", () => {
    expect(workflowWorkspaceNameFromPrompt("\n\n  Rework the queue  \nmore detail")).toBe(
      "Rework the queue",
    );
  });

  it("collapses runs of whitespace", () => {
    expect(workflowWorkspaceNameFromPrompt("Rework\tthe   queue")).toBe("Rework the queue");
  });

  it("clamps a very long prompt", () => {
    const name = workflowWorkspaceNameFromPrompt("word ".repeat(200));
    expect(name).not.toBeNull();
    expect((name as string).length).toBeLessThanOrEqual(MAX_WORKFLOW_WORKSPACE_NAME_CHARS);
    expect(name).toBe("word ".repeat(200).slice(0, MAX_WORKFLOW_WORKSPACE_NAME_CHARS).trim());
  });

  it("returns null for an empty or whitespace-only prompt", () => {
    expect(workflowWorkspaceNameFromPrompt("")).toBeNull();
    expect(workflowWorkspaceNameFromPrompt("   \n\t ")).toBeNull();
    expect(workflowWorkspaceNameFromPrompt(null)).toBeNull();
    expect(workflowWorkspaceNameFromPrompt(undefined)).toBeNull();
  });
});

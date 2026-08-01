import { describe, expect, it } from "vitest";
import {
  resolveKnowledgeBaseHostSelection,
  resolveKnowledgeBaseRowTitle,
} from "./knowledge-base-hub-row";

describe("resolveKnowledgeBaseRowTitle", () => {
  it("prefers a non-empty name over slug", () => {
    expect(
      resolveKnowledgeBaseRowTitle({ name: "Company runbooks", slug: "company-runbooks" }),
    ).toBe("Company runbooks");
  });

  it("falls back to slug when name is missing or blank", () => {
    expect(resolveKnowledgeBaseRowTitle({ name: "", slug: "company-runbooks" })).toBe(
      "company-runbooks",
    );
    expect(resolveKnowledgeBaseRowTitle({ name: "   ", slug: "company-runbooks" })).toBe(
      "company-runbooks",
    );
    expect(resolveKnowledgeBaseRowTitle({ slug: "company-runbooks" })).toBe("company-runbooks");
  });
});

describe("resolveKnowledgeBaseHostSelection", () => {
  const hosts = [{ serverId: "host-a" }, { serverId: "host-b" }];

  it("prefers a known preferredServerId", () => {
    expect(
      resolveKnowledgeBaseHostSelection({
        hosts,
        preferredServerId: "host-b",
        currentServerId: "host-a",
      }),
    ).toBe("host-b");
  });

  it("keeps current when preferred is missing or unknown", () => {
    expect(
      resolveKnowledgeBaseHostSelection({
        hosts,
        preferredServerId: "host-missing",
        currentServerId: "host-a",
      }),
    ).toBe("host-a");
    expect(resolveKnowledgeBaseHostSelection({ hosts, currentServerId: "host-b" })).toBe("host-b");
  });

  it("falls back to the first host", () => {
    expect(resolveKnowledgeBaseHostSelection({ hosts })).toBe("host-a");
    expect(resolveKnowledgeBaseHostSelection({ hosts: [] })).toBe("");
  });
});

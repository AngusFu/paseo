import { describe, expect, test } from "vitest";
import { KNOWLEDGE_BASES_AGENT_GUIDANCE } from "./knowledge-bases-guidance.js";

describe("KNOWLEDGE_BASES_AGENT_GUIDANCE", () => {
  test("matches Screen 4 copy contract with glossary labels", () => {
    expect(KNOWLEDGE_BASES_AGENT_GUIDANCE).toContain("Knowledge bases (read-only)");
    expect(KNOWLEDGE_BASES_AGENT_GUIDANCE).toContain("/paseo-vfs/<mountSlug>/");
    expect(KNOWLEDGE_BASES_AGENT_GUIDANCE).toContain("paseo kb ls");
    expect(KNOWLEDGE_BASES_AGENT_GUIDANCE).toContain("paseo kb cat");
    expect(KNOWLEDGE_BASES_AGENT_GUIDANCE).toContain("paseo kb grep");
    expect(KNOWLEDGE_BASES_AGENT_GUIDANCE).toContain("Writes are denied");
    expect(KNOWLEDGE_BASES_AGENT_GUIDANCE).toContain("Mount knowledge bases");
    expect(KNOWLEDGE_BASES_AGENT_GUIDANCE).not.toContain("--root");
    expect(KNOWLEDGE_BASES_AGENT_GUIDANCE).not.toContain("--unsafe");
  });
});

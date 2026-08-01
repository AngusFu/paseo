import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWLEDGE_BASE_PAGE_PATH,
  defaultKnowledgeBasePageContent,
  isKnowledgeBasePagePathValid,
  normalizeKnowledgeBasePagePath,
} from "./knowledge-base-page-path";

describe("normalizeKnowledgeBasePagePath", () => {
  it("trims, strips leading slashes, and normalizes separators", () => {
    expect(normalizeKnowledgeBasePagePath("  /guides\\b.md  ")).toBe("guides/b.md");
    expect(normalizeKnowledgeBasePagePath(DEFAULT_KNOWLEDGE_BASE_PAGE_PATH)).toBe("index.md");
  });

  it("rejects empty, dot, and parent segments", () => {
    expect(normalizeKnowledgeBasePagePath("")).toBeNull();
    expect(normalizeKnowledgeBasePagePath("   ")).toBeNull();
    expect(normalizeKnowledgeBasePagePath("../secret.md")).toBeNull();
    expect(normalizeKnowledgeBasePagePath("guides/../b.md")).toBeNull();
    expect(normalizeKnowledgeBasePagePath("./b.md")).toBeNull();
  });
});

describe("isKnowledgeBasePagePathValid", () => {
  it("allows .md / .mdx / .txt paths", () => {
    expect(isKnowledgeBasePagePathValid("index.md")).toBe(true);
    expect(isKnowledgeBasePagePathValid("guides/intro.mdx")).toBe(true);
    expect(isKnowledgeBasePagePathValid("notes/readme.txt")).toBe(true);
  });

  it("rejects paths without a document extension", () => {
    expect(isKnowledgeBasePagePathValid("guides")).toBe(false);
    expect(isKnowledgeBasePagePathValid("image.png")).toBe(false);
  });
});

describe("defaultKnowledgeBasePageContent", () => {
  it("seeds a markdown title from the basename", () => {
    expect(defaultKnowledgeBasePageContent("guides/setup.md")).toBe("# setup\n");
    expect(defaultKnowledgeBasePageContent("index.md")).toBe("# index\n");
  });
});

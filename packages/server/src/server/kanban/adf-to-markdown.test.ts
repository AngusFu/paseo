import { describe, expect, test } from "vitest";
import { adfToMarkdown } from "./adf-to-markdown.js";

describe("adfToMarkdown", () => {
  test("renders a paragraph with strong, em, code and link marks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " and " },
            { type: "text", text: "italic", marks: [{ type: "em" }] },
            { type: "text", text: " and " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "a link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe(
      "**bold** and _italic_ and `code` and [a link](https://example.com)",
    );
  });

  test("renders headings by level", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Section" }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("## Section");
  });

  test("renders a code block with a language fence", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("```ts\nconst x = 1;\n```");
  });

  test("renders a blockquote by prefixing each line", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "quoted text" }] }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("> quoted text");
  });

  test("renders a rule and a hard break", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "line one" },
            { type: "hardBreak" },
            { type: "text", text: "line two" },
          ],
        },
        { type: "rule" },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("line one\nline two\n\n---");
  });

  test("renders a nested bullet list containing an ordered list", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "first" }] },
                {
                  type: "orderedList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        { type: "paragraph", content: [{ type: "text", text: "nested one" }] },
                      ],
                    },
                    {
                      type: "listItem",
                      content: [
                        { type: "paragraph", content: [{ type: "text", text: "nested two" }] },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }],
            },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("- first\n  1. nested one\n  2. nested two\n- second");
  });

  test("renders mention, emoji and inlineCard nodes", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { text: "@Ada Lovelace" } },
            { type: "text", text: " reacted " },
            { type: "emoji", attrs: { shortName: ":tada:" } },
            { type: "text", text: " see " },
            { type: "inlineCard", attrs: { url: "https://example.com/PROJ-1" } },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("@Ada Lovelace reacted :tada: see https://example.com/PROJ-1");
  });

  test("renders a mediaSingle/media node as a placeholder image", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "mediaSingle",
          content: [{ type: "media", attrs: { alt: "screenshot.png" } }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("![screenshot.png](screenshot.png)");
  });

  test("renders a simple table with a header row", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }],
                },
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
                },
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("| Name | Value |\n| --- | --- |\n| a | 1 |");
  });

  test("recurses into an unknown node's content instead of throwing", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "panel",
          attrs: { panelType: "info" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "an info panel" }] }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("an info panel");
  });

  test("returns an empty string for null or non-object input", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(undefined)).toBe("");
    expect(adfToMarkdown("plain string")).toBe("");
  });
});

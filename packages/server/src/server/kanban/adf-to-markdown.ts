// Zero-dependency renderer for Atlassian Document Format (Jira Cloud's
// description/comment body shape) to Markdown. Unknown node types recurse
// into their `content` instead of throwing, so a node this doesn't know
// about yet degrades to its rendered children rather than dropping the field.

interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

function isAdfNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && typeof (value as AdfNode).type === "string";
}

function stringAttr(node: AdfNode, key: string): string {
  const value = node.attrs?.[key];
  return typeof value === "string" ? value : "";
}

// Resolves a media node's id/alt to a URL the client can actually load
// (e.g. the daemon's Jira attachment proxy path). Returns null to keep the
// existing placeholder rendering when nothing matches.
export type AdfMediaResolver = (idOrAlt: string) => string | null;

export function adfToMarkdown(doc: unknown, resolveMedia?: AdfMediaResolver): string {
  if (!isAdfNode(doc)) {
    return "";
  }
  return renderBlock(doc, 0, resolveMedia).trim();
}

function renderChildren(node: AdfNode, indent: number, resolveMedia?: AdfMediaResolver): string {
  return (node.content ?? [])
    .map((child) => renderBlock(child, indent, resolveMedia))
    .filter((rendered) => rendered.length > 0)
    .join("\n\n");
}

function renderInlineChildren(node: AdfNode): string {
  return (node.content ?? []).map(renderInline).join("");
}

function renderText(node: AdfNode): string {
  let text = node.text ?? "";
  const marks = node.marks ?? [];
  const hasMark = (type: string) => marks.some((mark) => mark.type === type);
  if (hasMark("code")) {
    text = `\`${text}\``;
  }
  if (hasMark("strong")) {
    text = `**${text}**`;
  }
  if (hasMark("em")) {
    text = `_${text}_`;
  }
  if (hasMark("strike")) {
    text = `~~${text}~~`;
  }
  const link = marks.find((mark) => mark.type === "link");
  if (link) {
    const href = typeof link.attrs?.href === "string" ? link.attrs.href : "";
    text = `[${text}](${href})`;
  }
  return text;
}

function renderInline(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return renderText(node);
    case "hardBreak":
      return "\n";
    case "mention": {
      const name = stringAttr(node, "text") || stringAttr(node, "id");
      return name.startsWith("@") ? name : `@${name}`;
    }
    case "emoji":
      return stringAttr(node, "shortName");
    case "inlineCard":
      return stringAttr(node, "url");
    default:
      return node.content ? renderInlineChildren(node) : "";
  }
}

function renderListItem(
  item: AdfNode,
  indent: number,
  marker: string,
  resolveMedia?: AdfMediaResolver,
): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  (item.content ?? []).forEach((child, index) => {
    if (child.type === "bulletList" || child.type === "orderedList") {
      lines.push(renderBlock(child, indent + 1, resolveMedia));
      return;
    }
    const rendered = renderBlock(child, indent, resolveMedia);
    lines.push(index === 0 ? `${pad}${marker} ${rendered}` : `${pad}  ${rendered}`);
  });
  return lines.join("\n");
}

function renderList(
  node: AdfNode,
  indent: number,
  marker: (index: number) => string,
  resolveMedia?: AdfMediaResolver,
): string {
  return (node.content ?? [])
    .map((item, index) => renderListItem(item, indent, marker(index), resolveMedia))
    .join("\n");
}

function renderTable(node: AdfNode, resolveMedia?: AdfMediaResolver): string {
  const rows = (node.content ?? []).filter((row) => row.type === "tableRow");
  if (rows.length === 0) {
    return "";
  }
  const cellsOf = (row: AdfNode) =>
    (row.content ?? []).map((cell) => renderChildren(cell, 0, resolveMedia).replace(/\n/g, " "));
  const [header, ...body] = rows.map(cellsOf);
  const separator = header.map(() => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...body.map((cells) => `| ${cells.join(" | ")} |`),
  ];
  return lines.join("\n");
}

// Split out of renderBlock's "media" case to keep its cyclomatic complexity
// under the lint threshold.
function renderMedia(node: AdfNode, resolveMedia?: AdfMediaResolver): string {
  const alt = stringAttr(node, "alt") || stringAttr(node, "id") || "attachment";
  const id = stringAttr(node, "id");
  const resolved = resolveMedia?.(alt) ?? (id ? resolveMedia?.(id) : null) ?? null;
  return `![${alt}](${resolved ?? alt})`;
}

function renderBlock(node: AdfNode, indent: number, resolveMedia?: AdfMediaResolver): string {
  switch (node.type) {
    case "doc":
    case "mediaSingle":
      return renderChildren(node, indent, resolveMedia);
    case "paragraph":
      return renderInlineChildren(node);
    case "heading": {
      const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
      const hashes = "#".repeat(Math.min(Math.max(level, 1), 6));
      return `${hashes} ${renderInlineChildren(node)}`;
    }
    case "bulletList":
      return renderList(node, indent, () => "-", resolveMedia);
    case "orderedList":
      return renderList(node, indent, (index) => `${index + 1}.`, resolveMedia);
    case "codeBlock": {
      const language = stringAttr(node, "language");
      const code = (node.content ?? []).map((child) => child.text ?? "").join("");
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }
    case "blockquote":
      return renderChildren(node, indent, resolveMedia)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return renderTable(node, resolveMedia);
    case "media":
      return renderMedia(node, resolveMedia);
    default:
      return node.content ? renderChildren(node, indent, resolveMedia) : "";
  }
}

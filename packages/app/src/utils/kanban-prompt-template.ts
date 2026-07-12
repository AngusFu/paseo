import type { KanbanSourceKind } from "@getpaseo/protocol/kanban/types";

// Renders a source's optional dispatch-prompt template: `{{name}}` placeholders
// only, no conditionals/loops. Unknown variables and literal newlines in the
// template are left as-is (newlines are typed directly, not escaped as `\n`).
export function renderPromptTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => vars[name] ?? "");
}

// The built-in dispatch prompts, expressed as templates. Single source of
// truth: the card-detail sheet renders these when a source has no custom
// promptTemplate, and the source form pre-fills its template field with them
// (an unmodified field is saved as "no template" so defaults keep evolving).
export const DEFAULT_KANBAN_PROMPT_TEMPLATES: Record<KanbanSourceKind | "manual", string> = {
  jira: `Fix {{issueKey}}: {{title}}
{{url}}
First rename the worktree branch to match the repo's branch contract: git branch -m "{{contractBranch}}".`,
  gitlab: `Review merge request !{{mrIid}}: {{title}}
{{url}}
Check out the MR source branch in this worktree before reviewing.`,
  manual: `{{title}}
{{url}}`,
};

// Renders one of the built-in templates and drops lines whose variables were
// all empty (e.g. a card without a URL) — the defaults never contain
// intentional blank lines, unlike user-authored templates which render raw.
export function renderDefaultPrompt(
  kind: KanbanSourceKind | "manual",
  vars: Readonly<Record<string, string>>,
): string {
  return renderPromptTemplate(DEFAULT_KANBAN_PROMPT_TEMPLATES[kind], vars)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

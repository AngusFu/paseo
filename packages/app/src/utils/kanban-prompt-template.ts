// Renders a source's optional dispatch-prompt template: `{{name}}` placeholders
// only, no conditionals/loops. Unknown variables and literal newlines in the
// template are left as-is (newlines are typed directly, not escaped as `\n`).
export function renderPromptTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => vars[name] ?? "");
}

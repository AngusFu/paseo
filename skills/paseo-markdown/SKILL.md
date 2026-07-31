---
name: paseo-markdown
description: >-
  Render a markdown report to styled standalone HTML and open it.
  Triggers: preview md/markdown as HTML, paseo markdown, open a .md report
  in the browser, "预览 markdown", "把 md 渲成 html", clear markdown cache.
  Not for editing markdown or converting to PDF/docx.
---

# paseo markdown

Md = archive, HTML = derived preview. Do not write a sibling `.html` next to the archive unless the user asks (`--out`).

## Command

```bash
paseo markdown --help                 # or: paseo markdown help / paseo help markdown
paseo markdown <file.md>              # render + open (default)
paseo markdown <file.md> --print      # print path only, do not open
paseo markdown <file.md> --stdout     # html to stdout
paseo markdown <file.md> --out x.html # explicit output path
paseo markdown <file.md> --no-cache   # temp html, do not touch stable cache
paseo markdown <file.md> --clear      # delete that file's cache entry
paseo markdown --clear-all            # wipe $TMPDIR/paseo-markdown
paseo markdown --cache-dir            # print cache directory
paseo markdown --ls-cache             # list cached html files
paseo markdown --serve [--port 4490]  # localhost render server
```

Requires `uv` on PATH (daemon host for MCP). Default cache is under the system temp dir (`$TMPDIR/paseo-markdown/`) so the OS can reclaim it. Override with `PASEO_MARKDOWN_CACHE` only if you want a sticky location.

## MCP tool

**`render_markdown`** — `{ path, open?, template?, noCache?, out?, clear?, clearAll? }`. Same renderer as the CLI. Default `open: true`. Prefer this from agent sessions instead of shelling out.

```json
{ "path": "reports/plan.md" }
{ "path": "/tmp/SCIF-1234/SCIF-1234.md", "open": true }
{ "path": "notes.md", "noCache": true, "open": false }
{ "clearAll": true }
```

## When to use

- User exported / wrote a markdown report and wants a readable preview
- After `jira-export … --no-open` — `render_markdown` / `paseo markdown <md>`
- Agent produced a long plan/audit/review `.md` and should show it, not dump the raw file in chat
- User asks to clear preview cache → `clear` / `clearAll`

## Rules

1. Prefer MCP `render_markdown` when available; otherwise `paseo markdown <path>`.
2. Return the `htmlPath` from the tool/CLI to the user.
3. Do not commit derived HTML next to archived markdown.
4. Use `noCache` when the user does not want a sticky cache file; use `clearAll` to wipe the cache dir.

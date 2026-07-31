---
title: paseo markdown sample
badges: smoke, fixture
isProject: false
todos:
  - id: "smoke-code"
    content: "Code highlight + autolink still work"
    status: completed
  - id: "smoke-todos"
    content: "Front-matter todos render as a checklist"
    status: pending
---

# Sample report

Exercises every renderer feature at once. Bare url https://example.com/x autolinks.
Ticket SCIF-4799 autolinks. MR !1737 autolinks when origin resolves.

## Code highlight

```python
def hello(name: str) -> str:
    return f"hi {name}"
```

Inline `code stays inert: SCIF-200 https://in.code` — no links inside.

## Table + list

| col | meaning |
| --- | ------- |
| a   | first   |
| b   | second  |

1. one
2. two
   - nested

## Diagram

```mermaid
flowchart LR
  A[md] --> B[render] --> C[html]
```

## Blockquote

> archive = md, derived view = html.

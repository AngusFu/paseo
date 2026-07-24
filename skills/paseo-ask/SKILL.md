---
name: paseo-ask
description: Ask the user for a decision via native AskUserQuestion or MCP ask_question; on timeout fall back to Question Inbox create+wait. Use when you need a user decision and must not ask in chat prose.
---

# paseo-ask

Ask the user for a **decision** without using chat prose.

## Ladder (priority order)

1. **Provider-native AskUserQuestion** — If this session already has a reliable native question UI (Claude / Cursor AskUserQuestion), use it. Do not also open a Paseo inbox item.
2. **MCP `ask_question`** — Default for Paseo-managed agents. Blocks until the user answers in the Paseo UI (or dismisses).
3. **Skill fallback (timeout / unavailable only)** — If MCP returns `timedOut: true`, throws a timeout/transport error, or is unavailable, wait on the **same** inbox id (or create+wait). Never re-ask in prose.

## MCP happy path

Call MCP tool `ask_question` with 1–4 questions (2–4 options each when possible).

Outcomes:

| Result                                   | Meaning                    | Next step                                    |
| ---------------------------------------- | -------------------------- | -------------------------------------------- |
| `dismissed: false` + `answers`           | User answered              | Continue with those answers                  |
| `dismissed: true`                        | User dismissed             | Treat as a real outcome; do **not** fallback |
| `timedOut: true` + optional `questionId` | MCP wait aborted/timed out | Go to fallback below                         |

**Clocks:** Cursor/ACP `tools/call` timeouts and daemon `question.wait` deadlines are separate. A tools/call timeout does **not** dismiss the inbox row — the card stays pending.

## Timeout / unavailable fallback

Only when MCP timed out or is unavailable (not on dismiss):

1. If `questionId` is present:  
   `paseo question wait <questionId> --timeout 30m`
2. Else create then wait:
   ```bash
   paseo question create --agent "$PASEO_AGENT_ID" --source skill --title "…" --questions '[…]'
   paseo question wait <id> --timeout 30m
   ```
3. Read `status` / `answers` from wait output. `dismissed`/status `dismissed` is final.

### Classify failures carefully

Treat as timeout/unavailable (fallback OK):

- structured `timedOut: true`
- MCP `-32001`, messages containing `timeout` / `timed out` / `unavailable` / `transport` / `ASK_QUESTION_TIMEOUT`

Do **not** fallback when:

- `dismissed: true`
- user cancelled the form intentionally
- you simply dislike the answer

## Never

- Ask for the decision again in chat prose (`let me know`, `要…吗?`, etc.)
- Create a second inbox row when you already have a `questionId` from the timed-out MCP call
- Invent a parallel UI outside Paseo / native AskUserQuestion

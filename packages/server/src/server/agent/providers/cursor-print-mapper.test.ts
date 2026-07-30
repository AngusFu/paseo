import { describe, expect, test } from "vitest";

import {
  mapCursorPrintToolCall,
  normalizeCursorPrintTodos,
  resolveAssistantEmitText,
  toToolCallTimelineItem,
} from "./cursor-print-mapper.js";

describe("mapCursorPrintToolCall", () => {
  test("maps readToolCall started + completed with content", () => {
    const started = mapCursorPrintToolCall(
      {
        readToolCall: {
          args: { path: "/tmp/hello.txt" },
          toolCallId: "tc-1",
        },
      },
      "call-1",
    );
    expect(started).toMatchObject({
      callId: "call-1",
      name: "Read",
      detail: { type: "read", filePath: "/tmp/hello.txt" },
    });

    const completed = mapCursorPrintToolCall(
      {
        readToolCall: {
          args: { path: "/tmp/hello.txt" },
          result: {
            success: {
              content: "x\n",
              path: "/tmp/hello.txt",
              readRange: { startLine: 1, endLine: 2 },
            },
          },
        },
      },
      "call-1",
    );
    expect(completed?.detail).toEqual({
      type: "read",
      filePath: "/tmp/hello.txt",
      content: "x\n",
      offset: 1,
      limit: 2,
    });
  });

  test("maps editToolCall completed with unifiedDiff", () => {
    const mapped = mapCursorPrintToolCall(
      {
        editToolCall: {
          args: { path: "/tmp/hello.txt", streamContent: "x\ny\n" },
          result: {
            success: {
              path: "/tmp/hello.txt",
              diffString: "--- a\n+++ b\n@@ -1 +1,2 @@\n x\n+y",
              beforeFullFileContent: "x\n",
              afterFullFileContent: "x\ny\n",
            },
          },
        },
      },
      "edit-1",
    );
    expect(mapped).toMatchObject({
      callId: "edit-1",
      name: "Edit",
      detail: {
        type: "edit",
        filePath: "/tmp/hello.txt",
        oldString: "x\n",
        newString: "x\ny\n",
        unifiedDiff: "--- a\n+++ b\n@@ -1 +1,2 @@\n x\n+y",
      },
    });

    const item = toToolCallTimelineItem({
      callId: "edit-1",
      mapped: mapped!,
      status: "completed",
    });
    expect(item.status).toBe("completed");
    expect(item.detail.type).toBe("edit");
  });

  test("maps shellToolCall success with interleavedOutput and empty cwd", () => {
    const mapped = mapCursorPrintToolCall(
      {
        shellToolCall: {
          args: {
            command: "echo hi-from-shell",
            workingDirectory: "",
            description: "Echo hi-from-shell message",
          },
          result: {
            success: {
              command: "echo hi-from-shell",
              workingDirectory: "",
              exitCode: 0,
              stdout: "hi-from-shell\n",
              stderr: "",
              interleavedOutput: "hi-from-shell\n",
            },
          },
        },
      },
      "shell-1",
    );
    expect(mapped).toMatchObject({
      name: "Bash",
      failed: false,
      detail: {
        type: "shell",
        command: "echo hi-from-shell",
        output: "hi-from-shell\n",
        exitCode: 0,
      },
    });
    expect(mapped && (mapped.detail as { cwd?: string }).cwd).toBeUndefined();
  });

  test("maps shellToolCall failure with stdout/stderr payload", () => {
    const mapped = mapCursorPrintToolCall(
      {
        shellToolCall: {
          args: { command: "false" },
          result: {
            failure: {
              command: "false",
              exitCode: 1,
              stdout: "error: boom\n",
              stderr: "",
              interleavedOutput: "error: boom\n",
            },
          },
        },
      },
      "shell-fail",
    );
    expect(mapped).toMatchObject({
      failed: true,
      errorMessage: "error: boom\n",
      detail: {
        type: "shell",
        command: "false",
        output: "error: boom\n",
        exitCode: 1,
      },
    });
  });

  test("maps deleteToolCall rejected as failed edit delete", () => {
    const mapped = mapCursorPrintToolCall(
      {
        deleteToolCall: {
          args: { path: "/tmp/src/b.ts" },
          result: {
            rejected: { path: "", reason: "File deletion rejected" },
          },
        },
      },
      "del-1",
    );
    expect(mapped).toMatchObject({
      name: "Delete",
      failed: true,
      errorMessage: "File deletion rejected",
      detail: {
        type: "edit",
        filePath: "/tmp/src/b.ts",
        newString: "",
      },
    });
  });

  test("maps globToolCall files list via globPattern", () => {
    const mapped = mapCursorPrintToolCall(
      {
        globToolCall: {
          args: { globPattern: "**/*.ts" },
          result: {
            success: {
              files: ["./src/b.ts", "./src/a.ts"],
              totalFiles: 2,
            },
          },
        },
      },
      "glob-1",
    );
    expect(mapped).toMatchObject({
      name: "Glob",
      detail: {
        type: "search",
        toolName: "glob",
        query: "**/*.ts",
        content: "./src/b.ts\n./src/a.ts",
        filePaths: ["./src/b.ts", "./src/a.ts"],
        numFiles: 2,
      },
    });
  });

  test("maps grepToolCall nested workspaceResults", () => {
    const mapped = mapCursorPrintToolCall(
      {
        grepToolCall: {
          args: { pattern: "foo" },
          result: {
            success: {
              pattern: "foo",
              outputMode: "content",
              totalMatchedLines: 1,
              workspaceResults: {
                "/tmp/project": {
                  content: {
                    matches: [
                      {
                        file: "./src/a.ts",
                        matches: [
                          {
                            lineNumber: 1,
                            content: "foo bar",
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      "grep-1",
    );
    expect(mapped).toMatchObject({
      name: "Grep",
      detail: {
        type: "search",
        toolName: "grep",
        query: "foo",
        content: "./src/a.ts:1:foo bar",
        filePaths: ["./src/a.ts"],
        numMatches: 1,
        numFiles: 1,
        mode: "content",
      },
    });
  });

  test("maps askQuestionToolCall into AskUserQuestion unknown/questions shape", () => {
    const mapped = mapCursorPrintToolCall(
      {
        askQuestionToolCall: {
          args: {
            title: "下一步",
            questions: [
              {
                id: "demo_choice",
                prompt: "想让我帮你做什么？",
                options: [
                  { id: "jira", label: "查 Jira 工单" },
                  { id: "code", label: "看代码" },
                ],
                allowMultiple: false,
              },
            ],
          },
          result: {
            rejected: {
              reason:
                "Questions skipped by the user, continue with the information you already have",
            },
          },
        },
      },
      "ask-1",
    );
    expect(mapped).toMatchObject({
      name: "AskUserQuestion",
      callKey: "askQuestionToolCall",
      failed: true,
      detail: {
        type: "unknown",
        input: {
          title: "下一步",
          questions: [
            {
              question: "想让我帮你做什么？",
              header: "demo_choice",
              options: [{ label: "查 Jira 工单" }, { label: "看代码" }],
              multiSelect: false,
            },
          ],
        },
      },
    });
    // No plain_text label — avoids "AskUserQuestion AskQuestion" badge.
    expect(mapped?.detail.type).not.toBe("plain_text");
  });

  test("maps unknown *ToolCall as plain_text without duplicating the name as label", () => {
    const mapped = mapCursorPrintToolCall(
      {
        getMcpToolsToolCall: {
          args: { pattern: "ask_question|AskUserQuestion" },
          result: {
            success: {
              content: '{\n  "mode": "search",\n  "matches": []\n}',
            },
          },
        },
      },
      "mcp-1",
    );
    expect(mapped).toMatchObject({
      name: "GetMcpTools",
      callKey: "getMcpToolsToolCall",
      detail: {
        type: "plain_text",
        label: "ask_question|AskUserQuestion",
        icon: "wrench",
        text: '{\n  "mode": "search",\n  "matches": []\n}',
      },
    });
  });

  test("maps webSearchToolCall without WebSearch WebSearch badge", () => {
    const mapped = mapCursorPrintToolCall(
      {
        webSearchToolCall: {
          args: { searchTerm: "cursor agent cli --force" },
          result: {
            success: {
              references: [
                {
                  title: "Web search results",
                  url: "",
                  chunk: "Title: Example\nURL: https://example.com",
                },
              ],
            },
          },
        },
      },
      "web-1",
    );
    expect(mapped).toMatchObject({
      name: "WebSearch",
      callKey: "webSearchToolCall",
      detail: {
        type: "plain_text",
        label: "cursor agent cli --force",
        icon: "wrench",
      },
    });
    // Badge is displayName + summary; label must not repeat the tool name.
    expect(mapped?.detail.type === "plain_text" && mapped.detail.label).not.toBe("WebSearch");
  });

  test("maps updateTodosToolCall into TodoWrite unknown input for Tasks card", () => {
    const mapped = mapCursorPrintToolCall(
      {
        updateTodosToolCall: {
          args: {
            todos: [
              { id: "1", content: "Implement login", status: "in_progress" },
              { content: "Write tests", status: "pending" },
            ],
          },
          result: { success: { updated: true } },
        },
      },
      "call-todos",
    );
    expect(mapped).toMatchObject({
      callId: "call-todos",
      name: "TodoWrite",
      callKey: "updateTodosToolCall",
      detail: {
        type: "unknown",
        input: {
          todos: [
            { content: "Implement login", status: "in_progress" },
            { content: "Write tests", status: "pending" },
          ],
        },
      },
    });
  });

  test("normalizes todo aliases and skips empty updates", () => {
    expect(
      normalizeCursorPrintTodos([
        { description: "Ship it", status: "IN-PROGRESS" },
        { title: "Done item", status: "done" },
        { text: "Cancelled", status: "cancelled" },
        { status: "pending" },
      ]),
    ).toEqual([
      { content: "Ship it", status: "in_progress" },
      { content: "Done item", status: "completed" },
      { content: "Cancelled", status: "completed" },
    ]);

    expect(
      mapCursorPrintToolCall(
        {
          todoToolCall: {
            args: { todos: [] },
          },
        },
        "call-empty",
      ),
    ).toBeNull();
  });
});

describe("resolveAssistantEmitText", () => {
  test("emits suffix deltas then skips duplicate final snapshot", () => {
    const first = resolveAssistantEmitText({
      incoming: "我",
      accumulated: "",
      hasModelCallId: false,
    });
    expect(first).toEqual({ text: "我", nextAccumulated: "我", skip: false });

    const second = resolveAssistantEmitText({
      incoming: "来读取",
      accumulated: first.nextAccumulated,
      hasModelCallId: false,
    });
    expect(second).toEqual({ text: "来读取", nextAccumulated: "我来读取", skip: false });

    // Cumulative snapshot without model_call_id → emit only unseen suffix.
    const growing = resolveAssistantEmitText({
      incoming: "我来读取文件",
      accumulated: second.nextAccumulated,
      hasModelCallId: false,
    });
    expect(growing).toEqual({ text: "文件", nextAccumulated: "我来读取文件", skip: false });

    const final = resolveAssistantEmitText({
      incoming: "我来读取文件",
      accumulated: growing.nextAccumulated,
      hasModelCallId: true,
    });
    expect(final.skip).toBe(true);
  });
});

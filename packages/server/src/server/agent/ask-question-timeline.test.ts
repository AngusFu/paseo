import { describe, expect, test } from "vitest";

import {
  CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
  isOpaqueAcpMcpToolCall,
  projectAskQuestionTimelineToolCall,
} from "./ask-question-timeline.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

const QUESTIONS = [
  {
    question: "Which environment?",
    header: "Env",
    options: [{ label: "staging" }, { label: "production" }],
  },
];

function toolCall(params: {
  name: string;
  detail?: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"];
  metadata?: Record<string, unknown>;
}): Extract<AgentTimelineItem, { type: "tool_call" }> {
  return {
    type: "tool_call",
    callId: "call-1",
    name: params.name,
    status: "running",
    error: null,
    detail: params.detail ?? {
      type: "unknown",
      input: { questions: QUESTIONS },
      output: null,
    },
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
}

describe("projectAskQuestionTimelineToolCall", () => {
  test("rewrites Claude MCP ask_question tool names to AskUserQuestion", () => {
    const projected = projectAskQuestionTimelineToolCall(
      toolCall({ name: "mcp__paseo__ask_question" }),
    );
    expect(projected).toMatchObject({
      type: "tool_call",
      name: CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
      detail: {
        type: "unknown",
        input: { questions: QUESTIONS },
      },
    });
  });

  test("rewrites MCP ask_question even before question args arrive", () => {
    const projected = projectAskQuestionTimelineToolCall(
      toolCall({
        name: "mcp__paseo__ask_question",
        detail: { type: "unknown", input: null, output: null },
      }),
    );
    expect(projected).toMatchObject({
      type: "tool_call",
      name: CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
    });
  });

  test("rewrites ACP human titles when questions are present", () => {
    const projected = projectAskQuestionTimelineToolCall(
      toolCall({
        name: "Ask the user a question",
        metadata: { title: "Ask the user a question" },
      }),
    );
    expect(projected).toMatchObject({
      type: "tool_call",
      name: CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
    });
  });

  test("leaves native AskUserQuestion and unrelated tools alone", () => {
    const native = toolCall({ name: CLAUDE_ASK_USER_QUESTION_TOOL_NAME });
    expect(projectAskQuestionTimelineToolCall(native)).toEqual({
      ...native,
      detail: {
        type: "unknown",
        input: { questions: QUESTIONS },
        output: null,
      },
    });

    const bash = toolCall({
      name: "Bash",
      detail: {
        type: "shell",
        command: "echo hi",
      },
    });
    expect(projectAskQuestionTimelineToolCall(bash)).toBe(bash);
  });

  test("runs through the shared timeline content funnel", () => {
    const item = limitAgentTimelineItemContent(toolCall({ name: "mcp__paseo__ask_question" }));
    expect(item).toMatchObject({
      type: "tool_call",
      name: CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
    });
  });

  test("detects Cursor ACP opaque MCP: tool shells", () => {
    expect(
      isOpaqueAcpMcpToolCall(
        toolCall({
          name: "other",
          detail: { type: "unknown", input: {}, output: null },
          metadata: { kind: "other", title: "MCP: tool" },
        }),
      ),
    ).toBe(true);
  });
});

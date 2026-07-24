import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { InboxQuestionItem } from "@getpaseo/protocol/question/types";
import { isPlanExecuteQuestionRequestId } from "../agent/plan-execute-question.js";

export function isInboxPermissionRequestId(requestId: string): boolean {
  return requestId.startsWith("mcp-question-") || requestId.startsWith("inbox-question-");
}

/**
 * True for provider-native question permissions (Claude AskUserQuestion,
 * Codex request_user_input, …). Excludes MCP/inbox/plan-execute disguises.
 */
export function isNativeQuestionPermission(request: AgentPermissionRequest): boolean {
  if (request.kind !== "question") {
    return false;
  }
  if (isInboxPermissionRequestId(request.id) || isPlanExecuteQuestionRequestId(request.id)) {
    return false;
  }
  return true;
}

export function extractInboxQuestionsFromPermission(
  request: AgentPermissionRequest,
): InboxQuestionItem[] | null {
  const input = request.input;
  if (!input || typeof input !== "object" || !Array.isArray(input.questions)) {
    return null;
  }
  const questions: InboxQuestionItem[] = [];
  for (const item of input.questions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const record = item as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const header = typeof record.header === "string" ? record.header.trim() : "";
    if (!question || !header) {
      return null;
    }
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return [];
          }
          const optionRecord = option as Record<string, unknown>;
          const label = typeof optionRecord.label === "string" ? optionRecord.label.trim() : "";
          if (!label) {
            return [];
          }
          return [
            {
              label,
              ...(typeof optionRecord.description === "string"
                ? { description: optionRecord.description }
                : {}),
            },
          ];
        })
      : undefined;
    questions.push({
      question,
      header,
      ...(options ? { options } : {}),
      ...(typeof record.multiSelect === "boolean" ? { multiSelect: record.multiSelect } : {}),
      ...(typeof record.allowOther === "boolean" ? { allowOther: record.allowOther } : {}),
      ...(typeof record.allowEmpty === "boolean" ? { allowEmpty: record.allowEmpty } : {}),
      ...(typeof record.placeholder === "string" ? { placeholder: record.placeholder } : {}),
    });
  }
  return questions.length > 0 ? questions : null;
}

/**
 * Normalize permission answers to header-keyed map (inbox / Approvals shape).
 * Accepts either question-text keys (Claude) or header keys (Paseo UI).
 */
export function headerKeyedAnswersFromPermissionResponse(input: {
  questions: InboxQuestionItem[];
  response: AgentPermissionResponse;
}): Record<string, string> | null {
  if (input.response.behavior !== "allow") {
    return null;
  }
  const raw = input.response.updatedInput?.answers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rawAnswers = raw as Record<string, unknown>;
  const answers: Record<string, string> = {};
  for (const question of input.questions) {
    const byHeader = rawAnswers[question.header];
    const byText = rawAnswers[question.question];
    const value =
      (typeof byHeader === "string" && byHeader.trim().length > 0 ? byHeader : null) ??
      (typeof byText === "string" && byText.trim().length > 0 ? byText : null);
    if (value) {
      answers[question.header] = value;
    }
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

import type { StoredInboxQuestion } from "@getpaseo/protocol/question/types";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { PendingPermission } from "@/types/shared";

/**
 * Build a synthetic permission so Approvals can reuse QuestionFormCard.
 * Answers go through question.answer RPC, not respondToPermission.
 */
export function toInboxQuestionPermission(question: StoredInboxQuestion): PendingPermission {
  return {
    key: `inbox:${question.id}`,
    agentId: question.agentId,
    request: {
      id: question.mcpRequestId ?? question.id,
      provider: "paseo",
      name: "ask_question",
      kind: "question",
      ...(question.title ? { title: question.title } : {}),
      input: {
        questions: question.questions.map((item) => ({
          question: item.question,
          header: item.header,
          options: item.options ?? [],
          ...(item.multiSelect !== undefined ? { multiSelect: item.multiSelect } : {}),
          ...(item.allowOther !== undefined ? { allowOther: item.allowOther } : {}),
          ...(item.allowEmpty !== undefined ? { allowEmpty: item.allowEmpty } : {}),
          ...(item.placeholder !== undefined ? { placeholder: item.placeholder } : {}),
        })),
      },
    },
  };
}

export function answersFromPermissionResponse(
  response: AgentPermissionResponse,
): { dismiss: true } | { answers: Record<string, string> } {
  if (response.behavior === "deny") {
    return { dismiss: true };
  }
  const raw = response.updatedInput?.answers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Question submit missing answers");
  }
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      answers[key] = value;
    }
  }
  if (Object.keys(answers).length === 0) {
    throw new Error("Question submit missing answers");
  }
  return { answers };
}

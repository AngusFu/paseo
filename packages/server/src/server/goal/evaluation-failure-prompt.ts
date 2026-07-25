/**
 * Body for a paseo-goal evaluator failure notification.
 * Wrapped by formatSystemNotificationPrompt at the call site.
 */
export function formatGoalEvaluationFailurePrompt(args: {
  condition: string;
  reason: string;
}): string {
  return [
    "paseo-goal: the daemon evaluator could not run.",
    "",
    `Condition: ${args.condition.trim()}`,
    `Error: ${args.reason.trim()}`,
    "",
    "The in-thread goal is paused until you clear it or re-register.",
    "Tell the user what happened and suggest either:",
    "- retry after configuring metadataGeneration providers on the host, or",
    "- fall back to paseo-loop for unattended continuation.",
    "Call clear_paseo_goal when abandoning this in-tab goal.",
  ].join("\n");
}

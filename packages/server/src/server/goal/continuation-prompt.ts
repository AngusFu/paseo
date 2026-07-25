/**
 * Body for a paseo-goal in-turn continuation nudge.
 * Wrapped by formatSystemNotificationPrompt at the call site.
 */
export function formatGoalContinuationPrompt(args: {
  condition: string;
  reason: string;
  iteration: number;
  maxIterations: number;
}): string {
  const remaining = Math.max(0, args.maxIterations - args.iteration);
  return [
    "paseo-goal: the completion condition is not met yet.",
    "",
    `Condition: ${args.condition.trim()}`,
    `Evaluator: ${args.reason.trim()}`,
    `Iteration: ${args.iteration}/${args.maxIterations} (${remaining} remaining).`,
    "",
    "Continue working toward the condition in this same agent tab.",
    "When blocked, stop and state exactly what is missing — do not spin.",
    "When done, summarize evidence (commands, files, test output) that proves the condition holds.",
  ].join("\n");
}

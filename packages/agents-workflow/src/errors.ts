// caveman law: ONE tribe root for all agents-workflow throw-rocks.
//
// every workflow-level error (runner
// ExecError, engine WorkflowAgentCapError/WorkflowBudgetExceededError)
// extends this ONE base. a caller that only cares "did the workflow layer
// throw" can do a single `catch (e) { if (e instanceof WorkflowError) ... }`
// instead of listing every subclass. names + messages of the subclasses do
// NOT change - this only adds a shared ancestor.
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

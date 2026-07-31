import type { ToolCallDetail, ToolCallTimelineItem } from "../agent-sdk-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNestedSuccess(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) {
    return null;
  }
  if (isRecord(result.success)) {
    return result.success;
  }
  return null;
}

function readNestedFailure(result: unknown): {
  failed: boolean;
  message: string | null;
  payload: Record<string, unknown> | null;
} {
  if (!isRecord(result)) {
    return { failed: false, message: null, payload: null };
  }
  if (isRecord(result.failure)) {
    return {
      failed: true,
      message:
        readString(result.failure.message) ??
        readString(result.failure.reason) ??
        readString(result.failure.stdout) ??
        "Tool failed",
      payload: result.failure,
    };
  }
  if (isRecord(result.rejected)) {
    return {
      failed: true,
      message:
        readString(result.rejected.reason) ??
        readString(result.rejected.message) ??
        "Tool rejected",
      payload: result.rejected,
    };
  }
  return { failed: false, message: null, payload: null };
}

function readShellOutput(payload: Record<string, unknown> | null | undefined): string | undefined {
  if (!payload) {
    return undefined;
  }
  const interleaved = readOptionalString(payload.interleavedOutput);
  if (interleaved) {
    return interleaved;
  }
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  if (stdout && stderr) {
    return `${stdout}${stderr.endsWith("\n") || stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
  }
  if (stdout) {
    return stdout;
  }
  if (stderr) {
    return stderr;
  }
  return readOptionalString(payload.output) ?? readOptionalString(payload.content);
}

/* eslint-disable complexity -- Cursor tool_call variants are branched by wire key. */
function formatGrepWorkspaceResults(success: Record<string, unknown>): {
  content?: string;
  filePaths?: string[];
  numMatches?: number;
  numFiles?: number;
  mode?: "content" | "files_with_matches" | "count";
} {
  const workspaceResults = success.workspaceResults;
  if (!isRecord(workspaceResults)) {
    return {
      content: readOptionalString(success.content),
      numMatches: typeof success.numMatches === "number" ? success.numMatches : undefined,
      numFiles: typeof success.numFiles === "number" ? success.numFiles : undefined,
    };
  }

  const lines: string[] = [];
  const filePaths: string[] = [];
  let numMatches = 0;
  for (const workspace of Object.values(workspaceResults)) {
    if (!isRecord(workspace) || !isRecord(workspace.content)) {
      continue;
    }
    const matches = Array.isArray(workspace.content.matches) ? workspace.content.matches : [];
    for (const fileMatch of matches) {
      if (!isRecord(fileMatch)) {
        continue;
      }
      const file = readString(fileMatch.file);
      if (file) {
        filePaths.push(file);
      }
      const lineMatches = Array.isArray(fileMatch.matches) ? fileMatch.matches : [];
      for (const lineMatch of lineMatches) {
        if (!isRecord(lineMatch)) {
          continue;
        }
        numMatches += 1;
        const lineNumber =
          typeof lineMatch.lineNumber === "number" ? String(lineMatch.lineNumber) : "?";
        const content = typeof lineMatch.content === "string" ? lineMatch.content : "";
        lines.push(`${file ?? "?"}:${lineNumber}:${content}`);
      }
    }
  }

  const outputMode = readString(success.outputMode);
  const mode =
    outputMode === "files_with_matches" || outputMode === "count" || outputMode === "content"
      ? outputMode
      : undefined;

  return {
    content: lines.length > 0 ? lines.join("\n") : readOptionalString(success.content),
    filePaths: filePaths.length > 0 ? filePaths : undefined,
    numMatches:
      typeof success.totalMatchedLines === "number"
        ? success.totalMatchedLines
        : numMatches || undefined,
    numFiles: filePaths.length > 0 ? new Set(filePaths).size : undefined,
    mode,
  };
}

function humanizeToolCallKey(key: string): string {
  const bare = key.endsWith("ToolCall") ? key.slice(0, -"ToolCall".length) : key;
  if (!bare) {
    return "Tool";
  }
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

export interface MappedCursorToolCall {
  callId: string | null;
  name: string;
  detail: ToolCallDetail;
  /** Stable key used when call_id is absent. */
  callKey: string;
  failed: boolean;
  errorMessage: string | null;
}

interface NormalizedCursorTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

function normalizeCursorTodoStatus(value: unknown): NormalizedCursorTodo["status"] | null {
  if (typeof value !== "string") {
    return null;
  }
  let normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  // Cursor stream-json uses TODO_STATUS_PENDING / IN_PROGRESS / COMPLETED.
  if (normalized.startsWith("todo_status_")) {
    normalized = normalized.slice("todo_status_".length);
  }
  switch (normalized) {
    case "pending":
    case "todo":
    case "not_started":
    case "open":
      return "pending";
    case "in_progress":
    case "inprogress":
    case "active":
    case "doing":
    case "started":
      return "in_progress";
    case "completed":
    case "complete":
    case "done":
    case "finished":
      return "completed";
    case "cancelled":
    case "canceled":
    case "skipped":
      // Surface cancelled items as completed so the Tasks card still lists them.
      return "completed";
    default:
      return null;
  }
}

function normalizeCursorTodoItem(value: unknown): NormalizedCursorTodo | null {
  if (!isRecord(value)) {
    return null;
  }
  const content =
    readString(value.content) ??
    readString(value.description) ??
    readString(value.title) ??
    readString(value.text) ??
    readString(value.task);
  if (!content) {
    return null;
  }
  const status = normalizeCursorTodoStatus(value.status) ?? "pending";
  const activeForm = readOptionalString(value.activeForm) ?? readOptionalString(value.active_form);
  return {
    content,
    status,
    ...(activeForm ? { activeForm } : {}),
  };
}

/** Exported for unit tests — coerce Cursor todo args into Claude TodoWrite shape. */
export function normalizeCursorPrintTodos(rawTodos: unknown): NormalizedCursorTodo[] {
  if (!Array.isArray(rawTodos)) {
    return [];
  }
  return rawTodos.flatMap((item) => {
    const normalized = normalizeCursorTodoItem(item);
    return normalized ? [normalized] : [];
  });
}

/**
 * Map Cursor `updateTodosToolCall` into Claude-shaped TodoWrite input so the
 * app Tasks card can reuse extractTaskEntriesFromToolCall (keeps in_progress).
 *
 * Prefer `result.success.todos` when present: Cursor's completed payload carries
 * the authoritative list (incl. TODO_STATUS_* enums). Args alone are often merge
 * patches without content, or statuses that only resolve correctly after success.
 */
function mapUpdateTodosToolCall(
  updateTodos: Record<string, unknown>,
  callIdFromEvent: string | null,
  toolCall: Record<string, unknown>,
): MappedCursorToolCall | null {
  const args = isRecord(updateTodos.args) ? updateTodos.args : {};
  const failure = readNestedFailure(updateTodos.result);
  const success = readNestedSuccess(updateTodos.result);
  const fromResult = success ? normalizeCursorPrintTodos(success.todos) : [];
  const fromArgs = normalizeCursorPrintTodos(args.todos);
  const todos = fromResult.length > 0 ? fromResult : fromArgs;
  if (todos.length === 0) {
    return null;
  }
  return {
    callId:
      callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(updateTodos.toolCallId),
    name: "TodoWrite",
    callKey: toolCall.updateTodosToolCall ? "updateTodosToolCall" : "todoToolCall",
    failed: failure.failed,
    errorMessage: failure.failed ? (failure.message ?? "Todo update failed") : null,
    detail: {
      type: "unknown",
      input: { todos },
      output: success ?? failure.payload ?? undefined,
    },
  };
}

/**
 * Normalize Cursor `askQuestionToolCall` args into the unknown/{questions}
 * shape AskQuestionCard + ask-question-timeline projection expect.
 * Avoids plain_text label "AskQuestion" + projected name "AskUserQuestion"
 * rendering as the awkward "AskUserQuestion AskQuestion" badge.
 */
function mapAskQuestionToolCall(
  ask: Record<string, unknown>,
  callIdFromEvent: string | null,
  toolCall: Record<string, unknown>,
): MappedCursorToolCall {
  const args = isRecord(ask.args) ? ask.args : {};
  const success = readNestedSuccess(ask.result);
  const failure = readNestedFailure(ask.result);
  const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
  const questions = rawQuestions.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const prompt = readString(item.prompt) ?? readString(item.question) ?? readString(item.text);
    if (!prompt) {
      return [];
    }
    const header =
      readString(item.header) ??
      readString(item.id) ??
      (prompt.length > 24 ? `${prompt.slice(0, 24)}…` : prompt);
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    const options = rawOptions.flatMap((opt) => {
      if (!isRecord(opt)) {
        return [];
      }
      const label = readString(opt.label) ?? readString(opt.id);
      if (!label) {
        return [];
      }
      const description = readString(opt.description);
      return [
        {
          label,
          ...(description ? { description } : {}),
        },
      ];
    });
    return [
      {
        question: prompt,
        header,
        options,
        multiSelect: item.allowMultiple === true || item.multiSelect === true,
        allowOther: item.allowOther === true,
        allowEmpty: item.allowEmpty === true,
      },
    ];
  });

  const title = readString(args.title);
  const output =
    success ?? (failure.failed ? (failure.payload ?? { message: failure.message }) : null);

  if (questions.length > 0) {
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(ask.toolCallId),
      name: "AskUserQuestion",
      callKey: "askQuestionToolCall",
      failed: failure.failed,
      errorMessage: failure.failed
        ? (failure.message ??
          "Questions skipped by the user, continue with the information you already have")
        : null,
      detail: {
        type: "unknown",
        input: {
          ...(title ? { title } : {}),
          questions,
        },
        output,
      },
    };
  }

  // Fallback when args are incomplete — keep a single display name (no plain_text label).
  return {
    callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(ask.toolCallId),
    name: "AskUserQuestion",
    callKey: "askQuestionToolCall",
    failed: failure.failed,
    errorMessage: failure.failed ? (failure.message ?? "AskQuestion failed") : null,
    detail: {
      type: "unknown",
      input: args,
      output,
    },
  };
}

/**
 * Map Cursor print/stream-json `tool_call` payloads into Paseo ToolCallDetail.
 * Wire shape is NOT ACP — this is the adaptation layer (cf. acp-agent mapToolDetail).
 */
export function mapCursorPrintToolCall(
  toolCall: Record<string, unknown>,
  callIdFromEvent: string | null,
): MappedCursorToolCall | null {
  // complexity: one branch per Cursor *ToolCall wire shape.
  const shell = toolCall.shellToolCall;
  if (isRecord(shell)) {
    const args = isRecord(shell.args) ? shell.args : {};
    const success = readNestedSuccess(shell.result);
    const failure = readNestedFailure(shell.result);
    const payload = success ?? failure.payload;
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(shell.toolCallId),
      name: "Bash",
      callKey: "shellToolCall",
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? "Shell tool failed") : null,
      detail: {
        type: "shell",
        command:
          readString(args.command) ??
          readString(success?.command) ??
          readString(shell.description) ??
          "Bash",
        cwd: readOptionalString(args.workingDirectory) ?? readOptionalString(args.cwd),
        output: readShellOutput(payload),
        exitCode: typeof payload?.exitCode === "number" ? payload.exitCode : undefined,
      },
    };
  }

  const read = toolCall.readToolCall;
  if (isRecord(read)) {
    const args = isRecord(read.args) ? read.args : {};
    const success = readNestedSuccess(read.result);
    const failure = readNestedFailure(read.result);
    const path =
      readString(args.path) ??
      readString(success?.path) ??
      readString(args.filePath) ??
      readString(read.description) ??
      "Read";
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(read.toolCallId),
      name: "Read",
      callKey: "readToolCall",
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? "Read tool failed") : null,
      detail: {
        type: "read",
        filePath: path,
        content: readString(success?.content) ?? undefined,
        offset:
          isRecord(success?.readRange) && typeof success.readRange.startLine === "number"
            ? success.readRange.startLine
            : undefined,
        limit:
          isRecord(success?.readRange) &&
          typeof success.readRange.startLine === "number" &&
          typeof success.readRange.endLine === "number"
            ? success.readRange.endLine - success.readRange.startLine + 1
            : undefined,
      },
    };
  }

  const edit = toolCall.editToolCall;
  if (isRecord(edit)) {
    const args = isRecord(edit.args) ? edit.args : {};
    const success = readNestedSuccess(edit.result);
    const failure = readNestedFailure(edit.result);
    const path =
      readString(args.path) ??
      readString(success?.path) ??
      readString(args.filePath) ??
      readString(edit.description) ??
      "Edit";
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(edit.toolCallId),
      name: "Edit",
      callKey: "editToolCall",
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? "Edit tool failed") : null,
      detail: {
        type: "edit",
        filePath: path,
        oldString: readString(success?.beforeFullFileContent) ?? undefined,
        newString:
          readString(success?.afterFullFileContent) ?? readString(args.streamContent) ?? undefined,
        unifiedDiff: readString(success?.diffString) ?? undefined,
      },
    };
  }

  const write = toolCall.writeToolCall;
  if (isRecord(write)) {
    const args = isRecord(write.args) ? write.args : {};
    const success = readNestedSuccess(write.result);
    const failure = readNestedFailure(write.result);
    const path =
      readString(args.path) ??
      readString(success?.path) ??
      readString(args.filePath) ??
      readString(write.description) ??
      "Write";
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(write.toolCallId),
      name: "Write",
      callKey: "writeToolCall",
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? "Write tool failed") : null,
      detail: {
        type: "write",
        filePath: path,
        content:
          readString(args.contents) ??
          readString(args.content) ??
          readString(args.streamContent) ??
          readString(success?.afterFullFileContent) ??
          undefined,
      },
    };
  }

  const del = toolCall.deleteToolCall;
  if (isRecord(del)) {
    const args = isRecord(del.args) ? del.args : {};
    const success = readNestedSuccess(del.result);
    const failure = readNestedFailure(del.result);
    const path =
      readString(args.path) ??
      readString(success?.path) ??
      readString(failure.payload?.path) ??
      readString(args.filePath) ??
      readString(del.description) ??
      "Delete";
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(del.toolCallId),
      name: "Delete",
      callKey: "deleteToolCall",
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? "Delete tool failed") : null,
      detail: {
        type: "edit",
        filePath: path,
        oldString: readString(success?.beforeFullFileContent) ?? undefined,
        newString: "",
        unifiedDiff: readString(success?.diffString) ?? undefined,
      },
    };
  }

  const list = toolCall.listToolCall ?? toolCall.lsToolCall;
  if (isRecord(list)) {
    const args = isRecord(list.args) ? list.args : {};
    const success = readNestedSuccess(list.result);
    const failure = readNestedFailure(list.result);
    const path =
      readString(args.path) ??
      readString(args.targetDirectory) ??
      readString(success?.path) ??
      readString(list.description) ??
      ".";
    let entries: unknown[] | null = null;
    if (Array.isArray(success?.entries)) {
      entries = success.entries;
    } else if (Array.isArray(success?.files)) {
      entries = success.files;
    }
    const content =
      readOptionalString(success?.content) ??
      (entries
        ? entries
            .map((entry) => {
              if (typeof entry === "string") {
                return entry;
              }
              if (isRecord(entry)) {
                return readString(entry.name) ?? readString(entry.path) ?? JSON.stringify(entry);
              }
              return null;
            })
            .filter((line): line is string => Boolean(line))
            .join("\n")
        : undefined);
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(list.toolCallId),
      name: "List",
      callKey: toolCall.listToolCall ? "listToolCall" : "lsToolCall",
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? "List tool failed") : null,
      detail: {
        type: "search",
        toolName: "glob",
        query: path,
        content,
        filePaths: Array.isArray(success?.files)
          ? success.files.filter((file): file is string => typeof file === "string")
          : undefined,
        numFiles: typeof success?.totalFiles === "number" ? success.totalFiles : undefined,
      },
    };
  }

  const grep = toolCall.grepToolCall;
  if (isRecord(grep)) {
    const args = isRecord(grep.args) ? grep.args : {};
    const success = readNestedSuccess(grep.result);
    const failure = readNestedFailure(grep.result);
    const formatted = success ? formatGrepWorkspaceResults(success) : {};
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(grep.toolCallId),
      name: "Grep",
      callKey: "grepToolCall",
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? "Grep tool failed") : null,
      detail: {
        type: "search",
        toolName: "grep",
        query:
          readString(args.pattern) ??
          readString(args.query) ??
          readString(grep.description) ??
          "Grep",
        content: formatted.content,
        filePaths: formatted.filePaths,
        numMatches: formatted.numMatches,
        numFiles: formatted.numFiles,
        mode: formatted.mode,
      },
    };
  }

  const glob = toolCall.globToolCall;
  if (isRecord(glob)) {
    const args = isRecord(glob.args) ? glob.args : {};
    const success = readNestedSuccess(glob.result);
    const failure = readNestedFailure(glob.result);
    const files = Array.isArray(success?.files)
      ? success.files.filter((file): file is string => typeof file === "string")
      : undefined;
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(glob.toolCallId),
      name: "Glob",
      callKey: "globToolCall",
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? "Glob tool failed") : null,
      detail: {
        type: "search",
        toolName: "glob",
        query:
          readString(args.globPattern) ??
          readString(args.pattern) ??
          readString(args.query) ??
          readString(glob.description) ??
          "Glob",
        content: files?.join("\n") ?? readOptionalString(success?.content),
        filePaths: files,
        numFiles: typeof success?.totalFiles === "number" ? success.totalFiles : files?.length,
      },
    };
  }

  const search = toolCall.searchToolCall;
  if (isRecord(search)) {
    const args = isRecord(search.args) ? search.args : {};
    const success = readNestedSuccess(search.result);
    const failure = readNestedFailure(search.result);
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(search.toolCallId),
      name: "Search",
      callKey: "searchToolCall",
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? "Search tool failed") : null,
      detail: {
        type: "search",
        toolName: "search",
        query:
          readString(args.pattern) ??
          readString(args.query) ??
          readString(search.description) ??
          "Search",
        content: readOptionalString(success?.content),
        numMatches: typeof success?.numMatches === "number" ? success.numMatches : undefined,
        numFiles: typeof success?.numFiles === "number" ? success.numFiles : undefined,
      },
    };
  }

  const webFetch = toolCall.webFetchToolCall;
  if (isRecord(webFetch)) {
    const args = isRecord(webFetch.args) ? webFetch.args : {};
    const success = readNestedSuccess(webFetch.result);
    const failure = readNestedFailure(webFetch.result);
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(webFetch.toolCallId),
      name: "WebFetch",
      callKey: "webFetchToolCall",
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? "WebFetch tool failed") : null,
      detail: {
        type: "fetch",
        url: readString(args.url) ?? readString(webFetch.description) ?? "",
        result: readString(success?.content) ?? readString(success?.result) ?? undefined,
      },
    };
  }

  const askQuestion = toolCall.askQuestionToolCall;
  if (isRecord(askQuestion)) {
    return mapAskQuestionToolCall(askQuestion, callIdFromEvent, toolCall);
  }

  const updateTodos = toolCall.updateTodosToolCall ?? toolCall.todoToolCall;
  if (isRecord(updateTodos)) {
    return mapUpdateTodosToolCall(updateTodos, callIdFromEvent, toolCall);
  }

  // Unknown nested *ToolCall shapes (e.g. webSearchToolCall, getMcpToolsToolCall) → plain_text.
  // Do not set label to the tool name — UI shows displayName + summary, so label===name
  // becomes the awkward "WebSearch WebSearch" badge.
  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith("ToolCall") || !isRecord(value)) {
      continue;
    }
    const args = isRecord(value.args) ? value.args : {};
    const success = readNestedSuccess(value.result);
    const failure = readNestedFailure(value.result);
    const name = humanizeToolCallKey(key);
    const summary =
      readString(args.searchTerm) ??
      readString(args.query) ??
      readString(args.pattern) ??
      readString(args.url) ??
      readString(value.description);
    const text =
      readOptionalString(success?.content) ??
      (success ? JSON.stringify(success, null, 2) : undefined) ??
      (Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : undefined) ??
      readOptionalString(value.description);
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId) ?? readString(value.toolCallId),
      name,
      callKey: key,
      failed: failure.failed,
      errorMessage: failure.failed ? (failure.message ?? `${name} failed`) : null,
      detail: {
        type: "plain_text",
        ...(summary && summary !== name ? { label: summary } : {}),
        icon: "wrench",
        text,
      },
    };
  }

  const description = readString(toolCall.description);
  if (description) {
    return {
      callId: callIdFromEvent ?? readString(toolCall.toolCallId),
      name: "Tool",
      callKey: "generic",
      failed: false,
      errorMessage: null,
      detail: { type: "unknown", input: description, output: undefined },
    };
  }
  return null;
}
/* eslint-enable complexity */

export function toToolCallTimelineItem(options: {
  callId: string;
  mapped: MappedCursorToolCall;
  status: ToolCallTimelineItem["status"];
}): ToolCallTimelineItem {
  const base = {
    type: "tool_call" as const,
    callId: options.callId,
    name: options.mapped.name,
    detail: options.mapped.detail,
    metadata: {
      cursorCallKey: options.mapped.callKey,
    },
  };
  if (options.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: { message: options.mapped.errorMessage ?? "Tool failed" },
    };
  }
  if (options.status === "completed") {
    return { ...base, status: "completed", error: null };
  }
  if (options.status === "canceled") {
    return { ...base, status: "canceled", error: null };
  }
  return { ...base, status: "running", error: null };
}

/**
 * Print + --stream-partial-output emits assistant text as:
 *   delta chunks (no model_call_id) then a cumulative final (often with model_call_id).
 *
 * Timeline projection concatenates adjacent assistant_message chunks, so we must emit
 * **suffix deltas only** (same contract as ACP agent_message_chunk).
 */
export function resolveAssistantEmitText(options: {
  incoming: string;
  accumulated: string;
  hasModelCallId: boolean;
}): { text: string; nextAccumulated: string; skip: boolean } {
  const { incoming, accumulated, hasModelCallId } = options;
  if (!incoming) {
    return { text: "", nextAccumulated: accumulated, skip: true };
  }

  if (hasModelCallId) {
    // Final snapshot — emit only the unseen suffix, or skip when already streamed.
    if (!accumulated) {
      return { text: incoming, nextAccumulated: incoming, skip: false };
    }
    if (incoming === accumulated || accumulated.startsWith(incoming)) {
      return { text: "", nextAccumulated: accumulated, skip: true };
    }
    if (incoming.startsWith(accumulated)) {
      const suffix = incoming.slice(accumulated.length);
      return { text: suffix, nextAccumulated: incoming, skip: suffix.length === 0 };
    }
    // Divergent final snapshot: replace by emitting the full text as a fresh chunk.
    return { text: incoming, nextAccumulated: incoming, skip: false };
  }

  if (!accumulated) {
    return { text: incoming, nextAccumulated: incoming, skip: false };
  }
  if (incoming.startsWith(accumulated)) {
    const suffix = incoming.slice(accumulated.length);
    return { text: suffix, nextAccumulated: incoming, skip: suffix.length === 0 };
  }
  // Pure delta suffix
  return {
    text: incoming,
    nextAccumulated: `${accumulated}${incoming}`,
    skip: false,
  };
}

// Multi-turn chat on the daemon's built-in local model. The daemon owns the
// loop: it replays truncated history into the stateless llm worker, optionally
// routes one or more Paseo tool calls (grammar-constrained JSON, whitelist
// only), streams the reply as llm.chat.event pushes, and persists each chat to
// $PASEO_HOME/llm-chat/<chatId>.json.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  StoredLlmChatSchema,
  type LlmChatEvent,
  type LlmChatMessage,
  type LlmChatSummary,
  type LlmChatToolCall,
  type StoredLlmChat,
} from "@getpaseo/protocol/llm/chat-rpc-schemas";
import type pino from "pino";
import type { PaseoToolCatalog } from "../agent/tools/types.js";
import type { LlamaService } from "./llama-service.js";
import type { LlmWorkerHistoryItem } from "./worker-protocol.js";

// Context is 4096 tokens; budget characters conservatively (~4 chars/token):
// history ~2000 tokens, system prompt + tool notes ~1000, generation ~1000.
const HISTORY_CHAR_BUDGET = 8000;
const MAX_USER_MESSAGE_CHARS = 4000;
const TOOL_RESULT_CHAR_LIMIT = 1500;
const MAX_TOOL_CALLS = 3;
const ROUTER_MAX_TOKENS = 256;
const REPLY_MAX_TOKENS = 768;
const TITLE_MAX_CHARS = 60;

// Tools the 4B model may invoke. Kept to a small, low-risk set — creation and
// read-only listing; nothing destructive.
const TOOL_WHITELIST = [
  "create_schedule",
  "list_schedules",
  "list_workspaces",
  "kanban_create_card",
  "kanban_list_columns",
  "kanban_list_cards",
] as const;

const CHAT_SYSTEM_PROMPT = [
  "You are Paseo's built-in assistant, a small on-device model.",
  "Be concise and helpful. Always answer in the language the user writes in.",
  "If a tool result is provided, base your answer on it and summarize the outcome plainly.",
  "If a tool failed, say so directly; never pretend an action succeeded.",
].join(" ");

export interface LlmChatEventPayload {
  chatId: string;
  sendRequestId: string;
  event: LlmChatEvent;
}

interface LlmChatServiceOptions {
  paseoHome: string;
  logger: pino.Logger;
  llamaService: LlamaService;
  // Resolved lazily so bootstrap can wire the catalog factory after the
  // websocket server is constructed. Null → chat runs without tools.
  getToolCatalog?: () => Promise<PaseoToolCatalog | null>;
  onEvent: (payload: LlmChatEventPayload) => void;
}

export interface LlmChatSendInput {
  chatId: string | null;
  text: string;
  requestId: string;
}

export interface LlmChatSendResult {
  chatId: string;
  message: LlmChatMessage | null;
  error: string | null;
}

interface ActiveSend {
  sendRequestId: string;
  // requestId of the llama generate call currently in flight (router or
  // reply phase) so cancel() can abort whichever one is running.
  currentGenerateId: string | null;
  cancelled: boolean;
}

interface RouterDecision {
  action: "none" | "tool";
  name?: string;
  input?: Record<string, unknown>;
}

const ROUTER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { enum: ["none", "tool"] },
    name: { enum: [...TOOL_WHITELIST] },
    input: { type: "object", additionalProperties: true },
  },
  required: ["action"],
};

function formatToolError(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
    const lines = error.issues
      .map((issue) => {
        if (typeof issue !== "object" || issue === null) {
          return null;
        }
        const { path: issuePath, message } = issue as { path?: unknown[]; message?: string };
        const field =
          Array.isArray(issuePath) && issuePath.length > 0 ? issuePath.join(".") : "(input)";
        return `${field}: ${message ?? "invalid"}`;
      })
      .filter((line): line is string => line !== null);
    if (lines.length > 0) {
      return `Invalid tool input — ${lines.join("; ")}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

function deriveTitle(text: string): string {
  const firstLine = text.trim().split("\n", 1)[0] ?? "";
  return firstLine.slice(0, TITLE_MAX_CHARS) || "New chat";
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export class LlmChatService {
  private readonly dir: string;
  private readonly logger: pino.Logger;
  private readonly llamaService: LlamaService;
  private readonly getToolCatalog?: () => Promise<PaseoToolCatalog | null>;
  private readonly onEvent: (payload: LlmChatEventPayload) => void;
  private readonly activeSends = new Map<string, ActiveSend>();

  constructor(options: LlmChatServiceOptions) {
    this.dir = path.join(options.paseoHome, "llm-chat");
    this.logger = options.logger.child({ module: "llm-chat-service" });
    this.llamaService = options.llamaService;
    this.getToolCatalog = options.getToolCatalog;
    this.onEvent = options.onEvent;
  }

  async listChats(): Promise<LlmChatSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const summaries: LlmChatSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const chat = await this.readChatFile(path.join(this.dir, entry));
      if (chat) {
        summaries.push({
          id: chat.id,
          title: chat.title,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          messageCount: chat.messages.length,
        });
      }
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  async getChat(chatId: string): Promise<StoredLlmChat | null> {
    return this.readChatFile(this.chatPath(chatId));
  }

  async deleteChat(chatId: string): Promise<boolean> {
    if (this.activeSends.has(chatId)) {
      this.cancel(chatId);
    }
    try {
      await fs.unlink(this.chatPath(chatId));
      return true;
    } catch {
      return false;
    }
  }

  cancel(chatId: string): boolean {
    const active = this.activeSends.get(chatId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    if (active.currentGenerateId) {
      this.llamaService.cancel(active.currentGenerateId);
    }
    return true;
  }

  async send(input: LlmChatSendInput): Promise<LlmChatSendResult> {
    const text = input.text.trim();
    if (!text) {
      return { chatId: input.chatId ?? "", message: null, error: "empty message" };
    }
    let chat: StoredLlmChat;
    if (input.chatId) {
      const existing = await this.getChat(input.chatId);
      if (!existing) {
        return { chatId: input.chatId, message: null, error: "chat not found" };
      }
      chat = existing;
    } else {
      const timestamp = nowIso();
      chat = {
        id: randomUUID(),
        title: deriveTitle(text),
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
      };
    }
    if (this.activeSends.has(chat.id)) {
      return { chatId: chat.id, message: null, error: "a reply is already in progress" };
    }

    const active: ActiveSend = {
      sendRequestId: input.requestId,
      currentGenerateId: null,
      cancelled: false,
    };
    this.activeSends.set(chat.id, active);
    try {
      return await this.runSend(chat, text, active);
    } finally {
      this.activeSends.delete(chat.id);
    }
  }

  private async runSend(
    chat: StoredLlmChat,
    text: string,
    active: ActiveSend,
  ): Promise<LlmChatSendResult> {
    const emit = (event: LlmChatEvent) => {
      this.onEvent({ chatId: chat.id, sendRequestId: active.sendRequestId, event });
    };

    const userText = truncate(text, MAX_USER_MESSAGE_CHARS);
    const userMessage: LlmChatMessage = {
      id: randomUUID(),
      role: "user",
      text: userText,
      createdAt: nowIso(),
    };
    const history = buildWorkerHistory(chat.messages);
    chat.messages.push(userMessage);
    chat.updatedAt = userMessage.createdAt;
    await this.writeChat(chat);

    try {
      const toolCalls: LlmChatToolCall[] = [];
      const toolNotes: string[] = [];
      const catalog = this.getToolCatalog ? await this.getToolCatalog() : null;
      if (catalog) {
        await this.runToolLoop({ active, catalog, userText, history, toolCalls, toolNotes, emit });
      }
      if (active.cancelled) {
        throw new Error("cancelled");
      }

      const replyPrompt =
        toolNotes.length > 0 ? `${userText}\n\n${toolNotes.join("\n")}` : userText;
      const replyId = `${active.sendRequestId}:reply`;
      active.currentGenerateId = replyId;
      const replyText = await this.llamaService.generate({
        requestId: replyId,
        prompt: replyPrompt,
        systemPrompt: CHAT_SYSTEM_PROMPT,
        history,
        maxTokens: REPLY_MAX_TOKENS,
        stream: true,
        onChunk: (chunk) => emit({ kind: "chunk", text: chunk }),
      });
      active.currentGenerateId = null;

      const assistantMessage: LlmChatMessage = {
        id: randomUUID(),
        role: "assistant",
        text: replyText,
        createdAt: nowIso(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
      chat.messages.push(assistantMessage);
      chat.updatedAt = assistantMessage.createdAt;
      await this.writeChat(chat);
      emit({ kind: "done" });
      return { chatId: chat.id, message: assistantMessage, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ kind: "error", message });
      return { chatId: chat.id, message: null, error: message };
    }
  }

  private async runToolLoop(args: {
    active: ActiveSend;
    catalog: PaseoToolCatalog;
    userText: string;
    history: LlmWorkerHistoryItem[];
    toolCalls: LlmChatToolCall[];
    toolNotes: string[];
    emit: (event: LlmChatEvent) => void;
  }): Promise<void> {
    const { active, catalog, userText, history, toolCalls, toolNotes, emit } = args;
    const available = TOOL_WHITELIST.filter((name) => catalog.getTool(name));
    if (available.length === 0) {
      return;
    }
    for (let round = 0; round < MAX_TOOL_CALLS; round++) {
      if (active.cancelled) {
        return;
      }
      const routerPrompt =
        toolNotes.length > 0 ? `${userText}\n\n${toolNotes.join("\n")}` : userText;
      const routerId = `${active.sendRequestId}:router${round}`;
      active.currentGenerateId = routerId;
      let decision: RouterDecision;
      try {
        const raw = await this.llamaService.generate({
          requestId: routerId,
          prompt: routerPrompt,
          systemPrompt: buildRouterSystemPrompt(available, catalog),
          history,
          jsonSchema: ROUTER_JSON_SCHEMA,
          maxTokens: ROUTER_MAX_TOKENS,
        });
        decision = JSON.parse(raw) as RouterDecision;
      } catch (error) {
        if (active.cancelled) {
          return;
        }
        // Router failures degrade to a plain chat reply; never block the turn.
        this.logger.warn({ err: error }, "llm chat tool router failed");
        return;
      } finally {
        active.currentGenerateId = null;
      }
      if (decision.action !== "tool" || !decision.name) {
        return;
      }
      const name = decision.name;
      if (!TOOL_WHITELIST.includes(name as (typeof TOOL_WHITELIST)[number])) {
        toolNotes.push(`[Tool "${name}" is not available. Tell the user you could not do this.]`);
        return;
      }
      const toolInput = decision.input ?? {};
      emit({ kind: "tool_call", name, input: toolInput });
      let ok = false;
      let summary: string;
      try {
        const result = await catalog.executeTool(name, toolInput);
        ok = !result.isError;
        const textParts = result.content
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .filter((part) => part.length > 0);
        summary = truncate(
          textParts.join("\n") ||
            (result.structuredContent !== undefined
              ? JSON.stringify(result.structuredContent)
              : "(no output)"),
          TOOL_RESULT_CHAR_LIMIT,
        );
      } catch (error) {
        // Zod validation failures read as a long JSON issue dump; compress to
        // "field: message" lines so the model can correct its input next round.
        summary = truncate(formatToolError(error), 400);
      }
      emit({ kind: "tool_result", name, ok, summary });
      toolCalls.push({ name, input: toolInput, ok, summary });
      toolNotes.push(
        `[Tool ${name} ${ok ? "succeeded" : "failed"}. Result: ${summary}]` +
          " [Answer the user based on this result.]",
      );
    }
  }

  private chatPath(chatId: string): string {
    // chatIds are daemon-minted UUIDs, but never trust an id from the wire as
    // a path segment.
    if (!/^[0-9a-f-]{36}$/i.test(chatId)) {
      return path.join(this.dir, "invalid.json.missing");
    }
    return path.join(this.dir, `${chatId}.json`);
  }

  private async readChatFile(filePath: string): Promise<StoredLlmChat | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return StoredLlmChatSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async writeChat(chat: StoredLlmChat): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.chatPath(chat.id);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(chat, null, 2), "utf8");
    await fs.rename(tmp, target);
  }
}

// Newest-first budget: keep the most recent turns whole and drop older ones
// once the character budget runs out.
export function buildWorkerHistory(messages: LlmChatMessage[]): LlmWorkerHistoryItem[] {
  const items: LlmWorkerHistoryItem[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (used + message.text.length > HISTORY_CHAR_BUDGET) {
      break;
    }
    used += message.text.length;
    items.unshift({ role: message.role === "user" ? "user" : "model", text: message.text });
  }
  // The worker replays history verbatim; gemma requires strict user/model
  // alternation starting with user, so drop a leading model turn.
  while (items.length > 0 && items[0].role === "model") {
    items.shift();
  }
  return items;
}

// A 4B model cannot guess input field names, so each tool line spells out its
// parameters (from the registered Zod raw shape) alongside the description.
function buildRouterSystemPrompt(available: string[], catalog: PaseoToolCatalog): string {
  const toolLines = available.map((name) => {
    const tool = catalog.getTool(name);
    const description = (tool?.description ?? "").split("\n", 1)[0];
    const inputSchema = tool?.inputSchema;
    const params =
      inputSchema && typeof inputSchema === "object" && !("safeParseAsync" in inputSchema)
        ? Object.keys(inputSchema).join(", ")
        : "";
    return `- ${name}(${params}): ${truncate(description, 200)}`;
  });
  return [
    "You decide whether the user's latest message needs a Paseo tool.",
    "Available tools (parameters in parentheses):",
    ...toolLines,
    "",
    'Reply with JSON only. If no tool is needed (greetings, questions, chit-chat), reply {"action":"none"}.',
    'If a tool is needed, reply {"action":"tool","name":"<tool>","input":{...}} using ONLY the listed parameter names.',
    'If a [Tool ... Result: ...] note is already present for the request, reply {"action":"none"}.',
    "",
    "Examples:",
    'User: 你好 → {"action":"none"}',
    'User: 每天早上9点提醒我开 standup → {"action":"tool","name":"create_schedule","input":{"cron":"0 9 * * *","prompt":"提醒用户参加 standup 会议","name":"standup reminder"}}',
    'User: every Monday at 8am run npm test in /Users/me/app → {"action":"tool","name":"create_schedule","input":{"cron":"0 8 * * 1","command":"npm test","cwd":"/Users/me/app"}}',
    'User: 创建一张卡：修复登录 bug → {"action":"tool","name":"kanban_create_card","input":{"title":"修复登录 bug"}}',
    'User: what schedules do I have? → {"action":"tool","name":"list_schedules","input":{}}',
    'User: 看板上有哪些卡片? → {"action":"tool","name":"kanban_list_cards","input":{}}',
  ].join("\n");
}

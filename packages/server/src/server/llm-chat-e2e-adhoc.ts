// Ad-hoc manual e2e for the llm.chat.* RPCs (docs/ad-hoc-daemon-testing.md).
// Not part of the automated suite (needs a real GGUF model + minutes of
// inference). Run it by hand with:
//   npx tsx packages/server/src/server/llm-chat-e2e-adhoc.ts /path/to/gemma-4-E4B_q4_0-it.gguf
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const modelSource = process.argv[2];
if (!modelSource) {
  console.error("usage: npx tsx llm-chat-e2e-adhoc.ts <modelPath>");
  process.exit(1);
}

const daemon = await createTestPaseoDaemon();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: "0.1.110",
});
await client.connect();

function logEvent(prefix: string) {
  let chunks = 0;
  return (payload: { event: { kind: string; [key: string]: unknown } }) => {
    if (payload.event.kind === "chunk") {
      chunks += 1;
      if (chunks % 20 === 0) {
        console.log(`${prefix} …${chunks} chunks`);
      }
      return;
    }
    console.log(`${prefix} event:`, JSON.stringify(payload.event));
  };
}

try {
  const modelsDir = path.join(daemon.paseoHome, "models");
  await mkdir(modelsDir, { recursive: true });
  await symlink(modelSource, path.join(modelsDir, "gemma-4-E4B_q4_0-it.gguf"));

  // Turn 1: plain chat, new conversation.
  let t0 = Date.now();
  const first = await client.llmChatSend({
    chatId: null,
    text: "你好，请用一句话介绍你自己",
    onEvent: logEvent("[turn1]"),
  });
  if (first.error || !first.message) {
    throw new Error(`turn1 failed: ${first.error}`);
  }
  console.log(`[turn1] (${((Date.now() - t0) / 1000).toFixed(1)}s) ->`, first.message.text);

  // Turn 2: multi-turn continuity on the same chat.
  t0 = Date.now();
  const second = await client.llmChatSend({
    chatId: first.chatId,
    text: "把上一句翻译成英文",
    onEvent: logEvent("[turn2]"),
  });
  if (second.error || !second.message) {
    throw new Error(`turn2 failed: ${second.error}`);
  }
  console.log(`[turn2] (${((Date.now() - t0) / 1000).toFixed(1)}s) ->`, second.message.text);

  // Turn 3: tool call — create a schedule via natural language. The daemon
  // now proposes mutating tools first; approve the proposal like the UI would.
  t0 = Date.now();
  const turn3Log = logEvent("[turn3]");
  const third = await client.llmChatSend({
    chatId: first.chatId,
    text: `帮我创建一个计划任务：每天早上9点在 ${daemon.paseoHome} 目录运行命令 echo standup`,
    onEvent: (payload) => {
      turn3Log(payload);
      if (payload.event.kind === "tool_proposal") {
        console.log("[turn3] approving proposal", payload.event.proposalId);
        void client.llmChatToolRespond({
          chatId: payload.chatId,
          proposalId: payload.event.proposalId,
          approve: true,
        });
      }
    },
  });
  console.log(
    `[turn3] (${((Date.now() - t0) / 1000).toFixed(1)}s) ->`,
    third.message?.text ?? third.error,
  );
  console.log("[turn3] toolCalls:", JSON.stringify(third.message?.toolCalls ?? null));

  const schedules = await client.scheduleList();
  console.log("schedules after turn3:", JSON.stringify(schedules.schedules));

  // Persistence: list + get.
  const list = await client.llmChatList();
  console.log(
    "chat list:",
    list.chats.map((chat) => `${chat.title} (${chat.messageCount})`),
  );
  const got = await client.llmChatGet(first.chatId);
  if (!got.chat || got.chat.messages.length < 6) {
    throw new Error(`expected >=6 stored messages, got ${got.chat?.messages.length}`);
  }

  const deleted = await client.llmChatDelete(first.chatId);
  if (!deleted.deleted) {
    throw new Error("delete failed");
  }
  console.log("E2E OK");
} finally {
  await client.close();
  await daemon.close();
}

#!/usr/bin/env node
import { resolveBaseUrl, rpc, unwrap } from "../api/transport.js";

const base = await resolveBaseUrl(process.env.DSH_WEB_URL);
console.log("baseUrl=", base);

const list = unwrap(await rpc(base, "workspace.list", {}), "workspace.list");
console.log("workspaces=", list.items?.length ?? 0);

const first = list.items?.[0];
if (!first) {
  console.log("No workspace to create a session under; smoke list-only OK");
  process.exit(0);
}

const created = unwrap(
  await rpc(base, "session.create", { workspaceId: first.workspaceId }),
  "session.create",
);
console.log("created session=", created.sessionId);

const prompted = unwrap(
  await rpc(base, "session.prompt", {
    sessionId: created.sessionId,
    mode: "queue",
    content: [{ type: "text", text: "smoke from dsh-ws-mcp" }],
  }),
  "session.prompt",
);
console.log("prompt accepted=", prompted.accepted);
console.log("SMOKE OK");

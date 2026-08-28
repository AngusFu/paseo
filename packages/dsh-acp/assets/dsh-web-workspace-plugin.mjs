export const name = "dsh-acp-workspace-host";
export const inject = ["webServer", "workspaceRegistry"];

export function apply(ctx) {
  const ensure = ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-acp.workspace.ensure",
    handler: route(async (payload) =>
      workspaceView(await ensureWorkspace(ctx, requireString(payload.cwd, "cwd"))),
    ),
  });
  const attach = ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-acp.workspace.attach-session",
    handler: route(async (payload) => {
      const workspace = await ensureWorkspace(ctx, requireString(payload.cwd, "cwd"));
      await workspace.attachSession(requireString(payload.sessionId, "sessionId"));
      return workspaceView(workspace);
    }),
  });
  return () => {
    attach();
    ensure();
  };
}

async function ensureWorkspace(ctx, cwd) {
  return (await ctx.workspaceRegistry.resolveByPath(cwd)) ?? ctx.workspaceRegistry.create(cwd);
}

function workspaceView(workspace) {
  return {
    workspaceId: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
  };
}

function route(handler) {
  return async (request, response) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    let rpcId = null;
    try {
      const envelope = await readEnvelope(request);
      rpcId = envelope.rpcId ?? null;
      if (envelope.type !== "client-request") throw new Error("expected type: client-request");
      const value = await handler(asRecord(envelope.payload) ?? {});
      sendJson(response, 200, { type: "server-response", rpcId, result: { ok: true, value } });
    } catch (error) {
      sendJson(response, 200, {
        type: "server-response",
        rpcId,
        result: {
          ok: false,
          error: {
            code: "workspace-attach-failed",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  };
}

function readEnvelope(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

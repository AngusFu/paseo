import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_BASE = "http://127.0.0.1:3080";

/**
 * Resolve the live DSH Web base URL.
 * Order: explicit arg → DSH_WEB_URL / DSH_WS_URL → DEFAULT → probe 127.0.0.1 listeners.
 */
export async function resolveBaseUrl(explicit) {
  const candidates = [];
  if (explicit) candidates.push(normalizeBase(explicit));
  for (const key of ["DSH_WEB_URL", "DSH_WS_URL"]) {
    const v = process.env[key]?.trim();
    if (v) candidates.push(normalizeBase(v));
  }
  candidates.push(DEFAULT_BASE);

  const seen = new Set();
  for (const base of candidates) {
    if (!base || seen.has(base)) continue;
    seen.add(base);
    if (await probe(base)) return base;
  }

  for (const base of listLoopbackHttpBases()) {
    if (seen.has(base)) continue;
    seen.add(base);
    if (await probe(base)) return base;
  }

  throw new Error(
    "No live DSH Web API found. Start one with `dsh web --port 3080`, or set DSH_WEB_URL.",
  );
}

function normalizeBase(url) {
  return String(url).replace(/\/$/, "");
}

async function probe(base) {
  try {
    const res = await rpc(base, "workspace.list", {});
    return res?.type === "server-response" && typeof res?.result === "object";
  } catch {
    return false;
  }
}

function listLoopbackHttpBases() {
  try {
    const out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const ports = new Set();
    for (const m of out.matchAll(/127\.0\.0\.1:(\d+)/g)) {
      ports.add(Number(m[1]));
    }
    return [...ports].sort((a, b) => a - b).map((p) => `http://127.0.0.1:${p}`);
  } catch {
    return [];
  }
}

export async function rpc(base, method, payload) {
  const body = {
    type: "client-request",
    rpcId: randomUUID(),
    method,
    payload,
  };
  const res = await fetch(`${normalizeBase(base)}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`transport failure for ${method}: HTTP ${res.status}`);
  }
  return res.json();
}

export function unwrap(result, label) {
  if (!result || result.type !== "server-response") {
    throw new Error(`${label}: unexpected response shape`);
  }
  if (!result.result?.ok) {
    const err = result.result?.error;
    const msg = err?.message || JSON.stringify(err || result.result);
    const code = err?.code ? ` [${err.code}]` : "";
    throw new Error(`${label} failed${code}: ${msg}`);
  }
  return result.result.value;
}

export function textResult(obj) {
  return {
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
  };
}

export function errorResult(err) {
  return {
    isError: true,
    content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  };
}

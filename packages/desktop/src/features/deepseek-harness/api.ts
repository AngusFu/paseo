import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface DshRpcEnvelope {
  type: string;
  result?: {
    ok?: boolean;
    value?: unknown;
    error?: { message?: string; code?: string };
  };
}

export function normalizeBaseUrl(url: string): string {
  return String(url).replace(/\/$/, "");
}

export async function dshRpc(
  baseUrl: string,
  method: string,
  payload: Record<string, unknown> = {},
  options?: { timeoutMs?: number },
): Promise<DshRpcEnvelope> {
  const body = {
    type: "client-request",
    rpcId: randomUUID(),
    method,
    payload,
  };
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`DeepSeek Harness transport failure for ${method}: HTTP ${res.status}`);
  }
  return (await res.json()) as DshRpcEnvelope;
}

export function unwrapDshResult(envelope: DshRpcEnvelope, label: string): unknown {
  if (!envelope || envelope.type !== "server-response") {
    throw new Error(`${label}: unexpected response shape`);
  }
  if (!envelope.result?.ok) {
    const err = envelope.result?.error;
    const msg = err?.message || JSON.stringify(err || envelope.result);
    const code = err?.code ? ` [${err.code}]` : "";
    throw new Error(`${label} failed${code}: ${msg}`);
  }
  return envelope.result.value;
}

/** Readiness probe used by Desktop start/status. */
export async function probeDshApi(baseUrl: string): Promise<boolean> {
  try {
    const envelope = await dshRpc(baseUrl, "workspace.list", {}, { timeoutMs: 2_000 });
    return envelope?.type === "server-response" && typeof envelope.result === "object";
  } catch {
    return false;
  }
}

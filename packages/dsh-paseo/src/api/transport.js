import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_BASE = "http://127.0.0.1:3080";
const DEFAULT_TIMEOUT_MS = 30_000;
/** Discovery probes must be short — Paseo Desktop leaves many loopback listeners. */
const PROBE_TIMEOUT_MS = 800;

/**
 * Resolve the live DSH Web base URL.
 * Order: explicit → DSH_WEB_URL / DSH_WS_URL → Paseo Desktop persisted port →
 * DEFAULT → parallel loopback probe.
 */
export async function resolveBaseUrl(explicit) {
  const candidates = [];
  if (explicit) candidates.push(normalizeBase(explicit));
  for (const key of ["DSH_WEB_URL", "DSH_WS_URL"]) {
    const v = process.env[key]?.trim();
    if (v) candidates.push(normalizeBase(v));
  }
  for (const base of listPaseoDesktopHarnessBases()) {
    candidates.push(base);
  }
  candidates.push(DEFAULT_BASE);

  const seen = new Set();
  const unique = [];
  for (const base of candidates) {
    if (!base || seen.has(base)) continue;
    seen.add(base);
    unique.push(base);
  }

  for (const base of unique) {
    if (await probe(base)) return base;
  }

  const loopback = listLoopbackHttpBases().filter((base) => !seen.has(base));
  const found = await probeFirstLive(loopback);
  if (found) return found;

  throw new Error(
    "No live DSH Web API found. Start DeepSeek Harness from Paseo Desktop, or set DSH_WEB_URL (e.g. http://127.0.0.1:64167). Tip: `dsh-paseo ls --host http://127.0.0.1:<port>`.",
  );
}

function normalizeBase(url) {
  return String(url).replace(/\/$/, "");
}

/**
 * Prefer the port Desktop already allocated and wrote to
 * `~/Library/Application Support/Paseo/desktop-settings.json`
 * (Linux: `~/.config/Paseo/…`).
 */
function listPaseoDesktopHarnessBases() {
  const homes = [];
  const home = homedir();
  if (process.platform === "darwin") {
    homes.push(path.join(home, "Library", "Application Support", "Paseo"));
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) homes.push(path.join(appData, "Paseo"));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    homes.push(xdg ? path.join(xdg, "Paseo") : path.join(home, ".config", "Paseo"));
  }
  // Dev / custom Electron userData overrides
  const override = process.env.PASEO_DESKTOP_USER_DATA?.trim();
  if (override) homes.unshift(override);

  const bases = [];
  for (const dir of homes) {
    try {
      const raw = readFileSync(path.join(dir, "desktop-settings.json"), "utf8");
      const json = JSON.parse(raw);
      const port = json?.deepseekHarness?.port;
      if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
        bases.push(`http://127.0.0.1:${port}`);
      }
    } catch {
      // missing / unreadable — ignore
    }
  }
  return bases;
}

async function probe(base) {
  try {
    const res = await rpc(base, "workspace.list", {}, { timeoutMs: PROBE_TIMEOUT_MS });
    return res?.type === "server-response" && typeof res?.result === "object";
  } catch {
    return false;
  }
}

async function probeFirstLive(bases) {
  if (bases.length === 0) return null;
  return await new Promise((resolve) => {
    let pending = bases.length;
    let settled = false;
    for (const base of bases) {
      void (async () => {
        const ok = await probe(base);
        if (settled) return;
        if (ok) {
          settled = true;
          resolve(base);
          return;
        }
        pending -= 1;
        if (pending === 0) resolve(null);
      })();
    }
  });
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

export async function rpc(base, method, payload, options) {
  const body = {
    type: "client-request",
    rpcId: randomUUID(),
    method,
    payload: payload ?? {},
  };
  const res = await fetch(`${normalizeBase(base)}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
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

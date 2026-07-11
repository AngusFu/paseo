import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Read Chrome's Cookies SQLite database without a native SQLite dependency.
 *
 * Chrome keeps the live DB locked, so we copy it to a temp file first, then
 * query it with the system `/usr/bin/sqlite3` CLI. Rows are emitted with a
 * `\x1f` (unit separator) field delimiter — safe because cookie fields never
 * contain that control byte — and the encrypted value is hex-encoded so the
 * binary blob survives the text pipe.
 */

const FIELD_SEP = "\x1f";

const QUERY =
  "SELECT host_key, name, path, is_secure, is_httponly, expires_utc, samesite, hex(encrypted_value) FROM cookies";

export interface RawCookieRow {
  hostKey: string;
  name: string;
  path: string;
  isSecure: boolean;
  isHttpOnly: boolean;
  /** Chrome epoch: microseconds since 1601-01-01. `0` means session cookie. */
  expiresUtc: number;
  /** Chrome samesite int: -1 unspecified, 0 none, 1 lax, 2 strict. */
  sameSite: number;
  encryptedValue: Buffer;
}

function parseRow(line: string): RawCookieRow | null {
  const fields = line.split(FIELD_SEP);
  if (fields.length < 8) {
    return null;
  }
  const [hostKey, name, cookiePath, isSecure, isHttpOnly, expiresUtc, sameSite, encryptedHex] =
    fields;
  return {
    hostKey,
    name,
    path: cookiePath,
    isSecure: isSecure === "1",
    isHttpOnly: isHttpOnly === "1",
    expiresUtc: Number(expiresUtc) || 0,
    sameSite: Number(sameSite),
    encryptedValue: Buffer.from(encryptedHex, "hex"),
  };
}

/**
 * Reads every cookie row from the given profile's Cookies database.
 * The live DB is copied to a temp file (deleted in `finally`) before querying.
 */
export function readCookieRows(cookiesPath: string): RawCookieRow[] {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "paseo-cookies-"));
  const tmpCopy = path.join(tmpDir, "Cookies");
  try {
    copyFileSync(cookiesPath, tmpCopy);
    const stdout = execFileSync("/usr/bin/sqlite3", [tmpCopy, "-separator", FIELD_SEP, QUERY], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const rows: RawCookieRow[] = [];
    for (const line of stdout.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const row = parseRow(line);
      if (row) {
        rows.push(row);
      }
    }
    return rows;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

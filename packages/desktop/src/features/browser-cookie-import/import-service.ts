import { session } from "electron";
import { PASEO_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import { decryptCookieValue, deriveKey } from "./chromium-cookie-decrypt.js";
import { readCookieRows, type RawCookieRow } from "./cookies-db.js";
import { getChromeSafeStoragePassword, KeychainError } from "./keychain.js";
import { listChromeProfiles } from "./profiles.js";

/**
 * Orchestrates a Chrome → Paseo-browser cookie import on macOS:
 * Keychain password → derive AES key → read Cookies DB → decrypt each →
 * inject into the shared persistent browser profile session.
 */

export type ImportFailureReason =
  | "keychain-denied"
  | "chrome-not-found"
  | "no-profiles"
  | "profile-not-found"
  | "not-macos"
  | "unexpected-error";

export interface ImportCookiesInput {
  browserId: string;
  profileId: string;
}

export type ImportCookiesResult =
  | { ok: true; imported: number; skipped: number; warnings: string[] }
  | { ok: false; reason: ImportFailureReason };

// Chrome timestamps are microseconds since 1601-01-01; unix epoch is 1970-01-01.
const CHROME_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000;

function chromeSameSiteToElectron(
  value: number,
): "unspecified" | "no_restriction" | "lax" | "strict" {
  switch (value) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

function chromeExpiryToUnixSeconds(expiresUtc: number): number | undefined {
  if (expiresUtc <= 0) {
    return undefined; // session cookie
  }
  return (expiresUtc - CHROME_EPOCH_OFFSET_MICROS) / 1_000_000;
}

function buildCookieUrl(row: RawCookieRow): string {
  const scheme = row.isSecure ? "https" : "http";
  const host = row.hostKey.replace(/^\./, "");
  const cookiePath = row.path || "/";
  return `${scheme}://${host}${cookiePath}`;
}

export async function importCookiesFromChrome(
  input: ImportCookiesInput,
): Promise<ImportCookiesResult> {
  const profiles = listChromeProfiles();
  if (profiles.length === 0) {
    return { ok: false, reason: "no-profiles" };
  }
  const profile = profiles.find((p) => p.id === input.profileId);
  if (!profile) {
    return { ok: false, reason: "profile-not-found" };
  }

  let key: Buffer;
  try {
    key = deriveKey(getChromeSafeStoragePassword());
  } catch (error) {
    if (error instanceof KeychainError) {
      return { ok: false, reason: error.reason === "not-macos" ? "not-macos" : "keychain-denied" };
    }
    return { ok: false, reason: "unexpected-error" };
  }

  let rows: RawCookieRow[];
  try {
    rows = readCookieRows(profile.cookiesPath);
  } catch {
    return { ok: false, reason: "unexpected-error" };
  }

  // browserId is retained for call-site compatibility; cookies share one profile.
  void input.browserId;
  const cookieStore = session.fromPartition(PASEO_BROWSER_PROFILE_PARTITION).cookies;

  let imported = 0;
  let skipped = 0;
  let unsupportedCount = 0;

  for (const row of rows) {
    const decrypted = decryptCookieValue(row.encryptedValue, row.hostKey, key);
    if (!decrypted.ok) {
      skipped += 1;
      if (decrypted.reason === "unsupported-format") {
        unsupportedCount += 1;
      }
      continue;
    }
    try {
      await cookieStore.set({
        url: buildCookieUrl(row),
        name: row.name,
        value: decrypted.value,
        domain: row.hostKey,
        path: row.path || "/",
        secure: row.isSecure,
        httpOnly: row.isHttpOnly,
        expirationDate: chromeExpiryToUnixSeconds(row.expiresUtc),
        sameSite: chromeSameSiteToElectron(row.sameSite),
      });
      imported += 1;
    } catch {
      // Per-cookie injection failure (e.g. domain/url mismatch) is non-fatal.
      skipped += 1;
    }
  }

  const warnings: string[] = [];
  if (unsupportedCount > 0) {
    warnings.push("unsupported-encryption");
  }

  return { ok: true, imported, skipped, warnings };
}

export { listChromeProfiles };

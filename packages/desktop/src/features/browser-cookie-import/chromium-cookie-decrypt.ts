import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";

/**
 * Pure Chromium cookie value decryption (macOS `v10`/`v11` scheme).
 *
 * Algorithm mirrors Chrome's os_crypt on macOS and cmux's ChromiumCookieDecryptor:
 * - key = PBKDF2-HMAC-SHA1(safeStoragePassword, salt="saltysalt", iter=1003, len=16)
 * - value = AES-128-CBC(ciphertext, key, iv=16×0x20), PKCS7 padding
 * - plaintext may carry a leading 32-byte SHA-256(host) prefix (newer Chrome); strip it
 *
 * `v20` (App-Bound Encryption) is intentionally unsupported — detected and reported,
 * matching cmux's own `unsupportedFormat` behavior.
 */

const SALT = "saltysalt";
const PBKDF2_ITERATIONS = 1003;
const KEY_LENGTH = 16; // AES-128
const IV = Buffer.alloc(16, 0x20); // 16 spaces

export type DecryptFailure = "unsupported-format" | "decrypt-error";

export type DecryptResult = { ok: true; value: string } | { ok: false; reason: DecryptFailure };

const SUPPORTED_PREFIXES = ["v10", "v11"] as const;

function detectVersionPrefix(encrypted: Buffer): string | null {
  for (const prefix of SUPPORTED_PREFIXES) {
    if (encrypted.subarray(0, prefix.length).toString("latin1") === prefix) {
      return prefix;
    }
  }
  return null;
}

export function deriveKey(safeStoragePassword: Buffer): Buffer {
  return pbkdf2Sync(safeStoragePassword, SALT, PBKDF2_ITERATIONS, KEY_LENGTH, "sha1");
}

function decodePlaintext(plaintext: Buffer, host: string): string {
  // Newer Chrome prepends SHA-256(host_key) to the plaintext. If present, strip it.
  const hostDigest = createHash("sha256").update(host, "utf8").digest();
  if (
    plaintext.length >= hostDigest.length &&
    plaintext.subarray(0, hostDigest.length).equals(hostDigest)
  ) {
    return plaintext.subarray(hostDigest.length).toString("utf8");
  }
  return plaintext.toString("utf8");
}

/**
 * Decrypt one cookie's `encrypted_value` blob.
 * @param encrypted raw blob from the Cookies SQLite `encrypted_value` column
 * @param host the cookie's host_key, used to strip the SHA-256 domain prefix
 * @param key derived AES key from {@link deriveKey}
 */
export function decryptCookieValue(encrypted: Buffer, host: string, key: Buffer): DecryptResult {
  const prefix = detectVersionPrefix(encrypted);
  if (!prefix) {
    return { ok: false, reason: "unsupported-format" };
  }
  const ciphertext = encrypted.subarray(prefix.length);
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { ok: true, value: decodePlaintext(plaintext, host) };
  } catch {
    return { ok: false, reason: "decrypt-error" };
  }
}

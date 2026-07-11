import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCookieValue, deriveKey } from "./chromium-cookie-decrypt.js";

const IV = Buffer.alloc(16, 0x20);

function encryptV10(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, IV);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), ciphertext]);
}

describe("decryptCookieValue", () => {
  const key = deriveKey(Buffer.from("fake-safe-storage-password"));

  it("round-trips a v10-encrypted value", () => {
    const encrypted = encryptV10(Buffer.from("session-token-123"), key);
    const result = decryptCookieValue(encrypted, "example.com", key);
    expect(result).toEqual({ ok: true, value: "session-token-123" });
  });

  it("strips a leading SHA-256(host) plaintext prefix", () => {
    const host = "example.com";
    const hostDigest = createHash("sha256").update(host, "utf8").digest();
    const plaintext = Buffer.concat([hostDigest, Buffer.from("value-with-prefix")]);
    const encrypted = encryptV10(plaintext, key);
    const result = decryptCookieValue(encrypted, host, key);
    expect(result).toEqual({ ok: true, value: "value-with-prefix" });
  });

  it("reports v20 (App-Bound) blobs as unsupported-format", () => {
    const encrypted = Buffer.concat([Buffer.from("v20", "latin1"), Buffer.alloc(32, 0)]);
    const result = decryptCookieValue(encrypted, "example.com", key);
    expect(result).toEqual({ ok: false, reason: "unsupported-format" });
  });
});

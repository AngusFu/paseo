import { execFileSync } from "node:child_process";

/**
 * Retrieve Chrome's "Safe Storage" password from the macOS login Keychain.
 *
 * Shelling out to `/usr/bin/security` triggers the OS Keychain authorization
 * prompt — this is the user-explicit gate for the import (no silent read).
 */

export type KeychainErrorReason = "keychain-denied" | "not-macos";

export class KeychainError extends Error {
  constructor(readonly reason: KeychainErrorReason) {
    super(reason);
    this.name = "KeychainError";
  }
}

/**
 * Returns the Safe Storage password as a Buffer (utf8 of the trimmed stdout).
 * Throws {@link KeychainError} when the user denies access or the item is absent.
 */
export function getChromeSafeStoragePassword(): Buffer {
  if (process.platform !== "darwin") {
    throw new KeychainError("not-macos");
  }
  try {
    const stdout = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
      { encoding: "utf8" },
    );
    return Buffer.from(stdout.trim(), "utf8");
  } catch {
    // Non-zero exit: user denied the prompt, or no matching keychain item.
    throw new KeychainError("keychain-denied");
  }
}

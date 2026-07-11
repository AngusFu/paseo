import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";

// Credential material for a kanban source, keyed by StoredKanbanSource.auth's
// credentialRef. Lives in its own 0600 file, separate from sources.json (which
// is world-readable-ish JSON and never carries secrets, only the reference).
export interface KanbanTokenSecret {
  method: "token";
  token: string;
}

export interface KanbanOauthSecret {
  method: "oauth";
  clientId: string;
  clientSecret: string;
  accessToken: string | null;
  refreshToken: string | null;
  // ISO timestamp, null when the provider didn't report an expiry.
  expiresAt: string | null;
}

export type KanbanSecret = KanbanTokenSecret | KanbanOauthSecret;

// Single JSON file of { [credentialRef]: KanbanSecret }, written 0600 via the
// same private-file primitive used elsewhere for credential material.
export class KanbanSecretsStore {
  private readonly mutations = new Map<string, Promise<unknown>>();
  private static readonly LOCK = "secrets";

  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, "secrets.json");
  }

  private async readAll(): Promise<Record<string, KanbanSecret>> {
    try {
      const content = await readFile(this.file, "utf-8");
      return JSON.parse(content) as Record<string, KanbanSecret>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private writeAll(secrets: Record<string, KanbanSecret>): void {
    ensurePrivateDirectory(this.dir);
    writePrivateFileAtomicSync(this.file, JSON.stringify(secrets, null, 2));
  }

  async get(credentialRef: string): Promise<KanbanSecret | null> {
    const all = await this.readAll();
    return all[credentialRef] ?? null;
  }

  async set(credentialRef: string, secret: KanbanSecret): Promise<void> {
    await this.serialize(async () => {
      const all = await this.readAll();
      all[credentialRef] = secret;
      this.writeAll(all);
    });
  }

  async delete(credentialRef: string): Promise<void> {
    await this.serialize(async () => {
      const all = await this.readAll();
      delete all[credentialRef];
      this.writeAll(all);
    });
  }

  private async serialize<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(KanbanSecretsStore.LOCK) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.mutations.set(KanbanSecretsStore.LOCK, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(KanbanSecretsStore.LOCK) === next) {
        this.mutations.delete(KanbanSecretsStore.LOCK);
      }
    }
  }
}

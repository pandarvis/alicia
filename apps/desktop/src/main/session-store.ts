import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { StoredSession } from "../shared/session.ts";

/** OS-backed encryption (Electron safeStorage in production, a fake in tests). */
export interface Cipher {
  isAvailable(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super("Chiffrement du système indisponible : impossible d'enregistrer la session.");
    this.name = "EncryptionUnavailableError";
  }
}

export class SessionStore {
  readonly #path: string;
  readonly #cipher: Cipher;

  constructor(path: string, cipher: Cipher) {
    this.#path = path;
    this.#cipher = cipher;
  }

  load(): StoredSession | null {
    if (!existsSync(this.#path)) return null;
    try {
      const parsed = StoredSession.safeParse(JSON.parse(this.#cipher.decrypt(readFileSync(this.#path))));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  save(session: StoredSession): void {
    if (!this.#cipher.isAvailable()) throw new EncryptionUnavailableError();
    const encrypted = this.#cipher.encrypt(JSON.stringify(StoredSession.parse(session)));
    // Write then rename, so a crash never leaves a half-written session.
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, encrypted, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }

  clear(): void {
    rmSync(this.#path, { force: true });
  }
}

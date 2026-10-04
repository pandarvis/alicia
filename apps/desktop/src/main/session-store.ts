import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { StoredSession } from "../shared/session.ts";

/** OS-backed encryption (Electron safeStorage in production, a fake in tests). */
export interface Cipher {
  isAvailable(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
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
    if (!this.#cipher.isAvailable()) {
      throw new Error("Chiffrement du système indisponible : impossible d'enregistrer la session.");
    }
    writeFileSync(this.#path, this.#cipher.encrypt(JSON.stringify(StoredSession.parse(session))));
  }

  clear(): void {
    rmSync(this.#path, { force: true });
  }
}

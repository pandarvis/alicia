import { createCipheriv, createDecipheriv, createSecretKey, type KeyObject, randomBytes } from "node:crypto";

const FORMAT = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = 1 + IV_BYTES + TAG_BYTES;

/** The stored token cannot be read back (other key, tampered blob, or a blob moved to another row). */
export class TokenDecryptError extends Error {
  constructor() {
    super("Stored Google token cannot be decrypted");
    this.name = "TokenDecryptError";
  }
}

/**
 * AES-256-GCM for Google refresh tokens at rest. Layout: format (1 byte) | IV (12) | tag (16) | ciphertext.
 * The context is authenticated data: it binds the ciphertext to its row (id + owner).
 */
export class TokenCipher {
  readonly #key: KeyObject;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error("TokenCipher needs a 32-byte key");
    // Held by OpenSSL, outside the JavaScript heap; the caller may (and should) wipe its own buffer.
    this.#key = createSecretKey(key);
  }

  encrypt(plain: string, context: string): Buffer {
    // An empty token would mean a broken exchange: never stored as if it could be refreshed.
    if (plain === "") throw new Error("TokenCipher refuses an empty token");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.of(FORMAT), iv, cipher.getAuthTag(), body]);
  }

  decrypt(blob: Buffer, context: string): string {
    if (blob.length <= HEADER || blob[0] !== FORMAT) throw new TokenDecryptError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, blob.subarray(1, 1 + IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(blob.subarray(1 + IV_BYTES, HEADER));
      return Buffer.concat([decipher.update(blob.subarray(HEADER)), decipher.final()]).toString("utf8");
    } catch {
      // Node's own error says nothing secret, but none of it is kept: one cause, one message.
      throw new TokenDecryptError();
    }
  }
}

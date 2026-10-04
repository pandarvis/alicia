import { type Embedder, normalize, words } from "./embedder.ts";

const DIMENSIONS = 64;

/** FNV-1a 32-bit. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** Deterministic bag-of-words vectors for tests: texts sharing words are close. Never downloads anything. */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-bag-of-words-64";
  readonly dimensions = DIMENSIONS;

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    return Promise.resolve(
      texts.map((text) => {
        const vector = new Float32Array(DIMENSIONS);
        for (const word of words(text)) {
          const slot = hash(word) % DIMENSIONS;
          vector[slot] = (vector[slot] ?? 0) + 1;
        }
        return normalize(vector);
      }),
    );
  }
}

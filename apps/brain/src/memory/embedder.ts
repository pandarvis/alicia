/** Turns texts into normalized vectors. "query" and "passage" may be encoded differently (e5 prefixes). */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Buffer): Float32Array {
  // Copy: the Buffer's offset may not be 4-byte aligned.
  const bytes = new Uint8Array(blob);
  return new Float32Array(bytes.buffer, 0, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

/** Dot product: equals cosine similarity for normalized vectors. Vectors of different models never compare. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Vector sizes differ (${a.length} vs ${b.length}): different embedding models`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function normalize(vector: Float32Array): Float32Array {
  const norm = Math.sqrt(cosine(vector, vector));
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

/** Lowercase, accent-free words of 2+ letters: shared by the fake embedder and the FTS query builder. */
export function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2);
}

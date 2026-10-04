import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import type { Embedder } from "./embedder.ts";

const MODEL = "Xenova/multilingual-e5-small";
const DIMENSIONS = 384;

/**
 * Local multilingual embeddings (ONNX on CPU): nothing leaves the house, no quota used.
 * The model (~120 MB) is downloaded once into `cacheDir` on first use.
 */
export class TransformersEmbedder implements Embedder {
  readonly model = MODEL;
  readonly dimensions = DIMENSIONS;
  readonly #cacheDir: string;
  #extractor: Promise<FeatureExtractionPipeline> | null = null;

  constructor(cacheDir: string) {
    this.#cacheDir = cacheDir;
  }

  async embed(texts: readonly string[], kind: "query" | "passage"): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.#load();
    // e5 expects these prefixes.
    const output = await extractor(texts.map((text) => `${kind}: ${text}`), { pooling: "mean", normalize: true });
    const data = Float32Array.from(output.data);
    return texts.map((_, i) => data.slice(i * DIMENSIONS, (i + 1) * DIMENSIONS));
  }

  #load(): Promise<FeatureExtractionPipeline> {
    if (this.#extractor === null) {
      env.cacheDir = this.#cacheDir;
      this.#extractor = pipeline("feature-extraction", MODEL, { dtype: "q8" });
    }
    return this.#extractor;
  }
}

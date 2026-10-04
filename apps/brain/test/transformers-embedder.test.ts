import { beforeEach, expect, test, vi } from "vitest";

const pipeline = vi.fn();
vi.mock("@huggingface/transformers", () => ({ env: { cacheDir: null }, pipeline }));

const { TransformersEmbedder } = await import("../src/memory/transformers-embedder.ts");

beforeEach(() => {
  pipeline.mockReset();
});

test("a failed model load is retried on the next call instead of being cached", async () => {
  const extractor = vi.fn(() => Promise.resolve({ data: new Float32Array(384).fill(0.5) }));
  pipeline.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(extractor);
  const embedder = new TransformersEmbedder("cache");

  await expect(embedder.embed(["x"], "query")).rejects.toThrow("network down");
  const [vector] = await embedder.embed(["x"], "query");

  expect(vector).toHaveLength(384);
  expect(pipeline).toHaveBeenCalledTimes(2);
  expect(extractor).toHaveBeenCalledWith(["query: x"], { pooling: "mean", normalize: true });
});

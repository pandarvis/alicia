import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cosine, type Embedder, fromBlob, toBlob } from "../src/memory/embedder.ts";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { TransformersEmbedder } from "../src/memory/transformers-embedder.ts";

describe("vector helpers", () => {
  test("blob round-trip", () => {
    const v = new Float32Array([0.5, -1, 2.25]);
    expect(Array.from(fromBlob(toBlob(v)))).toEqual([0.5, -1, 2.25]);
  });
  test("cosine of normalized vectors", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });
});

describe("FakeEmbedder", () => {
  test("deterministic, normalized, shared words → closer", async () => {
    const embedder: Embedder = new FakeEmbedder();
    const [a, b, c] = await embedder.embed(
      ["Kévin adore les lasagnes", "les lasagnes de Kévin", "réunion de parents d'élèves"], "passage",
    );
    if (a === undefined || b === undefined || c === undefined) throw new Error("missing vectors");
    expect(a).toHaveLength(embedder.dimensions);
    expect(cosine(a, a)).toBeCloseTo(1);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    expect(Array.from((await embedder.embed(["Kévin adore les lasagnes"], "query"))[0] ?? [])).toEqual(Array.from(a));
  });
});

// Downloads ~120 MB the first time: opt-in only (ALICIA_REAL_EMBEDDINGS=1).
describe.skipIf(process.env["ALICIA_REAL_EMBEDDINGS"] !== "1")("TransformersEmbedder (real model)", () => {
  test("a question finds the related memory", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "alicia-models-"));
    try {
      const embedder = new TransformersEmbedder(cacheDir);
      const [lasagna, meeting] = await embedder.embed(
        ["Le plat préféré de Kévin, ce sont les lasagnes.", "Réunion parents-profs jeudi à 18 h."], "passage",
      );
      const [question] = await embedder.embed(["Qu'est-ce que Kévin aime manger ?"], "query");
      if (lasagna === undefined || meeting === undefined || question === undefined) throw new Error("missing vectors");
      expect(lasagna).toHaveLength(384);
      expect(cosine(question, lasagna)).toBeGreaterThan(cosine(question, meeting));
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 300_000);
});

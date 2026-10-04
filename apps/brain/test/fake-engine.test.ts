import { expect, test } from "vitest";
import type { EngineEvent, EngineRequest } from "../src/engine/engine.ts";
import { FakeEngine } from "../src/engine/fake-engine.ts";

const REQUEST: EngineRequest = { prompt: "x", sessionId: undefined, model: "sonnet", systemPrompt: "c" };

async function collect(source: AsyncIterable<EngineEvent>) {
  const output: EngineEvent[] = [];
  for await (const e of source) output.push(e);
  return output;
}

test("replays the scenarios in order, repeats the last one, and records the requests", async () => {
  const engine = new FakeEngine(
    () => [{ type: "text", text: "un" }],
    () => [{ type: "text", text: "deux" }],
  );
  const signal = new AbortController().signal;
  expect(await collect(engine.run(REQUEST, signal))).toEqual([{ type: "text", text: "un" }]);
  expect(await collect(engine.run(REQUEST, signal))).toEqual([{ type: "text", text: "deux" }]);
  expect(await collect(engine.run(REQUEST, signal))).toEqual([{ type: "text", text: "deux" }]);
  expect(engine.requests).toHaveLength(3);
});

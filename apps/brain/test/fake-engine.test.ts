import { expect, test } from "vitest";
import { z } from "zod";
import type { EngineEvent, EngineRequest } from "../src/engine/engine.ts";
import { callTool, FakeEngine } from "../src/engine/fake-engine.ts";
import { defineTool } from "../src/engine/tools.ts";

const REQUEST: EngineRequest = { prompt: "x", sessionId: undefined, model: "sonnet", systemPrompt: "c", tools: [] };

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

test("a throwing scenario makes run throw synchronously", () => {
  const engine = new FakeEngine(() => {
    throw new Error("boom");
  });
  expect(() => engine.run(REQUEST, new AbortController().signal)).toThrow("boom");
});

test("an async scenario can call a tool of the request", async () => {
  const echo = defineTool({
    name: "echo", label: "Alicia répète…", description: "Répète", input: { word: z.string() },
    run: ({ word }) => Promise.resolve({ text: `écho ${word}` }),
  });
  const engine = new FakeEngine(async (request) => {
    const result = await callTool(request, "echo", { word: "bonjour" });
    return [{ type: "text", text: result.text }];
  });
  const events = await collect(engine.run({ ...REQUEST, tools: [echo] }, new AbortController().signal));
  expect(events).toEqual([{ type: "text", text: "écho bonjour" }]);
});

test("callTool rejects an unknown tool and invalid arguments", async () => {
  const echo = defineTool({
    name: "echo", label: "Alicia répète…", description: "Répète", input: { word: z.string() },
    run: ({ word }) => Promise.resolve({ text: word }),
  });
  const request = { ...REQUEST, tools: [echo] };
  await expect(callTool(request, "nope", {})).rejects.toThrow("No tool named nope");
  await expect(callTool(request, "echo", { word: 3 })).rejects.toThrow();
});

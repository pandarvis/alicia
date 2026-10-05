import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test, vi } from "vitest";
import { SdkEngine } from "../src/engine/sdk-engine.ts";
import { testRequest } from "./helpers.ts";

/** The SDK's query, replaced: it records the controller it was given and ends at once (never the real CLI). */
const controllers = vi.hoisted(() => [] as AbortController[]);
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual: object = await importOriginal();
  return {
    ...actual,
    query: ({ options }: { options: Options }) => {
      if (options.abortController !== undefined) controllers.push(options.abortController);
      return (async function* (): AsyncGenerator<SDKMessage> {
        // Nothing: the turn ends without a result.
      })();
    },
  };
});

test("whatever the end of a turn, the SDK process gets its own abort (nothing of the turn keeps running)", async () => {
  const engine = new SdkEngine({
    auth: { mode: "subscription", token: "j" },
    models: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" },
    workspaceDir: "/w",
    skills: [],
  });
  const events: unknown[] = [];
  for await (const event of engine.run(testRequest(), new AbortController().signal)) events.push(event);
  expect(controllers).toHaveLength(1);
  expect(controllers[0]?.signal.aborted).toBe(true);
});

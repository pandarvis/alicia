import { z } from "zod";
import type { Engine, EngineEvent, EngineRequest } from "./engine.ts";
import type { ToolResult } from "./tools.ts";

export type Scenario = (request: EngineRequest) => readonly EngineEvent[] | Promise<readonly EngineEvent[]>;

/** Test helper: lets a scenario call one of the request's tools like the model would. */
export async function callTool(request: EngineRequest, name: string, args: unknown): Promise<ToolResult> {
  const definition = request.tools.find((t) => t.name === name);
  if (definition === undefined) throw new Error(`No tool named ${name}`);
  const parsed = z.object(definition.input).parse(args);
  return definition.run(parsed);
}

/** Test engine: replays scenarios, never consumes any quota. */
export class FakeEngine implements Engine {
  readonly requests: EngineRequest[] = [];
  readonly #scenarios: readonly Scenario[];

  constructor(...scenarios: Scenario[]) {
    if (scenarios.length === 0) throw new Error("FakeEngine: at least one scenario is required");
    this.#scenarios = scenarios;
  }

  run(request: EngineRequest, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    this.requests.push(request);
    const index = Math.min(this.requests.length, this.#scenarios.length) - 1;
    const scenario = this.#scenarios[index];
    if (scenario === undefined) throw new Error("FakeEngine: scenario not found");
    // Called synchronously: a throwing scenario makes `run` itself throw.
    const result = scenario(request);
    return (async function* () {
      const events = await result;
      for (const e of events) {
        if (signal?.aborted === true) return;
        yield await Promise.resolve(e);
      }
    })();
  }
}

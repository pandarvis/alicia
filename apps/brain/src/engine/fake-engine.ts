import type { Engine, EngineEvent, EngineRequest } from "./engine.ts";

export type Scenario = (request: EngineRequest) => readonly EngineEvent[];

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
    const events = scenario(request);
    return (async function* () {
      for (const e of events) {
        if (signal?.aborted === true) return;
        yield await Promise.resolve(e);
      }
    })();
  }
}

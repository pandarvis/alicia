import type { EvenementMoteur, Moteur, RequeteMoteur } from "./engine.ts";

export type Scenario = (requete: RequeteMoteur) => readonly EvenementMoteur[];

/** Moteur de test : rejoue des scénarios, ne consomme jamais de quota. */
export class FauxMoteur implements Moteur {
  readonly requetes: RequeteMoteur[] = [];
  readonly #scenarios: readonly Scenario[];

  constructor(...scenarios: Scenario[]) {
    if (scenarios.length === 0) throw new Error("FauxMoteur : au moins un scénario");
    this.#scenarios = scenarios;
  }

  executer(requete: RequeteMoteur, signal?: AbortSignal): AsyncIterable<EvenementMoteur> {
    this.requetes.push(requete);
    const index = Math.min(this.requetes.length, this.#scenarios.length) - 1;
    const scenario = this.#scenarios[index];
    if (scenario === undefined) throw new Error("FauxMoteur : scénario introuvable");
    const evenements = scenario(requete);
    return (async function* () {
      for (const e of evenements) {
        if (signal?.aborted === true) return;
        yield await Promise.resolve(e);
      }
    })();
  }
}

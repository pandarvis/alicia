import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { ouvrirBase } from "./db/open.ts";
import type { Authentification, Config } from "./config.ts";
import { DepotConversations } from "./conversations/repository.ts";
import { horlogeSysteme } from "./clock.ts";
import { ServiceAppairage } from "./identity/pairing.ts";
import { synchroniserPersonnes } from "./identity/people.ts";
import type { Moteur } from "./engine/engine.ts";
import { MoteurSdk } from "./engine/sdk-engine.ts";
import { creerServeur } from "./server/server.ts";
import { VERSION } from "./version.ts";

/** cwd du processus SDK (skills au plan 3). */
export const DOSSIER_ESPACE = fileURLToPath(new URL("../workspace", import.meta.url));

export interface OptionsApplication {
  /** Journal Fastify (pino, Authorization masqué) : activé par `demarrer`, coupé par défaut. */
  journal?: boolean;
}

export interface Application {
  serveur: FastifyInstance;
  appairage: ServiceAppairage;
  /** Ferme le serveur (et ses WebSockets) puis la base. */
  fermer(): Promise<void>;
}

export function creerMoteurSdk(config: Config, auth: Authentification): Moteur {
  return new MoteurSdk({ auth, modeles: config.modeles, dossierEspace: DOSSIER_ESPACE });
}

export async function construireApplication(
  config: Config,
  moteur: Moteur,
  options: OptionsApplication = {},
): Promise<Application> {
  mkdirSync(config.dossierDonnees, { recursive: true });
  const base = ouvrirBase(join(config.dossierDonnees, "alicia.db"));
  try {
    synchroniserPersonnes(base, config.personnes);

    const depot = new DepotConversations(base, horlogeSysteme);
    const appairage = new ServiceAppairage(base, horlogeSysteme);
    const serveur = await creerServeur({
      appairage,
      depot,
      version: VERSION,
      chat: { depot, moteur, horloge: horlogeSysteme, fuseau: config.fuseau },
      ...(options.journal !== undefined ? { journal: options.journal } : {}),
    });

    return {
      serveur,
      appairage,
      fermer: async () => {
        await serveur.close();
        base.$client.close();
      },
    };
  } catch (erreur) {
    base.$client.close();
    throw erreur;
  }
}

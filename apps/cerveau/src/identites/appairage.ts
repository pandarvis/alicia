import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Personne } from "@alicia/protocole";
import { eq, lt } from "drizzle-orm";
import type { Base } from "../base/ouvrir.ts";
import { appareils, codesAppairage } from "../base/schema.ts";
import type { Horloge } from "../horloge.ts";
import { trouverPersonne } from "./personnes.ts";

const DUREE_CODE_MS = 10 * 60_000;
const FENETRE_ECHECS_MS = 60_000;
const MAX_ECHECS = 5;
const MAX_TIRAGES = 20;

const tirerCodeAleatoire = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0");

export const hacher = (valeur: string): string => createHash("sha256").update(valeur).digest("hex");

export type ResultatAppairage =
  | { jeton: string; personne: Personne }
  | { erreur: "code_invalide" | "trop_de_tentatives" };

export class ServiceAppairage {
  readonly #base: Base;
  readonly #horloge: Horloge;
  readonly #tirerCode: () => string;
  #echecs: number[] = [];

  constructor(base: Base, horloge: Horloge, tirerCode: () => string = tirerCodeAleatoire) {
    this.#base = base;
    this.#horloge = horloge;
    this.#tirerCode = tirerCode;
  }

  /** Code à 6 chiffres, valable 10 minutes, usage unique. */
  genererCode(personneId: string): string {
    if (trouverPersonne(this.#base, personneId) === undefined) {
      throw new Error(`Personne inconnue : ${personneId}`);
    }
    const maintenant = this.#horloge();
    this.#base.delete(codesAppairage).where(lt(codesAppairage.expireLe, maintenant)).run();
    // Un code déjà en attente (pour quiconque) n'est jamais réattribué : on en tire un autre.
    for (let essai = 0; essai < MAX_TIRAGES; essai++) {
      const code = this.#tirerCode();
      const resultat = this.#base
        .insert(codesAppairage)
        .values({ codeHache: hacher(code), personneId, expireLe: maintenant + DUREE_CODE_MS })
        .onConflictDoNothing()
        .run();
      if (resultat.changes === 1) return code;
    }
    throw new Error("Impossible de générer un code d'appairage unique.");
  }

  echanger(code: string, nomAppareil: string): ResultatAppairage {
    const maintenant = this.#horloge();
    this.#echecs = this.#echecs.filter((t) => maintenant - t < FENETRE_ECHECS_MS);
    if (this.#echecs.length >= MAX_ECHECS) return { erreur: "trop_de_tentatives" };

    const ligne = this.#base
      .select()
      .from(codesAppairage)
      .where(eq(codesAppairage.codeHache, hacher(code)))
      .get();
    if (ligne === undefined || ligne.expireLe < maintenant) {
      this.#echecs.push(maintenant);
      return { erreur: "code_invalide" };
    }
    this.#base.delete(codesAppairage).where(eq(codesAppairage.codeHache, ligne.codeHache)).run();

    const personne = trouverPersonne(this.#base, ligne.personneId);
    if (personne === undefined) return { erreur: "code_invalide" };

    const jeton = randomBytes(32).toString("base64url");
    this.#base
      .insert(appareils)
      .values({
        id: randomUUID(),
        personneId: personne.id,
        nom: nomAppareil,
        jetonHache: hacher(jeton),
        creeLe: maintenant,
      })
      .run();
    return { jeton, personne };
  }

  authentifier(jeton: string): Personne | undefined {
    const appareil = this.#base
      .select()
      .from(appareils)
      .where(eq(appareils.jetonHache, hacher(jeton)))
      .get();
    if (appareil === undefined || appareil.revoqueLe !== null) return undefined;
    this.#base
      .update(appareils)
      .set({ vuLe: this.#horloge() })
      .where(eq(appareils.id, appareil.id))
      .run();
    return trouverPersonne(this.#base, appareil.personneId);
  }

  revoquer(jeton: string): void {
    this.#base
      .update(appareils)
      .set({ revoqueLe: this.#horloge() })
      .where(eq(appareils.jetonHache, hacher(jeton)))
      .run();
  }
}

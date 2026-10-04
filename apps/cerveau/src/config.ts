import { readFileSync } from "node:fs";
import { Personne } from "@alicia/protocol";
import { parse } from "yaml";
import { z } from "zod";

const MODELES_PAR_DEFAUT = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };

export const SchemaConfig = z.object({
  port: z.number().int().min(1).max(65_535).default(8780),
  hote: z.string().default("0.0.0.0"),
  dossierDonnees: z.string().default("./donnees"),
  fuseau: z.string().default("Europe/Paris"),
  personnes: z.array(Personne).min(1),
  moteur: z.object({ mode: z.enum(["abonnement", "cle_api"]) }),
  modeles: z
    .object({ sonnet: z.string().min(1), opus: z.string().min(1) })
    .default(MODELES_PAR_DEFAUT),
});
export type Config = z.infer<typeof SchemaConfig>;
export type ModeMoteur = Config["moteur"]["mode"];

export type Authentification =
  | { mode: "abonnement"; jeton: string }
  | { mode: "cle_api"; cle: string };

export function lireConfig(texteYaml: string): Config {
  return SchemaConfig.parse(parse(texteYaml));
}

export function chargerConfig(chemin: string): Config {
  return lireConfig(readFileSync(chemin, "utf8"));
}

/** Les secrets viennent de l'environnement, jamais du fichier de config. */
export function lireAuthentification(
  mode: ModeMoteur,
  env: Readonly<Record<string, string | undefined>>,
): Authentification {
  if (mode === "abonnement") {
    const jeton = env["CLAUDE_CODE_OAUTH_TOKEN"];
    if (jeton === undefined || jeton === "") {
      throw new Error("CLAUDE_CODE_OAUTH_TOKEN manquant (générez-le avec `claude setup-token`).");
    }
    return { mode, jeton };
  }
  const cle = env["ANTHROPIC_API_KEY"];
  if (cle === undefined || cle === "") throw new Error("ANTHROPIC_API_KEY manquant.");
  return { mode, cle };
}

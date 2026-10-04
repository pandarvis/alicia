import type { Modele } from "@alicia/protocole";
import {
  type Options,
  query,
  type SDKMessage,
  type SDKRateLimitInfo,
  USAGE_LIMIT_ERROR_PREFIXES,
} from "@anthropic-ai/claude-agent-sdk";
import type { Authentification } from "../config.ts";
import type { EvenementMoteur, Moteur, RequeteMoteur } from "./moteur.ts";

const LIMITE = /usage limit|rate[ _]?limit|quota|too many requests|\b429\b/i;
const MESSAGE_QUOTA = "Je me repose : le quota de l'abonnement est atteint.";
const STATUT_TROP_DE_REQUETES = 429;

const QUOTA: EvenementMoteur = { type: "erreur", code: "quota", message: MESSAGE_QUOTA };

export function classerErreur(texte: string): { code: "quota" | "moteur"; message: string } {
  const limiteAtteinte = LIMITE.test(texte) || USAGE_LIMIT_ERROR_PREFIXES.some((prefixe) => texte.includes(prefixe));
  return limiteAtteinte
    ? { code: "quota", message: MESSAGE_QUOTA }
    : { code: "moteur", message: `Le moteur a échoué : ${texte}` };
}

/** Limite refusée, et le dépassement payant (overage) ne prend pas le relais. */
function limiteBloquante(info: SDKRateLimitInfo): boolean {
  return info.status === "rejected" && info.overageStatus !== "allowed" && info.overageStatus !== "allowed_warning";
}

/** Environnement du processus SDK : un seul secret, celui du mode choisi. */
export function construireEnv(
  base: Readonly<Record<string, string | undefined>>,
  auth: Authentification,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  delete env["ANTHROPIC_API_KEY"];
  delete env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (auth.mode === "abonnement") env["CLAUDE_CODE_OAUTH_TOKEN"] = auth.jeton;
  else env["ANTHROPIC_API_KEY"] = auth.cle;
  return env;
}

export function* traduireMessage(m: SDKMessage): Generator<EvenementMoteur> {
  switch (m.type) {
    case "system":
      if (m.subtype === "init") yield { type: "session", sessionId: m.session_id };
      return;
    case "stream_event":
      if (m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") {
        yield { type: "texte", texte: m.event.delta.text };
      }
      return;
    case "assistant":
      for (const bloc of m.message.content) {
        if (bloc.type === "tool_use") yield { type: "appel_outil", idAppel: bloc.id, outil: bloc.name };
      }
      return;
    case "user": {
      const contenu = m.message.content;
      if (typeof contenu === "string") return;
      for (const bloc of contenu) {
        if (bloc.type === "tool_result") {
          yield { type: "resultat_outil", idAppel: bloc.tool_use_id, succes: bloc.is_error !== true };
        }
      }
      return;
    }
    case "rate_limit_event":
      if (limiteBloquante(m.rate_limit_info)) yield QUOTA;
      return;
    case "result":
      if (m.subtype === "success" && !m.is_error) {
        yield { type: "fin", tokensEntree: m.usage.input_tokens, tokensSortie: m.usage.output_tokens };
      } else if (m.subtype === "success") {
        // « success » + is_error : le tour s'est terminé sur une erreur d'API, dont le texte est dans `result`.
        yield m.api_error_status === STATUT_TROP_DE_REQUETES ? QUOTA : { type: "erreur", ...classerErreur(m.result) };
      } else {
        yield { type: "erreur", ...classerErreur(m.errors.join(" ")) };
      }
      return;
    default:
      return;
  }
}

export interface ParametresMoteurSdk {
  auth: Authentification;
  modeles: Readonly<Record<Modele, string>>;
  dossierEspace: string;
}

export class MoteurSdk implements Moteur {
  readonly #parametres: ParametresMoteurSdk;

  constructor(parametres: ParametresMoteurSdk) {
    this.#parametres = parametres;
  }

  async *executer(requete: RequeteMoteur, signal: AbortSignal): AsyncGenerator<EvenementMoteur> {
    const controleur = new AbortController();
    if (signal.aborted) controleur.abort();
    else signal.addEventListener("abort", () => { controleur.abort(); }, { once: true });

    const options: Options = {
      model: this.#parametres.modeles[requete.modele],
      systemPrompt: requete.consigneSysteme,
      cwd: this.#parametres.dossierEspace,
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      allowedTools: [],
      includePartialMessages: true,
      canUseTool: () => Promise.resolve({ behavior: "deny", message: "Aucun outil n'est disponible pour l'instant." }),
      env: construireEnv(process.env, this.#parametres.auth),
      abortController: controleur,
      ...(requete.sessionId !== undefined ? { resume: requete.sessionId } : {}),
    };

    let resultatVu = false;
    try {
      for await (const m of query({ prompt: requete.prompt, options })) {
        if (m.type === "result") resultatVu = true;
        yield* traduireMessage(m);
      }
    } catch (cause) {
      if (!resultatVu && !signal.aborted) {
        yield { type: "erreur", ...classerErreur(cause instanceof Error ? cause.message : String(cause)) };
      }
    }
  }
}

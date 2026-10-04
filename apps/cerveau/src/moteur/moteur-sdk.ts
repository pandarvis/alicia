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

const LIMITE = /usage limit|rate[ _]?limit|(?<!disk )quota (?:exceeded|reached)|too many requests|\b429\b/i;
const MESSAGE_QUOTA = "Je me repose : le quota de l'abonnement est atteint.";
const STATUT_TROP_DE_REQUETES = 429;
const SECRET_MASQUE = "[secret]";

const QUOTA: EvenementMoteur = { type: "erreur", code: "quota", message: MESSAGE_QUOTA };

/**
 * Seules variables du parent transmises au processus SDK (plus le secret du mode choisi) :
 * de quoi démarrer (chemins, profil, temporaires, système Windows), la langue et le proxy.
 */
const ENV_AUTORISE: readonly string[] = [
  "PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR",
  "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS",
];

export function classerErreur(texte: string): { code: "quota" | "moteur"; message: string } {
  // USAGE_LIMIT_ERROR_PREFIXES est marqué @alpha dans le SDK : le revérifier à chaque mise à jour du SDK.
  const limiteAtteinte = LIMITE.test(texte) || USAGE_LIMIT_ERROR_PREFIXES.some((prefixe) => texte.includes(prefixe));
  return limiteAtteinte
    ? { code: "quota", message: MESSAGE_QUOTA }
    : { code: "moteur", message: `Le moteur a échoué : ${texte}` };
}

/** Limite refusée, et le dépassement payant (overage) ne prend pas le relais. */
function limiteBloquante(info: SDKRateLimitInfo): boolean {
  return info.status === "rejected" && info.overageStatus !== "allowed" && info.overageStatus !== "allowed_warning";
}

function masquer(texte: string, secret: string): string {
  return secret === "" ? texte : texte.replaceAll(secret, SECRET_MASQUE);
}

function secretDe(auth: Authentification): string {
  return auth.mode === "abonnement" ? auth.jeton : auth.cle;
}

/** Environnement du processus SDK : la liste blanche, plus un seul secret, celui du mode choisi. */
export function construireEnv(
  base: Readonly<Record<string, string | undefined>>,
  auth: Authentification,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const nom of ENV_AUTORISE) {
    const valeur = base[nom];
    if (valeur !== undefined) env[nom] = valeur;
  }
  if (auth.mode === "abonnement") env["CLAUDE_CODE_OAUTH_TOKEN"] = auth.jeton;
  else env["ANTHROPIC_API_KEY"] = auth.cle;
  return env;
}

/** Traduction d'un message isolé, sans état. Les limites d'usage sont gérées par `traduireTour`. */
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

/**
 * Traduction d'un tour complet : au plus une erreur, jamais à côté d'une fin.
 * Une limite refusée est retenue : si le tour échoue ensuite (résultat en erreur ou exception),
 * l'erreur est « quota » ; s'il réussit, elle est oubliée. Le secret est masqué dans les erreurs.
 */
export async function* traduireTour(
  messages: AsyncIterable<SDKMessage>,
  secret: string,
  signal: AbortSignal,
): AsyncGenerator<EvenementMoteur> {
  let limiteRefusee = false;
  let resultatVu = false;
  const erreur = (e: EvenementMoteur): EvenementMoteur =>
    limiteRefusee ? QUOTA : e.type === "erreur" ? { ...e, message: masquer(e.message, secret) } : e;

  try {
    for await (const m of messages) {
      if (m.type === "rate_limit_event") {
        if (limiteBloquante(m.rate_limit_info)) limiteRefusee = true;
        continue;
      }
      if (m.type === "result") {
        if (resultatVu) continue;
        resultatVu = true;
      }
      for (const e of traduireMessage(m)) yield e.type === "erreur" ? erreur(e) : e;
    }
  } catch (cause) {
    if (!resultatVu && !signal.aborted) {
      const texte = cause instanceof Error ? cause.message : String(cause);
      yield erreur({ type: "erreur", ...classerErreur(texte) });
    }
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
    const annuler = () => { controleur.abort(); };
    if (signal.aborted) controleur.abort();
    else signal.addEventListener("abort", annuler, { once: true });

    const { auth } = this.#parametres;
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
      env: construireEnv(process.env, auth),
      abortController: controleur,
      ...(requete.sessionId !== undefined ? { resume: requete.sessionId } : {}),
    };

    try {
      yield* traduireTour(query({ prompt: requete.prompt, options }), secretDe(auth), signal);
    } finally {
      signal.removeEventListener("abort", annuler);
    }
  }
}

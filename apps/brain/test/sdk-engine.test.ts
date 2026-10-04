import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import type { EvenementMoteur } from "../src/engine/engine.ts";
import { classerErreur, construireEnv, traduireMessage, traduireTour } from "../src/engine/sdk-engine.ts";

/** Les messages du SDK portent beaucoup de champs inutiles ici : fixtures partielles. */
const sdk = (m: Record<string, unknown>) => m as unknown as SDKMessage;
const traduire = (m: Record<string, unknown>) => [...traduireMessage(sdk(m))];

const QUOTA = { type: "erreur", code: "quota", message: "Je me repose : le quota de l'abonnement est atteint." };
const SECRET = "sk-ant-oat01-tres-secret";

const LIMITE_REFUSEE = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } };
const SUCCES = { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 40, output_tokens: 7 } };
const ECHEC = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] };

/** Rejoue des messages comme le ferait query(), puis lève éventuellement une exception. */
async function* flux(messages: readonly Record<string, unknown>[], exception?: Error): AsyncGenerator<SDKMessage> {
  for (const m of messages) yield await Promise.resolve(sdk(m));
  if (exception !== undefined) throw exception;
}

async function tour(
  messages: readonly Record<string, unknown>[],
  exception?: Error,
  signal: AbortSignal = new AbortController().signal,
): Promise<EvenementMoteur[]> {
  const sortie: EvenementMoteur[] = [];
  for await (const e of traduireTour(flux(messages, exception), SECRET, signal)) sortie.push(e);
  return sortie;
}

describe("construireEnv", () => {
  const PARENT = {
    PATH: "/bin",
    TEMP: "/tmp",
    ANTHROPIC_API_KEY: "vieille",
    CLAUDE_CODE_OAUTH_TOKEN: "vieux",
    ANTHROPIC_BASE_URL: "https://ailleurs.example",
    ANTHROPIC_AUTH_TOKEN: "jeton-tiers",
    CLAUDE_CODE_USE_BEDROCK: "1",
    GOOGLE_CLIENT_SECRET: "google",
  };
  const ABSENTES = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "GOOGLE_CLIENT_SECRET"];

  test("abonnement : liste blanche + jeton seul", () => {
    const env = construireEnv(PARENT, { mode: "abonnement", jeton: "j" });
    expect(env).toEqual({ PATH: "/bin", TEMP: "/tmp", CLAUDE_CODE_OAUTH_TOKEN: "j" });
    for (const nom of [...ABSENTES, "ANTHROPIC_API_KEY"]) expect(env).not.toHaveProperty(nom);
  });
  test("clé API : liste blanche + clé seule", () => {
    const env = construireEnv(PARENT, { mode: "cle_api", cle: "k" });
    expect(env).toEqual({ PATH: "/bin", TEMP: "/tmp", ANTHROPIC_API_KEY: "k" });
    for (const nom of [...ABSENTES, "CLAUDE_CODE_OAUTH_TOKEN"]) expect(env).not.toHaveProperty(nom);
  });
  test("variables de la liste blanche absentes du parent : non créées", () => {
    expect(construireEnv({}, { mode: "abonnement", jeton: "j" })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "j" });
  });
});

describe("traduireMessage", () => {
  test("init → session", () => {
    expect(traduire({ type: "system", subtype: "init", session_id: "s1" })).toEqual([
      { type: "session", sessionId: "s1" },
    ]);
  });
  test("autre message système : ignoré", () => {
    expect(traduire({ type: "system", subtype: "api_retry", session_id: "s1" })).toEqual([]);
  });
  test("delta de texte → texte", () => {
    expect(
      traduire({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Bon" } } }),
    ).toEqual([{ type: "texte", texte: "Bon" }]);
  });
  test("bloc texte d'un message assistant : ignoré (déjà reçu en morceaux)", () => {
    expect(traduire({ type: "assistant", message: { content: [{ type: "text", text: "Bonjour" }] } })).toEqual([]);
  });
  test("appel d'outil", () => {
    expect(
      traduire({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "meteo", input: {} }] } }),
    ).toEqual([{ type: "appel_outil", idAppel: "t1", outil: "meteo" }]);
  });
  test("résultat d'outil (succès et échec)", () => {
    expect(
      traduire({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            { type: "tool_result", tool_use_id: "t2", content: "ko", is_error: true },
          ],
        },
      }),
    ).toEqual([
      { type: "resultat_outil", idAppel: "t1", succes: true },
      { type: "resultat_outil", idAppel: "t2", succes: false },
    ]);
  });
  test("message utilisateur en texte simple : ignoré", () => {
    expect(traduire({ type: "user", message: { role: "user", content: "coucou" } })).toEqual([]);
  });
  test("résultat réussi → fin avec tokens", () => {
    expect(traduire(SUCCES)).toEqual([{ type: "fin", tokensEntree: 40, tokensSortie: 7 }]);
  });
  test("résultat en erreur → erreur classée", () => {
    expect(traduire(ECHEC)).toEqual([{ type: "erreur", code: "moteur", message: "Le moteur a échoué : boom" }]);
  });
  test("résultat « success » mais en erreur d'API → erreur avec le texte du résultat", () => {
    expect(
      traduire({ type: "result", subtype: "success", is_error: true, result: "API Error: 500", api_error_status: 500 }),
    ).toEqual([{ type: "erreur", code: "moteur", message: "Le moteur a échoué : API Error: 500" }]);
  });
  test("résultat en erreur d'API 429 → quota, même si le texte ne le dit pas", () => {
    expect(
      traduire({ type: "result", subtype: "success", is_error: true, result: "Échec", api_error_status: 429 }),
    ).toEqual([QUOTA]);
  });
  test("événement de limite : rien à lui seul (c'est le tour qui décide)", () => {
    expect(traduire(LIMITE_REFUSEE)).toEqual([]);
  });
});

describe("traduireTour", () => {
  test("tour normal : session, texte, fin", async () => {
    expect(
      await tour([
        { type: "system", subtype: "init", session_id: "s1" },
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Bon" } } },
        SUCCES,
      ]),
    ).toEqual([
      { type: "session", sessionId: "s1" },
      { type: "texte", texte: "Bon" },
      { type: "fin", tokensEntree: 40, tokensSortie: 7 },
    ]);
  });
  test("limite refusée puis résultat en erreur au texte quelconque → une seule erreur quota", async () => {
    expect(await tour([LIMITE_REFUSEE, ECHEC])).toEqual([QUOTA]);
  });
  test("limite refusée puis exception → une seule erreur quota", async () => {
    expect(await tour([LIMITE_REFUSEE], new Error("spawn ENOENT"))).toEqual([QUOTA]);
  });
  test("limite refusée puis succès → seulement la fin", async () => {
    expect(await tour([LIMITE_REFUSEE, SUCCES])).toEqual([{ type: "fin", tokensEntree: 40, tokensSortie: 7 }]);
  });
  test("limite non bloquante (avertissement, ou relayée par le dépassement) puis échec → erreur moteur", async () => {
    const avertissement = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } };
    const relayee = { type: "rate_limit_event", rate_limit_info: { status: "rejected", overageStatus: "allowed" } };
    expect(await tour([avertissement, relayee, ECHEC])).toEqual([
      { type: "erreur", code: "moteur", message: "Le moteur a échoué : boom" },
    ]);
  });
  test("résultat en erreur seul → une seule erreur moteur, l'exception qui suit est tue", async () => {
    expect(await tour([ECHEC], new Error("process exited with code 1"))).toEqual([
      { type: "erreur", code: "moteur", message: "Le moteur a échoué : boom" },
    ]);
  });
  test("exception sans résultat → erreur classée", async () => {
    expect(await tour([], new Error("spawn ENOENT"))).toEqual([
      { type: "erreur", code: "moteur", message: "Le moteur a échoué : spawn ENOENT" },
    ]);
  });
  test("exception après annulation : rien", async () => {
    const controleur = new AbortController();
    controleur.abort();
    expect(await tour([], new Error("aborted"), controleur.signal)).toEqual([]);
  });
  test("le secret actif est masqué dans les messages d'erreur", async () => {
    const evenements = await tour([], new Error(`échec avec CLAUDE_CODE_OAUTH_TOKEN=${SECRET} et ${SECRET}`));
    expect(evenements).toEqual([
      {
        type: "erreur",
        code: "moteur",
        message: "Le moteur a échoué : échec avec CLAUDE_CODE_OAUTH_TOKEN=[secret] et [secret]",
      },
    ]);
    expect(JSON.stringify(evenements)).not.toContain(SECRET);
  });
  test("le secret est aussi masqué dans un résultat en erreur", async () => {
    const echec = { type: "result", subtype: "error_during_execution", is_error: true, errors: [`clé ${SECRET} refusée`] };
    expect(await tour([echec])).toEqual([
      { type: "erreur", code: "moteur", message: "Le moteur a échoué : clé [secret] refusée" },
    ]);
  });
});

describe("classerErreur", () => {
  test("limite d'usage → quota", () => {
    expect(classerErreur("Claude AI usage limit reached|1759590000").code).toBe("quota");
    expect(classerErreur("429 rate_limit_error").code).toBe("quota");
    expect(classerErreur("Quota exceeded for this organization").code).toBe("quota");
  });
  test("textes de limite atteinte du SDK → quota", () => {
    expect(classerErreur("You've hit your session limit · resets 3pm").code).toBe("quota");
    expect(classerErreur("You're out of extra usage · resets Oct 7").code).toBe("quota");
  });
  test("le reste → moteur, y compris un quota disque", () => {
    expect(classerErreur("spawn ENOENT")).toEqual({ code: "moteur", message: "Le moteur a échoué : spawn ENOENT" });
    expect(classerErreur("EDQUOT: disk quota exceeded, write").code).toBe("moteur");
  });
});

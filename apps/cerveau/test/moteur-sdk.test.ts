import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import { classerErreur, construireEnv, traduireMessage } from "../src/moteur/moteur-sdk.ts";

/** Les messages du SDK portent beaucoup de champs inutiles ici : fixtures partielles. */
const sdk = (m: Record<string, unknown>) => m as unknown as SDKMessage;
const traduire = (m: Record<string, unknown>) => [...traduireMessage(sdk(m))];

const QUOTA = { type: "erreur", code: "quota", message: "Je me repose : le quota de l'abonnement est atteint." };

describe("construireEnv", () => {
  test("abonnement : jeton présent, clé API retirée", () => {
    const env = construireEnv({ ANTHROPIC_API_KEY: "vieille", PATH: "/bin" }, { mode: "abonnement", jeton: "j" });
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("j");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["PATH"]).toBe("/bin");
  });
  test("clé API : clé présente, jeton retiré", () => {
    const env = construireEnv({ CLAUDE_CODE_OAUTH_TOKEN: "vieux" }, { mode: "cle_api", cle: "k" });
    expect(env["ANTHROPIC_API_KEY"]).toBe("k");
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
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
    expect(
      traduire({ type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 40, output_tokens: 7 } }),
    ).toEqual([{ type: "fin", tokensEntree: 40, tokensSortie: 7 }]);
  });
  test("résultat en erreur → erreur classée", () => {
    expect(traduire({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] })).toEqual([
      { type: "erreur", code: "moteur", message: "Le moteur a échoué : boom" },
    ]);
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
  test("événement de limite refusé → quota", () => {
    expect(
      traduire({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } }),
    ).toEqual([QUOTA]);
  });
  test("événement de limite non bloquant (autorisé, ou relayé par le dépassement) : ignoré", () => {
    expect(traduire({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } })).toEqual([]);
    expect(
      traduire({ type: "rate_limit_event", rate_limit_info: { status: "rejected", overageStatus: "allowed" } }),
    ).toEqual([]);
  });
});

describe("classerErreur", () => {
  test("limite d'usage → quota", () => {
    expect(classerErreur("Claude AI usage limit reached|1759590000").code).toBe("quota");
    expect(classerErreur("429 rate_limit_error").code).toBe("quota");
  });
  test("textes de limite atteinte du SDK → quota", () => {
    expect(classerErreur("You've hit your session limit · resets 3pm").code).toBe("quota");
    expect(classerErreur("You're out of extra usage · resets Oct 7").code).toBe("quota");
  });
  test("le reste → moteur", () => {
    expect(classerErreur("spawn ENOENT")).toEqual({ code: "moteur", message: "Le moteur a échoué : spawn ENOENT" });
  });
});

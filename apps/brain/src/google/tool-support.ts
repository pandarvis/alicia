import type { ToolResult } from "../engine/tools.ts";
import type { GoogleAccount } from "./account-store.ts";
import type { GoogleAccess } from "./google-client.ts";
import { GoogleApiError, type GoogleFailure } from "./http.ts";

export const NO_ACCOUNT =
  "Aucun compte Google n'est connecté pour cette personne : elle peut en ajouter un dans l'app (écran Comptes).";

export const ACCOUNT_NOT_FOUND: ToolResult = {
  text: "Compte introuvable parmi les comptes Google de cette personne et de la Famille.",
  isError: true,
};

export function accountLabel(account: GoogleAccount): string {
  return account.owner === "common" ? `Famille (${account.email})` : `perso (${account.email})`;
}

export function failureText(account: GoogleAccount, failure: GoogleFailure): string {
  switch (failure) {
    case "reconnect":
      return `Le compte ${account.email} doit être reconnecté : la personne peut le faire dans l'app (écran Comptes, bouton « Reconnecter »).`;
    case "not_found":
      return "Introuvable : cet élément n'existe pas (ou plus) dans ce compte.";
    case "forbidden":
      return `Le compte ${account.email} n'a pas le droit de faire ça (agenda en lecture seule ?).`;
    case "invalid":
      return "Google a refusé la demande (données invalides).";
    case "changed":
      return "L'élément a changé depuis qu'il a été lu : rien n'a été fait. Relis-le, puis redemande à la personne.";
    case "unavailable":
      return "Google ne répond pas pour l'instant : propose de réessayer plus tard.";
  }
}

/** One line about an account that could not be used. Anything but a Google failure is a bug and propagates. */
export function failureLine(account: GoogleAccount, error: unknown): string {
  if (error instanceof GoogleApiError) return `${accountLabel(account)} : ${failureText(account, error.failure)}`;
  throw error;
}

/** Runs a single-account operation; a Google failure becomes an error result Alicia can explain. */
export async function guarded(account: GoogleAccount, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GoogleApiError) return { text: failureText(account, error.failure), isError: true };
    throw error;
  }
}

export type AccountChoice = { accounts: GoogleAccount[] } | { result: ToolResult };

/** The account named (within reach), or every account the person reaches. */
export function chooseAccounts(access: GoogleAccess, email: string | undefined): AccountChoice {
  if (email !== undefined) {
    const account = access.account(email);
    return account === undefined ? { result: ACCOUNT_NOT_FOUND } : { accounts: [account] };
  }
  const accounts = access.accounts();
  return accounts.length === 0 ? { result: { text: NO_ACCOUNT, isError: true } } : { accounts };
}

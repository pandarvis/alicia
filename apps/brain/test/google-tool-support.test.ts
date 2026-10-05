import { describe, expect, test } from "vitest";
import { type GoogleFailure, GoogleApiError } from "../src/google/http.ts";
import { accountLabel, chooseAccounts, failureLine, failureText, guarded, NO_ACCOUNT } from "../src/google/tool-support.ts";
import { createFamilyGoogle, createGoogleFixture } from "./google-fixture.ts";
import { ELODIE } from "./helpers.ts";

const FAILURES: readonly GoogleFailure[] = ["reconnect", "not_found", "forbidden", "invalid", "changed", "unavailable"];

describe("Google tool support", () => {
  test("accounts are chosen within reach only", async () => {
    const { elodieAccess } = await createFamilyGoogle();
    for (const email of ["kevin@example.com", " KEVIN@Example.com ", "inconnu@example.com"]) {
      const choice = chooseAccounts(elodieAccess, email);
      expect("result" in choice ? choice.result.isError : false, email).toBe(true);
      // The same answer whether the address exists elsewhere or not: nothing is revealed.
      expect("result" in choice ? choice.result.text : "", email).toMatch(/^Compte introuvable/);
    }
    const all = chooseAccounts(elodieAccess, undefined);
    expect("accounts" in all ? all.accounts.map((a) => a.email).sort() : []).toEqual(["elodie@example.com", "famille@example.com"]);
    const own = chooseAccounts(elodieAccess, "Famille@Example.com");
    expect("accounts" in own ? own.accounts.map((a) => a.email) : []).toEqual(["famille@example.com"]);
  });

  test("nobody connected: Alicia is told where accounts are added", () => {
    const { client } = createGoogleFixture();
    const choice = chooseAccounts(client.forPerson(ELODIE), undefined);
    expect("result" in choice ? choice.result : undefined).toEqual({ text: NO_ACCOUNT, isError: true });
  });

  test("accounts are named for the family: Famille or perso, with their address", async () => {
    const { accounts } = await createFamilyGoogle();
    expect(accountLabel(accounts.famille)).toBe("Famille (famille@example.com)");
    expect(accountLabel(accounts.kevin)).toBe("perso (kevin@example.com)");
  });

  test("every Google failure has its French sentence", async () => {
    const { accounts } = await createFamilyGoogle();
    const texts = FAILURES.map((failure) => failureText(accounts.famille, failure));
    expect(new Set(texts).size).toBe(FAILURES.length);
    expect(failureText(accounts.famille, "changed")).toMatch(/changé.*rien n'a été fait/);
  });

  test("Google failures become French sentences; other errors propagate", async () => {
    const { accounts } = await createFamilyGoogle();
    expect(failureLine(accounts.famille, new GoogleApiError("reconnect"))).toMatch(/Famille \(famille@example.com\).*reconnecté.*Comptes/);
    const result = await guarded(accounts.famille, () => Promise.reject(new GoogleApiError("unavailable")));
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/ne répond pas/);
    await expect(guarded(accounts.famille, () => Promise.reject(new Error("bug")))).rejects.toThrow("bug");
    expect(() => failureLine(accounts.famille, new Error("bug"))).toThrow("bug");
  });
});

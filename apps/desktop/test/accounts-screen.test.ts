import type { GoogleAccountSummary } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import { AccountsScreen, type AccountsPorts } from "../src/renderer/src/lib/accounts-screen.svelte.ts";

const FAMILLE: GoogleAccountSummary = {
  id: "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192", owner: "common", email: "famille@example.com",
  status: "connected", connectedAt: "2026-10-05T08:00:00.000Z",
};
const KEVIN: GoogleAccountSummary = {
  id: "7a2d9c4e-1b3f-4e5a-8c6d-0f1e2d3c4b5a", owner: "personal", email: "kevin@example.com",
  status: "reconnect", connectedAt: "2026-10-01T08:00:00.000Z",
};
const CLIENT = { clientId: "1-a.apps.googleusercontent.com", scopes: ["https://www.googleapis.com/auth/gmail.compose" as const] };
const GRANT = { ok: true as const, code: "4/0A", codeVerifier: "v".repeat(43), redirectUri: "http://127.0.0.1:4000" };

function setup(overrides: Partial<AccountsPorts> = {}) {
  const calls: { authorize: unknown[]; connect: unknown[]; removed: string[]; cancelled: number } = {
    authorize: [], connect: [], removed: [], cancelled: 0,
  };
  let listed: GoogleAccountSummary[] = [FAMILLE, KEVIN];
  const screen = new AccountsScreen({
    list: () => Promise.resolve({ available: true, accounts: listed }),
    client: () => Promise.resolve(CLIENT),
    authorize: (request) => {
      calls.authorize.push(request);
      return Promise.resolve(GRANT);
    },
    cancel: () => {
      calls.cancelled += 1;
      return Promise.resolve();
    },
    connect: (input) => {
      calls.connect.push(input);
      return Promise.resolve({ ok: true, account: { ...KEVIN, status: "connected" } });
    },
    remove: (id) => {
      calls.removed.push(id);
      return Promise.resolve(true);
    },
    ...overrides,
  });
  return { screen, calls, setListed: (list: GoogleAccountSummary[]) => { listed = list; } };
}

describe("AccountsScreen", () => {
  test("loads, groups by owner and flags accounts to reconnect", async () => {
    const { screen } = setup();
    expect(screen.phase).toBe("loading");
    await screen.load();
    expect(screen.phase).toBe("ready");
    expect(screen.common.map((a) => a.email)).toEqual(["famille@example.com"]);
    expect(screen.personal.map((a) => a.email)).toEqual(["kevin@example.com"]);
    expect(screen.needsAttention).toBe(true);
  });

  test("Google not configured on the brain", async () => {
    const { screen } = setup({ list: () => Promise.resolve({ available: false }) });
    await screen.load();
    expect(screen.phase).toBe("unavailable");
    expect(screen.needsAttention).toBe(false);
  });

  test("a first load that fails says so; a later one keeps the list and explains", async () => {
    let fail = true;
    const { screen } = setup({
      list: () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve({ available: true, accounts: [FAMILLE] })),
    });
    await screen.load();
    expect(screen.phase).toBe("failed");
    fail = false;
    await screen.load();
    expect(screen.phase).toBe("ready");
    fail = true;
    await screen.load();
    expect(screen.phase).toBe("ready");
    expect(screen.common).toEqual([FAMILLE]);
    expect(screen.message).toEqual({ tone: "error", text: "Impossible de charger les comptes pour l'instant." });
  });

  test("only the latest load is shown", async () => {
    const answers: ((accounts: GoogleAccountSummary[]) => void)[] = [];
    const { screen } = setup({
      list: () => new Promise((resolve) => {
        answers.push((accounts) => {
          resolve({ available: true, accounts });
        });
      }),
    });
    const older = screen.load();
    const newer = screen.load();
    answers[1]?.([FAMILLE]);
    await newer;
    answers[0]?.([FAMILLE, KEVIN]);
    await older;
    expect(screen.accounts).toEqual([FAMILLE]);
  });

  test("add a Famille account: browser flow, then the brain exchanges the code", async () => {
    const { screen, calls } = setup({
      connect: (input) => {
        calls.connect.push(input);
        return Promise.resolve({ ok: true, account: { ...FAMILLE, id: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e", email: "autre@example.com" } });
      },
    });
    await screen.load();
    await screen.add("common");
    expect(calls.authorize).toEqual([{ clientId: CLIENT.clientId, scopes: CLIENT.scopes }]);
    expect(calls.connect).toEqual([{ owner: "common", code: "4/0A", codeVerifier: GRANT.codeVerifier, redirectUri: GRANT.redirectUri }]);
    expect(screen.common.map((a) => a.email)).toEqual(["autre@example.com", "famille@example.com"]);
    expect(screen.message).toEqual({ tone: "info", text: "autre@example.com est connecté." });
    expect(screen.connecting).toBeNull();
  });

  test("reconnect suggests the same address and keeps the owner", async () => {
    const { screen, calls } = setup();
    await screen.reconnect(KEVIN.id);
    expect(calls.authorize).toEqual([{ clientId: CLIENT.clientId, scopes: CLIENT.scopes, loginHint: "kevin@example.com" }]);
    expect(calls.connect).toMatchObject([{ owner: "personal" }]);
    expect(screen.personal[0]?.status).toBe("connected");
    expect(screen.needsAttention).toBe(false);
    expect(screen.message).toEqual({ tone: "info", text: "kevin@example.com est connecté." });
  });

  test("reconnecting with another Google account says it is not the one to reconnect", async () => {
    const { screen } = setup({
      connect: () => Promise.resolve({
        ok: true, account: { ...KEVIN, id: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e", email: "autre@example.com", status: "connected" },
      }),
    });
    await screen.reconnect(KEVIN.id);
    expect(screen.message?.text).toBe("autre@example.com est connecté, mais ce n'est pas le compte à reconnecter.");
    expect(screen.needsAttention).toBe(true);
  });

  test("reconnecting an account that is gone does nothing", async () => {
    const { screen, calls } = setup();
    await screen.reconnect("5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e");
    expect(calls.authorize).toEqual([]);
    expect(screen.connecting).toBeNull();
  });

  test("a cancelled flow says nothing; other failures are explained in French", async () => {
    const cancelled = setup({ authorize: () => Promise.resolve({ ok: false, reason: "cancelled" }) });
    await cancelled.screen.add("personal");
    expect(cancelled.screen.message).toBeNull();
    expect(cancelled.calls.connect).toEqual([]);

    const denied = setup({ authorize: () => Promise.resolve({ ok: false, reason: "denied" }) });
    await denied.screen.add("personal");
    expect(denied.screen.message).toEqual({ tone: "error", text: "Connexion refusée dans le navigateur." });

    const late = setup({ authorize: () => Promise.resolve({ ok: false, reason: "timeout" }) });
    await late.screen.add("personal");
    expect(late.screen.message?.text).toMatch(/pas répondu à temps/);

    const partial = setup({ connect: () => Promise.resolve({ ok: false, reason: "missing_scopes" }) });
    await partial.screen.add("personal");
    expect(partial.screen.message?.text).toMatch(/cocher toutes les autorisations/);

    const taken = setup({ connect: () => Promise.resolve({ ok: false, reason: "already_connected" }) });
    await taken.screen.add("personal");
    expect(taken.screen.message?.text).toMatch(/déjà connecté/);

    const down = setup({ client: () => Promise.reject(new Error("offline")) });
    await down.screen.add("personal");
    expect(down.screen.message).toEqual({ tone: "error", text: "La connexion n'a pas abouti : réessaie." });
    expect(down.screen.connecting).toBeNull();
  });

  test("one flow at a time", async () => {
    let release: () => void = () => undefined;
    const { screen, calls } = setup({
      authorize: (request) => {
        calls.authorize.push(request);
        return new Promise((resolve) => {
          release = () => { resolve(GRANT); };
        });
      },
    });
    const first = screen.add("common");
    await Promise.resolve();
    await screen.add("personal");
    expect(screen.connecting).toEqual({ owner: "common", accountId: null });
    release();
    await first;
    expect(calls.authorize).toHaveLength(1);
  });

  test("Annuler asks the main process to stop waiting; a failure to ask is no crash", async () => {
    const { screen, calls } = setup();
    screen.cancel();
    expect(calls.cancelled).toBe(1);
    // An unhandled rejection would fail the run.
    const failing = setup({ cancel: () => Promise.reject(new Error("gone")) });
    failing.screen.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("remove asks first, then removes", async () => {
    const { screen, calls } = setup();
    await screen.load();
    screen.askRemove(FAMILLE.id);
    expect(screen.removingId).toBe(FAMILLE.id);
    screen.keep();
    expect(screen.removingId).toBeNull();
    screen.askRemove(FAMILLE.id);
    await screen.confirmRemove();
    expect(calls.removed).toEqual([FAMILLE.id]);
    expect(screen.common).toEqual([]);
    expect(screen.removingId).toBeNull();
    expect(screen.message).toEqual({ tone: "info", text: "Compte retiré." });
  });

  test("a removal that fails keeps the account and explains", async () => {
    const { screen } = setup({ remove: () => Promise.reject(new Error("offline")) });
    await screen.load();
    screen.askRemove(FAMILLE.id);
    await screen.confirmRemove();
    expect(screen.common).toEqual([FAMILLE]);
    expect(screen.removing).toBe(false);
    expect(screen.message).toEqual({ tone: "error", text: "Impossible de retirer ce compte pour l'instant." });
  });
});

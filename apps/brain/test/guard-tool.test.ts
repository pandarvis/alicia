import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { type Confirmed, defineTool } from "../src/engine/tools.ts";
import { guardTool } from "../src/tools/guard-tool.ts";
import { createTestTurn, KEVIN } from "./helpers.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

function deletion(ran: string[], seen: (Confirmed | undefined)[] = []) {
  return defineTool({
    name: "thing_delete",
    label: "Alicia supprime…",
    description: "Supprime une chose.",
    input: { id: z.string() },
    confirmation: ({ id }) => Promise.resolve(id === "absent" ? null : { summary: `Supprimer ${id} ?`, snapshot: `v1:${id}` }),
    run: ({ id }, confirmed) => {
      ran.push(id);
      seen.push(confirmed);
      return Promise.resolve({ text: `Supprimé ${id}` });
    },
  });
}

describe("guardTool", () => {
  test("approved: asks with the summary, then runs with what was approved", async () => {
    const ran: string[] = [];
    const seen: (Confirmed | undefined)[] = [];
    const { turn, asked } = createTestTurn(KEVIN, CONV, "approved");
    expect(await guardTool(deletion(ran, seen), turn).run({ id: "a" })).toEqual({ text: "Supprimé a" });
    expect(asked).toEqual([{ tool: "thing_delete", summary: "Supprimer a ?" }]);
    expect(ran).toEqual(["a"]);
    expect(seen).toEqual([{ snapshot: "v1:a" }]);
  });

  test.each([
    ["refused", "Refusé : la personne a répondu non. N'insiste pas et ne cherche pas à contourner."],
    ["expired", "Pas de réponse à temps à la demande de confirmation : rien n'a été fait."],
    ["cancelled", "Demande annulée : rien n'a été fait."],
  ] as const)("%s: never runs", async (outcome, text) => {
    const ran: string[] = [];
    const { turn } = createTestTurn(KEVIN, CONV, outcome);
    expect(await guardTool(deletion(ran), turn).run({ id: "a" })).toEqual({ text, isError: true });
    expect(ran).toEqual([]);
  });

  test("an approval arriving after the turn ended runs nothing", async () => {
    const ran: string[] = [];
    let approve: (outcome: "approved") => void = () => undefined;
    const { turn, end, asked } = createTestTurn(KEVIN, CONV, () => new Promise((resolve) => {
      approve = resolve;
    }));
    const result = guardTool(deletion(ran), turn).run({ id: "a" });
    await vi.waitFor(() => { expect(asked).toHaveLength(1); });
    end();
    approve("approved");
    expect(await result).toEqual({ text: "Demande annulée : rien n'a été fait.", isError: true });
    expect(ran).toEqual([]);
  });

  test("nothing to confirm (null): runs without asking", async () => {
    const ran: string[] = [];
    const seen: (Confirmed | undefined)[] = [];
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused");
    await guardTool(deletion(ran, seen), turn).run({ id: "absent" });
    expect(asked).toEqual([]);
    expect(ran).toEqual(["absent"]);
    expect(seen).toEqual([undefined]);
  });

  test("a tool without confirmation runs at once, keeping its name, label and input", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused");
    const plain = defineTool({
      name: "plain", label: "Alicia fait…", description: "Fait.", input: { n: z.number() },
      run: ({ n }) => Promise.resolve({ text: String(n) }),
    });
    const guarded = guardTool(plain, turn);
    expect([guarded.name, guarded.label, guarded.description, guarded.input]).toEqual(["plain", "Alicia fait…", "Fait.", plain.input]);
    expect(await guarded.run({ n: 2 })).toEqual({ text: "2" });
    expect(asked).toEqual([]);
  });

  test("a guarded tool no longer asks by itself: guarding it twice asks once", async () => {
    const ran: string[] = [];
    const { turn, asked } = createTestTurn(KEVIN, CONV, "approved");
    const twice = guardTool(guardTool(deletion(ran), turn), turn);
    expect("confirmation" in twice).toBe(false);
    await twice.run({ id: "a" });
    expect(asked).toHaveLength(1);
    expect(ran).toEqual(["a"]);
  });

  test("untrusted output marks the turn, even when the tool fails", async () => {
    const { turn } = createTestTurn(KEVIN, CONV);
    const reader = defineTool({
      name: "page_read", label: "…", description: "…", input: {}, untrustedOutput: true,
      run: () => Promise.reject(new Error("boom")),
    });
    expect(turn.untrusted).toBe(false);
    await expect(guardTool(reader, turn).run({})).rejects.toThrow("boom");
    expect(turn.untrusted).toBe(true);
  });

  test("a trusted tool leaves the turn trusted", async () => {
    const { turn } = createTestTurn(KEVIN, CONV);
    await guardTool(deletion([]), turn).run({ id: "a" });
    expect(turn.untrusted).toBe(false);
  });

  test("long summaries are cut to 500 characters", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV);
    const verbose = defineTool({
      name: "verbose", label: "…", description: "…", input: {},
      confirmation: () => Promise.resolve({ summary: "x".repeat(800), snapshot: "" }),
      run: () => Promise.resolve({ text: "ok" }),
    });
    await guardTool(verbose, turn).run({});
    expect(asked[0]?.summary).toHaveLength(500);
    expect(asked[0]?.summary.endsWith("…")).toBe(true);
  });

  test("a cut summary never splits an emoji in two", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV);
    const verbose = defineTool({
      name: "verbose", label: "…", description: "…", input: {},
      confirmation: () => Promise.resolve({ summary: `${"a".repeat(498)}😀 et la suite`, snapshot: "" }),
      run: () => Promise.resolve({ text: "ok" }),
    });
    await guardTool(verbose, turn).run({});
    expect(asked[0]?.summary.isWellFormed()).toBe(true);
    expect(asked[0]?.summary).toBe(`${"a".repeat(498)}…`);
  });

  test("an empty summary becomes a plain French question", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV);
    const terse = defineTool({
      name: "terse", label: "…", description: "…", input: {},
      confirmation: () => Promise.resolve({ summary: "  ", snapshot: "" }),
      run: () => Promise.resolve({ text: "ok" }),
    });
    await guardTool(terse, turn).run({});
    expect(asked[0]?.summary).toBe("Alicia voudrait utiliser l'outil « terse ». D'accord ?");
  });

  test("once the turn is over, no tool runs, not even one without confirmation", async () => {
    const ran: string[] = [];
    const { turn, end, asked } = createTestTurn(KEVIN, CONV, "approved");
    const plain = defineTool({
      name: "plain", label: "…", description: "…", input: {},
      run: () => {
        ran.push("plain");
        return Promise.resolve({ text: "ok" });
      },
    });
    end();
    expect(await guardTool(plain, turn).run({})).toEqual({ text: "Demande annulée : rien n'a été fait.", isError: true });
    expect(await guardTool(deletion(ran), turn).run({ id: "a" })).toEqual({ text: "Demande annulée : rien n'a été fait.", isError: true });
    expect(ran).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("every field but the confirmation is kept", () => {
    const { turn } = createTestTurn(KEVIN, CONV);
    const reader = defineTool({
      name: "reader", label: "…", description: "…", input: {}, untrustedOutput: true,
      confirmation: () => Promise.resolve(null),
      run: () => Promise.resolve({ text: "ok" }),
    });
    expect(Object.keys(guardTool(reader, turn)).sort()).toEqual(["description", "input", "label", "name", "run", "untrustedOutput"]);
  });

  test("a tool that takes longer than its budget: Alicia is told it may still have acted", async () => {
    const { turn } = createTestTurn(KEVIN, CONV);
    const slow = defineTool({
      name: "slow", label: "…", description: "…", input: {}, untrustedOutput: true,
      run: () => new Promise<never>(() => undefined),
    });
    expect(await guardTool(slow, turn, { runBudgetMs: 10 }).run({})).toEqual({
      text: "L'outil a mis trop de temps à répondre : il a peut-être agi quand même. Vérifie avant de recommencer, et dis-le à la personne.",
      isError: true,
    });
    // What it may bring later is outside content all the same.
    expect(turn.untrusted).toBe(true);
  });

});

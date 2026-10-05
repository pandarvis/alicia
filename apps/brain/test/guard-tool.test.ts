import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/engine/tools.ts";
import { guardTool } from "../src/tools/guard-tool.ts";
import { createTestTurn, KEVIN } from "./helpers.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

function deletion(ran: string[]) {
  return defineTool({
    name: "thing_delete",
    label: "Alicia supprime…",
    description: "Supprime une chose.",
    input: { id: z.string() },
    confirmation: ({ id }) => Promise.resolve(id === "absent" ? null : `Supprimer ${id} ?`),
    run: ({ id }) => {
      ran.push(id);
      return Promise.resolve({ text: `Supprimé ${id}` });
    },
  });
}

describe("guardTool", () => {
  test("approved: asks with the summary, then runs", async () => {
    const ran: string[] = [];
    const { turn, asked } = createTestTurn(KEVIN, CONV, "approved");
    expect(await guardTool(deletion(ran), turn).run({ id: "a" })).toEqual({ text: "Supprimé a" });
    expect(asked).toEqual([{ tool: "thing_delete", summary: "Supprimer a ?" }]);
    expect(ran).toEqual(["a"]);
  });

  test.each([
    ["refused", "Refusé : la personne a répondu non. N'insiste pas et ne cherche pas à contourner."],
    ["expired", "Pas de réponse à la demande de confirmation (5 minutes) : rien n'a été fait."],
    ["cancelled", "Demande de confirmation annulée (connexion perdue) : rien n'a été fait."],
  ] as const)("%s: never runs", async (outcome, text) => {
    const ran: string[] = [];
    const { turn } = createTestTurn(KEVIN, CONV, outcome);
    expect(await guardTool(deletion(ran), turn).run({ id: "a" })).toEqual({ text, isError: true });
    expect(ran).toEqual([]);
  });

  test("nothing to confirm (null): runs without asking", async () => {
    const ran: string[] = [];
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused");
    await guardTool(deletion(ran), turn).run({ id: "absent" });
    expect(asked).toEqual([]);
    expect(ran).toEqual(["absent"]);
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
      confirmation: () => Promise.resolve("x".repeat(800)),
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
      confirmation: () => Promise.resolve(`${"a".repeat(498)}😀 et la suite`),
      run: () => Promise.resolve({ text: "ok" }),
    });
    await guardTool(verbose, turn).run({});
    expect(asked[0]?.summary.isWellFormed()).toBe(true);
    expect(asked[0]?.summary).toBe(`${"a".repeat(498)}…`);
  });
});

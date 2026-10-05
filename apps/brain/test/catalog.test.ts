import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/engine/tools.ts";
import { labelOf, NATIVE_TOOL_LABELS, ToolCatalog, type ToolProvider } from "../src/tools/catalog.ts";
import { ELODIE, KEVIN } from "./helpers.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

const whoAmI: ToolProvider = (scope) => [
  defineTool({
    name: "who_am_i",
    label: "Alicia se présente…",
    description: "Dit à qui Alicia parle.",
    input: { polite: z.boolean().optional() },
    run: () => Promise.resolve({ text: `${scope.person.name} dans ${scope.conversationId}` }),
  }),
];

describe("ToolCatalog", () => {
  test("builds the tools of a turn, bound to its person and conversation", async () => {
    const catalog = new ToolCatalog([whoAmI]);
    const [kevinTool] = catalog.forTurn({ person: KEVIN, conversationId: CONV });
    const [elodieTool] = catalog.forTurn({ person: ELODIE, conversationId: CONV });
    expect(await kevinTool?.run({})).toEqual({ text: `Kévin dans ${CONV}` });
    expect(await elodieTool?.run({})).toEqual({ text: `Élodie dans ${CONV}` });
  });

  test("two tools with the same name are a programming error", () => {
    const catalog = new ToolCatalog([whoAmI, whoAmI]);
    expect(() => catalog.forTurn({ person: KEVIN, conversationId: CONV })).toThrow(/who_am_i/);
  });
});

describe("labelOf", () => {
  const tools = new ToolCatalog([whoAmI]).forTurn({ person: KEVIN, conversationId: CONV });
  test("our tools carry their own label", () => {
    expect(labelOf("who_am_i", tools)).toBe("Alicia se présente…");
  });
  test("built-in tools have French labels", () => {
    expect(labelOf("WebSearch", tools)).toBe(NATIVE_TOOL_LABELS["WebSearch"]);
    expect(labelOf("WebSearch", tools)).toBe("Alicia cherche sur le web…");
  });
  test("unknown tool: generic label", () => {
    expect(labelOf("mystery", tools)).toBe("Alicia utilise l'outil « mystery »…");
  });
});

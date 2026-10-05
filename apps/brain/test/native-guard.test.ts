import { expect, test } from "vitest";
import { createNativeGuard } from "../src/tools/native-guard.ts";

test("web search and skills are allowed; reading files, fetching pages and anything else are not (yet)", async () => {
  const guard = createNativeGuard();
  const signal = new AbortController().signal;
  expect(await guard.check("WebSearch", { query: "météo" }, signal)).toEqual({ allow: true });
  expect(await guard.check("Skill", { skill: "lire-un-document" }, signal)).toEqual({ allow: true });
  for (const tool of ["Read", "WebFetch", "Bash", "Write"]) {
    expect(await guard.check(tool, {}, signal), tool).toEqual({ allow: false, reason: "Cet outil n'est pas disponible." });
  }
  expect(guard.reminder("WebSearch", {})).toBeUndefined();
});

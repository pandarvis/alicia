import type { Memory, SheetMemories } from "./store.ts";

/** ~2 000 tokens of French text. */
export const SHEET_BUDGET_CHARS = 7000;

/** The permanent sheet injected in every system prompt. Most useful memories first; trimmed to budget. */
export function buildSheet(memories: SheetMemories, personName: string, budget = SHEET_BUDGET_CHARS): string {
  const sections: [string, readonly Memory[]][] = [
    ["Règles de la maison :", memories.rules],
    [`À propos de ${personName} :`, memories.pinnedPersonal],
    ["À propos de la famille :", memories.pinnedCommon],
  ];
  const header = "Ce que tu sais déjà (mémoire) :";
  let sheet = header;
  for (const [title, items] of sections) {
    let section = "";
    for (const item of items) {
      const line = `\n- ${item.text}`;
      const candidate = `\n${title}${section}${line}`;
      if (sheet.length + candidate.length > budget) break;
      section += line;
    }
    if (section !== "") sheet += `\n${title}${section}`;
  }
  return sheet === header ? "" : sheet;
}

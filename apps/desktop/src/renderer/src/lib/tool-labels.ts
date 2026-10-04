const LABELS: Readonly<Record<string, string>> = {
  memory_search: "Alicia fouille dans sa mémoire…",
  memory_remember: "Alicia retient ça…",
  memory_update: "Alicia met sa mémoire à jour…",
  memory_forget: "Alicia oublie ce souvenir…",
};

/** What the family sees while Alicia runs a tool (French label, generic for tools without one). */
export function toolActivity(tool: string): string {
  return LABELS[tool] ?? `Alicia utilise l'outil « ${tool} »…`;
}

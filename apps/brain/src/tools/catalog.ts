import type { Person } from "@alicia/protocol";
import type { ToolDefinition } from "../engine/tools.ts";

/** Who speaks and where: a turn's tools are always built for one person and one conversation. */
export interface ToolScope {
  person: Person;
  conversationId: string;
}

/** A family of tools (memory, weather, documents, later Google), built for each turn and bound to its scope. */
export type ToolProvider = (scope: ToolScope) => ToolDefinition[];

/** French labels of the SDK's built-in tools Alicia may use. */
export const NATIVE_TOOL_LABELS: Readonly<Record<string, string>> = {
  WebSearch: "Alicia cherche sur le web…",
  WebFetch: "Alicia lit une page web…",
  Read: "Alicia regarde le fichier…",
  Skill: "Alicia suit sa méthode…",
};

/** Every tool provider of the brain; the place where plan 3b adds Google. */
export class ToolCatalog {
  readonly #providers: readonly ToolProvider[];

  constructor(providers: readonly ToolProvider[]) {
    this.#providers = providers;
  }

  forTurn(scope: ToolScope): ToolDefinition[] {
    const tools = this.#providers.flatMap((provide) => provide(scope));
    const seen = new Set<string>();
    for (const t of tools) {
      if (seen.has(t.name)) throw new Error(`Two tools are named ${t.name}`);
      seen.add(t.name);
    }
    return tools;
  }
}

/** Label of a tool call: the tool's own, a built-in one, or a generic one. */
export function labelOf(tool: string, tools: readonly ToolDefinition[]): string {
  return tools.find((t) => t.name === tool)?.label ?? NATIVE_TOOL_LABELS[tool] ?? `Alicia utilise l'outil « ${tool} »…`;
}

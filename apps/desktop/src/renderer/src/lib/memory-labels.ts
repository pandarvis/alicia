import type { MemoryKind, MemoryScope, MemorySummary, MemoryTestHit } from "@alicia/protocol";
import { SIMILARITY_FLOOR, type MemorySort, type MemoryTab } from "./memory-screen.svelte.ts";

export const KIND_LABEL: Readonly<Record<MemoryKind, string>> = {
  rule: "Règle",
  preference: "Préférence",
  habit: "Habitude",
  fact: "Fait",
  event: "Événement",
};

/** For the filter chips. */
export const KIND_PLURAL: Readonly<Record<MemoryKind, string>> = {
  rule: "Règles",
  preference: "Préférences",
  habit: "Habitudes",
  fact: "Faits",
  event: "Événements",
};

export const SCOPE_LABEL: Readonly<Record<MemoryScope, string>> = {
  personal: "Moi",
  common: "Famille",
};

export const TAB_LABEL: Readonly<Record<MemoryTab, string>> = {
  all: "Tout",
  common: "Famille",
  personal: "Moi",
  trash: "Corbeille",
};

export const SORT_LABEL: Readonly<Record<MemorySort, string>> = {
  recent: "Récents",
  used: "Plus utilisés",
  dormant: "Qui dorment",
};

const DATE = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" });

/** "4 octobre 2026". */
export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}

/** Where a memory comes from; `conversation` is set when it can be opened. */
export interface Provenance {
  text: string;
  conversation: { id: string; title: string } | null;
}

export function provenance(memory: MemorySummary): Provenance {
  switch (memory.source) {
    case "manual":
      return { text: "Ajouté à la main", conversation: null };
    case "import":
      return { text: "Importé de l'ancienne Alice", conversation: null };
    case "conversation":
      if (memory.conversationId === null) return { text: "Retenu pendant une conversation supprimée", conversation: null };
      if (memory.conversationTitle === null) {
        // A household memory remembered while someone else was talking: their conversation stays theirs.
        return { text: "Retenu par Alicia pendant la conversation de quelqu'un d'autre", conversation: null };
      }
      return {
        text: "Retenu par Alicia pendant",
        conversation: { id: memory.conversationId, title: memory.conversationTitle },
      };
  }
}

export function usage(memory: MemorySummary): string {
  if (memory.recallCount === 0) return "Jamais utilisé";
  const count = `Utilisé ${memory.recallCount} fois`;
  return memory.lastRecalledAt === null ? count : `${count}, la dernière fois le ${formatDate(memory.lastRecalledAt)}`;
}

/** Why the brain found a test-bench hit. */
export function hitReasons(hit: MemoryTestHit): string[] {
  return [
    ...(hit.textMatch ? ["mots en commun"] : []),
    ...(hit.similarity >= SIMILARITY_FLOOR ? ["sens proche"] : []),
  ];
}

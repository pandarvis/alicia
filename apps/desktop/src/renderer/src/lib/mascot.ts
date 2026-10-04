/** Alicia's moods, one per validated paper-cut pose (design/mascotte/BRIEF.md). */
export const MASCOT_STATES = [
  "idle", "sleeping", "listening", "thinking", "speaking", "success", "alert", "error", "idea",
] as const;
export type MascotState = (typeof MASCOT_STATES)[number];

/** Source PNG names in design/mascotte/papier-decoupe/v2/. */
export const MASCOT_SOURCE_FILES: Readonly<Record<MascotState, string>> = {
  idle: "neutre",
  sleeping: "veille",
  listening: "ecoute",
  thinking: "reflexion",
  speaking: "parle",
  success: "victoire",
  alert: "alerte",
  error: "bug",
  idea: "idee",
};

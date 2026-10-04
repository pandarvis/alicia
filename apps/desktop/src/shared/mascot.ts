import type { ErrorCode } from "@alicia/protocol";
import { z } from "zod";

/** Alicia's moods, one per validated paper-cut pose (design/mascotte/BRIEF.md). */
export const MASCOT_STATES = [
  "idle", "sleeping", "listening", "thinking", "speaking", "success", "alert", "error", "idea",
] as const;
export const MascotState = z.enum(MASCOT_STATES);
export type MascotState = z.infer<typeof MascotState>;

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

/** Mood after a failed turn, by brain error code (any other code: alert). */
export const MASCOT_ON_ERROR: Readonly<Partial<Record<ErrorCode, MascotState>>> = {
  quota: "sleeping",
  busy: "alert",
  engine: "error",
  internal: "error",
};

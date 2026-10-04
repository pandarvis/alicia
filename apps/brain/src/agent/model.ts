import type { Model } from "@alicia/protocol";

const THINK_HARD = /r[ée]fl[ée]chis bien/i;

/** Sonnet by default; Opus if the interface asks for it or if the user says "réfléchis bien". */
export function chooseModel(requested: Model | undefined, text: string): Model {
  return requested === "opus" || THINK_HARD.test(text) ? "opus" : "sonnet";
}

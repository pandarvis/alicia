import { z } from "zod";
import type { NativeDecision, NativeToolGuard } from "../engine/engine.ts";
import { isReadable } from "./read-access.ts";
import type { TurnContext } from "./turn.ts";

export const ALLOW: NativeDecision = { allow: true };
export const NOT_AVAILABLE = "Cet outil n'est pas disponible.";
export const NOT_READABLE = "Lecture refusée : seuls les fichiers joints à cette conversation (et tes skills) sont lisibles.";

/** Read's input (sdk-tools.d.ts FileReadInput): only the path matters here, the rest (offset, pages…) passes. */
const ReadInput = z.looseObject({ file_path: z.string().min(1) });

export function deny(reason: string): NativeDecision {
  return { allow: false, reason };
}

/**
 * Read reaches two places only: this conversation's attachments (outside content: the turn is no longer trusted)
 * and Alicia's skills folder (her own reference files). Never the rest of the workspace (.claude/settings.json…),
 * the data folder, nor another conversation's or person's files.
 */
function checkRead(turn: TurnContext, input: unknown): NativeDecision {
  const parsed = ReadInput.safeParse(input);
  if (!parsed.success) return deny(NOT_READABLE);
  const path = parsed.data.file_path;
  if (isReadable(path, [turn.attachmentsDir])) {
    turn.markUntrusted();
    return ALLOW;
  }
  return isReadable(path, [turn.skillsDir]) ? ALLOW : deny(NOT_READABLE);
}

/** Decides on the SDK's built-in tools for one turn (the PreToolUse hook asks it before each call). */
export function createNativeGuard(turn: TurnContext): NativeToolGuard {
  return {
    check(tool, input) {
      switch (tool) {
        case "WebSearch":
        case "Skill":
          return Promise.resolve(ALLOW);
        case "Read":
          return Promise.resolve(checkRead(turn, input));
        default:
          return Promise.resolve(deny(NOT_AVAILABLE));
      }
    },
    reminder: () => undefined,
  };
}

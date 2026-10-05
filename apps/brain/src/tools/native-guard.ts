import type { NativeDecision, NativeToolGuard } from "../engine/engine.ts";

export const ALLOW: NativeDecision = { allow: true };
export const NOT_AVAILABLE = "Cet outil n'est pas disponible.";

export function deny(reason: string): NativeDecision {
  return { allow: false, reason };
}

/**
 * Decides on the SDK's built-in tools for one turn. First version: web search and Alicia's skills only; reading
 * a file (attachments) and fetching a page wait for their own guard.
 */
export function createNativeGuard(): NativeToolGuard {
  return {
    check(tool) {
      return Promise.resolve(tool === "WebSearch" || tool === "Skill" ? ALLOW : deny(NOT_AVAILABLE));
    },
    reminder: () => undefined,
  };
}

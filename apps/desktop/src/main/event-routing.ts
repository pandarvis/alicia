import type { ServerEvent } from "@alicia/protocol";
import type { Surface } from "../shared/surface.ts";

/**
 * Which windows receive a brain event. A turn's events go only to the window that asked for it (another
 * window starting a conversation must never show them); its end (`done`) reaches every window, which refresh
 * their conversation lists; connection events reach every window.
 */
export function eventRecipients(event: ServerEvent, owner: Surface | undefined, open: readonly Surface[]): Surface[] {
  switch (event.type) {
    case "ready":
    case "heartbeat":
    case "done":
      return [...open];
    case "conversation":
    case "text_delta":
    case "tool_call":
    case "tool_result":
    case "error":
      return owner !== undefined && open.includes(owner) ? [owner] : [];
  }
}

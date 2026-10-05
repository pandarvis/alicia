import type { ServerEvent } from "@alicia/protocol";
import type { Surface } from "../shared/surface.ts";

/**
 * Which windows may hold the device token: the main window and the Holo's mini-chat call the brain over HTTP
 * (conversations, memories). The Spotlight bar only sends through the main process: it only learns whether the
 * device is paired.
 */
export function mayReadSession(surface: Surface): boolean {
  return surface !== "spotlight";
}

/**
 * Which window shows a turn's confirmation card, and alone may answer it: the one whose turn asked. The Spotlight
 * bar closes once it sent its question and cannot show a card: the main window does.
 */
export function confirmationSurface(owner: Surface): Surface {
  return owner === "spotlight" ? "main" : owner;
}

/**
 * Which windows receive a brain event. A turn's events go only to the window that asked for it (another
 * window starting a conversation must never show them, nor answer its confirmations; a Spotlight turn's cards go to the main window); its end (`done`) reaches every window, which refresh
 * their conversation lists; connection events reach every window.
 */
export function eventRecipients(event: ServerEvent, owner: Surface | undefined, open: readonly Surface[]): Surface[] {
  switch (event.type) {
    case "ready":
    case "heartbeat":
    case "done":
      return [...open];
    case "confirm_request":
    case "confirm_result": {
      if (owner === undefined) return [];
      const surface = confirmationSurface(owner);
      return open.includes(surface) ? [surface] : [];
    }
    case "conversation":
    case "text_delta":
    case "tool_call":
    case "tool_result":
    case "error":
      return owner !== undefined && open.includes(owner) ? [owner] : [];
  }
}

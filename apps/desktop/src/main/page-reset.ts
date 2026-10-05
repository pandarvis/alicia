import type { EventEmitter } from "node:events";
import { z } from "zod";

/** What Electron says of a navigation that starts (`did-start-navigation`). */
const NavigationStart = z.object({ isMainFrame: z.boolean(), isSameDocument: z.boolean() });

/**
 * Calls `reset` whenever a window's page loses its state: it reloads (main-frame navigation), its renderer process
 * dies, or the window goes away. Whatever the page had set up in the main process (a suspended shortcut…) must be
 * undone then, since the page will never undo it itself. Never throws into Electron.
 */
export function onPageReset(contents: EventEmitter, reset: () => void): void {
  const safely = (): void => {
    try {
      reset();
    } catch (error) {
      console.error("page reset handler failed", error);
    }
  };
  contents.on("did-start-navigation", (details: unknown) => {
    const navigation = NavigationStart.safeParse(details);
    if (navigation.success && navigation.data.isMainFrame && !navigation.data.isSameDocument) safely();
  });
  contents.on("render-process-gone", safely);
  contents.on("destroyed", safely);
}

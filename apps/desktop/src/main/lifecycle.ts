/** The argument the login item starts Alicia with: stay in the notification area. */
export const HIDDEN_ARG = "--hidden";

/** Started by Windows at login (first or second launch): nothing to show. */
export function isHiddenLaunch(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_ARG);
}

/**
 * Wraps the quit cleanup so that every way of quitting can call it (will-quit, Windows ending the session, which
 * skips will-quit, the updater installing): it runs the first time only.
 */
export function runOnce(run: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    run();
  };
}

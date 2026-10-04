/**
 * Keeps a page in sync with state owned by the main process: subscribes first, then loads the current value,
 * which is dropped if a fresher pushed value already arrived. A failed load is tried once more, then logged
 * (pushes keep the page current anyway). Returns the unsubscribe function.
 */
export function mirror<T>(
  load: () => Promise<T>,
  subscribe: (listener: (value: T) => void) => () => void,
  apply: (value: T) => void,
): () => void {
  let pushed = false;
  const off = subscribe((value) => {
    pushed = true;
    apply(value);
  });
  const attempt = (retriesLeft: number): void => {
    load().then(
      (value) => {
        if (!pushed) apply(value);
      },
      (error: unknown) => {
        if (pushed) return;
        if (retriesLeft > 0) attempt(retriesLeft - 1);
        else console.error("could not load the current state from the main process", error);
      },
    );
  };
  attempt(1);
  return off;
}

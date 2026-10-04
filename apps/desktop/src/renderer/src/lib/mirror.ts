/**
 * Keeps a page in sync with state owned by the main process: subscribes first, then loads the current value,
 * which is dropped if a fresher pushed value already arrived. Returns the unsubscribe function.
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
  load().then(
    (value) => {
      if (!pushed) apply(value);
    },
    () => undefined,
  );
  return off;
}

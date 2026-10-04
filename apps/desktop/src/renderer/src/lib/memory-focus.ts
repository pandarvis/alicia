import { tick } from "svelte";

/** The memory the focus moves to when `removed` leaves the list: the next one, else the previous one. */
export function neighbourId(ids: readonly string[], removed: string): string | null {
  const index = ids.indexOf(removed);
  if (index === -1) return ids[0] ?? null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

/**
 * After a memory left the list: focus the card of `id` (or its « Récupérer » in the trash),
 * or the search field when there is none, so the keyboard is never dropped on the page.
 * Does nothing when the user already moved the focus somewhere that still exists.
 */
export async function focusMemory(id: string | null): Promise<void> {
  await tick();
  if (holdsFocus(document.activeElement)) return;
  const target = id === null ? null : document.querySelector<HTMLElement>(`[data-focus-memory="${CSS.escape(id)}"]`);
  (target ?? document.querySelector<HTMLElement>("[data-testid=memory-search]"))?.focus();
}

/** A live, focusable place (Svelte marks outroing nodes `inert`). */
function holdsFocus(element: Element | null): boolean {
  return element !== null && element !== document.body && element.isConnected && element.closest("[inert]") === null;
}

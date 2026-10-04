/**
 * Conversations where Alicia is currently answering, shared by every connection of the
 * process: a single turn at a time per conversation, across all devices.
 * The key includes the person: the id of someone else's conversation never reveals its activity.
 */
export class ConversationLocks {
  readonly #busy = new Set<string>();

  /** Acquires the lock; false if a turn is already running in this conversation. */
  acquire(personId: string, conversationId: string): boolean {
    const key = JSON.stringify([personId, conversationId]);
    if (this.#busy.has(key)) return false;
    this.#busy.add(key);
    return true;
  }

  release(personId: string, conversationId: string): void {
    this.#busy.delete(JSON.stringify([personId, conversationId]));
  }
}

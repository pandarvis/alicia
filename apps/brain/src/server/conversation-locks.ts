/**
 * Conversations où Alicia est en train de répondre, partagé par toutes les connexions
 * du processus : un seul tour à la fois par conversation, tous appareils confondus.
 * La clé inclut la personne : l'id d'une conversation d'autrui ne révèle jamais son activité.
 */
export class VerrouConversations {
  readonly #occupees = new Set<string>();

  /** Prend le verrou ; faux si un tour est déjà en cours dans cette conversation. */
  prendre(personneId: string, conversationId: string): boolean {
    const cle = JSON.stringify([personneId, conversationId]);
    if (this.#occupees.has(cle)) return false;
    this.#occupees.add(cle);
    return true;
  }

  liberer(personneId: string, conversationId: string): void {
    this.#occupees.delete(JSON.stringify([personneId, conversationId]));
  }
}

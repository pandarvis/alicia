import { type EvenementServeur, MessageClient, type Personne } from "@alicia/protocol";
import type { RawData, WebSocket } from "ws";
import { traiterEnvoi } from "../conversations/service-chat.ts";
import type { DependancesServeur } from "./serveur.ts";
import type { VerrouConversations } from "./verrou-conversations.ts";

const DELAI_AUTHENTIFICATION_PAR_DEFAUT_MS = 5000;
const FERMETURE_NON_AUTHENTIFIE = 4401;
const FERMETURE_ERREUR_INTERNE = 1011;

export function enTexte(donnees: RawData): string {
  if (Buffer.isBuffer(donnees)) return donnees.toString("utf8");
  if (Array.isArray(donnees)) return Buffer.concat(donnees).toString("utf8");
  return Buffer.from(donnees).toString("utf8");
}

function lire(donnees: RawData): MessageClient | undefined {
  try {
    const resultat = MessageClient.safeParse(JSON.parse(enTexte(donnees)));
    return resultat.success ? resultat.data : undefined;
  } catch {
    return undefined;
  }
}

export function brancherWs(socket: WebSocket, deps: DependancesServeur, verrou: VerrouConversations): void {
  let session: { appareilId: string; personne: Personne } | undefined;
  const tours = new Set<AbortController>();

  const envoyer = (evenement: EvenementServeur): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(evenement));
  };
  const refuser = (message: string): void => {
    envoyer({ type: "erreur", code: "non_authentifie", message });
    socket.close(FERMETURE_NON_AUTHENTIFIE, "non authentifie");
  };

  const minuteur = setTimeout(() => {
    if (session === undefined) refuser("Authentification attendue.");
  }, deps.delaiAuthentificationMs ?? DELAI_AUTHENTIFICATION_PAR_DEFAUT_MS);

  const traiter = (donnees: RawData): void => {
    const message = lire(donnees);

    if (session === undefined) {
      if (message?.type !== "authentifier") {
        refuser("Authentification attendue.");
        return;
      }
      const trouvee = deps.appairage.authentifierAppareil(message.jeton);
      if (trouvee === undefined) {
        refuser("Jeton refusé.");
        return;
      }
      session = trouvee;
      clearTimeout(minuteur);
      envoyer({ type: "pret", personne: trouvee.personne });
      return;
    }

    if (message === undefined) {
      envoyer({ type: "erreur", code: "requete_invalide", message: "Message invalide." });
      return;
    }
    if (message.type === "authentifier") {
      // L'identité est figée pour toute la durée de la connexion.
      envoyer({ type: "erreur", code: "requete_invalide", message: "Déjà authentifié." });
      return;
    }
    // Un appareil révoqué pendant la connexion perd la main dès son prochain envoi.
    if (!deps.appairage.estActif(session.appareilId)) {
      refuser("Appareil révoqué.");
      return;
    }
    if (tours.size > 0) {
      envoyer({
        type: "erreur",
        idRequete: message.idRequete,
        code: "occupe",
        message: "Alicia répond déjà ; réessaie après sa réponse.",
      });
      return;
    }

    const auteur = session.personne;
    // Conversation existante : verrouillée avant le tour, quel que soit l'appareil qui y répond déjà.
    let verrouillee: string | undefined;
    if (message.conversationId !== undefined) {
      if (!verrou.prendre(auteur.id, message.conversationId)) {
        envoyer({
          type: "erreur",
          idRequete: message.idRequete,
          code: "occupe",
          message: "Alicia répond déjà dans cette conversation.",
        });
        return;
      }
      verrouillee = message.conversationId;
    }

    const tour = new AbortController();
    tours.add(tour);
    void (async () => {
      try {
        for await (const e of traiterEnvoi(deps.chat, auteur, message, tour.signal)) {
          // Nouvelle conversation : verrouillée dès que son id existe, avant qu'un autre appareil ne le voie.
          if (e.type === "conversation" && verrouillee === undefined && verrou.prendre(auteur.id, e.conversationId)) {
            verrouillee = e.conversationId;
          }
          envoyer(e);
        }
      } catch {
        envoyer({ type: "erreur", idRequete: message.idRequete, code: "interne", message: "Erreur interne." });
      } finally {
        tours.delete(tour);
        if (verrouillee !== undefined) verrou.liberer(auteur.id, verrouillee);
      }
    })();
  };

  socket.on("message", (donnees: RawData) => {
    if (socket.readyState !== socket.OPEN) return;
    try {
      traiter(donnees);
    } catch {
      // Une exception synchrone ne doit jamais faire tomber le processus.
      envoyer({ type: "erreur", code: "interne", message: "Erreur interne." });
      socket.close(FERMETURE_ERREUR_INTERNE, "erreur interne");
    }
  });

  const abandonner = (): void => {
    clearTimeout(minuteur);
    for (const tour of tours) tour.abort();
  };
  socket.on("close", abandonner);
  // Une erreur de socket (trame trop grande, coupure brutale…) ne doit pas faire tomber
  // le processus : on annule les tours en cours, comme à la fermeture.
  socket.on("error", abandonner);
}

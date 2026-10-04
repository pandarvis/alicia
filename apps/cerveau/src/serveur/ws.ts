import { type EvenementServeur, MessageClient, type Personne } from "@alicia/protocole";
import type { RawData, WebSocket } from "ws";
import { traiterEnvoi } from "../conversations/service-chat.ts";
import type { DependancesServeur } from "./serveur.ts";

const DELAI_AUTHENTIFICATION_PAR_DEFAUT_MS = 5000;
const FERMETURE_NON_AUTHENTIFIE = 4401;

function enTexte(donnees: RawData): string {
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

export function brancherWs(socket: WebSocket, deps: DependancesServeur): void {
  let personne: Personne | undefined;
  const tours = new Set<AbortController>();

  const envoyer = (evenement: EvenementServeur): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(evenement));
  };
  const refuser = (message: string): void => {
    envoyer({ type: "erreur", code: "non_authentifie", message });
    socket.close(FERMETURE_NON_AUTHENTIFIE, "non authentifie");
  };

  const minuteur = setTimeout(() => {
    if (personne === undefined) refuser("Authentification attendue.");
  }, deps.delaiAuthentificationMs ?? DELAI_AUTHENTIFICATION_PAR_DEFAUT_MS);

  socket.on("message", (donnees: RawData) => {
    const message = lire(donnees);
    if (message === undefined) {
      envoyer({ type: "erreur", code: "requete_invalide", message: "Message invalide." });
      return;
    }

    if (message.type === "authentifier") {
      const trouvee = deps.appairage.authentifier(message.jeton);
      if (trouvee === undefined) {
        refuser("Jeton refusé.");
        return;
      }
      personne = trouvee;
      clearTimeout(minuteur);
      envoyer({ type: "pret", personne: trouvee });
      return;
    }

    const auteur = personne;
    if (auteur === undefined) {
      envoyer({ type: "erreur", code: "non_authentifie", message: "Authentification attendue." });
      return;
    }

    const tour = new AbortController();
    tours.add(tour);
    void (async () => {
      try {
        for await (const e of traiterEnvoi(deps.chat, auteur, message, tour.signal)) envoyer(e);
      } catch {
        envoyer({ type: "erreur", idRequete: message.idRequete, code: "interne", message: "Erreur interne." });
      } finally {
        tours.delete(tour);
      }
    })();
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

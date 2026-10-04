import type { EvenementServeur, MessageEnvoyer, Personne } from "@alicia/protocole";
import { construireConsigne, horodater } from "../agent/consigne.ts";
import { choisirModele } from "../agent/modele.ts";
import type { Horloge } from "../horloge.ts";
import type { EvenementMoteur, Moteur } from "../moteur/moteur.ts";
import type { AppelOutilJournal, Conversation, DepotConversations, Message } from "./depot.ts";

export interface DependancesChat {
  depot: DepotConversations;
  moteur: Moteur;
  horloge: Horloge;
  fuseau: string;
}

type ErreurMoteur = Extract<EvenementMoteur, { type: "erreur" }>;

const LONGUEUR_TITRE = 60;
const MESSAGES_DE_REPRISE = 10;

export function titreDepuis(texte: string): string {
  const ligne = (texte.split("\n")[0] ?? "").trim();
  return ligne.length > LONGUEUR_TITRE ? `${ligne.slice(0, LONGUEUR_TITRE - 1)}…` : ligne;
}

export function construirePromptReprise(historique: readonly Message[], prompt: string): string {
  if (historique.length === 0) return prompt;
  const lignes = historique.map((m) => `${m.role === "utilisateur" ? "Utilisateur" : "Alicia"} : ${m.texte}`);
  return `Contexte : la conversation précédente n'a pas pu être reprise. Ses derniers échanges :\n${lignes.join("\n")}\n\nNouveau message :\n${prompt}`;
}

export async function* traiterEnvoi(
  deps: DependancesChat,
  personne: Personne,
  message: MessageEnvoyer,
  signal: AbortSignal,
): AsyncGenerator<EvenementServeur> {
  const debut = deps.horloge();

  let conversation: Conversation;
  if (message.conversationId !== undefined) {
    const trouvee = deps.depot.obtenir(message.conversationId, personne.id);
    if (trouvee === undefined) {
      yield {
        type: "erreur", idRequete: message.idRequete, code: "requete_invalide", message: "Conversation introuvable.",
      };
      return;
    }
    conversation = trouvee;
  } else {
    conversation = deps.depot.creer(personne.id, titreDepuis(message.texte));
  }
  const conversationId = conversation.id;
  yield { type: "conversation", idRequete: message.idRequete, conversationId };

  const historique = deps.depot.derniersMessages(conversationId, MESSAGES_DE_REPRISE);
  deps.depot.ajouterMessage(conversationId, "utilisateur", message.texte);

  const modele = choisirModele(message.modele, message.texte);
  const consigneSysteme = construireConsigne(personne);
  const prompt = horodater(message.texte, new Date(debut), deps.fuseau);

  let texte = "";
  let tokensEntree = 0;
  let tokensSortie = 0;
  const outils: AppelOutilJournal[] = [];
  let sessionId = conversation.sessionId ?? undefined;
  let promptCourant = prompt;
  let erreur: ErreurMoteur | undefined;

  for (let essai = 0; essai < 2; essai++) {
    erreur = undefined;
    try {
      const flux = deps.moteur.executer({ prompt: promptCourant, sessionId, modele, consigneSysteme }, signal);
      for await (const e of flux) {
        switch (e.type) {
          case "session":
            deps.depot.definirSession(conversationId, e.sessionId);
            break;
          case "texte":
            texte += e.texte;
            yield { type: "morceau_texte", conversationId, texte: e.texte };
            break;
          case "appel_outil":
            outils.push({ idAppel: e.idAppel, outil: e.outil, succes: null });
            yield { type: "appel_outil", conversationId, idAppel: e.idAppel, outil: e.outil };
            break;
          case "resultat_outil": {
            const appel = outils.find((o) => o.idAppel === e.idAppel);
            if (appel !== undefined) appel.succes = e.succes;
            yield { type: "resultat_outil", conversationId, idAppel: e.idAppel, succes: e.succes };
            break;
          }
          case "fin":
            tokensEntree += e.tokensEntree;
            tokensSortie += e.tokensSortie;
            break;
          case "erreur":
            erreur = e;
            break;
        }
      }
    } catch (cause) {
      erreur = {
        type: "erreur", code: "moteur", message: cause instanceof Error ? cause.message : String(cause),
      };
    }

    const sessionIllisible = erreur?.code === "moteur" && sessionId !== undefined && texte === "";
    if (!sessionIllisible) break;
    sessionId = undefined;
    deps.depot.definirSession(conversationId, null);
    promptCourant = construirePromptReprise(historique, prompt);
  }

  const dureeMs = deps.horloge() - debut;
  if (texte !== "") deps.depot.ajouterMessage(conversationId, "alicia", texte);
  deps.depot.journaliser({
    conversationId, modele, tokensEntree, tokensSortie, dureeMs, outils, erreur: erreur?.message ?? null,
  });

  if (erreur !== undefined) {
    yield {
      type: "erreur", idRequete: message.idRequete, conversationId, code: erreur.code, message: erreur.message,
    };
    return;
  }
  yield { type: "fin", conversationId, modele, tokensEntree, tokensSortie, dureeMs };
}

import type { ServerEvent, SendMessage, Person } from "@alicia/protocol";
import { construireConsigne, horodater } from "../agent/system-prompt.ts";
import { choisirModele } from "../agent/model.ts";
import type { Horloge } from "../clock.ts";
import type { EvenementMoteur, Moteur } from "../engine/engine.ts";
import type { AppelOutilJournal, Conversation, DepotConversations, Message } from "./repository.ts";

export interface DependancesChat {
  depot: DepotConversations;
  moteur: Moteur;
  horloge: Horloge;
  fuseau: string;
}

type ErreurMoteur = Extract<EvenementMoteur, { type: "erreur" }>;

const LONGUEUR_TITRE = 60;
const MESSAGES_DE_REPRISE = 10;

function enErreurMoteur(cause: unknown): ErreurMoteur {
  return { type: "erreur", code: "moteur", message: cause instanceof Error ? cause.message : String(cause) };
}

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
  personne: Person,
  message: SendMessage,
  signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
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
  // Conversation existante sans session (perdue) : on réinjecte les derniers échanges dès le premier essai.
  let promptCourant = sessionId === undefined ? construirePromptReprise(historique, prompt) : prompt;
  let erreur: ErreurMoteur | undefined;

  try {
    for (let essai = 0; essai < 2; essai++) {
      erreur = undefined;

      // Seuls la création du flux et la lecture du moteur sont des « erreurs moteur » ;
      // une panne du dépôt dans le traitement d'un événement doit remonter telle quelle.
      let flux: AsyncIterator<EvenementMoteur> | undefined;
      try {
        flux = deps.moteur.executer({ prompt: promptCourant, sessionId, modele, consigneSysteme }, signal)[
          Symbol.asyncIterator
        ]();
      } catch (cause) {
        erreur = enErreurMoteur(cause);
      }

      try {
        while (flux !== undefined) {
          let suivant: IteratorResult<EvenementMoteur>;
          try {
            suivant = await flux.next();
          } catch (cause) {
            erreur = enErreurMoteur(cause);
            break;
          }
          if (suivant.done === true) break;
          const e = suivant.value;
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
      } finally {
        // Sortie anticipée (consommateur arrêté, panne du dépôt) : libérer le flux du moteur.
        await flux?.return?.();
      }

      const sessionIllisible =
        erreur?.code === "moteur" && sessionId !== undefined && texte === "" && outils.length === 0;
      if (!sessionIllisible || signal.aborted) break;
      sessionId = undefined;
      deps.depot.definirSession(conversationId, null);
      promptCourant = construirePromptReprise(historique, prompt);
    }
  } finally {
    // Toujours enregistrer ce qui a été dit et journaliser le tour, même si le consommateur s'arrête.
    const dureeMs = deps.horloge() - debut;
    if (texte !== "") deps.depot.ajouterMessage(conversationId, "alicia", texte);
    deps.depot.journaliser({
      conversationId, modele, tokensEntree, tokensSortie, dureeMs, outils,
      erreur: signal.aborted ? "annulé" : (erreur?.message ?? null),
    });
  }

  if (signal.aborted) return;
  const dureeMs = deps.horloge() - debut;
  if (erreur !== undefined) {
    yield {
      type: "erreur", idRequete: message.idRequete, conversationId, code: erreur.code, message: erreur.message,
    };
    return;
  }
  yield { type: "fin", conversationId, modele, tokensEntree, tokensSortie, dureeMs };
}

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { EvenementServeur, type MessageClient, ReponseAppairage } from "@alicia/protocole";
import WebSocket from "ws";
import { construireConsigne } from "./agent/consigne.ts";
import { construireApplication, creerMoteurSdk } from "./application.ts";
import { chargerConfig, lireAuthentification } from "./config.ts";
import type { Moteur, RequeteMoteur } from "./moteur/moteur.ts";
import { enTexte } from "./serveur/ws.ts";

const AIDE = `Usage : pnpm --filter @alicia/cerveau alicia <commande>

  demarrer                       lance le cerveau
  appairer <personne>            affiche un code d'appairage (10 min)
  discuter [--url U] [--code C]  discute dans le terminal (jeton : --code ou ALICIA_JETON)
  appareils                      liste les appareils appairés
  revoquer <id>                  révoque un appareil (effet immédiat, même connecté)
  verifier-moteur                un appel réel au SDK (consomme un peu de quota)

La config est lue dans ALICIA_CONFIG (défaut : alicia.config.yaml), les secrets dans l'environnement.`;

const cheminConfig = (): string => resolve(process.env["ALICIA_CONFIG"] ?? "alicia.config.yaml");

/** `appairer`, `appareils` et `revoquer` n'ont pas besoin du moteur : il ne doit jamais être appelé. */
const MOTEUR_INUTILISE: Moteur = {
  executer: () => {
    throw new Error("Moteur inutilisé par cette commande.");
  },
};

async function demarrer(): Promise<void> {
  const config = chargerConfig(cheminConfig());
  const moteur = creerMoteurSdk(config, lireAuthentification(config.moteur.mode, process.env));
  const appli = await construireApplication(config, moteur, { journal: true });
  try {
    await appli.serveur.listen({ port: config.port, host: config.hote });
  } catch (erreur) {
    await appli.fermer();
    throw erreur;
  }
  console.log(`Alicia écoute sur ${config.hote}:${config.port} (moteur : ${config.moteur.mode}).`);

  // Arrêt propre : fermer les WebSockets, le serveur et la base avant de sortir.
  const arreter = (signal: NodeJS.Signals): void => {
    console.log(`\n${signal} reçu : arrêt d'Alicia…`);
    appli.fermer().then(
      () => process.exit(0),
      (erreur: unknown) => {
        console.error(erreur instanceof Error ? erreur.message : erreur);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", arreter);
  process.once("SIGTERM", arreter);
}

async function appairer(personne: string | undefined): Promise<void> {
  if (personne === undefined) throw new Error("Précisez la personne : appairer <kevin|elodie>");
  const config = chargerConfig(cheminConfig());
  const appli = await construireApplication(config, MOTEUR_INUTILISE);
  try {
    console.log(`Code pour ${personne} : ${appli.appairage.genererCode(personne)} (valable 10 minutes)`);
  } finally {
    await appli.fermer();
  }
}

async function listerAppareils(): Promise<void> {
  const config = chargerConfig(cheminConfig());
  const appli = await construireApplication(config, MOTEUR_INUTILISE);
  try {
    const liste = appli.appairage.listerAppareils();
    if (liste.length === 0) {
      console.log("Aucun appareil appairé.");
      return;
    }
    const date = (ms: number | null): string =>
      ms === null
        ? "—"
        : new Date(ms).toLocaleString("fr-FR", { timeZone: config.fuseau, dateStyle: "short", timeStyle: "short" });
    const nomDe = (id: string): string => config.personnes.find((p) => p.id === id)?.nom ?? id;
    const lignes = [
      ["id", "personne", "nom", "créé le", "vu le", "révoqué"],
      ...liste.map((a) => [a.id, nomDe(a.personneId), a.nom, date(a.creeLe), date(a.vuLe), date(a.revoqueLe)]),
    ];
    const largeurs = lignes[0]?.map((_, i) => Math.max(...lignes.map((l) => (l[i] ?? "").length))) ?? [];
    for (const l of lignes) console.log(l.map((c, i) => c.padEnd(largeurs[i] ?? 0)).join("  ").trimEnd());
  } finally {
    await appli.fermer();
  }
}

async function revoquer(id: string | undefined): Promise<void> {
  if (id === undefined) throw new Error("Précisez l'appareil : revoquer <id> (voir « appareils »)");
  const config = chargerConfig(cheminConfig());
  const appli = await construireApplication(config, MOTEUR_INUTILISE);
  try {
    if (!appli.appairage.revoquerAppareil(id)) throw new Error(`Aucun appareil actif avec l'id ${id}.`);
    console.log(`Appareil ${id} révoqué.`);
  } finally {
    await appli.fermer();
  }
}

async function obtenirJeton(urlWs: string, code: string | undefined): Promise<string> {
  if (code === undefined) {
    const jeton = process.env["ALICIA_JETON"];
    if (jeton === undefined || jeton === "") throw new Error("Donnez --code <6 chiffres> ou la variable ALICIA_JETON.");
    return jeton;
  }
  const urlHttp = urlWs.replace(/^ws/, "http").replace(/\/ws$/, "/appairage");
  const reponse = await fetch(urlHttp, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, nomAppareil: "Terminal" }),
  });
  if (!reponse.ok) throw new Error(`Appairage refusé (${reponse.status}).`);
  const { jeton } = ReponseAppairage.parse(await reponse.json());
  console.log(`Jeton (à garder dans ALICIA_JETON) : ${jeton}`);
  return jeton;
}

function lireEvenement(donnees: WebSocket.RawData): EvenementServeur | undefined {
  try {
    const resultat = EvenementServeur.safeParse(JSON.parse(enTexte(donnees)));
    return resultat.success ? resultat.data : undefined;
  } catch {
    return undefined;
  }
}

async function discuter(url: string, code: string | undefined): Promise<void> {
  const jeton = await obtenirJeton(url, code);
  const ws = new WebSocket(url);
  let conversationId: string | undefined;
  let finTour: (() => void) | undefined;
  const ouverte = (): boolean => ws.readyState === WebSocket.OPEN;

  const envoyer = (m: MessageClient): void => {
    ws.send(JSON.stringify(m));
  };
  const pret = new Promise<void>((resoudre, rejeter) => {
    ws.on("message", (donnees: WebSocket.RawData) => {
      const e = lireEvenement(donnees);
      if (e === undefined) return;
      switch (e.type) {
        case "pret":
          console.log(`Connecté en tant que ${e.personne.nom}. Tape « /quitter » pour sortir.`);
          resoudre();
          break;
        case "conversation":
          conversationId = e.conversationId;
          process.stdout.write("Alicia : ");
          break;
        case "morceau_texte":
          process.stdout.write(e.texte);
          break;
        case "appel_outil":
          process.stdout.write(`\n  [outil : ${e.outil}]\n`);
          break;
        case "resultat_outil":
          break;
        case "fin":
          process.stdout.write(`\n  (${e.modele}, ${e.tokensEntree}→${e.tokensSortie} tokens, ${e.dureeMs} ms)\n`);
          finTour?.();
          break;
        case "erreur":
          // « occupe » : un tour est déjà en cours ; on affiche et on rend la main comme les autres erreurs.
          console.log(`\n  [erreur ${e.code}] ${e.message}`);
          finTour?.();
          if (e.code === "non_authentifie") rejeter(new Error(e.message));
          break;
      }
    });
    // Toujours écouter « error » (sinon le processus tombe) ; après « pret », rejeter n'a plus d'effet.
    ws.on("error", rejeter);
    ws.once("close", () => {
      finTour?.();
      rejeter(new Error("Connexion fermée par le cerveau."));
    });
  });
  ws.once("open", () => {
    envoyer({ type: "authentifier", jeton });
  });
  await pret;

  const lecteur = createInterface({ input: process.stdin, output: process.stdout });
  lecteur.on("SIGINT", () => {
    lecteur.close();
  });
  try {
    while (ouverte()) {
      let texte: string;
      try {
        texte = (await lecteur.question("\nToi : ")).trim();
      } catch {
        break; // Ctrl+C ou Ctrl+D : le lecteur est fermé.
      }
      if (texte === "/quitter") break;
      if (texte === "" || !ouverte()) continue;
      const tour = new Promise<void>((resoudre) => {
        finTour = resoudre;
      });
      envoyer({
        type: "envoyer",
        idRequete: randomUUID(),
        texte,
        ...(conversationId !== undefined ? { conversationId } : {}),
      });
      await tour;
    }
    if (!ouverte()) console.log("\nConnexion fermée par le cerveau.");
  } finally {
    lecteur.close();
    ws.close();
  }
}

async function verifierMoteur(): Promise<void> {
  const config = chargerConfig(cheminConfig());
  const moteur = creerMoteurSdk(config, lireAuthentification(config.moteur.mode, process.env));
  const personne = config.personnes[0];
  if (personne === undefined) throw new Error("Aucune personne dans la config.");
  const requete: RequeteMoteur = {
    prompt: "Réponds juste « ok » si tu m'entends.",
    sessionId: undefined,
    modele: "sonnet",
    consigneSysteme: construireConsigne(personne),
  };
  for await (const e of moteur.executer(requete, new AbortController().signal)) console.log(e);
}

async function principal(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string", default: "ws://127.0.0.1:8780/ws" },
      code: { type: "string" },
      aide: { type: "boolean", short: "h" },
    },
  });
  const [commande, argument] = positionals;
  if (values.aide === true) {
    console.log(AIDE);
    return;
  }
  switch (commande) {
    case "demarrer":
      return demarrer();
    case "appairer":
      return appairer(argument);
    case "discuter":
      return discuter(values.url, values.code);
    case "appareils":
      return listerAppareils();
    case "revoquer":
      return revoquer(argument);
    case "verifier-moteur":
      return verifierMoteur();
    case undefined:
      console.log(AIDE);
      return;
    default:
      console.error(`Commande inconnue : ${commande}\n`);
      console.log(AIDE);
      process.exitCode = 1;
  }
}

principal().catch((erreur: unknown) => {
  console.error(erreur instanceof Error ? erreur.message : erreur);
  process.exitCode = 1;
});

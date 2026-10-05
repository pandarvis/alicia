# Alicia — Sous-projet 1 : le socle du cerveau — Design

**Date :** 2026-10-04
**Statut :** validé en brainstorm avec Kévin (maquettes d'interface à l'appui, archivées dans
`.superpowers/brainstorm/`, non versionné)
**Dépôt :** `pandarvis/alicia` (nouveau). L'ancienne Alice (`pandarvis/alice`, package
`pandarvis`) reste en production jusqu'à la bascule.

## Contexte

Alicia (Alice + IA) est la refonte intégrale d'Alice, l'assistante familiale de Kévin et
Élodie. Trois raisons de refaire plutôt que de faire évoluer :

1. **Intelligence** : passer d'un échange question → outils à une vraie boucle d'agent
   (planifier, enchaîner des outils, vérifier) avec le **Claude Agent SDK**.
2. **Alimentation** : le SDK est branché sur **l'abonnement Claude de Kévin** (choix assumé
   par Kévin, sujet clos) au lieu de la facturation API à l'usage.
3. **Forme** : une **app Electron** sur chaque PC, qui est d'abord le **tableau de bord de la
   maison** (contrôles, capacités d'Alicia) avec le chat, plus la PWA mobile conservée.

**Périmètre produit :** outil familial (deux utilisateurs adultes, mêmes droits). Pas de
multi-foyers ni d'installation grand public. Ajouter une personne plus tard ne doit rien
casser.

## Feuille de route (5 sous-projets, une spec chacun)

| # | Sous-projet | Contenu |
|---|---|---|
| **1** | **Socle du cerveau** ← cette spec | Core TypeScript sur l'Agent SDK, identités, mémoire, outils de base, coquille Electron |
| 2 | Domaines de la maison | Home Assistant (MCP intégré à HA), écran Maison (version « tableau plein écran + barre Alicia + tuile Alicia propose »), courses, post-its, scénarios énergie, watchdog, notifications push, suivi des limites d'usage |
| 3 | Voix | Piper (voix Élodie) + reconnaissance vocale, streaming. Piste : sherpa-onnx dans Node pour éviter Python |
| 4 | Capacités locales Electron | Alicia agit sur les PC (fichiers, applis, captures) depuis le cerveau central |
| 5 | Interfaces | PWA mobile et kiosk sur les composants Svelte partagés |

**Migration :** grand remplacement. Tout se construit à côté ; l'ancienne Alice tourne en
parallèle ; les données migrent à la bascule.

**Matériel :** cerveau testé sur le **Raspberry Pi 5**, cible finale **Mac mini**. Le serveur
n'est pas conçu autour des limites du Pi mais doit y tourner. Les PC clients sont sous
**Windows** (les deux).

## Décisions actées

1. **Architecture hybride** : un cerveau central unique (mémoire, outils, automatismes)
   + des clients (Electron, plus tard PWA et kiosk). Les capacités locales des PC viennent au
   sous-projet 4.
2. **Tout TypeScript, typage maximal** : `strict` + `noUncheckedIndexedAccess` +
   `exactOptionalPropertyTypes` + `noImplicitOverride`, `any` interdit par le linter, Zod à
   chaque frontière (réseau, outils, config, données importées). Monorepo, types partagés.
3. **Moteur interchangeable** : jeton d'abonnement (`CLAUDE_CODE_OAUTH_TOKEN`, généré par
   `claude setup-token`) ou clé API (`ANTHROPIC_API_KEY`), choisi dans la config, sans code
   à toucher.
4. **Modèles** : **Sonnet 5.5** (`claude-sonnet-5-5`) par défaut ; **Opus 5.5**
   (`claude-opus-5-5`) ponctuellement (bouton dans l'app ou « réfléchis bien »).
5. **Conversations** : le SDK garde le contexte (sessions reprises par identifiant) ; la base
   d'Alicia garde une copie propre pour l'affichage, l'historique et la recherche.
6. **Mémoire hybride** : SQLite source de vérité, recherche mots-clés + sens (embeddings
   locaux), outils mémoire appelés par Alicia, fiche permanente plafonnée.
7. **Mémoire commune + mémoire perso cloisonnée** par personne. Cloisonnement garanti par le
   code.
8. **Comptes Google connectés** : un compte Famille (commun) + des comptes perso facultatifs.
9. **Gmail : lecture et brouillons, jamais d'envoi** (aucun outil d'envoi n'existe).
10. **Les contrôles du tableau de bord ne passent pas par l'IA** (principe valable dès le
    sous-projet 2) : la maison reste pilotable si le quota est épuisé.
11. **Interface en Svelte 5** pour toutes les surfaces (Electron, puis PWA et kiosk).
12. **App Electron installée** (installateur par utilisateur, sans droits admin) avec mise à
    jour automatique **servie par le cerveau**.

## Architecture

```
alicia/
├─ packages/
│  └─ protocole/      types + schémas Zod partagés (messages, événements, identités)
├─ apps/
│  ├─ cerveau/        serveur Node : Agent SDK, API HTTP + WebSocket, SQLite, outils
│  │  └─ espace/      espace de travail d'Alicia (cwd du SDK) : .claude/skills/
│  └─ bureau/         app Electron (electron-vite + Svelte 5)
├─ design/mascotte/   brief + références de la mascotte (refaite en parallèle)
└─ docs/superpowers/  specs et plans
```

- **Gestionnaire :** pnpm (workspaces). **Runtime :** Node LTS la plus récente disponible au
  moment de l'implémentation (vérifier qu'elle tourne sur Pi 5 ARM64 et macOS).
- **Serveur :** Fastify + WebSocket (`@fastify/websocket`).
- **Base :** SQLite (Drizzle ORM pour le typage), FTS5 pour les mots-clés, `sqlite-vec` pour
  les vecteurs.
- **Embeddings :** `@huggingface/transformers` (ONNX) avec un petit modèle multilingue
  (famille multilingual-e5-small). Calcul local : rien ne sort de la maison, aucun quota
  consommé.

### Le trajet d'un message

1. L'app envoie `{conversationId?, texte, piècesJointes?, modèle?}` par WebSocket avec son
   **jeton d'appareil** → le cerveau sait qui parle.
2. Le cerveau charge (ou crée) la conversation et son `sessionId` SDK.
3. Il construit la requête SDK : modèle, `resume`, consigne système (personnalité + **fiche
   permanente**), serveur d'outils **lié à la personne**, liste blanche d'outils.
4. Il relaie en direct chaque événement à l'app : `réflexion`, `appel_outil`,
   `résultat_outil`, `morceau_texte`, `demande_confirmation`, `fin`, `erreur`.
5. Il enregistre messages, appels d'outils et consommation dans la base.

### Réseau et identités

- Accès par le réseau de la maison ou **Tailscale** (déjà en place).
- **Appairage** : `alicia appairer <kevin|elodie>` (commande du cerveau) affiche un code à
  6 chiffres valable 10 minutes ; l'app le saisit et reçoit un **jeton d'appareil** aléatoire
  (256 bits), stocké chiffré côté client (Electron `safeStorage`) et **haché** côté cerveau.
  Un appareil peut être révoqué.
- La base connaît les **personnes** (Kévin, Élodie) ; chaque appareil appartient à une
  personne. Ajouter une personne = une ligne, pas de code.

## Mémoire

**Un souvenir** : texte, **portée** (`commun` | une personne), **type** (`règle`,
`préférence`, `habitude`, `fait`, `événement`), provenance (conversation), dates de création
et de mise à jour, compteur de rappels, date du dernier rappel, épinglé ou non.

**Recherche hybride** : FTS5 + similarité vectorielle, scores fusionnés (fusion par rangs
réciproques), filtrée par portée **avant** le classement.

**Outils mémoire** (serveur d'outils d'Alicia) : `memoire_chercher`, `memoire_retenir`,
`memoire_corriger`, `memoire_oublier`. Alicia retient d'elle-même ce qui compte (mémoire
autonome) ; en cas de doute entre perso et commun, elle range en **perso**.

**Cloisonnement par construction** : le serveur d'outils est instancié **par requête**, lié
à la personne qui parle ; ses requêtes SQL ne peuvent porter que sur `commun` ∪ cette
personne. Aucun paramètre d'outil ne permet de choisir une autre personne.

**Fiche permanente** (dans la consigne système à chaque message) : règles de la maison,
profil de la personne, ses souvenirs épinglés et les souvenirs communs épinglés. Plafond
d'environ 2 000 tokens ; au-delà, les plus anciens non rappelés sortent de la fiche (ils
restent cherchables).

**Import de l'ancienne Alice** (commande `alicia importer-alice <chemin data>`, lancée sur le
Pi contre les données de production) : souvenirs (Chroma, `data/memory/`) et règles de la
maison. Tout arrive en **commun** ; les règles deviennent des souvenirs de type `règle`.
Embeddings recalculés avec le nouveau modèle. Les anciennes conversations ne sont pas
importées. Idempotent (relançable sans doublons).

**Tri assisté** : Alicia peut proposer de déplacer un souvenir commun vers une portée perso
(« ce souvenir semble personnel à Kévin, je le déplace ? »), avec confirmation.

## Agent et outils

**Cadre du SDK :**
- `cwd` = `apps/cerveau/espace/` ; `settingSources: ["project"]` → seuls les skills et
  réglages d'Alicia sont chargés, jamais la config Claude Code de la machine.
- `strictMcpConfig: true` ; un seul serveur d'outils in-process (`createSdkMcpServer`),
  nommé `alicia`.
- **Liste blanche** : `WebSearch`, `WebFetch`, `Read`, `Skill`, `mcp__alicia__*`. Pas de
  terminal, pas d'édition de fichiers.
- `Read` est restreint par un hook `PreToolUse` au dossier de pièces jointes de la
  conversation en cours et au dossier des skills (`espace/.claude/skills/`, lecture des
  fichiers de référence d'un skill) ; toute autre lecture est refusée.
- **Garde-fou contre l'injection de consignes** : un mail, une page web ou un document peut
  contenir des instructions piégées visant à faire fuiter la mémoire ou les mails. Dès
  qu'un contenu non fiable est entré dans le tour (`gmail_lire`, `WebFetch`,
  `document_lire`, `Read` d'une pièce jointe), tout `WebFetch` vers une adresse absente du
  message de l'utilisateur demande une **confirmation**. Les contenus non fiables sont
  présentés à Alicia comme des données, jamais comme des consignes.
- Les **confirmations** passent par `canUseTool` : le cerveau émet `demande_confirmation`,
  l'app affiche une carte Oui / Non dans le chat, la réponse débloque ou refuse l'outil.

**Outils du socle :**

| Outil | Rôle | Confirmation |
|---|---|---|
| mémoire (×4) | voir la section Mémoire | `memoire_oublier` uniquement |
| `meteo` | Open-Meteo, coordonnées de la maison en config | non |
| `agenda_lister` | événements Famille + agendas perso de la personne | non |
| `agenda_creer` | crée un événement ; demande l'agenda si ambigu. **Sans invités** (une invitation Google part par mail, ce qui contredirait la règle « jamais d'envoi ») | non |
| `agenda_modifier`, `agenda_supprimer` | | **oui** |
| `gmail_chercher`, `gmail_lire` | comptes accessibles à la personne | non |
| `gmail_brouillon` | crée un brouillon | non |
| `document_lire` | Word (.docx) et Excel (.xlsx) → texte (mammoth, SheetJS) | non |
| `WebSearch`, `WebFetch`, `Read` | natifs (images et PDF lus nativement par `Read`) | non |

**Comptes Google connectés :** table des comptes (propriétaire `commun` ou une personne,
adresse, scopes, jeton de rafraîchissement **chiffré** en base, clé dans les secrets du
cerveau). Ajout depuis l'app : l'app mène le flux OAuth en boucle locale (navigateur système
→ `127.0.0.1`), puis transmet le code au cerveau, qui l'échange. Réutilise le
`google_client_secret.json` de l'ancienne Alice. Scopes : Calendar, `gmail.readonly`,
`gmail.compose`. **Aucun outil d'envoi** n'est programmé. Une personne accède aux comptes
`commun` et aux siens.

**Pièces jointes :** glisser-déposer dans le chat → envoi au cerveau → rangées dans
`espace/pieces-jointes/<conversation>/`. Images et PDF via `Read`, Word et Excel via
`document_lire`. Taille maximale : 25 Mo par fichier.

**Skills d'Alicia** (instructions seules, `espace/.claude/skills/`) :

| Skill | Rôle |
|---|---|
| `preparer-la-semaine` | agenda Famille + perso + météo → récap, conflits, oublis |
| `tri-des-mails` | résumer, repérer l'urgent, proposer des brouillons |
| `ranger-un-souvenir` | choisir la portée et le type ; quand retenir ou non |
| `lire-un-document` | facture, devis, courrier → l'essentiel, montants, échéances, proposer un rappel |
| `verifier-avant-d-agir` | deux ou trois points à vérifier après un conseil ou un brouillon (adapté en français de `discernment-nudge`, anthropics/skills) |

**Règle sur les skills tiers :** aucun skill externe contenant du code n'entre sans relecture
ligne à ligne ; on reprend les idées, pas les scripts. Repérés pour plus tard :
`home-assistant-best-practices` (homeassistant-ai/skills, MIT, instructions seules) au
sous-projet 2 ; les skills officiels `pdf`/`docx`/`xlsx` (création de documents, licence
propriétaire, besoin du bac à sable) après le socle.

**Personnalité :** consigne système « Alicia » reprise de `pandarvis/brain/persona.py`
(ancienne Alice) puis adaptée : espiègle, complice, en français, concise (une à deux phrases
par défaut).

**Modèle :** Sonnet 5.5 par défaut. Opus 5.5 si le bouton Opus est actif (pour la réponse ou
la conversation) ou si le message contient « réfléchis bien » (détection côté cerveau, avant
la requête).

## App Electron (« bureau »)

**Sécurité Electron :** `contextIsolation`, `sandbox`, pas de `nodeIntegration` ; échanges
interface ↔ processus principal par un pont `preload` minimal, messages validés par Zod.

**Surfaces :**
1. **Fenêtre principale** (maquette v2) : barre du haut intégrée (menu, panneau latéral,
   précédent / suivant, bascule **Chat | Maison**, titre, personne, actions), avec les
   boutons fenêtre natifs de Windows (`titleBarOverlay`) pour garder l'ancrage d'écran.
   Menu des écrans à gauche, contenu au centre.
2. **Holo détaché** : fenêtre transparente, toujours au-dessus, déplaçable, position
   mémorisée ; clic = mini-chat ; reflète l'état d'Alicia (repos, écoute, réflexion, parle,
   succès, alerte, erreur, idée). **Personnage provisoire** en attendant la nouvelle
   mascotte (voir `design/mascotte/BRIEF.md`) : seules les images changeront.
3. **Barre Spotlight** : raccourci global configurable (par défaut `Ctrl+Alt+A`), barre
   centrée par-dessus tout ; Entrée envoie, la barre se referme et la réponse s'affiche en
   notification.
4. **Zone de notification** : ouvrir, afficher / masquer l'Holo, lancer au démarrage,
   quitter. Notifications Windows quand Alicia répond fenêtre cachée.

**Écrans du socle :** Alicia (chat), Souvenirs, Comptes, Réglages. Le menu n'affiche que les
écrans disponibles ; Maison, Énergie, Agenda et Courses arrivent avec le sous-projet 2.

**Chat :** réponse en direct ; ligne d'activité discrète (« Alicia consulte l'agenda… ») ;
cartes de confirmation ; glisser-déposer de fichiers ; bouton Opus ; liste des conversations
dans le menu ; accueil « Bonsoir Kévin, on fait quoi ? » avec suggestions.

**Souvenirs :** lister, chercher, filtrer par portée et type, corriger, déplacer
(commun ↔ perso), épingler, oublier. Une personne voit le commun et les siens.

**Premier lancement :** découverte du cerveau sur le réseau local (mDNS), saisie manuelle de
l'adresse en repli (Tailscale), puis code d'appairage.

**Identité visuelle :** palette « Forêt de nuit » (`#16213E`, `#121A32`, `#1E2A4A`, sauge
`#8FB9A8`, crème `#F3EBDD`, ambre `#D9A45B`) et police Nunito auto-hébergée, reprises de
l'ancienne Alice. Transitions fluides entre états et écrans, jamais de saut sec.

**Distribution :** electron-builder, cible NSIS par utilisateur (sans droits admin) ;
`electron-updater` en fournisseur générique pointant sur le cerveau
(`/updates/`, publique en lecture seule), qui sert les versions publiées.

## Erreurs

| Situation | Comportement |
|---|---|
| Quota de l'abonnement atteint | Alicia passe en état « repos », affiche l'heure de reprise si le SDK la fournit. **Aucune bascule automatique** sur clé API |
| Cerveau injoignable | état « déconnectée » visible, reconnexion automatique avec attente croissante ; message non parti marqué « non envoyé, réessayer » |
| Jeton Google expiré ou révoqué | carte « Reconnecter le compte » |
| Échec d'un outil | Alicia le dit et propose de réessayer ; ne fabrique jamais de résultat |
| Session SDK illisible | nouvelle session, amorcée par un résumé de l'historique en base |
| Pièce jointe illisible ou trop grosse | refus clair avant envoi à Alicia |

**Journal :** pour chaque message, appels d'outils (nom, durée, succès), modèle, tokens
consommés et durée totale, en base. Rotation au-delà de 90 jours.

## Tests

- **Vitest**, développement piloté par les tests.
- **Faux moteur** : une implémentation de l'interface moteur qui rejoue des scénarios
  d'événements SDK. Aucun test automatique ne consomme le quota.
- **Cloisonnement** (critique) : Élodie ne peut ni lire, ni chercher, ni modifier les
  souvenirs ou les mails de Kévin, quels que soient les paramètres envoyés aux outils, et
  inversement.
- **Injection de consignes** : un mail piégé lu par `gmail_lire` ne peut pas déclencher de
  `WebFetch` vers une adresse inconnue sans confirmation ; `agenda_creer` refuse les invités.
- **Protocole** : chaque message et événement passe ses schémas Zod dans les deux sens.
- **Import** : jeu de données Chroma + règles de test, idempotence vérifiée.
- **App Electron** : Playwright (mode Electron) pour les parcours clés (appairage, envoi d'un
  message, confirmation, pièce jointe, Holo). Jamais de clics souris système.
- **Test réel manuel** contre l'abonnement : une commande dédiée vérifie la chaîne complète.

## Déploiement

- **Pi (tests)** : service systemd `alicia-cerveau`, à côté d'`alice-core`, sur un port
  distinct (8780). **Mac mini (cible)** : même code, service launchd.
- **Secrets** (hors dépôt) : jeton d'abonnement ou clé API, clé de chiffrement des jetons
  Google, `google_client_secret.json`.
- **Sauvegarde** : copie nocturne de la base SQLite (API de sauvegarde SQLite), les 14 copies
  les plus récentes conservées.

## Hors périmètre du socle

Home Assistant et l'écran Maison, courses, post-its, scénarios énergie, notifications push,
voix, capacités locales des PC, PWA et kiosk, création de documents (bac à sable), suivi des
limites d'usage dans l'interface, nouvelle mascotte (produite en parallèle hors code).

## Critères de réussite

1. Kévin et Élodie, chacun sur son PC Windows, appairent l'app et discutent avec Alicia
   (Sonnet 5.5 par défaut, Opus à la demande) via l'abonnement.
2. Alicia se souvient d'une conversation à l'autre, sépare commun et perso, et connaît dès le
   premier jour les souvenirs et règles importés de l'ancienne Alice.
3. Elle lit l'agenda Famille et les agendas perso, crée un événement, résume les mails et
   prépare un brouillon, sans jamais envoyer.
4. Elle cherche sur le web, donne la météo, lit une facture PDF, une photo et un fichier
   Excel déposés dans le chat.
5. L'Holo détaché et la barre Spotlight fonctionnent sur les deux PC.
6. Les tests de cloisonnement passent ; aucun test automatique ne consomme le quota.

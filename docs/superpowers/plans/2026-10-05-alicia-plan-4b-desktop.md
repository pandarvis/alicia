# Alicia — Plan 4b : l'app de bureau vit sur le PC (zone de notification, Holo, Spotlight, Réglages, découverte, installateur) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L'app Alicia devient une vraie app Windows : une seule instance, une icône dans la zone de notification, la fenêtre qui se cache au lieu de quitter, des notifications quand Alicia répond fenêtre cachée, l'Holo (la mascotte détachée, toujours au-dessus, avec mini-chat), la barre Spotlight (`Ctrl+Alt+A`), un écran Réglages, la découverte du cerveau sur le réseau (mDNS) et un installateur NSIS par utilisateur mis à jour par le cerveau.

**Architecture:** Le processus principal devient le **moyeu** de l'app : il garde l'**unique** connexion WebSocket au cerveau (`BrainHub`, qui réutilise `ChatConnection`) et la relaie par IPC à toutes les fenêtres (fenêtre principale, Holo, Spotlight), calcule l'**humeur commune** d'Alicia (`Presence`) et décide des notifications (`notificationFor`). Les trois surfaces sont la même page Svelte chargée avec `?surface=main|holo|spotlight` ; le HTTP (conversations, souvenirs) reste dans les pages comme aujourd'hui. Tout ce qui touche le système (raccourci global, lancement au démarrage, icône de zone de notification, notifications) passe par un port `OsIntegration`, remplacé dans les tests par un enregistreur (`RecordingOs`) que l'e2e pilote. Le cerveau s'annonce en `_alicia._tcp` et sert les fichiers de mise à jour sous `/updates/`.

**Tech Stack:** celle du dépôt (TypeScript ~6.0.3 strict, Zod 4, Electron 44 + electron-vite 6 bêta + Vite 8, Svelte 5 runes, Vitest 5, Playwright `_electron`, Fastify 5) + `bonjour-service` 1.4.4 (mDNS, cerveau et app), `@fastify/static` 10.1.5 (cerveau), `electron-builder` 26.17.0 et `electron-updater` 6.8.10 (app).

**Spec :** `docs/superpowers/specs/2026-10-04-alicia-socle-design.md`, sections « App Electron (bureau) » (surfaces 2 à 4, Réglages, premier lancement) et « Distribution ». Plan précédent : `docs/superpowers/plans/2026-10-04-alicia-plan-4a-desktop-shell.md` (sa liste « Reportés au plan 4b » est entièrement couverte ici).

**Point de départ :** branche `feat/hardening` (plan 4a + Souvenirs livrés), **après** le plan de durcissement `docs/superpowers/plans/2026-10-05-alicia-plan-hardening.md` (en cours au moment de l'écriture : événement `heartbeat` dans `ServerEvent`, chien de garde dans `ChatConnection`, origines autorisées, erreurs HTTP typées). Ne pas commencer tant que `git status` montre des changements non commités de ce plan dans `apps/desktop`. Lire le code réel avant chaque tâche : les noms ci-dessous correspondent au code au 2026-10-04 (`ChatConnection`, `ChatStore`, `BrainApi`, `SessionStore`, `isTrustedSenderUrl`, `Shell.svelte`, `Sidebar.svelte`, `PairingScreen.svelte`, `createServer`, `buildApplication`, `FakeEngine`…). En cas d'écart, s'aligner sur le code et le signaler.

---

## Contraintes (à lire avant la tâche 1)

- **TypeScript ultra-strict** (config de base du dépôt : `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`…), **pas d'`any`**, pas d'assertion de type dans `src/`, pas de règle de lint désactivée, pas d'`enum`, pas de propriétés de paramètres, champs privés en `#`. **Zod à chaque frontière** : IPC dans les deux sens (le processus principal valide ce qu'il reçoit, le preload valide ce qu'il reçoit), fichiers sur disque, variables d'environnement de test, mDNS. `svelte-check --fail-on-warnings`.
- **Code, identifiants, commentaires, noms de tests et commits en anglais ; textes affichés en français.**
- Imports relatifs avec extension `.ts` ; composants en `.svelte`.
- **Sécurité Electron inchangée** : `sandbox`, `contextIsolation`, pas de `nodeIntegration`, preload CommonJS minimal, **chaque handler IPC vérifie l'expéditeur** (`isTrustedSenderUrl`, qui compare le chemin de la page et ignore donc `?surface=`), et les handlers propres à une surface vérifient en plus quelle fenêtre parle.
- **Ne jamais toucher** `apps/brain/.env`, `apps/brain/alicia.config.yaml`, `apps/brain/data/`, ni `C:\Sources\alice`. **Le vrai cerveau de Kévin tourne sur le port 8780** : aucun test ne l'utilise, les cerveaux de test écoutent sur le port 0.
- **Aucun effet de bord système depuis les tests** : l'e2e lance l'app avec un profil temporaire (`ALICIA_USER_DATA`) **et** `ALICIA_OS_INTEGRATION=off` (pris en compte seulement hors app installée) : pas de raccourci global, pas d'entrée de démarrage, pas d'icône de zone de notification, pas de notification Windows, pas de mDNS. Un enregistreur prend leur place et l'e2e le lit par `globalThis.__aliciaTest`. Même en développement, l'entrée « lancer au démarrage » n'est écrite que par l'app **installée** (`app.isPackaged`).
- **Commits** : petits, en anglais, terminés par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Jamais `git add -A` ni `git add .`** : chemins explicites. **Commit seulement si** `pnpm test`, `pnpm typecheck`, `pnpm lint` **et** `pnpm --filter @alicia/desktop test:e2e` sont verts. Ne pas changer de branche, ne pas utiliser `git stash` ni `git checkout`.
- **Dépendances** : dernière version stable, en respectant le `minimumReleaseAge` de pnpm (par défaut, une version publiée depuis moins d'un jour est refusée) : **ne jamais ajouter `minimumReleaseAgeExclude`** ; si la plus récente est trop fraîche, prendre la précédente. Vérifier avec `npm view <paquet> version time --json` juste avant d'installer (versions relevées le 2026-10-04 : voir « Décisions »).
- **Fins de ligne** : `core.autocrlf=true`, les fichiers existants sont en CRLF sur le disque. Les modifier avec l'outil d'édition (qui garde les fins de ligne). Pour une réécriture complète d'un fichier existant, reconvertir ensuite en CRLF :
  `node -e "const f=process.argv[1],fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))" <fichier>`.
  Vérifier avant chaque commit : `git diff --stat` ne doit pas montrer un fichier entièrement réécrit sans raison.
- **Transitions fluides partout** (règle de Kévin) : apparition/disparition de l'Holo, du mini-chat, de la barre Spotlight, des écrans et des listes en fondu/glissement court via `motion()` de `lib/motion.ts` (qui respecte `prefers-reduced-motion`), changements d'humeur de la mascotte en fondu enchaîné (déjà fait par `Mascot.svelte`). Jamais de saut sec : une fenêtre transparente s'agrandit **avant** que son contenu n'apparaisse, et ne rétrécit **qu'après** la fin de l'animation de sortie.
- **Jamais de clic souris système** dans les tests : uniquement Playwright (`locator.click()`, `keyboard.press()`, événements CDP dans la page) et les crochets de test du processus principal.
- Toutes les commandes depuis `C:\Sources\alicia` (Git Bash), sauf mention contraire.

## Décisions de conception (et alternatives écartées)

1. **Une seule connexion WebSocket, dans le processus principal, relayée par IPC** (`BrainHub`). Le processus principal possède déjà la session (chiffrée par `safeStorage`) ; il ouvre la connexion avec le même code testé (`ChatConnection`, déplacé dans `src/shared/`, WebSocket natif de Node 24 dans Electron 44) et diffuse chaque `ServerEvent` (validé par Zod à la réception, puis revalidé par le preload) et chaque changement d'état à toutes les fenêtres. Les fenêtres envoient leurs messages par `brain:send` ; le principal sait de quelle fenêtre ils viennent (pour la notification) et voit **tous** les tours du PC (pour l'humeur de l'Holo).
   *Écartée : une connexion par fenêtre avec le même jeton.* Le cerveau n'envoie les événements d'un tour qu'à la connexion qui l'a demandé : l'Holo ne pourrait pas refléter une réponse en cours dans la fenêtre principale sans changer le cerveau, la logique de notification vivrait dans des pages cachées (minuteurs ralentis par Chromium), la barre Spotlight devrait rester vivante pour attendre la réponse, et le PC ouvrirait trois connexions.
   *Origine et vie de la connexion :* le WebSocket de Node (processus principal) n'envoie **pas** d'en-tête `Origin` (vérifié le 2026-10-04 avec le Node 24.21 d'Electron 44) : le cerveau l'accepte comme un client natif (`isAppOrigin(undefined)`, comme la commande `chat`), sans rien changer à sa liste d'origines. Le chien de garde du battement de cœur (`heartbeat`, plan de durcissement) part avec `ChatConnection` dans le processus principal, où les minuteurs ne sont pas ralentis comme dans une fenêtre cachée.
   *Conséquence assumée :* le cerveau ne traite **qu'un tour à la fois par connexion** ; un deuxième envoi pendant une réponse reçoit l'erreur `busy` (« Alicia répond déjà… »), affichée dans la fenêtre concernée ou en notification pour Spotlight. Pour une assistante familiale, c'est le comportement attendu (une seule Alicia par PC).
2. **Le HTTP reste dans les pages** (`BrainApi`, inchangé) : déplacer tout le HTTP dans le principal permettrait que le jeton ne quitte jamais le principal, mais c'est une refonte de tous les écrans hors sujet ici. Le jeton reste donc lisible par nos pages, comme dans le plan 4a.
3. **Une seule page, trois surfaces** (`index.html?surface=…`, `main.ts` monte `App`, `HoloApp` ou `SpotlightApp`). *Écartée : trois entrées HTML* (trois CSP, trois chemins de confiance pour `isTrustedSenderUrl`, plus de configuration Vite) pour un gain de poids négligeable sur PC.
4. **Réglages** : la déconnexion de l'appareil **déménage** dans Réglages (section « Appareil », à côté de l'adresse et du nom de l'appareil qu'elle concerne) ; le pied du menu garde seulement le nom de la personne. *Écarté : garder les deux* (deux confirmations identiques à maintenir, action destructrice trop exposée).
5. **Holo** : déplacement **à la main** par événements pointeur (seuil de 4 px entre clic et glisser ; la page signale seulement que le pointeur a bougé, le principal lit lui-même la position du pointeur sur le bureau (`screen.getCursorScreenPoint()`) depuis le début du geste — juste aussi entre deux écrans d'échelles différentes, décision de la revue des tâches 9–10 —, déplace la fenêtre et la garde dans l'écran). *Écarté : `-webkit-app-region: drag`*, qui avale les clics sous Windows (le clic doit ouvrir le mini-chat). Le mini-chat a **sa propre conversation**, gardée tant que l'app tourne, avec « Ouvrir dans l'app » et « Nouvelle conversation ». La fenêtre de l'Holo s'agrandit d'un côté (gauche si la place le permet) en gardant la mascotte exactement au même endroit de l'écran. Limite connue : la zone transparente de la fenêtre agrandie capte les clics (pas de clic traversant en v1).
6. **Spotlight** : chaque envoi ouvre une **nouvelle conversation** ; la barre se referme dès que le principal a accepté le message ; la réponse arrive en notification Windows dont le clic ouvre la fenêtre principale **sur cette conversation**. La barre se referme aussi sur Échap et en perdant le focus. Elle est créée cachée au démarrage pour s'ouvrir instantanément.
7. **Notifications** : quand le tour vient de Spotlight (toujours), de la fenêtre principale cachée, réduite **ou au second plan** (pas au premier plan : `isVisible() && !isMinimized() && isFocused()`, décision de la revue des tâches 4–6 : une réponse arrivée derrière une autre application passerait inaperçue), ou du mini-chat de l'Holo refermé. Réponse : titre « Alicia », texte de la réponse sans Markdown (seulement les marques appariées, celles de début de ligne et les liens `[texte](url)` → texte), coupé à 180 caractères lus (graphèmes : jamais un emoji coupé en deux). Échec : « Alicia n'a pas pu répondre » + le message du cerveau. Un changement demandé depuis le menu de la zone de notification qui ne peut pas être enregistré le dit aussi par une notification (« Impossible d'enregistrer ce réglage pour l'instant. »).
8. **Réglages sur disque** : `settings.json` en clair dans le profil (rien de secret), validé par Zod **champ par champ** (`.catch`) : un champ abîmé reprend sa valeur par défaut sans effacer les autres. *Écarté : `electron-store`* (une dépendance pour trente lignes, alors que `SessionStore` donne déjà le modèle d'écriture atomique). Valeurs par défaut : raccourci `Ctrl+Alt+A`, lancement au démarrage **désactivé** (rien ne s'inscrit dans Windows sans l'accord explicite de la personne), Holo **affiché** (c'est la surface que Kévin a demandée).
9. **Lancement au démarrage** : entrée de connexion par utilisateur (`app.setLoginItemSettings`, clé `HKCU\…\Run`) avec l'argument `--hidden` (l'app démarre dans la zone de notification, sans ouvrir la fenêtre), **seulement dans l'app installée**.
10. **Raccourci configurable** : capture au clavier dans Réglages. Pour ne jamais voler la frappe ordinaire ni une commande de fenêtre (règles fixées à la revue des tâches 1–3, voir `src/shared/accelerator.ts`) : une lettre, un chiffre ou Espace demande **deux** modificateurs (Ctrl, Alt, Maj) **ou** la touche Windows ; F1–F12 demandent Ctrl, Alt ou Windows (Maj+F10 est le menu contextuel) ; F13–F24 peuvent servir seules ; `Alt+F4` et `Alt+Space` sont refusés. La lettre est lue sur la touche tapée (un A AZERTY reste A), avec repli sur la touche physique pour les chiffres de la rangée du haut (& é "…) ; le pavé numérique donne `num0`–`num9`. Quand Ctrl+Alt (AltGr) tape un caractère (€, @…), la combinaison est **refusée** (« Cette combinaison tape un caractère sur ce clavier. ») au lieu de prendre la touche physique : elle volerait ce caractère. La capture renvoie la raison du refus (`captureShortcut`), affichée en français (`SHORTCUT_REFUSAL_MESSAGES`). Un raccourci déjà pris par une autre application est refusé avec une explication, l'ancien reste actif. Un changement de réglages est **tout ou rien** : si l'enregistrement sur disque échoue (`save_failed`), le nouveau raccourci est libéré et rien ne change.
11. **mDNS** : le cerveau s'annonce (`bonjour-service`) en `_alicia._tcp`, nom « Alicia sur <machine> », TXT `version` ; pas d'annonce quand il n'écoute que sur la boucle locale, et `discovery: false` dans sa config pour couper. L'app **ne cherche que sur l'écran d'appairage** (et ouvre le socket mDNS à ce moment-là seulement, ce qui limite l'éventuelle question du pare-feu Windows au premier lancement) ; un seul cerveau trouvé remplit l'adresse tout seul ; la saisie manuelle reste (Tailscale). Dans les tests, `ALICIA_TEST_BRAINS` (JSON validé, seulement avec `ALICIA_OS_INTEGRATION=off`) remplace le réseau. *Revue des tâches 11–13 :* `bonjour-service` n'écoute pas l'`error` de son socket multicast-dns (port 5353 déjà pris, accès refusé) : sans écouteur, Node lève l'erreur et le cerveau s'arrête (l'app affiche une boîte d'erreur). Le cerveau et l'app branchent donc `guardSocketErrors(bonjour, onError)` (atteint `bonjour.server.mdns` par `Reflect.get`, vérifié à l'exécution) : une annonce ou une recherche impossible est journalisée, jamais fatale. Le nom annoncé perd `.local` et tout domaine ; l'app compte un cerveau par nom et par adresse, suit `srv-update`, fait expirer les absents et ne cherche pas pendant que la fenêtre principale est cachée. *Revue finale :* l'expiration de `bonjour-service` ne voit jamais partir un cerveau (elle ne rafraîchit pas un service connu et l'enregistrement PTR vit 8 heures) : l'app recrée donc le navigateur mDNS toutes les trois requêtes (12 s), note quand chaque cerveau a répondu pour la dernière fois (`LastSeen`) et retire ceux qui se taisent depuis 30 s ; à la reprise (fenêtre de nouveau affichée), la liste repart vide.
12. **Mises à jour** : route `/updates/` (la spec disait `/mises-a-jour/` ; le code est en anglais) qui sert les fichiers de `<dataDir>/updates/` en lecture seule, **sans jeton** : un installateur ne contient aucun secret, le cerveau n'est joignable que par le réseau de la maison ou Tailscale, et c'est ce qui permet le **premier** téléchargement depuis un navigateur (`http://<cerveau>:8780/updates/Alicia-Setup-0.1.0.exe`) avant tout appairage. Pas de listage, pas de fichiers cachés, `latest.yml` jamais mis en cache. *Écarté : exiger le jeton d'appareil* (casse le premier téléchargement, et `electron-updater` le supporte mal pour un flux générique). Sans signature de code, `electron-updater` vérifie seulement l'empreinte SHA-512 annoncée par `latest.yml` (servi par le même cerveau) : risque accepté pour un usage familial sur réseau privé.
13. **Installateur** : `electron-builder`, cible NSIS « en un clic » **par utilisateur** (`%LOCALAPPDATA%\Programs\Alicia`, sans droits admin), icône `build/icon.ico`, pas de signature de code. Dans l'app installée, le nom d'app devient « Alicia » (`extraMetadata`) : son profil (`%APPDATA%\Alicia`) et son verrou d'instance unique sont distincts de ceux du développement (`@alicia/desktop`). L'adresse de mise à jour est fixée à l'exécution (`setFeedURL`) sur le cerveau appairé.
14. **Versions retenues** (vérifiées le 2026-10-04 avec `npm view`, toutes publiées depuis plus d'une semaine) : `electron-builder@26.17.0` et `electron-updater@6.8.10` — les plus récentes stables ; l'étiquette npm `latest` est restée sur 26.15.3 / 6.8.9, la ligne 26 est publiée sous l'étiquette `v26`, d'où l'installation par numéro exact ; `bonjour-service@1.4.4` ; `@fastify/static@10.1.5`. *Écartées : les 27.0.0-alpha / 7.0.0-alpha* (préversions, inutiles ici).

## Structure des fichiers

```
apps/desktop/
├─ package.json                 + version, author, description, script dist, dépendances
├─ electron-builder.yml         (nouveau) NSIS par utilisateur, publication générique
├─ src/shared/                  code commun au principal, au preload et aux pages
│  ├─ mascot.ts                 (déplacé de renderer/lib) états + schéma + humeur sur erreur
│  ├─ chat-connection.ts        (déplacé de renderer/lib) ChatConnection, ConnectionStatus, webSocketUrl
│  ├─ surface.ts                surfaces main | holo | spotlight
│  ├─ holo.ts                   Point, DragDelta, HoloView
│  ├─ accelerator.ts            raccourcis : validation, capture clavier
│  ├─ settings.ts               Settings, SettingsPatch, SettingsSnapshot, SettingsUpdateResult
│  ├─ discovery.ts              DiscoveredBrain
│  ├─ updates.ts                UpdateStatus
│  ├─ bridge.ts                 contrat du pont window.alicia + noms des canaux IPC
│  └─ session.ts                (allégé) StoredSession, SaveSessionResult
├─ src/main/
│  ├─ index.ts                  assemblage : instance unique, stores, moyeu, fenêtres, IPC
│  ├─ windows.ts                WindowManager : principale, Holo, Spotlight
│  ├─ ipc.ts                    tous les handlers, expéditeur vérifié, entrées validées
│  ├─ brain-hub.ts              l'unique connexion au cerveau, suivi des tours
│  ├─ presence.ts               humeur commune d'Alicia
│  ├─ turn-notifications.ts     quand et quoi notifier
│  ├─ layout.ts                 géométrie de l'Holo et de Spotlight
│  ├─ settings-store.ts         settings.json
│  ├─ settings-controller.ts    applique les réglages (raccourci, démarrage)
│  ├─ tray-menu.ts              menu de la zone de notification (pur)
│  ├─ os-integration.ts         port vers le système
│  ├─ electron-os.ts            implémentation Electron du port
│  ├─ recording-os.ts           implémentation enregistreuse + crochets de test
│  ├─ discovery.ts              navigation mDNS
│  ├─ updater.ts                mises à jour automatiques
│  ├─ session-store.ts, trusted-sender.ts   (inchangés)
├─ src/preload/index.ts         pont complet, tout ce qui arrive est validé
└─ src/renderer/src/
   ├─ main.ts                   monte la bonne surface
   ├─ App.svelte                (fenêtre principale) suit les changements de session
   ├─ HoloApp.svelte            (nouveau) l'Holo
   ├─ SpotlightApp.svelte       (nouveau) la barre
   ├─ lib/hub-client.ts         miroir de la connexion du principal
   ├─ lib/mirror.ts             état initial + poussées, sans course
   ├─ lib/drag.ts               clic ou glisser
   ├─ lib/mini-chat.svelte.ts   conversation du mini-chat
   ├─ lib/settings-screen.svelte.ts  état de l'écran Réglages
   └─ components/HoloChat.svelte, SettingsView.svelte (nouveaux) ; Shell, Sidebar, Composer, PairingScreen (modifiés)
apps/brain/src/
├─ discovery.ts                 (nouveau) annonce mDNS
├─ config.ts, cli.ts            option discovery, annonce au démarrage
├─ server/server.ts             route /updates/
└─ application.ts               dossier <dataDir>/updates
apps/desktop/e2e/support.ts     (nouveau) outils partagés de l'e2e ; desktop.e2e.ts (nouveau)
```

---

### Task 1: Modules partagés (mascotte, connexion, surfaces)

Le processus principal va utiliser `ChatConnection` et les états de la mascotte : on les sort de `renderer/` sans changer leur comportement.

**Files:**
- Move: `apps/desktop/src/renderer/src/lib/mascot.ts` → `apps/desktop/src/shared/mascot.ts`
- Move: `apps/desktop/src/renderer/src/lib/chat-connection.ts` → `apps/desktop/src/shared/chat-connection.ts`
- Create: `apps/desktop/src/shared/surface.ts`, `apps/desktop/test/surface.test.ts`
- Modify: `apps/desktop/src/renderer/src/lib/brain-client.ts`, `apps/desktop/src/renderer/src/lib/chat-store.svelte.ts`, `apps/desktop/src/renderer/src/lib/mascot-images.ts`, `apps/desktop/src/renderer/src/components/{Mascot,Composer,TitleBar,Shell}.svelte`, `apps/desktop/scripts/export-mascot.ts`
- Test: `apps/desktop/test/mascot.test.ts`, `apps/desktop/test/chat-connection.test.ts`, `apps/desktop/test/brain-client.test.ts`

- [ ] **Step 1: Déplacer les deux modules**

```bash
git mv apps/desktop/src/renderer/src/lib/mascot.ts apps/desktop/src/shared/mascot.ts
git mv apps/desktop/src/renderer/src/lib/chat-connection.ts apps/desktop/src/shared/chat-connection.ts
```

- [ ] **Step 2: Écrire les tests (ils échouent)**

`apps/desktop/test/surface.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { parseSurface } from "../src/shared/surface.ts";

describe("parseSurface", () => {
  test("known surfaces", () => {
    expect(parseSurface("main")).toBe("main");
    expect(parseSurface("holo")).toBe("holo");
    expect(parseSurface("spotlight")).toBe("spotlight");
  });

  test("anything else is the main window", () => {
    expect(parseSurface(null)).toBe("main");
    expect(parseSurface("")).toBe("main");
    expect(parseSurface("evil")).toBe("main");
  });
});
```

`apps/desktop/test/mascot.test.ts` (remplacer le fichier) :
```ts
import { describe, expect, test } from "vitest";
import { MASCOT_ON_ERROR, MASCOT_SOURCE_FILES, MASCOT_STATES, MascotState } from "../src/shared/mascot.ts";

describe("mascot", () => {
  test("nine states, each mapped to a validated source image", () => {
    expect(MASCOT_STATES).toHaveLength(9);
    expect(Object.keys(MASCOT_SOURCE_FILES).sort()).toEqual([...MASCOT_STATES].sort());
    expect(MASCOT_SOURCE_FILES.idle).toBe("neutre");
    expect(MASCOT_SOURCE_FILES.speaking).toBe("parle");
  });

  test("states are validated at boundaries", () => {
    expect(MascotState.safeParse("idea").success).toBe(true);
    expect(MascotState.safeParse("dancing").success).toBe(false);
  });

  test("mood on a failed turn", () => {
    expect(MASCOT_ON_ERROR.quota).toBe("sleeping");
    expect(MASCOT_ON_ERROR.engine).toBe("error");
    expect(MASCOT_ON_ERROR.unauthenticated).toBeUndefined();
  });
});
```

Dans `apps/desktop/test/chat-connection.test.ts`, remplacer l'import par :
```ts
import {
  ChatConnection, ConnectionStatus, type SocketLike, webSocketUrl,
} from "../src/shared/chat-connection.ts";
```
et ajouter à la fin du fichier :
```ts
describe("webSocketUrl", () => {
  test("derives the WebSocket URL", () => {
    expect(webSocketUrl("http://127.0.0.1:8780")).toBe("ws://127.0.0.1:8780/ws");
    expect(webSocketUrl("https://alicia.ts.net")).toBe("wss://alicia.ts.net/ws");
    expect(webSocketUrl("https://host/alicia")).toBe("wss://host/alicia/ws");
  });
});

describe("ConnectionStatus", () => {
  test("the four states, validated at boundaries", () => {
    expect(ConnectionStatus.options).toEqual(["connecting", "ready", "offline", "rejected"]);
    expect(ConnectionStatus.safeParse("lost").success).toBe(false);
  });
});
```
Les autres usages de `ConnectionStatus` dans ce fichier sont des positions de type (`const statuses: ConnectionStatus[]`) : ils restent valides.

Dans `apps/desktop/test/brain-client.test.ts`, retirer `webSocketUrl` de l'import et supprimer le test `"derives the WebSocket URL"` (il vit maintenant dans `chat-connection.test.ts`).

- [ ] **Step 3: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/desktop test`
Expected: FAIL (`src/shared/surface.ts` introuvable, `MascotState`/`MASCOT_ON_ERROR`/`webSocketUrl`/`ConnectionStatus` non exportés).

- [ ] **Step 4: Implémenter**

`apps/desktop/src/shared/surface.ts` :
```ts
import { z } from "zod";

/** The three pages of the app: the main window, the detached Holo and the Spotlight bar. */
export const Surface = z.enum(["main", "holo", "spotlight"]);
export type Surface = z.infer<typeof Surface>;

/** The surface named by the page URL (`?surface=`); anything unknown is the main window. */
export function parseSurface(raw: string | null): Surface {
  const parsed = Surface.safeParse(raw);
  return parsed.success ? parsed.data : "main";
}
```

`apps/desktop/src/shared/mascot.ts` : remplacer le début du fichier jusqu'à `export type MascotState…` inclus par
```ts
import type { ErrorCode } from "@alicia/protocol";
import { z } from "zod";

/** Alicia's moods, one per validated paper-cut pose (design/mascotte/BRIEF.md). */
export const MASCOT_STATES = [
  "idle", "sleeping", "listening", "thinking", "speaking", "success", "alert", "error", "idea",
] as const;
export const MascotState = z.enum(MASCOT_STATES);
export type MascotState = z.infer<typeof MascotState>;
```
et ajouter à la fin :
```ts
/** Mood after a failed turn, by brain error code (any other code: alert). */
export const MASCOT_ON_ERROR: Readonly<Partial<Record<ErrorCode, MascotState>>> = {
  quota: "sleeping",
  busy: "alert",
  engine: "error",
  internal: "error",
};
```

`apps/desktop/src/shared/chat-connection.ts` :
- remplacer `import { type SendMessage, ServerEvent } from "@alicia/protocol";` et la ligne `export type ConnectionStatus = …` par :
```ts
import { type SendMessage, ServerEvent } from "@alicia/protocol";
import { z } from "zod";

export const ConnectionStatus = z.enum(["connecting", "ready", "offline", "rejected"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;
```
- renommer `browserSocket` en `openWebSocket` et remplacer son commentaire par `/** Adapter from the standard WebSocket (renderer pages, and Electron's main process on Node 24) to SocketLike. */` ;
- ajouter, juste après l'adaptateur, la fonction retirée de `brain-client.ts` :
```ts
/** Takes an already-normalized server URL. */
export function webSocketUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/i, "ws")}/ws`;
}
```

`apps/desktop/src/renderer/src/lib/brain-client.ts` : supprimer la fonction `webSocketUrl` (et son commentaire).

`apps/desktop/src/renderer/src/lib/chat-store.svelte.ts` : supprimer la constante locale `MASCOT_ON_ERROR`, retirer `ErrorCode` de l'import de `@alicia/protocol` s'il n'y sert plus, et remplacer `import type { MascotState } from "./mascot.ts";` par
```ts
import { MASCOT_ON_ERROR, type MascotState } from "../../../shared/mascot.ts";
```

Imports à mettre à jour (même contenu, nouveau chemin) :
- `lib/mascot-images.ts` : `import type { MascotState } from "../../../shared/mascot.ts";`
- `components/Mascot.svelte` : `import { MASCOT_STATES, type MascotState } from "../../../shared/mascot.ts";`
- `components/Composer.svelte` et `components/TitleBar.svelte` : `import type { ConnectionStatus } from "../../../shared/chat-connection.ts";`
- `components/Shell.svelte` : `import { BrainApi, UnauthorizedError } from "../lib/brain-client.ts";` et `import { ChatConnection, type ConnectionStatus, openWebSocket, webSocketUrl } from "../../../shared/chat-connection.ts";`, puis `openSocket: openWebSocket,` dans la création de `ChatConnection`.
- `scripts/export-mascot.ts` : `import { MASCOT_SOURCE_FILES, MASCOT_STATES } from "../src/shared/mascot.ts";`

- [ ] **Step 5: Vérifier**

Run: `pnpm --filter @alicia/desktop test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout PASS (comportement inchangé).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/mascot.ts apps/desktop/src/shared/chat-connection.ts apps/desktop/src/shared/surface.ts apps/desktop/src/renderer/src/lib/mascot.ts apps/desktop/src/renderer/src/lib/chat-connection.ts apps/desktop/src/renderer/src/lib/brain-client.ts apps/desktop/src/renderer/src/lib/chat-store.svelte.ts apps/desktop/src/renderer/src/lib/mascot-images.ts apps/desktop/src/renderer/src/components/Mascot.svelte apps/desktop/src/renderer/src/components/Composer.svelte apps/desktop/src/renderer/src/components/TitleBar.svelte apps/desktop/src/renderer/src/components/Shell.svelte apps/desktop/scripts/export-mascot.ts apps/desktop/test/surface.test.ts apps/desktop/test/mascot.test.ts apps/desktop/test/chat-connection.test.ts apps/desktop/test/brain-client.test.ts
git commit -m "refactor(desktop): share mascot states and the chat connection with the main process

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Réglages — schéma, raccourci clavier, fichier

> **Revue (commit `fix(desktop): 4b review — safe settings updates, keyboard-safe shortcuts`) :** les règles du raccourci ci-dessous ont été durcies (décision 10) ; `captureShortcut`/`SHORTCUT_REFUSAL_MESSAGES` s'ajoutent à `acceleratorFromKey` ; `SettingsSnapshot` est strict (`StrictSettings`, sans `.catch`) pour le sens principal → fenêtres ; `SettingsUpdateResult.reason` gagne `save_failed`, avec les messages français dans `SETTINGS_UPDATE_MESSAGES` ; `SettingsStore` réessaie le renommage (3 fois sur EPERM/EBUSY/EACCES). Le code réel fait foi ; les blocs de cette tâche sont l'état initial.

**Files:**
- Create: `apps/desktop/src/shared/holo.ts`, `apps/desktop/src/shared/accelerator.ts`, `apps/desktop/src/shared/settings.ts`, `apps/desktop/src/main/settings-store.ts`
- Test: `apps/desktop/test/accelerator.test.ts`, `apps/desktop/test/settings-store.test.ts`

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/accelerator.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { acceleratorFromKey, isValidAccelerator, type KeyLike } from "../src/shared/accelerator.ts";

function press(key: string, code: string, modifiers: Partial<KeyLike> = {}): KeyLike {
  return { key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
}

describe("isValidAccelerator", () => {
  test("modifier + key, in canonical order", () => {
    for (const accelerator of ["Ctrl+Alt+A", "Ctrl+Shift+K", "Alt+Space", "Super+1", "F9", "Shift+F12", "Ctrl+Alt+Shift+Super+Z"]) {
      expect(isValidAccelerator(accelerator)).toBe(true);
    }
  });

  test("refuses a bare key, Shift alone, unknown keys, duplicates and odd order", () => {
    for (const accelerator of ["A", "Shift+A", "Ctrl+", "Ctrl+Alt", "Ctrl+Ctrl+A", "Alt+Ctrl+A", "Ctrl+Enter", "Cmd+A", "", "Ctrl+a", "F25"]) {
      expect(isValidAccelerator(accelerator)).toBe(false);
    }
  });
});

describe("acceleratorFromKey", () => {
  test("the letter comes from the typed key, so an AZERTY A stays A", () => {
    expect(acceleratorFromKey(press("a", "KeyQ", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+A");
    expect(acceleratorFromKey(press("K", "KeyK", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+K");
  });

  test("falls back to the physical key when Ctrl+Alt (AltGr) types a symbol", () => {
    expect(acceleratorFromKey(press("€", "KeyE", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+E");
  });

  test("digits of the AZERTY top row, function keys, space", () => {
    expect(acceleratorFromKey(press("&", "Digit1", { ctrlKey: true }))).toBe("Ctrl+1");
    expect(acceleratorFromKey(press("F9", "F9"))).toBe("F9");
    expect(acceleratorFromKey(press(" ", "Space", { altKey: true }))).toBe("Alt+Space");
  });

  test("null when the combination is not usable", () => {
    expect(acceleratorFromKey(press("K", "KeyK", { shiftKey: true }))).toBeNull();
    expect(acceleratorFromKey(press("k", "KeyK"))).toBeNull();
    expect(acceleratorFromKey(press("Enter", "Enter", { ctrlKey: true }))).toBeNull();
    expect(acceleratorFromKey(press("Control", "ControlLeft", { ctrlKey: true }))).toBeNull();
  });
});
```

`apps/desktop/test/settings-store.test.ts` :
```ts
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsStore } from "../src/main/settings-store.ts";
import { SettingsPatch } from "../src/shared/settings.ts";

const DEFAULTS = { shortcut: "Ctrl+Alt+A", launchAtStartup: false, showHolo: true, holoAnchor: null };
const dirs: string[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "alicia-settings-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  return { dir, path, store: new SettingsStore(path) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  test("no file yet: the defaults", () => {
    expect(setup().store.load()).toEqual(DEFAULTS);
  });

  test("saves and loads back, leaving no temporary file", () => {
    const { dir, store } = setup();
    const settings = { shortcut: "Ctrl+Shift+K", launchAtStartup: true, showHolo: false, holoAnchor: { x: -1200, y: 40 } };
    store.save(settings);
    expect(store.load()).toEqual(settings);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  test("a broken field falls back to its default, the others are kept", () => {
    const { path, store } = setup();
    writeFileSync(path, JSON.stringify({ shortcut: "Ctrl+Hyper+A", launchAtStartup: true, showHolo: "yes", holoAnchor: { x: 10, y: 20 } }));
    expect(store.load()).toEqual({ shortcut: "Ctrl+Alt+A", launchAtStartup: true, showHolo: true, holoAnchor: { x: 10, y: 20 } });
  });

  test("unreadable JSON, or JSON that is not an object: the defaults", () => {
    const { path, store } = setup();
    writeFileSync(path, "{ not json");
    expect(store.load()).toEqual(DEFAULTS);
    writeFileSync(path, "[1, 2]");
    expect(store.load()).toEqual(DEFAULTS);
  });
});

describe("SettingsPatch", () => {
  test("only the three settings a window may change, each validated", () => {
    expect(SettingsPatch.safeParse({ showHolo: false }).success).toBe(true);
    expect(SettingsPatch.safeParse({ shortcut: "Ctrl+Shift+K", launchAtStartup: true }).success).toBe(true);
    expect(SettingsPatch.safeParse({ shortcut: "A" }).success).toBe(false);
    expect(SettingsPatch.safeParse({ holoAnchor: { x: 1, y: 1 } }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/desktop test -- accelerator settings-store`
Expected: FAIL (modules introuvables).

- [ ] **Step 3: Implémenter**

`apps/desktop/src/shared/holo.ts` :
```ts
import { z } from "zod";

const coordinate = z.number().int().min(-100_000).max(100_000);

/** A point on the desktop, in Electron screen coordinates (DIP). */
export const Point = z.object({ x: coordinate, y: coordinate });
export type Point = z.infer<typeof Point>;

/** How far the pointer moved since a Holo drag started (screen DIP). */
export const DragDelta = z.object({
  dx: z.number().finite().min(-100_000).max(100_000),
  dy: z.number().finite().min(-100_000).max(100_000),
});
export type DragDelta = z.infer<typeof DragDelta>;

export const PanelSide = z.enum(["left", "right"]);
export type PanelSide = z.infer<typeof PanelSide>;

/** What the Holo page needs to lay itself out: mini-chat open or not, on which side, where the mascot sits. */
export const HoloView = z.object({ expanded: z.boolean(), panelSide: PanelSide, mascot: Point });
export type HoloView = z.infer<typeof HoloView>;
```

`apps/desktop/src/shared/accelerator.ts` :
```ts
/** Global shortcut used when none was chosen (spec: Ctrl+Alt+A). */
export const DEFAULT_SHORTCUT = "Ctrl+Alt+A";

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Super"] as const;
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
const KEY = /^(?:[A-Z]|[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space)$/;

function isModifier(part: string): boolean {
  return MODIFIERS.some((modifier) => modifier === part);
}

/**
 * An Electron accelerator we accept: modifiers in canonical order (Ctrl, Alt, Shift, Super) then one key
 * (A–Z, 0–9, F1–F24, Space). Ctrl, Alt or Super is required, except for function keys: Shift+letter would
 * steal ordinary typing.
 */
export function isValidAccelerator(value: string): boolean {
  const parts = value.split("+");
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (key === undefined || !KEY.test(key)) return false;
  if (!modifiers.every(isModifier)) return false;
  const canonical = MODIFIERS.filter((modifier) => modifiers.includes(modifier));
  if (canonical.join("+") !== modifiers.join("+")) return false;
  return FUNCTION_KEY.test(key) || modifiers.some((modifier) => modifier !== "Shift");
}

/** The parts of a keydown event used to capture a shortcut. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Letters and digits from the typed key (layout-aware); the physical key when Ctrl+Alt (AltGr) typed a symbol. */
function keyName(key: string, code: string): string | null {
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return letter;
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit !== undefined) return digit;
  if (FUNCTION_KEY.test(code)) return code;
  return code === "Space" ? "Space" : null;
}

/** The accelerator for a key press, or null when it cannot be a shortcut. */
export function acceleratorFromKey(event: KeyLike): string | null {
  const key = keyName(event.key, event.code);
  if (key === null) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Super");
  const accelerator = [...modifiers, key].join("+");
  return isValidAccelerator(accelerator) ? accelerator : null;
}
```

`apps/desktop/src/shared/settings.ts` :
```ts
import { z } from "zod";
import { DEFAULT_SHORTCUT, isValidAccelerator } from "./accelerator.ts";
import { Point } from "./holo.ts";

export const Accelerator = z.string().max(60).refine(isValidAccelerator, "Invalid shortcut");

/** The app's settings (settings.json). Each field falls back to its default on its own when unreadable. */
export const Settings = z.object({
  shortcut: Accelerator.catch(DEFAULT_SHORTCUT),
  launchAtStartup: z.boolean().catch(false),
  showHolo: z.boolean().catch(true),
  /** Top-left corner of the collapsed Holo window; null until the Holo was moved. */
  holoAnchor: Point.nullable().catch(null),
});
export type Settings = z.infer<typeof Settings>;

/** What a window may change (the Holo position only changes by dragging the Holo). */
export const SettingsPatch = z.strictObject({
  shortcut: Accelerator.optional(),
  launchAtStartup: z.boolean().optional(),
  showHolo: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** The settings, and whether the shortcut is really registered (another app may hold it). */
export const SettingsSnapshot = z.object({ settings: Settings, shortcutActive: z.boolean() });
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;

export const SettingsUpdateResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), snapshot: SettingsSnapshot }),
  z.object({ ok: z.literal(false), reason: z.enum(["invalid", "shortcut_unavailable"]), snapshot: SettingsSnapshot }),
]);
export type SettingsUpdateResult = z.infer<typeof SettingsUpdateResult>;
```

`apps/desktop/src/main/settings-store.ts` :
```ts
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Settings } from "../shared/settings.ts";

/** settings.json in the profile: plain JSON (nothing secret), validated field by field. */
export class SettingsStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  load(): Settings {
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch {
      // Missing or unreadable file: every field takes its default.
    }
    // Only an object can hold settings; anything else (a string, a list…) counts as empty.
    return Settings.parse(typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {});
  }

  save(settings: Settings): void {
    // Write then rename, so a crash never leaves a half-written file.
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(Settings.parse(settings), null, 2));
    renameSync(temporary, this.#path);
  }
}
```

- [ ] **Step 4: Vérifier**

Run: `pnpm --filter @alicia/desktop test -- accelerator settings-store && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/holo.ts apps/desktop/src/shared/accelerator.ts apps/desktop/src/shared/settings.ts apps/desktop/src/main/settings-store.ts apps/desktop/test/accelerator.test.ts apps/desktop/test/settings-store.test.ts
git commit -m "feat(desktop): settings schema, shortcut capture rules and settings file

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Appliquer les réglages, menu de la zone de notification, intégration système enregistrable

> **Revue (même commit de correction) :** `SettingsController.update` est tout ou rien (nouveau raccourci enregistré, puis sauvegarde, puis seulement ancien raccourci libéré et entrée de démarrage changée ; sauvegarde ratée → `save_failed`) ; `start()` réapplique aussi l'entrée de démarrage ; `setHoloAnchor` ne lève jamais. `RecordingOs` gagne le crochet `occupy(accelerator)` (le raccourci devient indisponible), et `trayAction`/`trayClick` lèvent « No tray » sans icône. Le code réel fait foi.

**Files:**
- Create: `apps/desktop/src/main/tray-menu.ts`, `apps/desktop/src/main/os-integration.ts`, `apps/desktop/src/main/recording-os.ts`, `apps/desktop/src/main/settings-controller.ts`
- Test: `apps/desktop/test/tray-menu.test.ts`, `apps/desktop/test/recording-os.test.ts`, `apps/desktop/test/settings-controller.test.ts`

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/tray-menu.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { trayMenuItems } from "../src/main/tray-menu.ts";

const BASE = { paired: true, showHolo: true, launchAtStartup: false, updateReady: false };

describe("trayMenuItems", () => {
  test("open, Holo, launch at startup, then quit", () => {
    const items = trayMenuItems(BASE);
    expect(items.map((item) => [item.id, item.label, item.checked])).toEqual([
      ["open", "Ouvrir Alicia", null],
      ["toggle-holo", "Afficher l'Holo", true],
      ["toggle-startup", "Lancer au démarrage", false],
      ["separator", "", null],
      ["quit", "Quitter Alicia", null],
    ]);
  });

  test("the Holo needs a paired device", () => {
    expect(trayMenuItems({ ...BASE, paired: false }).find((item) => item.id === "toggle-holo")?.enabled).toBe(false);
  });

  test("a downloaded update offers a restart", () => {
    const ids = trayMenuItems({ ...BASE, updateReady: true }).map((item) => item.id);
    expect(ids).toEqual(["open", "toggle-holo", "toggle-startup", "install-update", "separator", "quit"]);
  });
});
```

`apps/desktop/test/recording-os.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { RecordedState, RecordingOs } from "../src/main/recording-os.ts";
import { trayMenuItems } from "../src/main/tray-menu.ts";

describe("RecordingOs", () => {
  test("records shortcuts, login item, notifications and tray, and lets the test drive them", () => {
    const os = new RecordingOs();
    const hooks = os.hooks();
    let triggered = 0;
    let clicked = 0;
    let trayClicks = 0;
    const actions: string[] = [];
    expect(os.registerShortcut("Ctrl+Alt+A", () => { triggered++; })).toBe(true);
    os.setLoginItem(true);
    os.notify({ title: "Alicia", body: "Coucou", onClick: () => { clicked++; } });
    os.createTray(trayMenuItems({ paired: true, showHolo: true, launchAtStartup: false, updateReady: false }), (action) => {
      actions.push(action);
    }, () => { trayClicks++; });

    const state = RecordedState.parse(hooks.state());
    expect(state.shortcuts).toEqual(["Ctrl+Alt+A"]);
    expect(state.loginItem).toBe(true);
    expect(state.notifications).toEqual([{ title: "Alicia", body: "Coucou" }]);
    expect(state.tray.map((item) => item.id)).toEqual(["open", "toggle-holo", "toggle-startup", "quit"]);

    hooks.triggerShortcut();
    hooks.clickNotification(0);
    hooks.trayAction("toggle-holo");
    hooks.trayClick();
    expect([triggered, clicked, trayClicks, actions]).toEqual([1, 1, 1, ["toggle-holo"]]);
    expect(() => { hooks.trayAction("format-disk"); }).toThrow();
  });

  test("an unregistered shortcut is gone", () => {
    const os = new RecordingOs();
    os.registerShortcut("Ctrl+Alt+A", () => undefined);
    os.unregisterShortcut("Ctrl+Alt+A");
    expect(os.hooks().state().shortcuts).toEqual([]);
    expect(() => { os.hooks().triggerShortcut(); }).toThrow();
  });
});
```

`apps/desktop/test/settings-controller.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { SettingsController } from "../src/main/settings-controller.ts";
import { Settings, type SettingsSnapshot } from "../src/shared/settings.ts";

function setup(initial: Partial<Settings> = {}, taken: string[] = []) {
  let saved: Settings = { ...Settings.parse({}), ...initial };
  const registered = new Set<string>();
  const loginItems: boolean[] = [];
  const changes: SettingsSnapshot[] = [];
  const controller = new SettingsController(
    { load: () => saved, save: (settings) => { saved = settings; } },
    {
      registerShortcut: (accelerator) => {
        if (taken.includes(accelerator) || registered.has(accelerator)) return false;
        registered.add(accelerator);
        return true;
      },
      unregisterShortcut: (accelerator) => { registered.delete(accelerator); },
      setLoginItem: (open) => { loginItems.push(open); },
      onChange: (snapshot) => { changes.push(snapshot); },
    },
  );
  return { controller, registered, loginItems, changes, saved: () => saved };
}

describe("SettingsController", () => {
  test("start registers the saved shortcut", () => {
    const { controller, registered } = setup();
    controller.start();
    expect([...registered]).toEqual(["Ctrl+Alt+A"]);
    expect(controller.snapshot.shortcutActive).toBe(true);
  });

  test("a shortcut held by another app at start is reported, not fatal", () => {
    const { controller } = setup({}, ["Ctrl+Alt+A"]);
    controller.start();
    expect(controller.snapshot.shortcutActive).toBe(false);
  });

  test("a new shortcut is registered, the old one freed, then saved and announced", () => {
    const { controller, registered, changes, saved } = setup();
    controller.start();
    const result = controller.update({ shortcut: "Ctrl+Shift+K" });
    expect(result.ok).toBe(true);
    expect([...registered]).toEqual(["Ctrl+Shift+K"]);
    expect(saved().shortcut).toBe("Ctrl+Shift+K");
    expect(changes.at(-1)?.settings.shortcut).toBe("Ctrl+Shift+K");
  });

  test("a shortcut taken by another app is refused and the old one stays", () => {
    const { controller, registered, saved } = setup({}, ["Ctrl+Shift+K"]);
    controller.start();
    const result = controller.update({ shortcut: "Ctrl+Shift+K" });
    expect(result).toMatchObject({ ok: false, reason: "shortcut_unavailable" });
    expect([...registered]).toEqual(["Ctrl+Alt+A"]);
    expect(saved().shortcut).toBe("Ctrl+Alt+A");
  });

  test("choosing the same shortcut again retries it when it was not active", () => {
    const taken = ["Ctrl+Alt+A"];
    const { controller, registered } = setup({}, taken);
    controller.start();
    taken.pop();
    expect(controller.update({ shortcut: "Ctrl+Alt+A" }).ok).toBe(true);
    expect([...registered]).toEqual(["Ctrl+Alt+A"]);
    expect(controller.snapshot.shortcutActive).toBe(true);
  });

  test("launch at startup touches the login item only when it changes", () => {
    const { controller, loginItems } = setup();
    controller.update({ launchAtStartup: false });
    controller.update({ launchAtStartup: true });
    controller.update({ launchAtStartup: true });
    expect(loginItems).toEqual([true]);
  });

  test("showing the Holo and its position are saved", () => {
    const { controller, saved, changes } = setup();
    controller.update({ showHolo: false });
    controller.setHoloAnchor({ x: 100, y: 200 });
    expect(saved()).toMatchObject({ showHolo: false, holoAnchor: { x: 100, y: 200 } });
    expect(changes).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/desktop test -- tray-menu recording-os settings-controller`
Expected: FAIL (modules introuvables).

- [ ] **Step 3: Implémenter**

`apps/desktop/src/main/tray-menu.ts` :
```ts
import { z } from "zod";

export const TrayAction = z.enum(["open", "toggle-holo", "toggle-startup", "install-update", "quit"]);
export type TrayAction = z.infer<typeof TrayAction>;

export interface TrayItem {
  id: TrayAction | "separator";
  label: string;
  /** null: a plain item; a boolean: a checkbox. */
  checked: boolean | null;
  enabled: boolean;
}

export interface TrayState {
  paired: boolean;
  showHolo: boolean;
  launchAtStartup: boolean;
  updateReady: boolean;
}

/** The notification-area menu (spec: open, show/hide the Holo, launch at startup, quit). */
export function trayMenuItems(state: TrayState): TrayItem[] {
  const items: TrayItem[] = [
    { id: "open", label: "Ouvrir Alicia", checked: null, enabled: true },
    { id: "toggle-holo", label: "Afficher l'Holo", checked: state.showHolo, enabled: state.paired },
    { id: "toggle-startup", label: "Lancer au démarrage", checked: state.launchAtStartup, enabled: true },
  ];
  if (state.updateReady) {
    items.push({ id: "install-update", label: "Redémarrer pour mettre à jour", checked: null, enabled: true });
  }
  items.push(
    { id: "separator", label: "", checked: null, enabled: true },
    { id: "quit", label: "Quitter Alicia", checked: null, enabled: true },
  );
  return items;
}
```

`apps/desktop/src/main/os-integration.ts` :
```ts
import type { TrayAction, TrayItem } from "./tray-menu.ts";

export interface NotificationRequest {
  title: string;
  body: string;
  onClick: () => void;
}

export interface TrayHandle {
  update(items: readonly TrayItem[]): void;
}

/** Everything that reaches outside the app's own windows: Electron in the app, a recorder in tests. */
export interface OsIntegration {
  /** False when the accelerator is invalid or already held by another application. */
  registerShortcut(accelerator: string, run: () => void): boolean;
  unregisterShortcut(accelerator: string): void;
  setLoginItem(openAtLogin: boolean): void;
  notify(request: NotificationRequest): void;
  createTray(items: readonly TrayItem[], onAction: (action: TrayAction) => void, onClick: () => void): TrayHandle;
  dispose(): void;
}
```

`apps/desktop/src/main/recording-os.ts` :
```ts
import { z } from "zod";
import type { NotificationRequest, OsIntegration, TrayHandle } from "./os-integration.ts";
import { TrayAction, type TrayItem } from "./tray-menu.ts";

/** Where the end-to-end test finds the recorder (`globalThis[TEST_HOOKS_KEY]`, read through app.evaluate). */
export const TEST_HOOKS_KEY = "__aliciaTest";

/** What the test can read back. */
export const RecordedState = z.object({
  shortcuts: z.array(z.string()),
  loginItem: z.boolean().nullable(),
  notifications: z.array(z.object({ title: z.string(), body: z.string() })),
  tray: z.array(z.object({ id: z.string(), label: z.string(), checked: z.boolean().nullable() })),
});
export type RecordedState = z.infer<typeof RecordedState>;

export interface TestHooks {
  state(): RecordedState;
  triggerShortcut(): void;
  clickNotification(index: number): void;
  trayAction(id: string): void;
  /** A left click on the tray icon. */
  trayClick(): void;
}

interface RecordedTray {
  items: readonly TrayItem[];
  onAction: (action: TrayAction) => void;
  onClick: () => void;
}

/** Stand-in for the OS in tests: nothing leaves the app, everything is recorded and can be triggered. */
export class RecordingOs implements OsIntegration {
  readonly #shortcuts = new Map<string, () => void>();
  readonly #notifications: NotificationRequest[] = [];
  #loginItem: boolean | null = null;
  #tray: RecordedTray | null = null;

  registerShortcut(accelerator: string, run: () => void): boolean {
    this.#shortcuts.set(accelerator, run);
    return true;
  }

  unregisterShortcut(accelerator: string): void {
    this.#shortcuts.delete(accelerator);
  }

  setLoginItem(openAtLogin: boolean): void {
    this.#loginItem = openAtLogin;
  }

  notify(request: NotificationRequest): void {
    this.#notifications.push(request);
  }

  createTray(items: readonly TrayItem[], onAction: (action: TrayAction) => void, onClick: () => void): TrayHandle {
    const tray: RecordedTray = { items, onAction, onClick };
    this.#tray = tray;
    return {
      update: (next) => {
        tray.items = next;
      },
    };
  }

  dispose(): void {
    this.#shortcuts.clear();
    this.#tray = null;
  }

  hooks(): TestHooks {
    return {
      state: () => ({
        shortcuts: [...this.#shortcuts.keys()],
        loginItem: this.#loginItem,
        notifications: this.#notifications.map(({ title, body }) => ({ title, body })),
        tray: (this.#tray?.items ?? [])
          .filter((item) => item.id !== "separator")
          .map((item) => ({ id: item.id, label: item.label, checked: item.checked })),
      }),
      triggerShortcut: () => {
        const [run] = this.#shortcuts.values();
        if (run === undefined) throw new Error("No shortcut registered");
        run();
      },
      clickNotification: (index) => {
        const notification = this.#notifications[index];
        if (notification === undefined) throw new Error(`No notification #${index}`);
        notification.onClick();
      },
      trayAction: (id) => {
        this.#tray?.onAction(TrayAction.parse(id));
      },
      trayClick: () => {
        this.#tray?.onClick();
      },
    };
  }
}
```

`apps/desktop/src/main/settings-controller.ts` :
```ts
import type { Point } from "../shared/holo.ts";
import type { Settings, SettingsPatch, SettingsSnapshot, SettingsUpdateResult } from "../shared/settings.ts";

export interface SettingsPersistence {
  load(): Settings;
  save(settings: Settings): void;
}

export interface SettingsPorts {
  /** False when another application holds the shortcut. */
  registerShortcut(accelerator: string): boolean;
  unregisterShortcut(accelerator: string): void;
  setLoginItem(openAtLogin: boolean): void;
  onChange(snapshot: SettingsSnapshot): void;
}

/** The settings and their effects on the system (shortcut, login item); the Holo follows `onChange`. */
export class SettingsController {
  readonly #store: SettingsPersistence;
  readonly #ports: SettingsPorts;
  #settings: Settings;
  #shortcutActive = false;

  constructor(store: SettingsPersistence, ports: SettingsPorts) {
    this.#store = store;
    this.#ports = ports;
    this.#settings = store.load();
  }

  get snapshot(): SettingsSnapshot {
    return { settings: this.#settings, shortcutActive: this.#shortcutActive };
  }

  /** Registers the saved shortcut; another app may already hold it (reported in the snapshot). */
  start(): void {
    this.#shortcutActive = this.#ports.registerShortcut(this.#settings.shortcut);
  }

  update(patch: SettingsPatch): SettingsUpdateResult {
    const next: Settings = { ...this.#settings };
    if (patch.shortcut !== undefined && (patch.shortcut !== next.shortcut || !this.#shortcutActive)) {
      if (!this.#ports.registerShortcut(patch.shortcut)) {
        return { ok: false, reason: "shortcut_unavailable", snapshot: this.snapshot };
      }
      if (this.#shortcutActive && patch.shortcut !== next.shortcut) this.#ports.unregisterShortcut(next.shortcut);
      this.#shortcutActive = true;
      next.shortcut = patch.shortcut;
    }
    if (patch.launchAtStartup !== undefined && patch.launchAtStartup !== next.launchAtStartup) {
      this.#ports.setLoginItem(patch.launchAtStartup);
      next.launchAtStartup = patch.launchAtStartup;
    }
    if (patch.showHolo !== undefined) next.showHolo = patch.showHolo;
    this.#commit(next);
    return { ok: true, snapshot: this.snapshot };
  }

  setHoloAnchor(anchor: Point): void {
    this.#commit({ ...this.#settings, holoAnchor: anchor });
  }

  #commit(next: Settings): void {
    this.#store.save(next);
    this.#settings = next;
    this.#ports.onChange(this.snapshot);
  }
}
```

- [ ] **Step 4: Vérifier**

Run: `pnpm --filter @alicia/desktop test -- tray-menu recording-os settings-controller && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/tray-menu.ts apps/desktop/src/main/os-integration.ts apps/desktop/src/main/recording-os.ts apps/desktop/src/main/settings-controller.ts apps/desktop/test/tray-menu.test.ts apps/desktop/test/recording-os.test.ts apps/desktop/test/settings-controller.test.ts
git commit -m "feat(desktop): settings controller, tray menu and a recordable OS integration port

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: BrainHub — une seule connexion pour tout le PC

> **Revue des tâches 4–6 (commit `fix(desktop): 4b review — turn routing, orphan errors, resilient hub`) :** les ports du moyeu deviennent `onEvent(event, owner)` (fenêtre du tour, `undefined` sinon), `onSent(origin, pendingTurns)` et `onTurnFinished(turn, pendingTurns)` ; un échec porte le `code` du cerveau ; une erreur sans identifiant termine le plus ancien tour qui attend encore sa conversation ; un `requestId` déjà en cours est refusé ; `connect()` remplace la connexion sans passer par « offline » ; le moyeu met à jour ses tours **avant** d'appeler ses ports, chacun protégé (une exception est journalisée). Le principal envoie les événements d'un tour **à la seule fenêtre qui l'a demandé** (`eventRecipients` dans `src/main/event-routing.ts`) ; `done` va à toutes (elles rafraîchissent leur liste), et `ChatStore` n'accepte les événements d'un tour que pour la conversation nommée par son propre événement `conversation`. `Presence` ne compte plus les tours : `sent(pendingTurns)`, `finished(turn, pendingTurns)`, `signedOut()` ; le quota la laisse endormie jusqu'à la prochaine réponse réussie. Le code réel fait foi pour les tâches suivantes.

**Files:**
- Create: `apps/desktop/src/main/brain-hub.ts`
- Test: `apps/desktop/test/brain-hub.test.ts`

Le moyeu ouvre la connexion avec `ChatConnection`, relaie tout, et suit chaque tour (fenêtre d'origine, conversation, texte complet) pour annoncer sa fin.

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/brain-hub.test.ts` :
```ts
import type { SendMessage, ServerEvent } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import { BrainHub, type FinishedTurn } from "../src/main/brain-hub.ts";
import type { ConnectionStatus, SocketLike } from "../src/shared/chat-connection.ts";
import type { Surface } from "../src/shared/surface.ts";

const SESSION = { serverUrl: "http://127.0.0.1:8780", token: "t".repeat(43) };
const READY = { type: "ready", person: { id: "kevin", name: "Kévin" } };
const REQUEST = "7a1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const OTHER_REQUEST = "8b2d3c0f-9b5e-4d2f-8c8b-3e6f7a819203";
const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const DONE = { type: "done", conversationId: CONV, model: "sonnet", inputTokens: 1, outputTokens: 2, durationMs: 3 };

class FakeSocket implements SocketLike {
  readonly url: string;
  sent: string[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code;
  }
  receive(event: unknown): void {
    this.onmessage?.(JSON.stringify(event));
  }
}

function message(requestId = REQUEST, text = "Salut"): SendMessage {
  return { type: "send", requestId, text };
}

function setup() {
  const sockets: FakeSocket[] = [];
  const events: ServerEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const sent: Surface[] = [];
  const finished: FinishedTurn[] = [];
  const hub = new BrainHub({
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    schedule: () => () => undefined,
    onEvent: (event) => { events.push(event); },
    onStatus: (status) => { statuses.push(status); },
    onSent: (origin) => { sent.push(origin); },
    onTurnFinished: (turn) => { finished.push(turn); },
  });
  const socket = (): FakeSocket => {
    const last = sockets.at(-1);
    if (last === undefined) throw new Error("no socket");
    return last;
  };
  const connectReady = (): void => {
    hub.connect(SESSION);
    socket().onopen?.();
    socket().receive(READY);
  };
  return { hub, sockets, events, statuses, sent, finished, socket, connectReady };
}

describe("BrainHub", () => {
  test("connects to the paired brain, relays every event and status", () => {
    const { hub, socket, events, statuses, connectReady } = setup();
    expect(hub.status).toBe("offline");
    connectReady();
    expect(socket().url).toBe("ws://127.0.0.1:8780/ws");
    expect(socket().sent[0]).toBe(JSON.stringify({ type: "authenticate", token: SESSION.token }));
    expect(statuses).toEqual(["connecting", "ready"]);
    expect(events).toEqual([READY]);
    expect(hub.status).toBe("ready");
  });

  test("send is refused until ready, then remembers which window asked", () => {
    const { hub, socket, sent, connectReady } = setup();
    expect(hub.send(message(), "spotlight")).toBe(false);
    connectReady();
    expect(hub.send(message(), "spotlight")).toBe(true);
    expect(socket().sent.at(-1)).toBe(JSON.stringify(message()));
    expect(sent).toEqual(["spotlight"]);
  });

  test("an answered turn reports its window, conversation and whole text", () => {
    const { hub, socket, finished, connectReady } = setup();
    connectReady();
    hub.send(message(), "spotlight");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "text_delta", conversationId: CONV, text: "Bonjour " });
    socket().receive({ type: "tool_call", conversationId: CONV, callId: "c", tool: "weather" });
    socket().receive({ type: "text_delta", conversationId: CONV, text: "Kévin" });
    expect(finished).toEqual([]);
    socket().receive(DONE);
    expect(finished).toEqual([{ origin: "spotlight", outcome: "answered", conversationId: CONV, text: "Bonjour Kévin" }]);
  });

  test("a refused send (busy) fails with the brain's message, the running turn goes on", () => {
    const { hub, socket, finished, connectReady } = setup();
    connectReady();
    hub.send(message(), "main");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    hub.send(message(OTHER_REQUEST, "Et aussi"), "spotlight");
    socket().receive({ type: "error", requestId: OTHER_REQUEST, code: "busy", message: "Alicia répond déjà ; réessaie après sa réponse." });
    expect(finished).toEqual([
      { origin: "spotlight", outcome: "failed", conversationId: undefined, message: "Alicia répond déjà ; réessaie après sa réponse." },
    ]);
    socket().receive(DONE);
    expect(finished.at(-1)).toMatchObject({ origin: "main", outcome: "answered", conversationId: CONV });
  });

  test("an engine error is matched by request, with its conversation", () => {
    const { hub, socket, finished, connectReady } = setup();
    connectReady();
    hub.send(message(), "holo");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().receive({ type: "error", requestId: REQUEST, conversationId: CONV, code: "engine", message: "Le moteur a échoué." });
    expect(finished).toEqual([{ origin: "holo", outcome: "failed", conversationId: CONV, message: "Le moteur a échoué." }]);
  });

  test("connection lost mid-turn: the turn fails once, with an explanation", () => {
    const { hub, socket, finished, statuses, connectReady } = setup();
    connectReady();
    hub.send(message(), "spotlight");
    socket().receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    socket().onclose?.(1006);
    expect(statuses.at(-1)).toBe("offline");
    expect(finished).toEqual([
      { origin: "spotlight", outcome: "failed", conversationId: CONV, message: "Connexion perdue : la réponse d'Alicia n'est pas arrivée." },
    ]);
  });

  test("disconnect closes the socket, forgets the turns, and ignores the old socket", () => {
    const { hub, socket, events, finished, connectReady } = setup();
    connectReady();
    hub.send(message(), "main");
    const old = socket();
    hub.disconnect();
    expect(old.closedWith).toBe(1000);
    expect(hub.status).toBe("offline");
    old.receive({ type: "conversation", requestId: REQUEST, conversationId: CONV });
    expect(events).toEqual([READY]);
    expect(finished).toEqual([]);
  });

  test("connecting again replaces the previous connection", () => {
    const { hub, sockets, connectReady } = setup();
    connectReady();
    hub.connect({ serverUrl: "https://alicia.ts.net", token: "u".repeat(43) });
    expect(sockets[0]?.closedWith).toBe(1000);
    expect(sockets[1]?.url).toBe("wss://alicia.ts.net/ws");
  });
});
```

- [ ] **Step 2: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/desktop test -- brain-hub`
Expected: FAIL (`brain-hub.ts` introuvable).

- [ ] **Step 3: Implémenter**

`apps/desktop/src/main/brain-hub.ts` :
```ts
import type { SendMessage, ServerEvent } from "@alicia/protocol";
import { ChatConnection, type ConnectionStatus, type SocketLike, webSocketUrl } from "../shared/chat-connection.ts";
import type { Surface } from "../shared/surface.ts";

/** How a turn ended, and which window asked for it (the notification depends on both). */
export type FinishedTurn =
  | { origin: Surface; outcome: "answered"; conversationId: string; text: string }
  | { origin: Surface; outcome: "failed"; conversationId: string | undefined; message: string };

export interface BrainHubPorts {
  openSocket(url: string): SocketLike;
  /** Runs `run` after `ms`; returns a cancel function. */
  schedule(run: () => void, ms: number): () => void;
  /** Every event from the brain, already validated, for every window. */
  onEvent(event: ServerEvent): void;
  onStatus(status: ConnectionStatus): void;
  /** A message left for the brain. */
  onSent(origin: Surface): void;
  onTurnFinished(turn: FinishedTurn): void;
}

interface Turn {
  origin: Surface;
  conversationId: string | undefined;
  text: string;
}

const CONNECTION_LOST = "Connexion perdue : la réponse d'Alicia n'est pas arrivée.";
const DEVICE_REFUSED = "Cet appareil a été déconnecté d'Alicia.";

/**
 * The only connection from this PC to the brain, owned by the main process. Every window sends through it
 * and receives everything from it; the brain answers one turn at a time per connection, so one per PC.
 */
export class BrainHub {
  readonly #ports: BrainHubPorts;
  #connection: ChatConnection | null = null;
  #status: ConnectionStatus = "offline";
  /** Turns waiting for their end, by request id. */
  readonly #turns = new Map<string, Turn>();

  constructor(ports: BrainHubPorts) {
    this.#ports = ports;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  connect(session: { serverUrl: string; token: string }): void {
    this.disconnect();
    const connection: ChatConnection = new ChatConnection({
      url: webSocketUrl(session.serverUrl),
      token: session.token,
      openSocket: (url) => this.#ports.openSocket(url),
      schedule: (run, ms) => this.#ports.schedule(run, ms),
      onEvent: (event) => {
        if (this.#connection === connection) this.#receive(event);
      },
      onStatus: (status) => {
        if (this.#connection === connection) this.#setStatus(status);
      },
    });
    this.#connection = connection;
    connection.start();
  }

  /** Signed out: the connection closes and pending turns are forgotten (no notification). */
  disconnect(): void {
    const connection = this.#connection;
    if (connection === null) return;
    this.#connection = null;
    connection.stop();
    this.#turns.clear();
    this.#setStatus("offline");
  }

  send(message: SendMessage, origin: Surface): boolean {
    if (this.#connection?.send(message) !== true) return false;
    this.#turns.set(message.requestId, { origin, conversationId: message.conversationId, text: "" });
    this.#ports.onSent(origin);
    return true;
  }

  #receive(event: ServerEvent): void {
    this.#ports.onEvent(event);
    switch (event.type) {
      case "conversation": {
        const turn = this.#turns.get(event.requestId);
        if (turn !== undefined) turn.conversationId = event.conversationId;
        return;
      }
      case "text_delta": {
        const found = this.#find(event.conversationId);
        if (found !== undefined) found[1].text += event.text;
        return;
      }
      case "done": {
        const found = this.#find(event.conversationId);
        if (found === undefined) return;
        const [requestId, turn] = found;
        this.#finish(requestId, { origin: turn.origin, outcome: "answered", conversationId: event.conversationId, text: turn.text });
        return;
      }
      case "error": {
        const requestId = event.requestId ?? (event.conversationId === undefined ? undefined : this.#find(event.conversationId)?.[0]);
        const turn = requestId === undefined ? undefined : this.#turns.get(requestId);
        if (requestId === undefined || turn === undefined) return;
        this.#finish(requestId, {
          origin: turn.origin, outcome: "failed", conversationId: event.conversationId ?? turn.conversationId, message: event.message,
        });
        return;
      }
      case "heartbeat":
      case "ready":
      case "tool_call":
      case "tool_result":
        return;
    }
  }

  #find(conversationId: string): [string, Turn] | undefined {
    for (const entry of this.#turns) {
      if (entry[1].conversationId === conversationId) return entry;
    }
    return undefined;
  }

  #finish(requestId: string, turn: FinishedTurn): void {
    this.#turns.delete(requestId);
    this.#ports.onTurnFinished(turn);
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.#ports.onStatus(status);
    if (status !== "offline" && status !== "rejected") return;
    const message = status === "rejected" ? DEVICE_REFUSED : CONNECTION_LOST;
    for (const [requestId, turn] of [...this.#turns]) {
      this.#finish(requestId, { origin: turn.origin, outcome: "failed", conversationId: turn.conversationId, message });
    }
  }
}
```

- [ ] **Step 4: Vérifier**

Run: `pnpm --filter @alicia/desktop test -- brain-hub && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/brain-hub.ts apps/desktop/test/brain-hub.test.ts
git commit -m "feat(desktop): one brain connection per PC, owned by the main process, with turn tracking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Humeur commune d'Alicia et notifications de réponse

> **Revue :** `Presence.status("ready")` ne remet l'humeur au repos que si elle venait de la connexion (hors ligne ou appareil refusé) : une Alicia endormie (quota) reste endormie, et une réussite ou une erreur affichée un instant garde son minuteur. Le code réel fait foi.

**Files:**
- Create: `apps/desktop/src/main/presence.ts`, `apps/desktop/src/main/turn-notifications.ts`
- Test: `apps/desktop/test/presence.test.ts`, `apps/desktop/test/turn-notifications.test.ts`

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/presence.test.ts` :
```ts
import type { ServerEvent } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import { LISTENING_MS, Presence, SLEEP_AFTER_MS, SUCCESS_MS, TURN_ERROR_MS } from "../src/main/presence.ts";
import type { MascotState } from "../src/shared/mascot.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const DONE: ServerEvent = { type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 };

function setup() {
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const moods: MascotState[] = [];
  const presence = new Presence({
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    onChange: (mood) => { moods.push(mood); },
  });
  /** Runs the pending timer of that duration. */
  const elapse = (ms: number): void => {
    const timer = timers.find((t) => t.ms === ms && !t.cancelled);
    if (timer === undefined) throw new Error(`no pending ${ms} ms timer`);
    timer.cancelled = true;
    timer.run();
  };
  return { presence, moods, elapse };
}

describe("Presence", () => {
  test("idle, then asleep after a long quiet time", () => {
    const { presence, moods, elapse } = setup();
    expect(presence.mood).toBe("idle");
    elapse(SLEEP_AFTER_MS);
    expect(moods).toEqual(["sleeping"]);
  });

  test("a turn: thinking, speaking, success, then idle", () => {
    const { presence, moods, elapse } = setup();
    presence.sent();
    presence.event({ type: "text_delta", conversationId: CONV, text: "Bonjour" });
    presence.event(DONE);
    elapse(SUCCESS_MS);
    expect(moods).toEqual(["thinking", "speaking", "success", "idle"]);
  });

  test("remembering gives an idea, other tools keep thinking", () => {
    const { presence, moods } = setup();
    presence.sent();
    presence.event({ type: "tool_call", conversationId: CONV, callId: "a", tool: "memory_remember" });
    presence.event({ type: "tool_call", conversationId: CONV, callId: "b", tool: "weather" });
    expect(moods).toEqual(["thinking", "idea", "thinking"]);
  });

  test("a second message refused while Alicia answers does not stop the first turn", () => {
    const { presence, moods } = setup();
    presence.sent();
    presence.sent();
    presence.event({ type: "error", requestId: "8b2d3c0f-9b5e-4d2f-8c8b-3e6f7a819203", code: "busy", message: "Alicia répond déjà." });
    presence.event({ type: "text_delta", conversationId: CONV, text: "Oui" });
    expect(moods).toEqual(["thinking", "speaking"]);
  });

  test("a failed turn shows its mood for a moment; quota puts her to sleep", () => {
    const { presence, moods, elapse } = setup();
    presence.sent();
    presence.event({ type: "error", code: "engine", message: "Le moteur a échoué." });
    elapse(TURN_ERROR_MS);
    presence.sent();
    presence.event({ type: "error", code: "quota", message: "Quota atteint." });
    expect(moods).toEqual(["thinking", "error", "idle", "thinking", "sleeping"]);
  });

  test("typing makes her listen, but not during a turn", () => {
    const { presence, moods, elapse } = setup();
    presence.typing();
    elapse(LISTENING_MS);
    presence.sent();
    presence.typing();
    expect(moods).toEqual(["listening", "idle", "thinking"]);
  });

  test("connection lost: alert until the brain is back; refused device: error", () => {
    const { presence, moods } = setup();
    presence.sent();
    presence.status("offline");
    presence.typing();
    presence.status("connecting");
    presence.status("ready");
    presence.status("rejected");
    expect(moods).toEqual(["thinking", "alert", "idle", "error"]);
  });

  test("events without a turn of ours change nothing", () => {
    const { presence, moods } = setup();
    presence.event({ type: "text_delta", conversationId: CONV, text: "?" });
    presence.event(DONE);
    expect(moods).toEqual([]);
  });
});
```

`apps/desktop/test/turn-notifications.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { notificationBody, notificationFor } from "../src/main/turn-notifications.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const VISIBLE = { main: true, holoChat: true };
const HIDDEN = { main: false, holoChat: false };

describe("notificationFor", () => {
  test("Spotlight answers always come as a notification that opens the conversation", () => {
    const turn = { origin: "spotlight", outcome: "answered", conversationId: CONV, text: "Il fait beau." } as const;
    expect(notificationFor(turn, VISIBLE)).toEqual({ title: "Alicia", body: "Il fait beau.", conversationId: CONV, openConversation: true });
  });

  test("main window: only when hidden, and the conversation is already the open one", () => {
    const turn = { origin: "main", outcome: "answered", conversationId: CONV, text: "Voilà." } as const;
    expect(notificationFor(turn, VISIBLE)).toBeNull();
    expect(notificationFor(turn, HIDDEN)).toEqual({ title: "Alicia", body: "Voilà.", conversationId: CONV, openConversation: false });
  });

  test("Holo: only when its mini-chat is closed", () => {
    const turn = { origin: "holo", outcome: "answered", conversationId: CONV, text: "Oui !" } as const;
    expect(notificationFor(turn, { main: false, holoChat: true })).toBeNull();
    expect(notificationFor(turn, { main: true, holoChat: false })?.openConversation).toBe(true);
  });

  test("a failure says so, with the brain's message", () => {
    const turn = { origin: "spotlight", outcome: "failed", conversationId: undefined, message: "Alicia répond déjà." } as const;
    expect(notificationFor(turn, VISIBLE)).toEqual({
      title: "Alicia n'a pas pu répondre", body: "Alicia répond déjà.", conversationId: undefined, openConversation: false,
    });
  });

  test("an empty answer still says something", () => {
    const turn = { origin: "spotlight", outcome: "answered", conversationId: CONV, text: "  " } as const;
    expect(notificationFor(turn, VISIBLE)?.body).toBe("Alicia a répondu.");
  });
});

describe("notificationBody", () => {
  test("plain text: no Markdown marks, single spaces, cut at 180 characters", () => {
    expect(notificationBody("**Bonjour**  `Kévin`\n\n# Titre")).toBe("Bonjour Kévin Titre");
    const long = notificationBody("a".repeat(300));
    expect(long).toHaveLength(180);
    expect(long.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/desktop test -- presence turn-notifications`
Expected: FAIL (modules introuvables).

- [ ] **Step 3: Implémenter**

`apps/desktop/src/main/presence.ts` :
```ts
import type { ServerEvent } from "@alicia/protocol";
import type { ConnectionStatus } from "../shared/chat-connection.ts";
import { MASCOT_ON_ERROR, type MascotState } from "../shared/mascot.ts";

export interface PresencePorts {
  schedule(run: () => void, ms: number): () => void;
  onChange(mood: MascotState): void;
}

export const SUCCESS_MS = 1500;
export const TURN_ERROR_MS = 4000;
export const LISTENING_MS = 2500;
/** "veille" in the mascot brief: inactive for a while. */
export const SLEEP_AFTER_MS = 10 * 60_000;

/** Alicia's mood for the whole PC, from every window's turns and from the connection: what the Holo shows. */
export class Presence {
  readonly #ports: PresencePorts;
  #mood: MascotState = "idle";
  /** Messages sent and not finished yet (a refused second message must not end the first turn). */
  #turns = 0;
  #offline = false;
  #cancelTimer: (() => void) | null = null;

  constructor(ports: PresencePorts) {
    this.#ports = ports;
    this.#set("idle");
  }

  get mood(): MascotState {
    return this.#mood;
  }

  sent(): void {
    this.#turns++;
    this.#set("thinking");
  }

  event(event: ServerEvent): void {
    switch (event.type) {
      case "text_delta":
        if (this.#turns > 0) this.#set("speaking");
        return;
      case "tool_call":
        if (this.#turns > 0) this.#set(event.tool === "memory_remember" ? "idea" : "thinking");
        return;
      case "done":
        if (this.#turns === 0) return;
        this.#turns--;
        if (this.#turns === 0) this.#set("success", SUCCESS_MS);
        return;
      case "error":
        if (this.#turns === 0) return;
        this.#turns--;
        if (this.#turns === 0) this.#set(MASCOT_ON_ERROR[event.code] ?? "alert", TURN_ERROR_MS);
        return;
      case "heartbeat":
      case "ready":
      case "conversation":
      case "tool_result":
        return;
    }
  }

  status(status: ConnectionStatus): void {
    if (status === "ready") {
      this.#offline = false;
      if (this.#turns === 0) this.#set("idle");
      return;
    }
    if (status === "offline" || status === "rejected") {
      this.#turns = 0;
      this.#offline = true;
      this.#set(status === "rejected" ? "error" : "alert");
    }
  }

  /** Someone types to Alicia in one of the windows. */
  typing(): void {
    if (this.#turns > 0 || this.#offline) return;
    this.#set("listening", LISTENING_MS);
  }

  /** Sets the mood; with `resetAfterMs`, back to idle afterwards; idle falls asleep after a long quiet time. */
  #set(mood: MascotState, resetAfterMs?: number): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    if (mood !== this.#mood) {
      this.#mood = mood;
      this.#ports.onChange(mood);
    }
    if (resetAfterMs !== undefined) {
      this.#cancelTimer = this.#ports.schedule(() => {
        this.#cancelTimer = null;
        this.#set("idle");
      }, resetAfterMs);
    } else if (mood === "idle") {
      this.#cancelTimer = this.#ports.schedule(() => {
        this.#cancelTimer = null;
        this.#set("sleeping");
      }, SLEEP_AFTER_MS);
    }
  }
}
```

Vérifier le test « second message refused » : `sent()` ×2 → 2 tours, `error` → 1 tour restant (pas de changement d'humeur), `text_delta` → `speaking`. Et « events without a turn » : aucun `onChange`.

`apps/desktop/src/main/turn-notifications.ts` :
```ts
import type { FinishedTurn } from "./brain-hub.ts";

/** Which surfaces the person can see right now. */
export interface Visibility {
  /** Main window shown and not minimized. */
  main: boolean;
  /** Holo shown with its mini-chat open. */
  holoChat: boolean;
}

export interface TurnNotification {
  title: string;
  body: string;
  conversationId: string | undefined;
  /** True when a click must open this conversation in the main window (it came from Spotlight or the Holo). */
  openConversation: boolean;
}

const MAX_BODY = 180;

/** Plain text for a notification: no Markdown marks, single spaces, at most 180 characters. */
export function notificationBody(text: string): string {
  const plain = text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  return plain.length > MAX_BODY ? `${plain.slice(0, MAX_BODY - 1).trimEnd()}…` : plain;
}

/** A Windows notification when the answer would otherwise go unseen; null when the asking window shows it. */
export function notificationFor(turn: FinishedTurn, visible: Visibility): TurnNotification | null {
  const unseen =
    turn.origin === "spotlight" ||
    (turn.origin === "main" && !visible.main) ||
    (turn.origin === "holo" && !visible.holoChat);
  if (!unseen) return null;
  const elsewhere = turn.origin !== "main";
  if (turn.outcome === "answered") {
    const body = notificationBody(turn.text);
    return { title: "Alicia", body: body === "" ? "Alicia a répondu." : body, conversationId: turn.conversationId, openConversation: elsewhere };
  }
  return {
    title: "Alicia n'a pas pu répondre",
    body: notificationBody(turn.message),
    conversationId: turn.conversationId,
    openConversation: elsewhere && turn.conversationId !== undefined,
  };
}
```
Le texte coupé fait exactement 180 caractères (179 + « … ») quand rien n'est retiré par `trimEnd` ; le test utilise des « a », sans espace.

- [ ] **Step 4: Vérifier**

Run: `pnpm --filter @alicia/desktop test -- presence turn-notifications && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/presence.ts apps/desktop/src/main/turn-notifications.ts apps/desktop/test/presence.test.ts apps/desktop/test/turn-notifications.test.ts
git commit -m "feat(desktop): Alicia's shared mood and when an answer becomes a notification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Géométrie de l'Holo et de Spotlight, clic ou glisser, miroir d'état

> **Revue :** `holoLayout` garde aussi la fenêtre agrandie dans l'écran à droite (et en bas) : sur un écran trop étroit pour le mini-chat des deux côtés, la fenêtre est ramenée dans l'écran et la mascotte la suit, toujours collée à son mini-chat (`mascot.x` vaut 0 côté droit, `largeur − 136` côté gauche). Deuxième revue : `nearestWorkArea` et `holoAnchor` ramènent une place enregistrée sur un écran débranché vers l'écran le plus proche ; `spotlightBounds` rétrécit la barre sur un écran étroit ; `DragTracker` suit un seul `pointerId` (`down/move/up` prennent `{ x, y, pointerId }`, `cancel(pointerId)`), ignore un autre pointeur pendant un geste et termine le geste dont le relâchement a été perdu ; `mirror` réessaie une fois un chargement initial raté, puis le journalise. Le déplacement d'une fenêtre d'un écran à l'autre se fait par `setBounds` avec la taille explicite (mise à l'échelle par écran). Le code réel fait foi.

**Files:**
- Create: `apps/desktop/src/main/layout.ts`, `apps/desktop/src/renderer/src/lib/drag.ts`, `apps/desktop/src/renderer/src/lib/mirror.ts`
- Test: `apps/desktop/test/layout.test.ts`, `apps/desktop/test/drag.test.ts`, `apps/desktop/test/mirror.test.ts`

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/layout.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { clampAnchor, defaultAnchor, HOLO_SIZE, holoLayout, spotlightBounds } from "../src/main/layout.ts";

const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 };

describe("Holo layout", () => {
  test("starts in the bottom-right corner, clear of the taskbar", () => {
    expect(defaultAnchor(SCREEN)).toEqual({ x: 1760, y: 864 });
  });

  test("stays on screen", () => {
    expect(clampAnchor({ x: -50, y: 2000 }, SCREEN)).toEqual({ x: 0, y: 1040 - HOLO_SIZE.height });
    expect(clampAnchor({ x: 1900.6, y: 10.2 }, SCREEN)).toEqual({ x: 1920 - HOLO_SIZE.width, y: 10 });
  });

  test("collapsed: just the mascot", () => {
    expect(holoLayout({ x: 1760, y: 864 }, false, SCREEN)).toEqual({
      bounds: { x: 1760, y: 864, width: 136, height: 152 }, panelSide: "left", mascot: { x: 0, y: 0 },
    });
  });

  test("expanded: the mini-chat opens on the left, the mascot does not move on screen", () => {
    expect(holoLayout({ x: 1760, y: 864 }, true, SCREEN)).toEqual({
      bounds: { x: 1432, y: 596, width: 464, height: 420 }, panelSide: "left", mascot: { x: 328, y: 268 },
    });
  });

  test("near the left edge, the mini-chat opens on the right", () => {
    expect(holoLayout({ x: 100, y: 864 }, true, SCREEN)).toEqual({
      bounds: { x: 100, y: 596, width: 464, height: 420 }, panelSide: "right", mascot: { x: 0, y: 268 },
    });
  });

  test("near the top, the window stays on screen and the mascot keeps its place", () => {
    expect(holoLayout({ x: 1760, y: 50 }, true, SCREEN)).toMatchObject({ bounds: { y: 0 }, mascot: { y: 50 } });
  });

  test("on a second screen", () => {
    const right = { x: 1920, y: 0, width: 2560, height: 1400 };
    expect(holoLayout(defaultAnchor(right), false, right).bounds.x).toBeGreaterThan(1920);
  });
});

describe("spotlightBounds", () => {
  test("centred, a little above the middle of the screen", () => {
    expect(spotlightBounds(SCREEN)).toEqual({ x: 620, y: 229, width: 680, height: 120 });
  });
});
```

`apps/desktop/test/drag.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { DragTracker } from "../src/renderer/src/lib/drag.ts";

function setup() {
  const calls: string[] = [];
  const tracker = new DragTracker({
    start: () => { calls.push("start"); },
    move: ({ dx, dy }) => { calls.push(`move ${dx},${dy}`); },
    end: () => { calls.push("end"); },
    click: () => { calls.push("click"); },
  });
  return { tracker, calls };
}

describe("DragTracker", () => {
  test("a press without moving is a click", () => {
    const { tracker, calls } = setup();
    tracker.down({ x: 10, y: 10 });
    tracker.up({ x: 10, y: 10 });
    expect(calls).toEqual(["click"]);
  });

  test("a tiny wobble is still a click", () => {
    const { tracker, calls } = setup();
    tracker.down({ x: 10, y: 10 });
    tracker.move({ x: 12, y: 11 });
    tracker.up({ x: 12, y: 11 });
    expect(calls).toEqual(["click"]);
  });

  test("beyond the threshold: one start, offsets from the press point, one end, no click", () => {
    const { tracker, calls } = setup();
    tracker.down({ x: 10, y: 10 });
    tracker.move({ x: 20, y: 10 });
    tracker.move({ x: 40, y: -5 });
    tracker.up({ x: 40, y: -5 });
    expect(calls).toEqual(["start", "move 10,0", "move 30,-15", "move 30,-15", "end"]);
  });

  test("cancel ends a drag without a click; moves without a press are ignored", () => {
    const { tracker, calls } = setup();
    tracker.move({ x: 50, y: 50 });
    tracker.down({ x: 0, y: 0 });
    tracker.move({ x: 0, y: 20 });
    tracker.cancel();
    tracker.up({ x: 0, y: 20 });
    expect(calls).toEqual(["start", "move 0,20", "end"]);
  });
});
```

`apps/desktop/test/mirror.test.ts` :
```ts
import { describe, expect, test, vi } from "vitest";
import { mirror } from "../src/renderer/src/lib/mirror.ts";

function source<T>() {
  const listeners: ((value: T) => void)[] = [];
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const loaded = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    load: () => loaded,
    subscribe: (listener: (value: T) => void) => {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    },
    push: (value: T) => { for (const listener of [...listeners]) listener(value); },
    resolve, reject, listeners,
  };
}

describe("mirror", () => {
  test("applies the loaded value, then every push", async () => {
    const s = source<string>();
    const seen: string[] = [];
    mirror(s.load, s.subscribe, (value) => { seen.push(value); });
    s.resolve("a");
    await vi.waitFor(() => { expect(seen).toEqual(["a"]); });
    s.push("b");
    expect(seen).toEqual(["a", "b"]);
  });

  test("a push before the load wins over the older loaded value", async () => {
    const s = source<string>();
    const seen: string[] = [];
    mirror(s.load, s.subscribe, (value) => { seen.push(value); });
    s.push("fresh");
    s.resolve("stale");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["fresh"]);
  });

  test("returns the unsubscribe; a failed load is ignored", async () => {
    const s = source<string>();
    const off = mirror(s.load, s.subscribe, () => undefined);
    s.reject(new Error("down"));
    await Promise.resolve();
    off();
    expect(s.listeners).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/desktop test -- layout drag mirror`
Expected: FAIL (modules introuvables).

- [ ] **Step 3: Implémenter**

`apps/desktop/src/main/layout.ts` :
```ts
import type { PanelSide, Point } from "../shared/holo.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The collapsed Holo window: the 120 px mascot with room around it. */
export const HOLO_SIZE = { width: 136, height: 152 } as const;
/** The mini-chat beside the mascot. */
export const HOLO_PANEL = { width: 320, height: 420, gap: 8 } as const;
export const SPOTLIGHT_SIZE = { width: 680, height: 120 } as const;
const MARGIN = 24;

export interface HoloLayout {
  bounds: Rect;
  panelSide: PanelSide;
  /** Where the collapsed box (the mascot) sits inside the window. */
  mascot: Point;
}

/** Bottom-right corner of the work area (above the taskbar). */
export function defaultAnchor(workArea: Rect): Point {
  return {
    x: workArea.x + workArea.width - HOLO_SIZE.width - MARGIN,
    y: workArea.y + workArea.height - HOLO_SIZE.height - MARGIN,
  };
}

/** Keeps the collapsed Holo fully inside the work area. */
export function clampAnchor(anchor: Point, workArea: Rect): Point {
  return {
    x: Math.round(Math.min(Math.max(anchor.x, workArea.x), workArea.x + workArea.width - HOLO_SIZE.width)),
    y: Math.round(Math.min(Math.max(anchor.y, workArea.y), workArea.y + workArea.height - HOLO_SIZE.height)),
  };
}

/**
 * The Holo window for a mascot at `anchor`. Expanded, the window grows towards the side with room (left first)
 * and upwards, so the mascot stays exactly where it is on screen.
 */
export function holoLayout(anchor: Point, expanded: boolean, workArea: Rect): HoloLayout {
  if (!expanded) return { bounds: { ...anchor, ...HOLO_SIZE }, panelSide: "left", mascot: { x: 0, y: 0 } };
  const width = HOLO_SIZE.width + HOLO_PANEL.gap + HOLO_PANEL.width;
  const height = Math.max(HOLO_SIZE.height, HOLO_PANEL.height);
  const panelSide: PanelSide = anchor.x - workArea.x >= HOLO_PANEL.width + HOLO_PANEL.gap ? "left" : "right";
  const x = panelSide === "left" ? anchor.x - HOLO_PANEL.gap - HOLO_PANEL.width : anchor.x;
  const y = Math.max(workArea.y, anchor.y + HOLO_SIZE.height - height);
  return { bounds: { x, y, width, height }, panelSide, mascot: { x: anchor.x - x, y: anchor.y - y } };
}

/** The Spotlight bar: centred, a little above the middle of the screen under the pointer. */
export function spotlightBounds(workArea: Rect): Rect {
  return {
    x: workArea.x + Math.round((workArea.width - SPOTLIGHT_SIZE.width) / 2),
    y: workArea.y + Math.round(workArea.height * 0.22),
    ...SPOTLIGHT_SIZE,
  };
}
```

`apps/desktop/src/renderer/src/lib/drag.ts` :
```ts
import type { DragDelta } from "../../../shared/holo.ts";

export interface DragPorts {
  start(): void;
  /** Offset from the press point, in screen pixels. */
  move(delta: DragDelta): void;
  end(): void;
  click(): void;
}

/** Below this distance (px), a press is a click, not a drag. */
export const DRAG_THRESHOLD = 4;

/** Tells a click from a drag on the Holo (screen coordinates, so the moving window does not matter). */
export class DragTracker {
  readonly #ports: DragPorts;
  #origin: { x: number; y: number } | null = null;
  #dragging = false;

  constructor(ports: DragPorts) {
    this.#ports = ports;
  }

  down(point: { x: number; y: number }): void {
    this.#origin = point;
    this.#dragging = false;
  }

  move(point: { x: number; y: number }): void {
    const origin = this.#origin;
    if (origin === null) return;
    const delta = { dx: point.x - origin.x, dy: point.y - origin.y };
    if (!this.#dragging) {
      if (Math.hypot(delta.dx, delta.dy) < DRAG_THRESHOLD) return;
      this.#dragging = true;
      this.#ports.start();
    }
    this.#ports.move(delta);
  }

  up(point: { x: number; y: number }): void {
    if (this.#origin === null) return;
    this.move(point);
    const dragged = this.#dragging;
    this.#origin = null;
    this.#dragging = false;
    if (dragged) this.#ports.end();
    else this.#ports.click();
  }

  cancel(): void {
    const dragged = this.#dragging;
    this.#origin = null;
    this.#dragging = false;
    if (dragged) this.#ports.end();
  }
}
```

`apps/desktop/src/renderer/src/lib/mirror.ts` :
```ts
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
```
Si le lint signale la promesse de `load().then(…)` comme flottante, la préfixer par `void`.

- [ ] **Step 4: Vérifier**

Run: `pnpm --filter @alicia/desktop test -- layout drag mirror && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/layout.ts apps/desktop/src/renderer/src/lib/drag.ts apps/desktop/src/renderer/src/lib/mirror.ts apps/desktop/test/layout.test.ts apps/desktop/test/drag.test.ts apps/desktop/test/mirror.test.ts
git commit -m "feat(desktop): Holo and Spotlight geometry, click-or-drag tracking, race-free state mirror

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: La connexion partagée — pont, IPC, preload, fenêtres branchées sur le moyeu

À la fin de cette tâche, la fenêtre principale n'ouvre plus de WebSocket : elle parle au cerveau par le moyeu du processus principal. Comportement visible identique ; tout l'e2e existant doit rester vert.

**Files:**
- Create: `apps/desktop/src/shared/bridge.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/windows.ts`, `apps/desktop/src/renderer/src/lib/hub-client.ts`
- Modify: `apps/desktop/src/shared/session.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/src/env.d.ts`, `apps/desktop/src/renderer/src/lib/chat-store.svelte.ts`, `apps/desktop/src/renderer/src/components/Shell.svelte`, `apps/desktop/src/renderer/src/components/Composer.svelte`, `apps/desktop/src/renderer/src/App.svelte`
- Test: `apps/desktop/test/hub-client.test.ts`, `apps/desktop/test/chat-store.test.ts`

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/hub-client.test.ts` :
```ts
import type { SendMessage, ServerEvent } from "@alicia/protocol";
import { describe, expect, test, vi } from "vitest";
import { HubClient } from "../src/renderer/src/lib/hub-client.ts";
import type { BrainBridge } from "../src/shared/bridge.ts";
import type { ConnectionStatus } from "../src/shared/chat-connection.ts";

const MESSAGE: SendMessage = { type: "send", requestId: "7a1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192", text: "Salut" };
const READY: ServerEvent = { type: "ready", person: { id: "kevin", name: "Kévin" } };

function setup(initial: ConnectionStatus = "ready", delivered = true) {
  const eventListeners: ((event: ServerEvent) => void)[] = [];
  const statusListeners: ((status: ConnectionStatus) => void)[] = [];
  const sent: SendMessage[] = [];
  const bridge: BrainBridge = {
    status: () => Promise.resolve(initial),
    send: (message) => {
      sent.push(message);
      return Promise.resolve(delivered);
    },
    onEvent: (listener) => {
      eventListeners.push(listener);
      return () => { eventListeners.splice(eventListeners.indexOf(listener), 1); };
    },
    onStatus: (listener) => {
      statusListeners.push(listener);
      return () => { statusListeners.splice(statusListeners.indexOf(listener), 1); };
    },
  };
  const events: ServerEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const undelivered: string[] = [];
  const hub = new HubClient(bridge, {
    onEvent: (event) => { events.push(event); },
    onStatus: (status) => { statuses.push(status); },
    onUndelivered: (requestId) => { undelivered.push(requestId); },
  });
  return {
    hub, sent, events, statuses, undelivered, eventListeners, statusListeners,
    pushEvent: (event: ServerEvent) => { for (const listener of [...eventListeners]) listener(event); },
    pushStatus: (status: ConnectionStatus) => { for (const listener of [...statusListeners]) listener(status); },
  };
}

describe("HubClient", () => {
  test("mirrors the main process's connection status and relays its events", async () => {
    const { hub, events, statuses, pushEvent, pushStatus } = setup();
    hub.start();
    await vi.waitFor(() => { expect(statuses).toEqual(["ready"]); });
    pushEvent(READY);
    pushStatus("offline");
    expect(events).toEqual([READY]);
    expect(statuses).toEqual(["ready", "offline"]);
    expect(hub.status).toBe("offline");
  });

  test("send is refused until ready, then handed to the main process", async () => {
    const { hub, sent, statuses, pushStatus } = setup("connecting");
    hub.start();
    await vi.waitFor(() => { expect(statuses).toEqual(["connecting"]); });
    expect(hub.send(MESSAGE)).toBe(false);
    pushStatus("ready");
    expect(hub.send(MESSAGE)).toBe(true);
    expect(sent).toEqual([MESSAGE]);
  });

  test("a message the main process could not deliver is reported", async () => {
    const { hub, statuses, undelivered } = setup("ready", false);
    hub.start();
    await vi.waitFor(() => { expect(statuses).toEqual(["ready"]); });
    expect(hub.send(MESSAGE)).toBe(true);
    await vi.waitFor(() => { expect(undelivered).toEqual([MESSAGE.requestId]); });
  });

  test("stop unsubscribes, and nothing is sent afterwards", async () => {
    const { hub, statuses, eventListeners, statusListeners } = setup();
    hub.start();
    await vi.waitFor(() => { expect(statuses).toEqual(["ready"]); });
    hub.stop();
    expect([eventListeners.length, statusListeners.length]).toEqual([0, 0]);
    expect(hub.send(MESSAGE)).toBe(false);
  });
});
```

Ajouter à `apps/desktop/test/chat-store.test.ts`, dans `describe("ChatStore", …)` (les helpers `setup`, `msg`, `CONV`, `CONV_B` existent déjà) :
```ts
  test("undelivered: the pending message ends the turn with a notice", () => {
    const { store, sent } = setup();
    store.send("Salut");
    store.undelivered("00000000-0000-4000-8000-000000000099");
    expect(store.busy).toBe(true);
    store.undelivered(sent[0]?.requestId ?? "");
    expect(store.busy).toBe(false);
    expect(store.notice).toBe("Alicia n'est pas joignable pour l'instant.");
    expect(store.mascot).toBe("alert");
  });

  test("another window's turn ending refreshes the list and reloads the open conversation", async () => {
    const history = vi.fn(() => Promise.resolve([msg("00000000-0000-4000-8000-0000000000a1", "Avant")]));
    const listConversations = vi.fn(() => Promise.resolve([]));
    const { store } = setup([], { history, listConversations });
    await store.open(CONV);
    expect(history).toHaveBeenCalledTimes(1);
    store.handle({ type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 });
    await vi.waitFor(() => { expect(history).toHaveBeenCalledTimes(2); });
    expect(listConversations).toHaveBeenCalled();
    store.handle({ type: "done", conversationId: CONV_B, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 });
    expect(history).toHaveBeenCalledTimes(2);
  });
```
Le test existant « events for another conversation are ignored while busy » reste valable : pendant un tour, la fin d'un autre tour ne touche pas aux messages (elle ne fait que rafraîchir la liste).

- [ ] **Step 2: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/desktop test -- hub-client chat-store`
Expected: FAIL (`hub-client.ts` et `bridge.ts` introuvables, `undelivered` absent).

- [ ] **Step 3: Le contrat du pont**

`apps/desktop/src/shared/session.ts` : supprimer l'interface `AliciaBridge` et la constante `IPC` (le fichier garde `StoredSession` et `SaveSessionResult`).

`apps/desktop/src/shared/bridge.ts` :
```ts
import type { SendMessage, ServerEvent } from "@alicia/protocol";
import type { ConnectionStatus } from "./chat-connection.ts";
import type { MascotState } from "./mascot.ts";
import type { SaveSessionResult, StoredSession } from "./session.ts";

export type Unsubscribe = () => void;

/** The brain connection, owned by the main process (BrainHub) and mirrored in every window. */
export interface BrainBridge {
  status(): Promise<ConnectionStatus>;
  /** True once the main process handed the message to the brain. */
  send(message: SendMessage): Promise<boolean>;
  onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
  onStatus(listener: (status: ConnectionStatus) => void): Unsubscribe;
}

/** Alicia's mood for the whole PC. */
export interface PresenceBridge {
  current(): Promise<MascotState>;
  onChange(listener: (mood: MascotState) => void): Unsubscribe;
  /** Someone types to Alicia (fire and forget). */
  typing(): void;
}

/** API exposed to every page as `window.alicia` by the preload script. */
export interface AliciaBridge {
  getSession(): Promise<StoredSession | null>;
  saveSession(session: StoredSession): Promise<SaveSessionResult>;
  clearSession(): Promise<void>;
  deviceName(): Promise<string>;
  /** Paired or signed out, whichever window did it. */
  onSessionChanged(listener: (session: StoredSession | null) => void): Unsubscribe;
  brain: BrainBridge;
  presence: PresenceBridge;
}

/** Page → main process (ipcRenderer.invoke); every handler checks the sender and validates the payload. */
export const INVOKE = {
  getSession: "session:get",
  saveSession: "session:save",
  clearSession: "session:clear",
  deviceName: "device:name",
  brainStatus: "brain:status",
  brainSend: "brain:send",
  presenceGet: "presence:get",
  presenceTyping: "presence:typing",
} as const;

/** Main process → pages (webContents.send); the preload validates every payload. */
export const PUSH = {
  session: "push:session",
  brainEvent: "push:brain-event",
  brainStatus: "push:brain-status",
  presence: "push:presence",
} as const;
```

`apps/desktop/src/renderer/src/env.d.ts` : remplacer l'import par `import type { AliciaBridge } from "../../shared/bridge.ts";`.

- [ ] **Step 4: Le preload (réécriture complète, puis reconversion CRLF)**

`apps/desktop/src/preload/index.ts` :
```ts
import { ServerEvent } from "@alicia/protocol";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { z } from "zod";
import { type AliciaBridge, INVOKE, PUSH } from "../shared/bridge.ts";
import { ConnectionStatus } from "../shared/chat-connection.ts";
import { MascotState } from "../shared/mascot.ts";
import { SaveSessionResult, StoredSession } from "../shared/session.ts";

/** Listens to a main-process push; anything that does not match the schema is dropped. */
function subscribe<T>(channel: string, schema: z.ZodType<T>, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, raw: unknown): void => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) listener(parsed.data);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/** Calls the main process and validates its answer (throws when it does not match). */
async function call<T>(schema: z.ZodType<T>, channel: string, ...args: unknown[]): Promise<T> {
  const raw: unknown = await ipcRenderer.invoke(channel, ...args);
  return schema.parse(raw);
}

const bridge: AliciaBridge = {
  async getSession() {
    const raw: unknown = await ipcRenderer.invoke(INVOKE.getSession);
    const parsed = StoredSession.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  async saveSession(session) {
    const raw: unknown = await ipcRenderer.invoke(INVOKE.saveSession, session);
    const parsed = SaveSessionResult.safeParse(raw);
    return parsed.success ? parsed.data : { ok: false, reason: "invalid_session" };
  },
  async clearSession() {
    await ipcRenderer.invoke(INVOKE.clearSession);
  },
  async deviceName() {
    const raw: unknown = await ipcRenderer.invoke(INVOKE.deviceName);
    return typeof raw === "string" ? raw : "PC";
  },
  onSessionChanged: (listener) => subscribe(PUSH.session, StoredSession.nullable(), listener),
  brain: {
    async status() {
      const raw: unknown = await ipcRenderer.invoke(INVOKE.brainStatus);
      const parsed = ConnectionStatus.safeParse(raw);
      return parsed.success ? parsed.data : "offline";
    },
    send: (message) => call(z.boolean(), INVOKE.brainSend, message),
    onEvent: (listener) => subscribe(PUSH.brainEvent, ServerEvent, listener),
    onStatus: (listener) => subscribe(PUSH.brainStatus, ConnectionStatus, listener),
  },
  presence: {
    current: () => call(MascotState, INVOKE.presenceGet),
    onChange: (listener) => subscribe(PUSH.presence, MascotState, listener),
    typing: () => {
      void ipcRenderer.invoke(INVOKE.presenceTyping).catch(() => undefined);
    },
  },
};

contextBridge.exposeInMainWorld("alicia", bridge);
```

- [ ] **Step 5: Le processus principal**

`apps/desktop/src/main/windows.ts` (création ; la fenêtre principale quitte `index.ts`, à l'identique, mais chargée en `?surface=main`) :
```ts
import { fileURLToPath } from "node:url";
import { BrowserWindow, shell, type WebContents, type WebPreferences } from "electron";
import type { Surface } from "../shared/surface.ts";

const PRELOAD = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));

export interface WindowManagerOptions {
  /** The bundled page (production). */
  rendererIndex: string;
  /** Dev server URL (unpackaged `electron-vite dev` only). */
  devUrl: string | undefined;
  /** Window and taskbar icon, when present. */
  icon: string | undefined;
}

/** Only web links leave the app; anything else (file:, custom schemes) is refused. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function secureWebPreferences(): WebPreferences {
  return { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false };
}

/** The app's windows. They all load the same page, each as its own surface (`?surface=`). */
export class WindowManager {
  readonly #options: WindowManagerOptions;
  #main: BrowserWindow | null = null;

  constructor(options: WindowManagerOptions) {
    this.#options = options;
  }

  createMain(options: { show: boolean }): void {
    const window = new BrowserWindow({
      ...(this.#options.icon !== undefined ? { icon: this.#options.icon } : {}),
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      show: false,
      backgroundColor: "#16213e",
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#121a32", symbolColor: "#f3ebdd", height: 40 },
      webPreferences: secureWebPreferences(),
    });
    if (options.show) {
      window.once("ready-to-show", () => {
        window.show();
      });
    }
    this.#harden(window);
    this.#load(window, "main");
    this.#main = window;
  }

  /** Which of our windows sent an IPC message (undefined: not one of ours). */
  surfaceOf(contents: WebContents): Surface | undefined {
    const main = this.#main;
    if (main !== null && !main.isDestroyed() && main.webContents === contents) return "main";
    return undefined;
  }

  /** Sends to every open window. */
  broadcast(channel: string, payload?: unknown): void {
    for (const window of this.#windows()) window.webContents.send(channel, payload);
  }

  #windows(): BrowserWindow[] {
    return [this.#main].filter((window): window is BrowserWindow => window !== null && !window.isDestroyed());
  }

  /** The app never navigates away nor opens windows; external links go to the browser. */
  #harden(window: BrowserWindow): void {
    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  }

  #load(window: BrowserWindow, surface: Surface): void {
    const devUrl = this.#options.devUrl;
    if (devUrl !== undefined) {
      const url = new URL(devUrl);
      url.searchParams.set("surface", surface);
      void window.loadURL(url.href);
    } else {
      void window.loadFile(this.#options.rendererIndex, { query: { surface } });
    }
  }
}
```

`apps/desktop/src/main/ipc.ts` :
```ts
import { hostname } from "node:os";
import { SendMessage } from "@alicia/protocol";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { z } from "zod";
import { INVOKE } from "../shared/bridge.ts";
import type { SaveSessionResult, StoredSession } from "../shared/session.ts";
import type { Surface } from "../shared/surface.ts";
import type { BrainHub } from "./brain-hub.ts";
import type { Presence } from "./presence.ts";
import type { WindowManager } from "./windows.ts";

export interface IpcDependencies {
  /** Only our own page (any surface) may call the main process. */
  isTrusted(event: IpcMainInvokeEvent): boolean;
  session: { get(): StoredSession | null; save(raw: unknown): SaveSessionResult; clear(): void };
  windows: WindowManager;
  hub: BrainHub;
  presence: Presence;
}

const NONE = z.undefined();

/** Every page → main process call: sender checked, payload validated by Zod, then handled. */
export function registerIpc(deps: IpcDependencies): void {
  function handle<A>(channel: string, schema: z.ZodType<A>, run: (arg: A, sender: WebContents) => unknown): void {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, raw: unknown) => {
      if (!deps.isTrusted(event)) throw new Error("Untrusted IPC sender");
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new Error(`Invalid IPC payload on ${channel}`);
      return run(parsed.data, event.sender);
    });
  }

  function surfaceOf(sender: WebContents): Surface {
    const surface = deps.windows.surfaceOf(sender);
    if (surface === undefined) throw new Error("IPC from an unknown window");
    return surface;
  }

  handle(INVOKE.getSession, NONE, () => deps.session.get());
  // An invalid session is answered with a reason, not an exception (the pairing screen explains it).
  handle(INVOKE.saveSession, z.unknown(), (raw) => deps.session.save(raw));
  handle(INVOKE.clearSession, NONE, () => {
    deps.session.clear();
  });
  handle(INVOKE.deviceName, NONE, () => hostname());
  handle(INVOKE.brainStatus, NONE, () => deps.hub.status);
  handle(INVOKE.brainSend, SendMessage, (message, sender) => deps.hub.send(message, surfaceOf(sender)));
  handle(INVOKE.presenceGet, NONE, () => deps.presence.mood);
  handle(INVOKE.presenceTyping, NONE, () => {
    deps.presence.typing();
  });
}
```

`apps/desktop/src/main/index.ts` (réécriture complète, puis reconversion CRLF) :
```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, type IpcMainInvokeEvent, safeStorage, session } from "electron";
import { PUSH } from "../shared/bridge.ts";
import { openWebSocket } from "../shared/chat-connection.ts";
import { type SaveSessionResult, StoredSession } from "../shared/session.ts";
import { BrainHub } from "./brain-hub.ts";
import { registerIpc } from "./ipc.ts";
import { Presence } from "./presence.ts";
import { EncryptionUnavailableError, SessionStore } from "./session-store.ts";
import { isTrustedSenderUrl } from "./trusted-sender.ts";
import { WindowManager } from "./windows.ts";

const RENDERER_INDEX = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
/** Mascot head icon (design/mascotte/icone/v1), exported to build/ for electron-builder too. */
const APP_ICON = join(app.getAppPath(), "build", "icon.png");
// Own taskbar identity on Windows: otherwise the window is grouped under Electron's icon.
app.setAppUserModelId("fr.pandarvis.alicia");

// Lets the end-to-end test isolate its profile; ignored in a packaged app.
const userDataOverride = process.env["ALICIA_USER_DATA"];
if (!app.isPackaged && userDataOverride !== undefined) app.setPath("userData", userDataOverride);

/** The dev server URL, only ever honoured when running unpackaged. */
function devServerUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
}

/** Only our own page (whatever its `?surface=`) may talk to the main process. */
function isTrusted(event: IpcMainInvokeEvent): boolean {
  return isTrustedSenderUrl(event.senderFrame?.url, {
    rendererFileUrl: pathToFileURL(RENDERER_INDEX).href,
    devUrl: devServerUrl(),
  });
}

function schedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => {
    clearTimeout(timer);
  };
}

function start(): void {
  // Deny every browser permission (camera, mic, notifications…) until a feature explicitly needs one.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  const sessions = new SessionStore(join(app.getPath("userData"), "session.bin"), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  const windows = new WindowManager({
    rendererIndex: RENDERER_INDEX,
    devUrl: devServerUrl(),
    icon: existsSync(APP_ICON) ? APP_ICON : undefined,
  });
  const presence = new Presence({
    schedule,
    onChange: (mood) => {
      windows.broadcast(PUSH.presence, mood);
    },
  });
  const hub = new BrainHub({
    openSocket: openWebSocket,
    schedule,
    onEvent: (event) => {
      windows.broadcast(PUSH.brainEvent, event);
      presence.event(event);
    },
    onStatus: (status) => {
      windows.broadcast(PUSH.brainStatus, status);
      presence.status(status);
    },
    onSent: () => {
      presence.sent();
    },
    // Windows notifications arrive with the tray (task 8).
    onTurnFinished: () => undefined,
  });

  /** Paired or signed out: (re)connect, and tell every window. */
  function setSession(next: StoredSession | null): void {
    if (next === null) hub.disconnect();
    else hub.connect(next);
    windows.broadcast(PUSH.session, next);
  }

  function saveSession(raw: unknown): SaveSessionResult {
    const parsed = StoredSession.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "invalid_session" };
    try {
      sessions.save(parsed.data);
    } catch (error) {
      if (error instanceof EncryptionUnavailableError) return { ok: false, reason: "encryption_unavailable" };
      throw error;
    }
    setSession(parsed.data);
    return { ok: true };
  }

  registerIpc({
    isTrusted,
    session: {
      get: () => sessions.load(),
      save: saveSession,
      clear: () => {
        sessions.clear();
        setSession(null);
      },
    },
    windows,
    hub,
    presence,
  });
  windows.createMain({ show: true });
  const saved = sessions.load();
  if (saved !== null) hub.connect(saved);
}

void app.whenReady().then(start);
app.on("window-all-closed", () => {
  app.quit();
});
```

- [ ] **Step 6: Les pages**

`apps/desktop/src/renderer/src/lib/hub-client.ts` :
```ts
import type { SendMessage, ServerEvent } from "@alicia/protocol";
import type { BrainBridge } from "../../../shared/bridge.ts";
import type { ConnectionStatus } from "../../../shared/chat-connection.ts";
import { mirror } from "./mirror.ts";

export interface HubClientHandlers {
  onEvent(event: ServerEvent): void;
  onStatus(status: ConnectionStatus): void;
  /** A message the window believed sent did not reach the brain after all. */
  onUndelivered(requestId: string): void;
}

/** A window's view of the main process's brain connection; `send` stays synchronous like ChatConnection's. */
export class HubClient {
  readonly #bridge: BrainBridge;
  readonly #handlers: HubClientHandlers;
  #status: ConnectionStatus = "connecting";
  readonly #offs: (() => void)[] = [];
  #stopped = false;

  constructor(bridge: BrainBridge, handlers: HubClientHandlers) {
    this.#bridge = bridge;
    this.#handlers = handlers;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  start(): void {
    this.#stopped = false;
    this.#offs.push(
      this.#bridge.onEvent((event) => {
        this.#handlers.onEvent(event);
      }),
      mirror(
        () => this.#bridge.status(),
        (listener) => this.#bridge.onStatus(listener),
        (status) => {
          if (this.#stopped) return;
          this.#status = status;
          this.#handlers.onStatus(status);
        },
      ),
    );
  }

  stop(): void {
    this.#stopped = true;
    for (const off of this.#offs.splice(0)) off();
  }

  /** False when the connection is not ready; a refusal by the main process arrives later as `onUndelivered`. */
  send(message: SendMessage): boolean {
    if (this.#stopped || this.#status !== "ready") return false;
    this.#bridge.send(message).then(
      (delivered) => {
        if (!delivered && !this.#stopped) this.#handlers.onUndelivered(message.requestId);
      },
      () => {
        if (!this.#stopped) this.#handlers.onUndelivered(message.requestId);
      },
    );
    return true;
  }
}
```

`apps/desktop/src/renderer/src/lib/chat-store.svelte.ts` :
- dans `handle`, **avant** la ligne `if (isTurnEvent(event) && !this.#isCurrentTurn(event.conversationId)) return;`, ajouter :
```ts
    // Another window's turn (Holo, Spotlight) ended: the list may have changed, and maybe the open conversation.
    if (event.type === "done" && !this.#isCurrentTurn(event.conversationId)) {
      this.#otherTurnDone(event.conversationId);
      return;
    }
```
- ajouter après `connectionLost()` :
```ts
  /** The main process could not deliver the message `send` accepted: same outcome as a refused send. */
  undelivered(requestId: string): void {
    if (requestId !== this.#pendingRequestId) return;
    this.#endTurn();
    this.notice = "Alicia n'est pas joignable pour l'instant.";
    this.#setMascot("alert");
  }
```
- ajouter avant `#isCurrentTurn` :
```ts
  #otherTurnDone(conversationId: string): void {
    void this.refreshConversations();
    if (!this.busy && conversationId === this.activeId) void this.#loadHistory(conversationId);
  }
```

`apps/desktop/src/renderer/src/components/Shell.svelte` :
- remplacer l'import de `chat-connection.ts` par
```ts
  import type { ConnectionStatus } from "../../../shared/chat-connection.ts";
  import { HubClient } from "../lib/hub-client.ts";
```
- dans la création de `ChatStore`, remplacer `send: (message) => connection.send(message),` par `send: (message) => hub.send(message),` ;
- remplacer tout le bloc `const connection = new ChatConnection({ … });` par
```ts
  // The brain connection lives in the main process, shared with the Holo and Spotlight.
  const hub = new HubClient(window.alicia.brain, {
    onEvent: handleEvent,
    onStatus: handleStatus,
    onUndelivered: (requestId) => {
      store.undelivered(requestId);
    },
  });
```
- dans `onMount`, `connection.start();` devient `hub.start();` ; dans `onDestroy`, `connection.stop();` devient `hub.stop();`.

`apps/desktop/src/renderer/src/components/Composer.svelte` : sur le `<textarea>`, ajouter `oninput={() => { window.alicia.presence.typing(); }}` (l'Holo écoute pendant qu'on écrit).

`apps/desktop/src/renderer/src/App.svelte` : remplacer
```ts
  onMount(() => {
    void loadSession();
  });
```
par
```ts
  onMount(() => {
    void loadSession();
    // Signed out from another window (or by the main process): back to pairing here too.
    return window.alicia.onSessionChanged((next) => {
      if (next === null) {
        session = null;
      } else if (session?.token !== next.token) {
        session = next;
        notice = null;
      }
    });
  });
```

- [ ] **Step 7: Vérifier**

Run: `pnpm --filter @alicia/desktop test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout PASS, e2e compris (appairage, streaming, coupure et retour du cerveau, appareil révoqué, Souvenirs) : la connexion est maintenant dans le processus principal. Si « the app shows when the brain is away… » échoue, vérifier que `BrainHub` relaie bien `offline` puis `ready` (le minuteur de reconnexion est celui de `ChatConnection`, passé par `schedule`).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/shared/bridge.ts apps/desktop/src/shared/session.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/windows.ts apps/desktop/src/renderer/src/env.d.ts apps/desktop/src/renderer/src/lib/hub-client.ts apps/desktop/src/renderer/src/lib/chat-store.svelte.ts apps/desktop/src/renderer/src/components/Shell.svelte apps/desktop/src/renderer/src/components/Composer.svelte apps/desktop/src/renderer/src/App.svelte apps/desktop/test/hub-client.test.ts apps/desktop/test/chat-store.test.ts
git commit -m "feat(desktop): windows talk to the brain through the main process's single connection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Instance unique, zone de notification, fermer = cacher, notifications

**Files:**
- Create: `apps/desktop/src/main/electron-os.ts`, `apps/desktop/e2e/support.ts`, `apps/desktop/e2e/desktop.e2e.ts`
- Modify: `apps/desktop/src/main/windows.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/shared/bridge.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/components/Shell.svelte`, `apps/desktop/e2e/app.e2e.ts`

- [ ] **Step 1: Outils e2e partagés**

Les outils de `e2e/app.e2e.ts` déménagent dans `e2e/support.ts` (le fichier n'est pas un test : `vitest.e2e.config.ts` ne prend que `*.e2e.ts`) et gagnent ce qu'il faut pour plusieurs fenêtres et les crochets de test. Le code ci-dessous reprend `startBrain`, `pair`, `send` et `answered` tels qu'au 2026-10-04 : si le plan de durcissement les a modifiés depuis, garder leur version actuelle et n'y ajouter que les changements décrits ici (exports, scénarios multiples, `launch` qui rend `{ app, page }`).

`apps/desktop/e2e/support.ts` :
```ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterEach, expect } from "vitest";
import { type Application, buildApplication } from "../../brain/src/application.ts";
import { parseConfig } from "../../brain/src/config.ts";
import type { EngineEvent } from "../../brain/src/engine/engine.ts";
import { FakeEngine, type Scenario } from "../../brain/src/engine/fake-engine.ts";
import { FakeEmbedder } from "../../brain/src/memory/fake-embedder.ts";
import { RecordedState, TEST_HOOKS_KEY } from "../src/main/recording-os.ts";
import type { Surface } from "../src/shared/surface.ts";

export const MAIN = fileURLToPath(new URL("../out/main/index.js", import.meta.url));

/** Cleanups registered by the running test; each is best effort (Windows keeps files locked a little). */
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()?.();
    } catch {
      // A temporary directory left behind is harmless.
    }
  }
});

/** Poll options: the default of one second is too short for an app that animates and reconnects. */
export const POLL = { timeout: 15_000, interval: 50 };

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return dir;
}

export interface Brain {
  readonly engine: FakeEngine;
  readonly url: string;
  /** The running application (replaced by `restart`). */
  app: Application;
  stop: () => Promise<void>;
  /** Starts a fresh application on the same data and the same port. */
  restart: () => Promise<void>;
}

export const GREETING_EVENTS: readonly EngineEvent[] = [
  { type: "session", sessionId: "s1" },
  { type: "text", text: "Bonjour Kévin, " },
  { type: "text", text: "je suis là !" },
  { type: "done", inputTokens: 1, outputTokens: 2 },
];
export const GREETING: Scenario = () => GREETING_EVENTS;

/** A real brain on a free local port (never 8780), with a fake engine (by default, a greeting). */
export async function startBrain(...scenarios: Scenario[]): Promise<Brain> {
  const dataDir = tempDir("alicia-e2e-brain-");
  const config = parseConfig(`
dataDir: ${JSON.stringify(dataDir)}
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
`);
  const engine = new FakeEngine(...(scenarios.length > 0 ? scenarios : [GREETING]));
  const first = await buildApplication(config, engine, { embedder: new FakeEmbedder() });
  await first.server.listen({ port: 0, host: "127.0.0.1" });
  const port = (first.server.server.address() as AddressInfo).port;
  let running = true;
  const brain: Brain = {
    engine,
    url: `http://127.0.0.1:${port}`,
    app: first,
    stop: async () => {
      if (!running) return;
      running = false;
      await brain.app.close();
    },
    restart: async () => {
      await brain.stop();
      brain.app = await buildApplication(config, engine, { embedder: new FakeEmbedder() });
      await brain.app.server.listen({ port, host: "127.0.0.1" });
      running = true;
    },
  };
  cleanups.push(() => brain.stop());
  return brain;
}

/** The app's environment in tests: its own profile, and nothing that reaches the OS (see ALICIA_OS_INTEGRATION). */
export function appEnv(userData: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RENDERER_URL") env[key] = value;
  }
  return { ...env, ALICIA_USER_DATA: userData, ALICIA_OS_INTEGRATION: "off", ...extra };
}

export interface Launched {
  app: ElectronApplication;
  /** The main window. */
  page: Page;
}

export async function launch(userData: string, extraEnv: Readonly<Record<string, string>> = {}): Promise<Launched> {
  const app = await electron.launch({ args: [MAIN], env: appEnv(userData, extraEnv) });
  cleanups.push(async () => {
    await app.close();
  });
  return { app, page: await surfacePage(app, "main") };
}

function surfaceOfUrl(url: string): string | null {
  return URL.canParse(url) ? new URL(url).searchParams.get("surface") : null;
}

/** The page of one surface (main window, Holo or Spotlight bar), once its window exists. */
export async function surfacePage(app: ElectronApplication, surface: Surface): Promise<Page> {
  const deadline = Date.now() + POLL.timeout;
  for (;;) {
    const found = app.windows().find((page) => surfaceOfUrl(page.url()) === surface);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`No ${surface} window`);
    await new Promise((resolve) => setTimeout(resolve, POLL.interval));
  }
}

/** Whether the window of that surface is shown (read in the main process). */
export function windowVisible(app: ElectronApplication, surface: Surface): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }, wanted) =>
    BrowserWindow.getAllWindows().some((window) => {
      const url = window.webContents.getURL();
      return window.isVisible() && URL.canParse(url) && new URL(url).searchParams.get("surface") === wanted;
    }), surface);
}

export function windowBounds(app: ElectronApplication, surface: Surface): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }, wanted) => {
    const found = BrowserWindow.getAllWindows().find((window) => {
      const url = window.webContents.getURL();
      return URL.canParse(url) && new URL(url).searchParams.get("surface") === wanted;
    });
    if (found === undefined) throw new Error(`No ${wanted} window`);
    return found.getBounds();
  }, surface);
}

/** Closes a window the way its close button would (the main window then hides in the tray). */
export async function closeWindow(app: ElectronApplication, surface: Surface): Promise<void> {
  await app.evaluate(({ BrowserWindow }, wanted) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const url = window.webContents.getURL();
      if (URL.canParse(url) && new URL(url).searchParams.get("surface") === wanted) window.close();
    }
  }, surface);
}

export type HookName = "state" | "triggerShortcut" | "clickNotification" | "trayAction" | "trayClick";

/** Calls one of RecordingOs's test hooks in the main process. */
export function callHook(app: ElectronApplication, name: HookName, argument?: number | string): Promise<unknown> {
  return app.evaluate((_electron, [key, hook, arg]) => {
    const hooks: unknown = Reflect.get(globalThis, key);
    if (typeof hooks !== "object" || hooks === null) throw new Error("No test hooks: is ALICIA_OS_INTEGRATION=off?");
    const run: unknown = Reflect.get(hooks, hook);
    if (typeof run !== "function") throw new Error(`Unknown test hook ${hook}`);
    const result: unknown = Reflect.apply(run, hooks, arg === undefined ? [] : [arg]);
    return result;
  }, [TEST_HOOKS_KEY, name, argument] as const);
}

/** What the app asked of the OS so far (shortcuts, login item, notifications, tray menu). */
export async function recorded(app: ElectronApplication): Promise<RecordedState> {
  return RecordedState.parse(await callHook(app, "state"));
}

const electronBinary: unknown = createRequire(import.meta.url)("electron");

/** Starts Alicia again on the same profile, like a second click on its shortcut; resolves with its exit code. */
export function secondInstance(userData: string): Promise<number | null> {
  if (typeof electronBinary !== "string") throw new Error("Electron binary not found");
  const child = spawn(electronBinary, [MAIN], { env: appEnv(userData), stdio: "ignore" });
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => {
      resolve(code);
    });
    child.once("error", reject);
  });
}

/** A gate a fake engine scenario can wait on. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Pairs the app with the brain, typing the code the way a person reads it (with a space). */
export async function pair(page: Page, brain: Brain): Promise<void> {
  const code = brain.app.pairing.generateCode("kevin");
  await page.getByTestId("pairing-server").fill(brain.url);
  await page.getByTestId("pairing-code").fill(`${code.slice(0, 3)} ${code.slice(3)}`);
  await expect.poll(() => page.getByTestId("pairing-code").inputValue(), POLL).toBe(code);
  await page.getByTestId("pairing-submit").click();
  await page.getByTestId("chat-welcome").waitFor();
  // The welcome screen shows before the connection is ready: wait until the composer accepts messages.
  await expect.poll(() => page.getByTestId("composer-input").isEnabled(), POLL).toBe(true);
}

export async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
}

/** Waits until the `count`-th answer is complete (the typing caret is gone). */
export async function answered(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.getByTestId("message-assistant").count(), POLL).toBe(count);
  await expect.poll(() => page.locator(".caret").count(), POLL).toBe(0);
}
```

`apps/desktop/e2e/app.e2e.ts` :
- supprimer tout ce qui a déménagé (imports Node/Playwright/cerveau devenus inutiles, `MAIN`, `cleanups` et son `afterEach`, `POLL`, `tempDir`, `Brain`, `GREETING`, `startBrain`, `launch`, `pair`, `send`, `answered`) et importer à la place :
```ts
import type { Page } from "playwright";
import { expect, test } from "vitest";
import { callTool, type Scenario } from "../../brain/src/engine/fake-engine.ts";
import { answered, launch, pair, POLL, send, startBrain, tempDir } from "./support.ts";
```
- `launch` rend maintenant `{ app, page }` : dans le premier test, `const first = await launch(userData);` devient `const { app: firstApp, page: first } = await launch(userData);`, `await first.close();` devient `await firstApp.close();` (fermer la page ne quitte plus l'app : elle se cacherait dans la zone de notification), et `const second = await launch(userData);` devient `const { page: second } = await launch(userData);` ;
- dans les autres tests, `const page = await launch(…);` devient `const { page } = await launch(…);`.

- [ ] **Step 2: Écrire les tests de bout en bout (ils échouent)**

`apps/desktop/e2e/desktop.e2e.ts` :
```ts
import { expect, test } from "vitest";
import {
  callHook, closeWindow, deferred, GREETING_EVENTS, launch, pair, POLL, recorded, secondInstance, send, startBrain,
  tempDir, windowVisible,
} from "./support.ts";

test("closing the main window hides it in the tray; launching Alicia again brings it back", async () => {
  const userData = tempDir("alicia-e2e-profile-");
  const { app } = await launch(userData);
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);

  await closeWindow(app, "main");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(false);
  // Still running: the main process answers.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);

  // A second launch on the same profile gives way to the first one, which shows itself.
  expect(await secondInstance(userData)).toBe(0);
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
});

test("the tray menu opens Alicia and switches launch at startup", async () => {
  const { app } = await launch(tempDir("alicia-e2e-profile-"));
  expect((await recorded(app)).tray.map((item) => item.label)).toEqual([
    "Ouvrir Alicia", "Afficher l'Holo", "Lancer au démarrage", "Quitter Alicia",
  ]);

  await callHook(app, "trayAction", "toggle-startup");
  await expect.poll(async () => (await recorded(app)).loginItem, POLL).toBe(true);
  expect((await recorded(app)).tray.find((item) => item.id === "toggle-startup")?.checked).toBe(true);

  await closeWindow(app, "main");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(false);
  await callHook(app, "trayClick");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
  await closeWindow(app, "main");
  await callHook(app, "trayAction", "open");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
});

test("an answer arriving while the window is hidden becomes a notification that brings it back", async () => {
  const gate = deferred();
  const brain = await startBrain(() => GREETING_EVENTS, async () => {
    await gate.promise;
    return GREETING_EVENTS;
  });
  const { app, page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);

  // Window visible: no notification.
  await send(page, "Salut");
  await page.getByTestId("message-assistant").filter({ hasText: "je suis là !" }).waitFor();
  expect((await recorded(app)).notifications).toEqual([]);

  // Hidden while Alicia answers: notification, whose click shows the window again.
  await send(page, "Tu es toujours là ?");
  await page.getByTestId("message-user").filter({ hasText: "Tu es toujours là ?" }).waitFor();
  await closeWindow(app, "main");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(false);
  gate.resolve();
  await expect.poll(async () => (await recorded(app)).notifications, POLL).toEqual([
    { title: "Alicia", body: "Bonjour Kévin, je suis là !" },
  ]);
  await callHook(app, "clickNotification", 0);
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
  await expect.poll(() => page.getByTestId("message-assistant").count(), POLL).toBe(2);
});
```

Run: `pnpm --filter @alicia/desktop test:e2e`
Expected: `app.e2e.ts` PASS (refactor seul) ; `desktop.e2e.ts` FAIL (la fenêtre se ferme et l'app quitte, pas de crochets de test).

- [ ] **Step 3: L'intégration Electron du système**

`apps/desktop/src/main/electron-os.ts` :
```ts
import {
  app, globalShortcut, Menu, type MenuItemConstructorOptions, nativeImage, Notification, Tray,
} from "electron";
import type { OsIntegration, TrayHandle } from "./os-integration.ts";
import type { TrayAction, TrayItem } from "./tray-menu.ts";

function menuTemplate(items: readonly TrayItem[], onAction: (action: TrayAction) => void): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    if (item.id === "separator") return { type: "separator" };
    const action = item.id;
    return {
      label: item.label,
      type: item.checked === null ? "normal" : "checkbox",
      checked: item.checked ?? false,
      enabled: item.enabled,
      click: () => {
        onAction(action);
      },
    };
  });
}

/** The real OS: global shortcut, Windows login item, notifications and the notification-area icon. */
export function electronOs(options: { trayIcon: string; notificationIcon: string }): OsIntegration {
  /** Kept until clicked or dismissed: a garbage-collected notification loses its click handler. */
  const shown = new Set<Notification>();
  let tray: Tray | null = null;
  return {
    registerShortcut: (accelerator, run) => {
      try {
        return globalShortcut.register(accelerator, run);
      } catch {
        return false;
      }
    },
    unregisterShortcut: (accelerator) => {
      globalShortcut.unregister(accelerator);
    },
    // Only the installed app registers itself with Windows: a dev build never writes a login item.
    setLoginItem: (openAtLogin) => {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] });
    },
    notify: (request) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        title: request.title,
        body: request.body,
        icon: nativeImage.createFromPath(options.notificationIcon),
      });
      shown.add(notification);
      notification.on("click", () => {
        shown.delete(notification);
        request.onClick();
      });
      notification.on("close", () => {
        shown.delete(notification);
      });
      notification.show();
    },
    createTray: (items, onAction, onClick): TrayHandle => {
      const created = new Tray(nativeImage.createFromPath(options.trayIcon));
      created.setToolTip("Alicia");
      created.on("click", () => {
        onClick();
      });
      const update = (next: readonly TrayItem[]): void => {
        created.setContextMenu(Menu.buildFromTemplate(menuTemplate(next, onAction)));
      };
      update(items);
      tray = created;
      return { update };
    },
    dispose: () => {
      globalShortcut.unregisterAll();
      tray?.destroy();
      tray = null;
    },
  };
}
```
Si TypeScript ne restreint pas `item.id` après le test `"separator"`, écrire `const { id } = item; if (id === "separator") …` et utiliser `id`.

- [ ] **Step 4: Fenêtre principale qui se cache, contrat `app` du pont**

`apps/desktop/src/main/windows.ts` :
- importer `import { PUSH } from "../shared/bridge.ts";` et `import type { Visibility } from "./turn-notifications.ts";` ;
- ajouter le champ `#quitting = false;` et les méthodes publiques :
```ts
  /** Quitting for real (tray, update, Windows shutting down): windows may now close. */
  prepareQuit(): void {
    this.#quitting = true;
  }

  /** Brings the main window forward (second launch, tray, notification click). */
  showMain(): void {
    const window = this.#main;
    if (window === null || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  /** Asks the main window to show a conversation (it is already shown by then). */
  openConversation(conversationId: string): void {
    const window = this.#main;
    if (window !== null && !window.isDestroyed()) window.webContents.send(PUSH.openConversation, conversationId);
  }

  /** What the person can see right now (decides notifications). */
  visibility(): Visibility {
    return { main: this.#mainVisible(), holoChat: false };
  }

  #mainVisible(): boolean {
    const window = this.#main;
    return window !== null && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
  }
```
- dans `createMain`, juste après la création de la fenêtre :
```ts
    // Closing the window keeps Alicia running in the notification area.
    window.on("close", (event) => {
      if (this.#quitting) return;
      event.preventDefault();
      window.hide();
    });
```

`apps/desktop/src/shared/bridge.ts` : ajouter
```ts
export interface AppBridge {
  version(): Promise<string>;
  showMain(): Promise<void>;
  /** Shows the main window on this conversation. */
  openConversation(conversationId: string): Promise<void>;
  /** A notification (or another window) asks the main window to show a conversation. */
  onOpenConversation(listener: (conversationId: string) => void): Unsubscribe;
}
```
le champ `app: AppBridge;` dans `AliciaBridge`, les entrées `appVersion: "app:version"`, `showMain: "app:show-main"`, `openConversation: "app:open-conversation"` dans `INVOKE` et `openConversation: "push:open-conversation"` dans `PUSH`.

`apps/desktop/src/preload/index.ts` : ajouter dans `bridge`
```ts
  app: {
    version: () => call(z.string(), INVOKE.appVersion),
    showMain: () => call(z.undefined(), INVOKE.showMain),
    openConversation: (conversationId) => call(z.undefined(), INVOKE.openConversation, conversationId),
    onOpenConversation: (listener) => subscribe(PUSH.openConversation, z.uuid(), listener),
  },
```

`apps/desktop/src/main/ipc.ts` : importer `app` depuis `electron` et ajouter dans `registerIpc`
```ts
  handle(INVOKE.appVersion, NONE, () => app.getVersion());
  handle(INVOKE.showMain, NONE, () => {
    deps.windows.showMain();
  });
  handle(INVOKE.openConversation, z.uuid(), (conversationId) => {
    deps.windows.showMain();
    deps.windows.openConversation(conversationId);
  });
```

`apps/desktop/src/renderer/src/components/Shell.svelte` : remplacer le `onMount` par
```ts
  onMount(() => {
    hub.start();
    void store.refreshConversations();
    // A notification or the Holo asks for a conversation.
    return window.alicia.app.onOpenConversation((conversationId) => {
      openConversation(conversationId);
    });
  });
```

- [ ] **Step 5: L'assemblage du processus principal (réécriture complète de `index.ts`, puis reconversion CRLF)**

`apps/desktop/src/main/index.ts` :
```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, type IpcMainInvokeEvent, safeStorage, session } from "electron";
import { PUSH } from "../shared/bridge.ts";
import { openWebSocket } from "../shared/chat-connection.ts";
import { type SaveSessionResult, StoredSession } from "../shared/session.ts";
import { BrainHub } from "./brain-hub.ts";
import { electronOs } from "./electron-os.ts";
import { registerIpc } from "./ipc.ts";
import type { OsIntegration, TrayHandle } from "./os-integration.ts";
import { Presence } from "./presence.ts";
import { RecordingOs, TEST_HOOKS_KEY } from "./recording-os.ts";
import { EncryptionUnavailableError, SessionStore } from "./session-store.ts";
import { SettingsController } from "./settings-controller.ts";
import { SettingsStore } from "./settings-store.ts";
import { type TrayAction, type TrayItem, trayMenuItems } from "./tray-menu.ts";
import { isTrustedSenderUrl } from "./trusted-sender.ts";
import { notificationFor } from "./turn-notifications.ts";
import { WindowManager } from "./windows.ts";

const RENDERER_INDEX = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
/** Mascot head icon (design/mascotte/icone/v1), packaged with the app (electron-builder `files`). */
const ICON_PNG = join(app.getAppPath(), "build", "icon.png");
/** Multi-size icon, sharp in the notification area. */
const ICON_ICO = join(app.getAppPath(), "build", "icon.ico");
// Own taskbar identity on Windows (and the installer's shortcut uses the same id, for notifications).
app.setAppUserModelId("fr.pandarvis.alicia");

// Lets the end-to-end test isolate its profile; ignored in a packaged app. Must run before the single-instance lock.
const userDataOverride = process.env["ALICIA_USER_DATA"];
if (!app.isPackaged && userDataOverride !== undefined) app.setPath("userData", userDataOverride);

/**
 * Tests (unpackaged only) turn off everything that reaches outside the app: global shortcut, login item,
 * notification-area icon, Windows notifications, mDNS. A recorder stands in, exposed as globalThis.__aliciaTest.
 */
const osIntegrationOff = !app.isPackaged && process.env["ALICIA_OS_INTEGRATION"] === "off";
/** Started by Windows at login (login item argument): stay in the notification area. */
const startHidden = process.argv.includes("--hidden");

/** The dev server URL, only ever honoured when running unpackaged. */
function devServerUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
}

/** Only our own page (whatever its `?surface=`) may talk to the main process. */
function isTrusted(event: IpcMainInvokeEvent): boolean {
  return isTrustedSenderUrl(event.senderFrame?.url, {
    rendererFileUrl: pathToFileURL(RENDERER_INDEX).href,
    devUrl: devServerUrl(),
  });
}

function schedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => {
    clearTimeout(timer);
  };
}

function start(): void {
  // Deny every browser permission (camera, mic, web notifications…) until a feature explicitly needs one.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  const recording = osIntegrationOff ? new RecordingOs() : null;
  if (recording !== null) Reflect.set(globalThis, TEST_HOOKS_KEY, recording.hooks());
  const os: OsIntegration = recording ?? electronOs({ trayIcon: ICON_ICO, notificationIcon: ICON_PNG });

  const sessions = new SessionStore(join(app.getPath("userData"), "session.bin"), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  let current: StoredSession | null = sessions.load();
  let tray: TrayHandle | null = null;

  const windows = new WindowManager({
    rendererIndex: RENDERER_INDEX,
    devUrl: devServerUrl(),
    icon: existsSync(ICON_PNG) ? ICON_PNG : undefined,
  });
  const presence = new Presence({
    schedule,
    onChange: (mood) => {
      windows.broadcast(PUSH.presence, mood);
    },
  });
  const hub = new BrainHub({
    openSocket: openWebSocket,
    schedule,
    onEvent: (event) => {
      windows.broadcast(PUSH.brainEvent, event);
      presence.event(event);
    },
    onStatus: (status) => {
      windows.broadcast(PUSH.brainStatus, status);
      presence.status(status);
    },
    onSent: () => {
      presence.sent();
    },
    onTurnFinished: (turn) => {
      const notification = notificationFor(turn, windows.visibility());
      if (notification === null) return;
      os.notify({
        title: notification.title,
        body: notification.body,
        onClick: () => {
          windows.showMain();
          if (notification.openConversation && notification.conversationId !== undefined) {
            windows.openConversation(notification.conversationId);
          }
        },
      });
    },
  });
  const settings = new SettingsController(new SettingsStore(join(app.getPath("userData"), "settings.json")), {
    // Until the Spotlight bar exists (task 10), the shortcut brings Alicia's window forward.
    registerShortcut: (accelerator) =>
      os.registerShortcut(accelerator, () => {
        windows.showMain();
      }),
    unregisterShortcut: (accelerator) => {
      os.unregisterShortcut(accelerator);
    },
    setLoginItem: (openAtLogin) => {
      os.setLoginItem(openAtLogin);
    },
    onChange: () => {
      refreshTray();
    },
  });

  function trayItems(): TrayItem[] {
    const { showHolo, launchAtStartup } = settings.snapshot.settings;
    return trayMenuItems({ paired: current !== null, showHolo, launchAtStartup, updateReady: false });
  }

  function refreshTray(): void {
    tray?.update(trayItems());
  }

  function onTrayAction(action: TrayAction): void {
    switch (action) {
      case "open":
        windows.showMain();
        return;
      case "toggle-holo":
        settings.update({ showHolo: !settings.snapshot.settings.showHolo });
        return;
      case "toggle-startup":
        settings.update({ launchAtStartup: !settings.snapshot.settings.launchAtStartup });
        return;
      case "install-update":
        // Offered once updates exist (task 15).
        return;
      case "quit":
        app.quit();
        return;
    }
  }

  /** Paired or signed out: (re)connect, and tell every window. */
  function setSession(next: StoredSession | null): void {
    current = next;
    if (next === null) hub.disconnect();
    else hub.connect(next);
    windows.broadcast(PUSH.session, next);
    refreshTray();
  }

  function saveSession(raw: unknown): SaveSessionResult {
    const parsed = StoredSession.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "invalid_session" };
    try {
      sessions.save(parsed.data);
    } catch (error) {
      if (error instanceof EncryptionUnavailableError) return { ok: false, reason: "encryption_unavailable" };
      throw error;
    }
    setSession(parsed.data);
    return { ok: true };
  }

  registerIpc({
    isTrusted,
    session: {
      get: () => sessions.load(),
      save: saveSession,
      clear: () => {
        sessions.clear();
        setSession(null);
      },
    },
    windows,
    hub,
    presence,
  });

  windows.createMain({ show: !startHidden });
  tray = os.createTray(trayItems(), onTrayAction, () => {
    windows.showMain();
  });
  settings.start();
  if (current !== null) hub.connect(current);

  app.on("second-instance", () => {
    windows.showMain();
  });
  app.on("before-quit", () => {
    windows.prepareQuit();
  });
  app.on("will-quit", () => {
    hub.disconnect();
    os.dispose();
  });
}

// One Alicia per Windows session (per profile): a second launch only brings the first one forward.
if (app.requestSingleInstanceLock()) {
  void app.whenReady().then(start);
} else {
  app.quit();
}
app.on("window-all-closed", () => {
  app.quit();
});
```

- [ ] **Step 6: Vérifier**

Run: `pnpm --filter @alicia/desktop test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout PASS. Si `app.close()` de Playwright reste bloqué, c'est que la fermeture des fenêtres est interceptée sans `before-quit` : vérifier (superpowers:systematic-debugging) que `prepareQuit()` est bien appelé avant la fermeture des fenêtres, plutôt que de contourner dans le test.

- [ ] **Step 7: Vérification manuelle rapide (développement)**

Run: `pnpm --filter @alicia/desktop dev` puis fermer la fenêtre : l'icône Alicia reste dans la zone de notification ; clic gauche = la fenêtre revient ; clic droit = le menu. Quitter par le menu. (En développement, « Lancer au démarrage » est enregistré dans les réglages mais n'écrit rien dans Windows.)

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/electron-os.ts apps/desktop/src/main/windows.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/shared/bridge.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/components/Shell.svelte apps/desktop/e2e/support.ts apps/desktop/e2e/app.e2e.ts apps/desktop/e2e/desktop.e2e.ts
git commit -m "feat(desktop): single instance, notification-area icon, close to tray, notifications for unseen answers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: L'Holo détaché

**Files:**
- Create: `apps/desktop/src/renderer/src/HoloApp.svelte`, `apps/desktop/src/renderer/src/components/HoloChat.svelte`, `apps/desktop/src/renderer/src/lib/mini-chat.svelte.ts`
- Modify: `apps/desktop/src/main/windows.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/shared/bridge.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/main.ts`, `apps/desktop/src/renderer/src/app.css`
- Test: `apps/desktop/e2e/desktop.e2e.ts`

- [ ] **Step 1: Écrire le test de bout en bout (il échoue)**

Ajouter à `apps/desktop/e2e/desktop.e2e.ts` (compléter l'import depuis `./support.ts` avec `surfacePage` et `windowBounds`) :
```ts
test("Holo: follows Alicia's mood, opens a mini-chat, hides from the tray, and keeps its place", async () => {
  const gate = deferred();
  const brain = await startBrain(async () => {
    await gate.promise;
    return GREETING_EVENTS;
  });
  const userData = tempDir("alicia-e2e-profile-");
  const { app, page } = await launch(userData);
  await pair(page, brain);

  const holo = await surfacePage(app, "holo");
  await expect.poll(() => windowVisible(app, "holo"), POLL).toBe(true);
  const mood = (): Promise<string | null> => holo.getByTestId("holo-mascot").getByTestId("mascot").getAttribute("data-mood");
  await expect.poll(mood, POLL).toBe("idle");

  // A turn from the main window: the Holo thinks, then celebrates, then rests.
  await send(page, "Salut");
  await expect.poll(mood, POLL).toBe("thinking");
  gate.resolve();
  await expect.poll(mood, POLL).toBe("success");
  await expect.poll(mood, POLL).toBe("idle");

  // A click opens the mini-chat, which talks to the same Alicia.
  await holo.getByTestId("holo-mascot").click();
  await holo.getByTestId("holo-chat").waitFor();
  expect((await windowBounds(app, "holo")).width).toBeGreaterThan(400);
  await expect.poll(() => holo.getByTestId("holo-input").isEnabled(), POLL).toBe(true);
  await holo.getByTestId("holo-input").fill("Et toi ?");
  await holo.getByTestId("holo-input").press("Enter");
  await holo.getByTestId("holo-message-assistant").filter({ hasText: "je suis là !" }).waitFor();
  // Its answer reached the open mini-chat: no notification.
  expect((await recorded(app)).notifications).toEqual([]);
  await holo.getByTestId("holo-chat-close").click();
  await holo.getByTestId("holo-chat").waitFor({ state: "detached" });
  await expect.poll(async () => (await windowBounds(app, "holo")).width, POLL).toBe(136);

  // Moved by hand (the drag itself is unit-tested), hidden and shown again from the tray.
  await holo.evaluate(async () => {
    await window.alicia.holo.dragStart();
    await window.alicia.holo.dragTo({ dx: -300, dy: -200 });
    await window.alicia.holo.dragEnd();
  });
  const moved = await windowBounds(app, "holo");
  await callHook(app, "trayAction", "toggle-holo");
  await expect.poll(() => windowVisible(app, "holo"), POLL).toBe(false);
  await callHook(app, "trayAction", "toggle-holo");
  await expect.poll(() => windowVisible(app, "holo"), POLL).toBe(true);
  await app.close();

  // Its place is remembered.
  const again = await launch(userData);
  await surfacePage(again.app, "holo");
  await expect.poll(() => windowVisible(again.app, "holo"), POLL).toBe(true);
  expect(await windowBounds(again.app, "holo")).toEqual(moved);
});
```

Run: `pnpm --filter @alicia/desktop test:e2e`
Expected: FAIL (`No holo window`).

- [ ] **Step 2: Contrat du pont pour l'Holo**

`apps/desktop/src/shared/bridge.ts` : importer `import type { DragDelta, HoloView } from "./holo.ts";` et ajouter
```ts
/** For the floating windows (Holo, Spotlight): entrance and exit animations around show/hide. */
export interface SurfaceBridge {
  /** The window was just shown: play the entrance. */
  onShown(listener: () => void): Unsubscribe;
  /** The main process wants this window hidden: play the exit, then call hideSelf. */
  onHideRequest(listener: () => void): Unsubscribe;
  hideSelf(): Promise<void>;
}

export interface HoloBridge {
  dragStart(): Promise<void>;
  /** Offset from where the drag started, in screen pixels. */
  dragTo(delta: DragDelta): Promise<void>;
  /** Ends the drag; the new place is remembered. */
  dragEnd(): Promise<void>;
  /** Grows or shrinks the window around the mascot; answers how to lay the page out. */
  setExpanded(expanded: boolean): Promise<HoloView>;
}
```
les champs `surface: SurfaceBridge;` et `holo: HoloBridge;` dans `AliciaBridge`, les entrées `hideSelf: "window:hide-self"`, `holoDragStart: "holo:drag-start"`, `holoDragTo: "holo:drag-to"`, `holoDragEnd: "holo:drag-end"`, `holoSetExpanded: "holo:set-expanded"` dans `INVOKE`, et `shown: "push:shown"`, `hideRequest: "push:hide-request"` dans `PUSH`.

`apps/desktop/src/preload/index.ts` : importer `import { HoloView } from "../shared/holo.ts";` et ajouter dans `bridge`
```ts
  surface: {
    onShown: (listener) => subscribe(PUSH.shown, z.undefined(), () => {
      listener();
    }),
    onHideRequest: (listener) => subscribe(PUSH.hideRequest, z.undefined(), () => {
      listener();
    }),
    hideSelf: () => call(z.undefined(), INVOKE.hideSelf),
  },
  holo: {
    dragStart: () => call(z.undefined(), INVOKE.holoDragStart),
    dragTo: (delta) => call(z.undefined(), INVOKE.holoDragTo, delta),
    dragEnd: () => call(z.undefined(), INVOKE.holoDragEnd),
    setExpanded: (expanded) => call(HoloView, INVOKE.holoSetExpanded, expanded),
  },
```

`apps/desktop/src/main/ipc.ts` : importer `import { DragDelta } from "../shared/holo.ts";` et `import type { SettingsController } from "./settings-controller.ts";`, ajouter `settings: SettingsController;` à `IpcDependencies`, puis dans `registerIpc` :
```ts
  /** The Holo's own calls are refused from any other window. */
  function holoOnly(sender: WebContents): void {
    if (surfaceOf(sender) !== "holo") throw new Error("Holo only");
  }

  handle(INVOKE.hideSelf, NONE, (_none, sender) => {
    deps.windows.hideSelf(sender);
  });
  handle(INVOKE.holoDragStart, NONE, (_none, sender) => {
    holoOnly(sender);
    deps.windows.holoDragStart();
  });
  handle(INVOKE.holoDragTo, DragDelta, (delta, sender) => {
    holoOnly(sender);
    deps.windows.holoDragTo(delta);
  });
  handle(INVOKE.holoDragEnd, NONE, (_none, sender) => {
    holoOnly(sender);
    const anchor = deps.windows.holoDragEnd();
    if (anchor !== null) deps.settings.setHoloAnchor(anchor);
  });
  handle(INVOKE.holoSetExpanded, z.boolean(), (expanded, sender) => {
    holoOnly(sender);
    return deps.windows.setHoloExpanded(expanded);
  });
```

- [ ] **Step 3: La fenêtre de l'Holo**

`apps/desktop/src/main/windows.ts` :
- imports : `screen` en plus depuis `electron` ; `import type { DragDelta, HoloView, Point } from "../shared/holo.ts";` ; `import { clampAnchor, defaultAnchor, HOLO_SIZE, type HoloLayout, holoLayout, type Rect } from "./layout.ts";`
- au niveau du module :
```ts
/** A window asked to fade out hides anyway after this delay. */
const HIDE_FALLBACK_MS = 400;

/** The work area of the screen closest to a point (the Holo may live on any screen). */
function workAreaNear(point: Point): Rect {
  return screen.getDisplayNearestPoint(point).workArea;
}
```
- `WindowManagerOptions` gagne :
```ts
  /** Alt+F4 on the Holo: the person does not want it any more (same as unticking it). */
  onHoloDismissed(): void;
```
- champs :
```ts
  #holo: BrowserWindow | null = null;
  #anchor: Point | null = null;
  #expanded = false;
  #dragOrigin: Point | null = null;
  /** Windows asked to fade out, with their fallback timer. */
  readonly #hiding = new Map<BrowserWindow, ReturnType<typeof setTimeout>>();
```
- `surfaceOf` reconnaît toutes les fenêtres :
```ts
  surfaceOf(contents: WebContents): Surface | undefined {
    const windows: [BrowserWindow | null, Surface][] = [[this.#main, "main"], [this.#holo, "holo"]];
    for (const [window, surface] of windows) {
      if (window !== null && !window.isDestroyed() && window.webContents === contents) return surface;
    }
    return undefined;
  }
```
- `#windows()` renvoie `[this.#main, this.#holo].filter(…)` ;
- `visibility()` devient :
```ts
  visibility(): Visibility {
    const holo = this.#holo;
    const holoShown = holo !== null && !holo.isDestroyed() && holo.isVisible();
    return { main: this.#mainVisible(), holoChat: holoShown && this.#expanded };
  }
```
- méthodes publiques :
```ts
  /** The remembered place of the Holo (null: default corner). */
  setHoloAnchor(anchor: Point | null): void {
    this.#anchor = anchor;
  }

  setHoloVisible(visible: boolean): void {
    const current = this.#holo;
    if (!visible) {
      if (current !== null && !current.isDestroyed() && current.isVisible()) this.#requestHide(current);
      return;
    }
    const window = this.#ensureHolo();
    const wasHiding = this.#cancelHide(window);
    if (window.isVisible()) {
      // Shown again while fading out: fade back in.
      if (wasHiding) window.webContents.send(PUSH.shown);
      return;
    }
    this.#expanded = false;
    this.#layoutHolo();
    // Never steals the focus from what the person is doing.
    window.showInactive();
    this.#sendWhenLoaded(window, PUSH.shown);
  }

  holoDragStart(): void {
    this.#dragOrigin = this.#holoAnchor();
  }

  holoDragTo(delta: DragDelta): void {
    const origin = this.#dragOrigin;
    if (origin === null) return;
    const target = { x: Math.round(origin.x + delta.dx), y: Math.round(origin.y + delta.dy) };
    this.#anchor = clampAnchor(target, workAreaNear(target));
    this.#layoutHolo();
  }

  /** The place to remember, or null when no drag was going on. */
  holoDragEnd(): Point | null {
    if (this.#dragOrigin === null) return null;
    this.#dragOrigin = null;
    return this.#holoAnchor();
  }

  setHoloExpanded(expanded: boolean): HoloView {
    this.#expanded = expanded;
    const layout = this.#layoutHolo();
    const holo = this.#holo;
    if (expanded && holo !== null && !holo.isDestroyed()) holo.focus();
    return { expanded, panelSide: layout.panelSide, mascot: layout.mascot };
  }

  /** The page finished its exit animation. The Holo only hides when the main process asked for it. */
  hideSelf(contents: WebContents): void {
    const window = this.#windows().find((candidate) => candidate !== this.#main && candidate.webContents === contents);
    if (window === undefined) return;
    if (window === this.#holo && !this.#hiding.has(window)) return;
    this.#finishHide(window);
  }
```
- méthodes privées :
```ts
  #holoAnchor(): Point {
    const anchor = this.#anchor ?? defaultAnchor(screen.getPrimaryDisplay().workArea);
    return clampAnchor(anchor, workAreaNear(anchor));
  }

  #layoutHolo(): HoloLayout {
    const anchor = this.#holoAnchor();
    const layout = holoLayout(anchor, this.#expanded, workAreaNear(anchor));
    const holo = this.#holo;
    if (holo !== null && !holo.isDestroyed()) holo.setBounds(layout.bounds);
    return layout;
  }

  #ensureHolo(): BrowserWindow {
    const existing = this.#holo;
    if (existing !== null && !existing.isDestroyed()) return existing;
    const window = new BrowserWindow({
      ...HOLO_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: secureWebPreferences(),
    });
    window.setAlwaysOnTop(true, "floating");
    window.on("close", (event) => {
      if (this.#quitting) return;
      event.preventDefault();
      this.#options.onHoloDismissed();
    });
    this.#harden(window);
    this.#load(window, "holo");
    this.#holo = window;
    return window;
  }

  /** Asks the page to play its exit; it calls hideSelf when done (or the window hides anyway shortly after). */
  #requestHide(window: BrowserWindow): void {
    if (this.#hiding.has(window)) return;
    this.#hiding.set(window, setTimeout(() => {
      this.#finishHide(window);
    }, HIDE_FALLBACK_MS));
    window.webContents.send(PUSH.hideRequest);
  }

  /** True when a fade-out was going on. */
  #cancelHide(window: BrowserWindow): boolean {
    const timer = this.#hiding.get(window);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.#hiding.delete(window);
    return true;
  }

  #finishHide(window: BrowserWindow): void {
    this.#cancelHide(window);
    if (window.isDestroyed()) return;
    window.hide();
    if (window === this.#holo) {
      this.#expanded = false;
      this.#layoutHolo();
    }
  }

  /** Sends once the page is loaded (a push sent earlier would be lost). */
  #sendWhenLoaded(window: BrowserWindow, channel: string): void {
    const contents = window.webContents;
    if (contents.isLoading()) {
      contents.once("did-finish-load", () => {
        contents.send(channel);
      });
    } else {
      contents.send(channel);
    }
  }
```

`apps/desktop/src/main/index.ts` :
- `new WindowManager({ … })` reçoit en plus :
```ts
    onHoloDismissed: () => {
      settings.update({ showHolo: false });
    },
```
- ajouter, après `refreshTray` :
```ts
  /** The Holo floats on the desktop when the device is paired and the person wants it. */
  function applyHolo(): void {
    windows.setHoloVisible(current !== null && settings.snapshot.settings.showHolo);
  }
```
- `onChange` des réglages devient `onChange: () => { applyHolo(); refreshTray(); },` ;
- dans `setSession`, appeler `applyHolo();` après la diffusion ;
- passer `settings` à `registerIpc({ … })` ;
- après `windows.createMain({ show: !startHidden });` :
```ts
  windows.setHoloAnchor(settings.snapshot.settings.holoAnchor);
  applyHolo();
```

- [ ] **Step 4: La page de l'Holo**

`apps/desktop/src/renderer/src/main.ts` :
```ts
// Must stay the first import: it configures Zod before any schema is created.
import "./zod-config.ts";
import { mount } from "svelte";
import { parseSurface } from "../../shared/surface.ts";
import App from "./App.svelte";
import HoloApp from "./HoloApp.svelte";
import "./app.css";

const surface = parseSurface(new URLSearchParams(location.search).get("surface"));
document.documentElement.dataset["surface"] = surface;
const target = document.getElementById("app");
if (target === null) throw new Error("Missing #app element");
if (surface === "holo") mount(HoloApp, { target });
else mount(App, { target });
```

`apps/desktop/src/renderer/src/app.css` : ajouter
```css
/* The Holo and the Spotlight bar float on the desktop: their windows are transparent. */
:root[data-surface="holo"],
:root[data-surface="spotlight"] { background: transparent; }
:root[data-surface="holo"] body,
:root[data-surface="spotlight"] body { overflow: hidden; user-select: none; }
```

`apps/desktop/src/renderer/src/lib/mini-chat.svelte.ts` :
```ts
import type { BrainBridge } from "../../../shared/bridge.ts";
import type { ConnectionStatus } from "../../../shared/chat-connection.ts";
import type { StoredSession } from "../../../shared/session.ts";
import { BrainApi } from "./brain-client.ts";
import { ChatStore } from "./chat-store.svelte.ts";
import { HubClient } from "./hub-client.ts";

function schedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => {
    clearTimeout(timer);
  };
}

/** The Holo's own conversation, over the main process's shared connection. */
export class MiniChat {
  status = $state<ConnectionStatus>("connecting");
  readonly store: ChatStore;
  readonly #hub: HubClient;

  constructor(session: StoredSession, bridge: BrainBridge, fetchFn: typeof fetch) {
    const api = new BrainApi(fetchFn, session);
    const hub = new HubClient(bridge, {
      onEvent: (event) => {
        this.store.handle(event);
      },
      onStatus: (status) => {
        this.status = status;
        if (status === "offline") this.store.connectionLost();
      },
      onUndelivered: (requestId) => {
        this.store.undelivered(requestId);
      },
    });
    this.store = new ChatStore({
      listConversations: () => api.listConversations(),
      history: (id) => api.history(id),
      send: (message) => hub.send(message),
      deleteConversation: (id) => api.deleteConversation(id),
      newId: () => crypto.randomUUID(),
      schedule,
    });
    this.#hub = hub;
  }

  start(): void {
    this.#hub.start();
  }

  stop(): void {
    this.#hub.stop();
  }
}
```

`apps/desktop/src/renderer/src/components/HoloChat.svelte` :
```svelte
<script lang="ts">
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import type { MiniChat } from "../lib/mini-chat.svelte.ts";
  import { motion, scrollBehavior } from "../lib/motion.ts";

  let { chat, onClose }: { chat: MiniChat; onClose: () => void } = $props();

  let text = $state("");
  let input = $state<HTMLTextAreaElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  const store = $derived(chat.store);
  const ready = $derived(chat.status === "ready");
  /** Changes whenever a message is added or grows: the list then follows its end. */
  const tail = $derived(`${store.messages.length}:${store.messages.at(-1)?.text.length ?? 0}`);
  let seenTail = "";

  onMount(() => {
    input?.focus();
  });

  $effect(() => {
    if (list === null || tail === seenTail) return;
    seenTail = tail;
    list.scrollTo({ top: list.scrollHeight, behavior: scrollBehavior() });
  });

  function submit(): void {
    if (store.send(text)) text = "";
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  function openInApp(): void {
    const id = store.activeId;
    if (id === null) void window.alicia.app.showMain();
    else void window.alicia.app.openConversation(id);
  }
</script>

<section class="chat" aria-label="Discussion avec Alicia" data-testid="holo-chat">
  <header>
    <span class="title">Alicia</span>
    <button class="icon" onclick={() => { store.startNew(); }} disabled={store.busy} title="Nouvelle conversation" aria-label="Nouvelle conversation" data-testid="holo-chat-new"><Plus size={15} aria-hidden="true" /></button>
    <button class="icon" onclick={openInApp} title="Ouvrir dans l'app" aria-label="Ouvrir dans l'app" data-testid="holo-chat-open"><ExternalLink size={15} aria-hidden="true" /></button>
    <button class="icon" onclick={onClose} title="Fermer" aria-label="Fermer la discussion" data-testid="holo-chat-close"><X size={15} aria-hidden="true" /></button>
  </header>
  <div class="messages" bind:this={list}>
    {#each store.messages as message (message.id)}
      <p class="bubble {message.role}" data-testid="holo-message-{message.role}" in:fade={{ duration: motion(150) }}>
        {message.text}{#if message.streaming}<span class="caret"></span>{/if}
      </p>
    {:else}
      <p class="empty" in:fade={{ duration: motion(150) }}>Une question rapide ? Je t'écoute.</p>
    {/each}
    {#if store.activity}<p class="activity" transition:fade={{ duration: motion(150) }}>{store.activity}</p>{/if}
  </div>
  {#if store.notice}<p class="notice" role="status" transition:fade={{ duration: motion(150) }}>{store.notice}</p>{/if}
  <textarea
    bind:this={input}
    bind:value={text}
    onkeydown={handleKeydown}
    oninput={() => { window.alicia.presence.typing(); }}
    rows="2"
    placeholder={ready ? "Écris à Alicia…" : "Connexion à Alicia…"}
    aria-label="Message pour Alicia"
    disabled={!ready}
    data-testid="holo-input"
  ></textarea>
</section>

<style>
  .chat {
    height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 12px;
    background: var(--night-deep); border: 1px solid var(--surface); border-radius: 18px;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.35);
  }
  header { display: flex; align-items: center; gap: 2px; }
  .title { flex: 1; font-weight: 700; color: var(--cream); }
  .icon { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: none; color: var(--cream-muted); cursor: pointer; transition: background var(--duration) ease, color var(--duration) ease; }
  .icon:hover:not(:disabled) { background: var(--surface); color: var(--cream); }
  .icon:disabled { opacity: 0.5; cursor: default; }
  .messages { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
  .bubble { margin: 0; padding: 7px 10px; border-radius: 12px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; max-width: 92%; }
  .bubble.user { align-self: flex-end; background: var(--surface-raised); }
  .bubble.assistant { align-self: flex-start; background: var(--surface); }
  .caret { display: inline-block; width: 6px; height: 1em; margin-left: 2px; vertical-align: -2px; background: var(--sage); animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .empty, .activity { margin: auto 0 0; color: var(--muted); font-size: 13px; }
  .notice { margin: 0; color: var(--amber); font-size: 13px; }
  textarea { resize: none; border: 1px solid transparent; border-radius: 10px; padding: 8px 10px; background: var(--surface); transition: border-color var(--duration) ease; }
  textarea:focus { outline: none; border-color: var(--sage); }
</style>
```

`apps/desktop/src/renderer/src/HoloApp.svelte` :
```svelte
<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { fly } from "svelte/transition";
  import type { HoloView } from "../../shared/holo.ts";
  import type { MascotState } from "../../shared/mascot.ts";
  import type { StoredSession } from "../../shared/session.ts";
  import HoloChat from "./components/HoloChat.svelte";
  import Mascot from "./components/Mascot.svelte";
  import { DragTracker } from "./lib/drag.ts";
  import { MiniChat } from "./lib/mini-chat.svelte.ts";
  import { mirror } from "./lib/mirror.ts";
  import { motion } from "./lib/motion.ts";

  const FADE_MS = 180;
  const MOOD_LABEL: Readonly<Record<MascotState, string>> = {
    idle: "Alicia",
    sleeping: "Alicia somnole",
    listening: "Alicia t'écoute",
    thinking: "Alicia réfléchit",
    speaking: "Alicia te répond",
    success: "C'est fait !",
    alert: "Alicia a besoin de toi",
    error: "Quelque chose n'a pas marché",
    idea: "Alicia a une idée",
  };

  let session = $state<StoredSession | null>(null);
  let mood = $state<MascotState>("idle");
  let view = $state<HoloView>({ expanded: false, panelSide: "left", mascot: { x: 0, y: 0 } });
  let shown = $state(false);
  let chatOpen = $state(false);
  let chat = $state<MiniChat | null>(null);
  const token = $derived(session?.token ?? null);

  const drag = new DragTracker({
    start: () => {
      void window.alicia.holo.dragStart();
    },
    move: (delta) => {
      void window.alicia.holo.dragTo(delta);
    },
    end: () => {
      void window.alicia.holo.dragEnd();
    },
    click: () => {
      void toggleChat();
    },
  });

  onMount(() => {
    const offs = [
      mirror(() => window.alicia.getSession(), (listener) => window.alicia.onSessionChanged(listener), (next) => {
        session = next;
      }),
      mirror(() => window.alicia.presence.current(), (listener) => window.alicia.presence.onChange(listener), (next) => {
        mood = next;
      }),
      window.alicia.surface.onShown(() => {
        shown = true;
      }),
      window.alicia.surface.onHideRequest(() => {
        void hide();
      }),
    ];
    void window.alicia.holo.setExpanded(false).then((next) => {
      view = next;
    });
    // The window only exists to be shown: play the entrance now.
    shown = true;
    return () => {
      for (const off of offs) off();
    };
  });

  // One mini-chat conversation per pairing, kept while the app runs (also while the panel is closed).
  $effect(() => {
    if (token === null) return;
    const current = untrack(() => session);
    if (current === null) return;
    const created = new MiniChat(current, window.alicia.brain, fetch);
    created.start();
    chat = created;
    return () => {
      created.stop();
      chat = null;
    };
  });

  /** Opening: the window grows first, then the panel slides in. Closing: the panel slides out, then the window shrinks. */
  async function toggleChat(): Promise<void> {
    if (chatOpen) {
      chatOpen = false;
      return;
    }
    view = await window.alicia.holo.setExpanded(true);
    chatOpen = true;
  }

  async function collapse(): Promise<void> {
    if (chatOpen) return;
    view = await window.alicia.holo.setExpanded(false);
  }

  async function hide(): Promise<void> {
    shown = false;
    chatOpen = false;
    await new Promise((resolve) => setTimeout(resolve, motion(FADE_MS)));
    // Shown again meanwhile: stay.
    if (!shown) await window.alicia.surface.hideSelf();
  }

  function onPointerDown(event: PointerEvent & { currentTarget: EventTarget & HTMLButtonElement }): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.down({ x: event.screenX, y: event.screenY });
  }

  function onPointerMove(event: PointerEvent): void {
    drag.move({ x: event.screenX, y: event.screenY });
  }

  function onPointerUp(event: PointerEvent): void {
    drag.up({ x: event.screenX, y: event.screenY });
  }

  /** Keyboard activation only (Enter, Space): pointer clicks go through the drag tracker. */
  function onClick(event: MouseEvent): void {
    if (event.detail === 0) void toggleChat();
  }
</script>

<div class="holo" class:shown data-testid="holo">
  {#if chatOpen}
    <div
      class="panel {view.panelSide}"
      transition:fly={{ x: view.panelSide === "left" ? 24 : -24, duration: motion(200) }}
      onoutroend={() => void collapse()}
    >
      {#if chat}
        <HoloChat {chat} onClose={() => { chatOpen = false; }} />
      {:else}
        <p class="unpaired">Appaire d'abord Alicia depuis l'app.</p>
      {/if}
    </div>
  {/if}
  <button
    class="mascot"
    style:left="{view.mascot.x}px"
    style:top="{view.mascot.y}px"
    title={MOOD_LABEL[mood]}
    aria-label={chatOpen ? "Fermer la discussion" : "Discuter avec Alicia"}
    aria-expanded={chatOpen}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={() => { drag.cancel(); }}
    onclick={onClick}
    data-testid="holo-mascot"
  ><span class="breathe"><Mascot {mood} size={120} /></span></button>
</div>

<style>
  .holo {
    position: fixed; inset: 0; opacity: 0; transform: scale(0.96); transform-origin: bottom center;
    transition: opacity 180ms ease, transform 180ms ease;
  }
  .holo.shown { opacity: 1; transform: none; }
  .mascot {
    position: absolute; width: 136px; height: 152px; padding: 0 0 8px; display: grid; place-items: end center;
    background: none; border: 0; border-radius: 16px; cursor: grab; touch-action: none;
  }
  .mascot:active { cursor: grabbing; }
  .mascot:focus-visible { outline: 2px solid var(--sage); outline-offset: -4px; }
  /* A slow, tiny breath: she is alive even at rest (stopped by reduced motion, app.css). */
  .breathe { display: block; animation: breathe 4.5s ease-in-out infinite; }
  @keyframes breathe { 50% { transform: translateY(-2px); } }
  .panel { position: absolute; top: 0; bottom: 0; width: 320px; }
  .panel.left { left: 0; }
  .panel.right { right: 0; }
  .unpaired { margin: 0; padding: 16px; border-radius: 16px; background: var(--night-deep); color: var(--cream-muted); }
</style>
```

- [ ] **Step 5: Vérifier**

Run: `pnpm --filter @alicia/desktop test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout PASS. L'e2e laisse apparaître l'Holo quelques secondes en bas à droite de l'écran pendant les tests : c'est normal (fenêtres de test, profil temporaire).

- [ ] **Step 6: Vérification manuelle (développement)**

`pnpm --filter @alicia/desktop dev`, appairer un cerveau de développement (jamais celui du port 8780) : l'Holo apparaît en fondu en bas à droite, se déplace à la souris, s'ouvre au clic (la fenêtre grandit puis le panneau glisse ; la mascotte ne bouge pas), se referme en glissant puis la fenêtre rétrécit ; son humeur suit les réponses de la fenêtre principale ; « Afficher l'Holo » dans le menu de la zone de notification le cache en fondu.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/windows.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/shared/bridge.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/main.ts apps/desktop/src/renderer/src/app.css apps/desktop/src/renderer/src/HoloApp.svelte apps/desktop/src/renderer/src/components/HoloChat.svelte apps/desktop/src/renderer/src/lib/mini-chat.svelte.ts apps/desktop/e2e/desktop.e2e.ts
git commit -m "feat(desktop): detached Holo with Alicia's mood, mini-chat and remembered position

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: La barre Spotlight

**Files:**
- Create: `apps/desktop/src/renderer/src/SpotlightApp.svelte`
- Modify: `apps/desktop/src/main/windows.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/src/main.ts`
- Test: `apps/desktop/e2e/desktop.e2e.ts`

- [ ] **Step 1: Écrire les tests de bout en bout (ils échouent)**

Ajouter à `apps/desktop/e2e/desktop.e2e.ts` :
```ts
test("Spotlight: the shortcut opens the bar, Enter sends, the answer comes back as a notification", async () => {
  const brain = await startBrain();
  const { app, page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  expect((await recorded(app)).shortcuts).toEqual(["Ctrl+Alt+A"]);
  await closeWindow(app, "main");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(false);

  await callHook(app, "triggerShortcut");
  const bar = await surfacePage(app, "spotlight");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(true);
  const input = bar.getByTestId("spotlight-input");
  await expect.poll(() => input.evaluate((element) => element === document.activeElement), POLL).toBe(true);
  await input.fill("Quel temps fait-il ?");
  await input.press("Enter");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(false);

  await expect.poll(async () => (await recorded(app)).notifications, POLL).toEqual([
    { title: "Alicia", body: "Bonjour Kévin, je suis là !" },
  ]);
  // The notification opens the main window on that conversation.
  await callHook(app, "clickNotification", 0);
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
  await page.getByTestId("message-user").filter({ hasText: "Quel temps fait-il ?" }).waitFor();
  await page.getByTestId("conversation-list").getByText("Quel temps fait-il ?").waitFor();
});

test("Spotlight: Escape closes the bar without sending, and it opens again empty", async () => {
  const brain = await startBrain();
  const { app, page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  await callHook(app, "triggerShortcut");
  const bar = await surfacePage(app, "spotlight");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(true);
  await bar.getByTestId("spotlight-input").fill("Rien du tout");
  await bar.getByTestId("spotlight-input").press("Escape");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(false);
  expect(brain.engine.requests).toHaveLength(0);

  await callHook(app, "triggerShortcut");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(true);
  await expect.poll(() => bar.getByTestId("spotlight-input").inputValue(), POLL).toBe("");
});
```

Run: `pnpm --filter @alicia/desktop test:e2e`
Expected: les deux nouveaux tests FAIL (`No spotlight window`).

- [ ] **Step 2: La fenêtre**

`apps/desktop/src/main/windows.ts` :
- compléter l'import de `./layout.ts` avec `SPOTLIGHT_SIZE` et `spotlightBounds` ;
- champ `#spotlight: BrowserWindow | null = null;` ;
- `surfaceOf` : ajouter `[this.#spotlight, "spotlight"]` à la liste ; `#windows()` : `[this.#main, this.#holo, this.#spotlight]` ;
- méthodes publiques :
```ts
  /** Created hidden at startup, so the shortcut shows it at once. */
  createSpotlight(): void {
    this.#ensureSpotlight();
  }

  /** The global shortcut: shows the bar on the screen under the pointer, or closes it. */
  toggleSpotlight(): void {
    const window = this.#ensureSpotlight();
    if (window.isVisible() && !this.#hiding.has(window)) {
      this.#requestHide(window);
      return;
    }
    this.#cancelHide(window);
    window.setBounds(spotlightBounds(workAreaNear(screen.getCursorScreenPoint())));
    window.show();
    window.focus();
    this.#sendWhenLoaded(window, PUSH.shown);
  }
```
- méthode privée :
```ts
  #ensureSpotlight(): BrowserWindow {
    const existing = this.#spotlight;
    if (existing !== null && !existing.isDestroyed()) return existing;
    const window = new BrowserWindow({
      ...SPOTLIGHT_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: secureWebPreferences(),
    });
    window.setAlwaysOnTop(true, "pop-up-menu");
    // Like Spotlight: clicking anywhere else closes the bar.
    window.on("blur", () => {
      if (window.isVisible()) this.#requestHide(window);
    });
    window.on("close", (event) => {
      if (this.#quitting) return;
      event.preventDefault();
      this.#requestHide(window);
    });
    this.#harden(window);
    this.#load(window, "spotlight");
    this.#spotlight = window;
    return window;
  }
```
(`hideSelf` accepte déjà la barre : elle se ferme d'elle-même après Entrée ou Échap.)

`apps/desktop/src/main/index.ts` :
- `registerShortcut` des réglages devient
```ts
    registerShortcut: (accelerator) =>
      os.registerShortcut(accelerator, () => {
        windows.toggleSpotlight();
      }),
```
(supprimer le commentaire « Until the Spotlight bar exists… ») ;
- après `windows.createMain({ show: !startHidden });`, ajouter `windows.createSpotlight();`.

- [ ] **Step 3: La page**

`apps/desktop/src/renderer/src/main.ts` : importer `import SpotlightApp from "./SpotlightApp.svelte";` et remplacer les deux dernières lignes par
```ts
if (surface === "holo") mount(HoloApp, { target });
else if (surface === "spotlight") mount(SpotlightApp, { target });
else mount(App, { target });
```

`apps/desktop/src/renderer/src/SpotlightApp.svelte` :
```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { fade, fly } from "svelte/transition";
  import type { ConnectionStatus } from "../../shared/chat-connection.ts";
  import type { MascotState } from "../../shared/mascot.ts";
  import type { StoredSession } from "../../shared/session.ts";
  import Mascot from "./components/Mascot.svelte";
  import { mirror } from "./lib/mirror.ts";
  import { motion } from "./lib/motion.ts";

  const FADE_MS = 160;
  const UNREACHABLE = "Alicia n'est pas joignable pour l'instant.";

  let session = $state<StoredSession | null>(null);
  let status = $state<ConnectionStatus>("connecting");
  let mood = $state<MascotState>("idle");
  let text = $state("");
  let error = $state<string | null>(null);
  let sending = $state(false);
  let shown = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  onMount(() => {
    const offs = [
      mirror(() => window.alicia.getSession(), (listener) => window.alicia.onSessionChanged(listener), (next) => {
        session = next;
      }),
      mirror(() => window.alicia.brain.status(), (listener) => window.alicia.brain.onStatus(listener), (next) => {
        status = next;
      }),
      mirror(() => window.alicia.presence.current(), (listener) => window.alicia.presence.onChange(listener), (next) => {
        mood = next;
      }),
      window.alicia.surface.onShown(open),
      window.alicia.surface.onHideRequest(() => {
        void close();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  });

  // Each time the bar appears, the cursor is in it.
  $effect(() => {
    if (shown) input?.focus();
  });

  function open(): void {
    text = "";
    error = null;
    sending = false;
    shown = true;
  }

  async function close(): Promise<void> {
    shown = false;
    await new Promise((resolve) => setTimeout(resolve, motion(FADE_MS)));
    // Shown again meanwhile: stay.
    if (!shown) await window.alicia.surface.hideSelf();
  }

  async function submit(): Promise<void> {
    const message = text.trim();
    if (message === "" || sending) return;
    if (session === null) {
      await window.alicia.app.showMain();
      await close();
      return;
    }
    if (status !== "ready") {
      error = UNREACHABLE;
      return;
    }
    sending = true;
    error = null;
    let delivered = false;
    try {
      delivered = await window.alicia.brain.send({ type: "send", requestId: crypto.randomUUID(), text: message });
    } catch {
      delivered = false;
    }
    sending = false;
    if (!delivered) {
      error = UNREACHABLE;
      return;
    }
    // The answer comes back as a notification.
    await close();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      void close();
    }
  }
</script>

<div class="stage">
  {#if shown}
    <div class="bar" transition:fly={{ y: -12, duration: motion(FADE_MS) }} data-testid="spotlight">
      <Mascot {mood} size={44} />
      <input
        bind:this={input}
        bind:value={text}
        onkeydown={handleKeydown}
        oninput={() => { window.alicia.presence.typing(); }}
        maxlength="2000"
        disabled={sending}
        placeholder={session === null ? "Appaire d'abord Alicia : Entrée ouvre l'app" : "Demande à Alicia…"}
        aria-label="Message pour Alicia"
        autocomplete="off"
        data-testid="spotlight-input"
      />
      <kbd aria-hidden="true">Entrée</kbd>
    </div>
    {#if error}
      <p class="error" role="status" transition:fade={{ duration: motion(120) }} data-testid="spotlight-error">{error}</p>
    {/if}
  {/if}
</div>

<style>
  .stage { position: fixed; inset: 0; padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; }
  .bar {
    display: flex; align-items: center; gap: 12px; height: 64px; padding: 0 16px 0 10px;
    background: var(--night-deep); border: 1px solid var(--surface-raised); border-radius: 18px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);
  }
  input { flex: 1; min-width: 0; border: 0; background: none; font-size: 19px; color: var(--cream); }
  input:focus { outline: none; }
  input::placeholder { color: var(--muted); }
  kbd { font: inherit; font-size: 12px; color: var(--muted); border: 1px solid var(--surface-raised); border-radius: 6px; padding: 2px 6px; }
  .error { margin: 0 12px; color: var(--amber); font-size: 13px; text-shadow: 0 1px 2px rgb(0 0 0 / 0.6); }
</style>
```

- [ ] **Step 4: Vérifier**

Run: `pnpm --filter @alicia/desktop test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout PASS. Si la barre se cache toute seule pendant le test (focus volé par une autre fenêtre du système → `blur`), relancer une fois ; si ça se reproduit, enquêter avant de toucher au test.

- [ ] **Step 5: Vérification manuelle (développement)**

`pnpm --filter @alicia/desktop dev` : `Ctrl+Alt+A` depuis n'importe quelle application ouvre la barre au centre de l'écran sous la souris, en glissant ; Échap ou un clic ailleurs la referme en fondu ; Entrée envoie, la barre disparaît, la réponse arrive en notification Windows (en développement, la notification peut afficher « Electron » comme expéditeur : l'identité « Alicia » vient du raccourci créé par l'installateur) ; un clic sur la notification ouvre la conversation.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/windows.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/main.ts apps/desktop/src/renderer/src/SpotlightApp.svelte apps/desktop/e2e/desktop.e2e.ts
git commit -m "feat(desktop): Spotlight bar on a global shortcut, answer as a notification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: L'écran Réglages

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/settings-screen.svelte.ts`, `apps/desktop/src/renderer/src/components/SettingsView.svelte`
- Modify: `apps/desktop/src/shared/bridge.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/src/lib/app-view.ts`, `apps/desktop/src/renderer/src/lib/brain-client.ts`, `apps/desktop/src/renderer/src/components/Sidebar.svelte`, `apps/desktop/src/renderer/src/components/Shell.svelte`
- Test: `apps/desktop/test/settings-screen.test.ts`, `apps/desktop/test/brain-client.test.ts`, `apps/desktop/e2e/desktop.e2e.ts`

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/settings-screen.test.ts` :
```ts
import { describe, expect, test, vi } from "vitest";
import { SETTINGS_MESSAGES, SettingsScreen, type SettingsPorts } from "../src/renderer/src/lib/settings-screen.svelte.ts";
import type { KeyLike } from "../src/shared/accelerator.ts";
import { Settings, type SettingsPatch, type SettingsSnapshot, type SettingsUpdateResult } from "../src/shared/settings.ts";

function snapshot(settings: Partial<Settings> = {}, shortcutActive = true): SettingsSnapshot {
  return { settings: { ...Settings.parse({}), ...settings }, shortcutActive };
}

function key(name: string, code: string, modifiers: Partial<KeyLike> = {}): KeyLike {
  return { key: name, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
}

function setup(answer?: (patch: SettingsPatch, current: SettingsSnapshot) => Promise<SettingsUpdateResult>) {
  let current = snapshot();
  const patches: SettingsPatch[] = [];
  const listeners: ((next: SettingsSnapshot) => void)[] = [];
  const ports: SettingsPorts = {
    get: () => Promise.resolve(current),
    update: (patch) => {
      patches.push(patch);
      if (answer !== undefined) return answer(patch, current);
      current = snapshot({
        ...current.settings,
        ...(patch.shortcut !== undefined ? { shortcut: patch.shortcut } : {}),
        ...(patch.launchAtStartup !== undefined ? { launchAtStartup: patch.launchAtStartup } : {}),
        ...(patch.showHolo !== undefined ? { showHolo: patch.showHolo } : {}),
      });
      return Promise.resolve({ ok: true, snapshot: current });
    },
    onChange: (listener) => {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    },
  };
  const screen = new SettingsScreen(ports);
  return { screen, patches, push: (next: SettingsSnapshot) => { for (const listener of [...listeners]) listener(next); } };
}

async function started(screen: SettingsScreen): Promise<void> {
  screen.start();
  await vi.waitFor(() => { expect(screen.snapshot).not.toBeNull(); });
}

describe("SettingsScreen", () => {
  test("loads the settings and follows changes made elsewhere (tray menu)", async () => {
    const { screen, push } = setup();
    await started(screen);
    expect(screen.snapshot?.settings.shortcut).toBe("Ctrl+Alt+A");
    push(snapshot({ showHolo: false }));
    expect(screen.snapshot?.settings.showHolo).toBe(false);
  });

  test("switches launch at startup and the Holo", async () => {
    const { screen, patches } = setup();
    await started(screen);
    await screen.toggleStartup();
    await screen.toggleHolo();
    expect(patches).toEqual([{ launchAtStartup: true }, { showHolo: false }]);
    expect(screen.snapshot?.settings).toMatchObject({ launchAtStartup: true, showHolo: false });
  });

  test("capturing a shortcut: Escape cancels, a modifier alone waits, a bare letter explains, Ctrl+Shift+K saves", async () => {
    const { screen, patches } = setup();
    await started(screen);
    screen.startCapture();
    await screen.captureKey(key("Escape", "Escape"));
    expect(screen.capturing).toBe(false);

    screen.startCapture();
    await screen.captureKey(key("Control", "ControlLeft", { ctrlKey: true }));
    expect([screen.capturing, screen.error]).toEqual([true, null]);
    await screen.captureKey(key("k", "KeyK"));
    expect([screen.capturing, screen.error]).toEqual([true, SETTINGS_MESSAGES.not_a_shortcut]);
    await screen.captureKey(key("€", "KeyE", { ctrlKey: true, altKey: true }));
    expect([screen.capturing, screen.error]).toEqual([true, SETTINGS_MESSAGES.types_character]);
    await screen.captureKey(key("K", "KeyK", { ctrlKey: true, shiftKey: true }));
    expect(screen.capturing).toBe(false);
    expect(patches).toEqual([{ shortcut: "Ctrl+Shift+K" }]);
    expect(screen.snapshot?.settings.shortcut).toBe("Ctrl+Shift+K");
    expect(screen.error).toBeNull();
  });

  test("a shortcut held by another app is explained, the old one stays", async () => {
    const { screen } = setup((_patch, current) => Promise.resolve({ ok: false, reason: "shortcut_unavailable", snapshot: current }));
    await started(screen);
    screen.startCapture();
    await screen.captureKey(key("K", "KeyK", { ctrlKey: true, shiftKey: true }));
    expect(screen.error).toBe(SETTINGS_MESSAGES.shortcut_unavailable);
    expect(screen.snapshot?.settings.shortcut).toBe("Ctrl+Alt+A");
  });

  test("a setting the main process could not write to disk is explained", async () => {
    const { screen } = setup((_patch, current) => Promise.resolve({ ok: false, reason: "save_failed", snapshot: current }));
    await started(screen);
    await screen.toggleHolo();
    expect(screen.error).toBe(SETTINGS_MESSAGES.save_failed);
  });

  test("a setting that cannot be saved is explained", async () => {
    const { screen } = setup(() => Promise.reject(new Error("IPC down")));
    await started(screen);
    await screen.toggleHolo();
    expect(screen.error).toBe(SETTINGS_MESSAGES.failed);
    expect(screen.saving).toBe(false);
  });

  test("reset brings Ctrl+Alt+A back", async () => {
    const { screen, patches } = setup();
    await started(screen);
    await screen.resetShortcut();
    expect(patches).toEqual([{ shortcut: "Ctrl+Alt+A" }]);
  });
});
```

Dans `apps/desktop/test/brain-client.test.ts`, dans `describe("BrainApi", …)` (où `session` et `fakeFetch` existent) :
```ts
  test("health: the brain's version, read without side effects", async () => {
    const { calls, fetchFn } = fakeFetch(200, { ok: true, version: "0.1.0" });
    expect(await new BrainApi(fetchFn, session).health()).toEqual({ ok: true, version: "0.1.0" });
    expect(calls[0]?.url).toBe("http://127.0.0.1:8780/health");
  });
```

Ajouter à `apps/desktop/e2e/desktop.e2e.ts` :
```ts
test("Réglages: shortcut, launch at startup and Holo are kept after a restart; sign out lives here", async () => {
  const brain = await startBrain();
  const userData = tempDir("alicia-e2e-profile-");
  const first = await launch(userData);
  await pair(first.page, brain);
  await first.page.getByTestId("nav-settings").click();
  await first.page.getByTestId("settings-view").waitFor();
  await expect.poll(() => first.page.getByTestId("titlebar-title").textContent(), POLL).toBe("Réglages");
  await expect.poll(() => first.page.getByTestId("settings-server").textContent(), POLL).toBe(brain.url);
  await expect.poll(() => first.page.getByTestId("settings-shortcut").textContent(), POLL).toBe("Ctrl+Alt+A");

  // A new shortcut, typed on the keyboard.
  await first.page.getByTestId("settings-shortcut-change").click();
  await first.page.getByTestId("settings-shortcut-capture").waitFor();
  await first.page.keyboard.press("Control+Shift+K");
  await expect.poll(() => first.page.getByTestId("settings-shortcut").textContent(), POLL).toBe("Ctrl+Shift+K");
  expect((await recorded(first.app)).shortcuts).toEqual(["Ctrl+Shift+K"]);

  await first.page.getByTestId("settings-startup").click();
  await expect.poll(() => first.page.getByTestId("settings-startup").getAttribute("aria-checked"), POLL).toBe("true");
  expect((await recorded(first.app)).loginItem).toBe(true);

  await expect.poll(() => windowVisible(first.app, "holo"), POLL).toBe(true);
  await first.page.getByTestId("settings-holo").click();
  await expect.poll(() => windowVisible(first.app, "holo"), POLL).toBe(false);
  await first.app.close();

  const second = await launch(userData);
  await second.page.getByTestId("nav-settings").click();
  await expect.poll(() => second.page.getByTestId("settings-shortcut").textContent(), POLL).toBe("Ctrl+Shift+K");
  expect(await second.page.getByTestId("settings-startup").getAttribute("aria-checked")).toBe("true");
  expect(await second.page.getByTestId("settings-holo").getAttribute("aria-checked")).toBe("false");
  expect((await recorded(second.app)).shortcuts).toEqual(["Ctrl+Shift+K"]);
  expect(await windowVisible(second.app, "holo")).toBe(false);

  // Signing out is in Réglages now.
  await second.page.getByTestId("sign-out").click();
  await second.page.getByTestId("sign-out-yes").click();
  await second.page.getByTestId("pairing-code").waitFor();
});
```

- [ ] **Step 2: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/desktop test -- settings-screen brain-client`
Expected: FAIL (`settings-screen.svelte.ts` introuvable, `health` absent).

- [ ] **Step 3: Pont, IPC, processus principal**

`apps/desktop/src/shared/bridge.ts` : importer `import type { SettingsPatch, SettingsSnapshot, SettingsUpdateResult } from "./settings.ts";` et ajouter
```ts
export interface SettingsBridge {
  get(): Promise<SettingsSnapshot>;
  update(patch: SettingsPatch): Promise<SettingsUpdateResult>;
  /** Changed from another place (tray menu, Holo closed with Alt+F4…). */
  onChange(listener: (snapshot: SettingsSnapshot) => void): Unsubscribe;
}
```
le champ `settings: SettingsBridge;` dans `AliciaBridge`, `settingsGet: "settings:get"`, `settingsUpdate: "settings:update"` dans `INVOKE`, `settings: "push:settings"` dans `PUSH`.

`apps/desktop/src/preload/index.ts` : importer `import { SettingsSnapshot, SettingsUpdateResult } from "../shared/settings.ts";` et ajouter
```ts
  settings: {
    get: () => call(SettingsSnapshot, INVOKE.settingsGet),
    update: (patch) => call(SettingsUpdateResult, INVOKE.settingsUpdate, patch),
    onChange: (listener) => subscribe(PUSH.settings, SettingsSnapshot, listener),
  },
```

`apps/desktop/src/main/ipc.ts` : importer `import { SettingsPatch, type SettingsUpdateResult } from "../shared/settings.ts";` et ajouter
```ts
  handle(INVOKE.settingsGet, NONE, () => deps.settings.snapshot);
  // An invalid patch is answered as such (the page shows why), not thrown.
  handle(INVOKE.settingsUpdate, z.unknown(), (raw): SettingsUpdateResult => {
    const patch = SettingsPatch.safeParse(raw);
    if (!patch.success) return { ok: false, reason: "invalid", snapshot: deps.settings.snapshot };
    return deps.settings.update(patch.data);
  });
```

`apps/desktop/src/main/index.ts` : l'`onChange` des réglages devient
```ts
    onChange: (snapshot) => {
      windows.broadcast(PUSH.settings, snapshot);
      applyHolo();
      refreshTray();
    },
```

- [ ] **Step 4: L'état de l'écran**

`apps/desktop/src/renderer/src/lib/settings-screen.svelte.ts` :
```ts
import { captureShortcut, DEFAULT_SHORTCUT, type KeyLike, SHORTCUT_REFUSAL_MESSAGES } from "../../../shared/accelerator.ts";
import {
  SETTINGS_UPDATE_MESSAGES, type SettingsPatch, type SettingsSnapshot, type SettingsUpdateResult,
} from "../../../shared/settings.ts";
import { mirror } from "./mirror.ts";

/** What the screen needs from the main process (window.alicia.settings; a fake in tests). */
export interface SettingsPorts {
  get(): Promise<SettingsSnapshot>;
  update(patch: SettingsPatch): Promise<SettingsUpdateResult>;
  onChange(listener: (snapshot: SettingsSnapshot) => void): () => void;
}

export const SETTINGS_MESSAGES = {
  ...SETTINGS_UPDATE_MESSAGES,
  ...SHORTCUT_REFUSAL_MESSAGES,
  failed: "Impossible d'enregistrer ce réglage pour l'instant.",
} as const;

const MODIFIER_KEYS = new Set(["Control", "Alt", "AltGraph", "Shift", "Meta"]);

/** State of the Réglages screen: settings owned by the main process, edited here. */
export class SettingsScreen {
  snapshot = $state<SettingsSnapshot | null>(null);
  /** Waiting for the new shortcut on the keyboard. */
  capturing = $state(false);
  saving = $state(false);
  error = $state<string | null>(null);

  readonly #ports: SettingsPorts;
  #off: (() => void) | null = null;

  constructor(ports: SettingsPorts) {
    this.#ports = ports;
  }

  start(): void {
    this.#off ??= mirror(
      () => this.#ports.get(),
      (listener) => this.#ports.onChange(listener),
      (snapshot) => {
        this.snapshot = snapshot;
      },
    );
  }

  stop(): void {
    this.#off?.();
    this.#off = null;
  }

  toggleStartup(): Promise<void> {
    const current = this.snapshot;
    return current === null ? Promise.resolve() : this.#update({ launchAtStartup: !current.settings.launchAtStartup });
  }

  toggleHolo(): Promise<void> {
    const current = this.snapshot;
    return current === null ? Promise.resolve() : this.#update({ showHolo: !current.settings.showHolo });
  }

  startCapture(): void {
    this.error = null;
    this.capturing = true;
  }

  cancelCapture(): void {
    this.capturing = false;
  }

  /** A key pressed while capturing: Escape cancels, modifiers alone wait for the key, anything else is tried. */
  async captureKey(key: KeyLike): Promise<void> {
    if (!this.capturing) return;
    const bare = !key.ctrlKey && !key.altKey && !key.shiftKey && !key.metaKey;
    if (key.key === "Escape" && bare) {
      this.cancelCapture();
      return;
    }
    if (MODIFIER_KEYS.has(key.key)) return;
    const capture = captureShortcut(key);
    if (!capture.ok) {
      this.error = SETTINGS_MESSAGES[capture.reason];
      return;
    }
    this.capturing = false;
    await this.#update({ shortcut: capture.accelerator });
  }

  resetShortcut(): Promise<void> {
    return this.#update({ shortcut: DEFAULT_SHORTCUT });
  }

  async #update(patch: SettingsPatch): Promise<void> {
    this.saving = true;
    this.error = null;
    try {
      const result = await this.#ports.update(patch);
      this.snapshot = result.snapshot;
      if (!result.ok) this.error = SETTINGS_MESSAGES[result.reason];
    } catch {
      this.error = SETTINGS_MESSAGES.failed;
    } finally {
      this.saving = false;
    }
  }
}
```

- [ ] **Step 5: Client HTTP**

`apps/desktop/src/renderer/src/lib/brain-client.ts` : ajouter `HealthResponse` à l'import de `@alicia/protocol` et, dans `BrainApi` :
```ts
  /** The brain's version (shown in Réglages). */
  health(): Promise<HealthResponse> {
    return this.#get("/health", HealthResponse);
  }
```

- [ ] **Step 6: L'écran et le menu**

`apps/desktop/src/renderer/src/lib/app-view.ts` : `export type AppView = "chat" | "memories" | "settings";`

`apps/desktop/src/renderer/src/components/SettingsView.svelte` (la confirmation de déconnexion vient de `Sidebar.svelte`, à l'identique) :
```svelte
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { fade, slide } from "svelte/transition";
  import { DEFAULT_SHORTCUT } from "../../../shared/accelerator.ts";
  import type { ConnectionStatus } from "../../../shared/chat-connection.ts";
  import type { StoredSession } from "../../../shared/session.ts";
  import type { BrainApi } from "../lib/brain-client.ts";
  import { motion } from "../lib/motion.ts";
  import { SettingsScreen } from "../lib/settings-screen.svelte.ts";

  let { session, api, status, onSignOut }: {
    session: StoredSession;
    api: BrainApi;
    status: ConnectionStatus;
    onSignOut: () => void;
  } = $props();

  const uid = $props.id();
  const screen = new SettingsScreen(window.alicia.settings);
  const STATUS_LABEL: Readonly<Record<ConnectionStatus, string>> = {
    connecting: "Connexion…",
    ready: "Connectée",
    offline: "Hors ligne, reconnexion…",
    rejected: "Appareil refusé",
  };

  let deviceName = $state("…");
  let appVersion = $state("…");
  let brainVersion = $state<string | null>(null);
  let captureButton = $state<HTMLButtonElement | null>(null);
  let confirming = $state(false);
  let signOutButton = $state<HTMLButtonElement | null>(null);
  let cancelButton = $state<HTMLButtonElement | null>(null);
  /** Set when the question is dismissed, so the focus goes back to "Déconnecter cet appareil". */
  let returnFocus = false;
  const settings = $derived(screen.snapshot?.settings ?? null);
  const busy = $derived(settings === null || screen.saving);

  onMount(() => {
    screen.start();
    void window.alicia.deviceName().then((name) => {
      deviceName = name;
    });
    void window.alicia.app.version().then((version) => {
      appVersion = version;
    });
    void api.health().then(
      (health) => {
        brainVersion = health.version;
      },
      () => {
        brainVersion = null;
      },
    );
  });
  onDestroy(() => {
    screen.stop();
  });

  // The capture button takes the focus: the next key press is the new shortcut.
  $effect(() => {
    if (screen.capturing) captureButton?.focus();
  });

  function handleCaptureKeydown(event: KeyboardEvent): void {
    // Tab still leaves (and the blur cancels the capture).
    if (event.key === "Tab") return;
    event.preventDefault();
    void screen.captureKey(event);
  }

  function askSignOut(): void {
    confirming = true;
  }

  function cancelSignOut(): void {
    returnFocus = true;
    confirming = false;
  }

  function handleConfirmKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancelSignOut();
  }

  // The safe answer gets the focus when the question shows up; the button gets it back afterwards.
  $effect(() => {
    if (confirming) {
      cancelButton?.focus();
    } else if (returnFocus && signOutButton !== null) {
      returnFocus = false;
      signOutButton.focus();
    }
  });
</script>

<div class="settings" data-testid="settings-view">
  <div class="content">
    <h1>Réglages</h1>

    <section aria-labelledby="{uid}-quick">
      <h2 id="{uid}-quick">Accès rapide</h2>
      <div class="row">
        <div class="label">
          <p class="name" id="{uid}-shortcut">Raccourci de la barre Spotlight</p>
          <p class="hint">Ouvre, par-dessus tout, une barre pour écrire à Alicia.</p>
        </div>
        {#if screen.capturing}
          <button
            class="capture"
            bind:this={captureButton}
            onkeydown={handleCaptureKeydown}
            onblur={() => { screen.cancelCapture(); }}
            aria-describedby="{uid}-shortcut"
            data-testid="settings-shortcut-capture"
            in:fade={{ duration: motion(120) }}
          >Appuie sur la combinaison… (Échap pour annuler)</button>
        {:else}
          <kbd data-testid="settings-shortcut" in:fade={{ duration: motion(120) }}>{settings?.shortcut ?? "…"}</kbd>
          <button class="link" onclick={() => { screen.startCapture(); }} disabled={busy} data-testid="settings-shortcut-change">Modifier</button>
          {#if settings !== null && settings.shortcut !== DEFAULT_SHORTCUT}
            <button class="link" onclick={() => void screen.resetShortcut()} disabled={busy} data-testid="settings-shortcut-reset" transition:fade={{ duration: motion(120) }}>Rétablir {DEFAULT_SHORTCUT}</button>
          {/if}
        {/if}
      </div>
      {#if screen.snapshot !== null && !screen.snapshot.shortcutActive}
        <p class="warning" role="status" data-testid="settings-shortcut-inactive" transition:slide={{ duration: motion(150) }}>
          Ce raccourci ne marche pas : une autre application l'utilise déjà. Choisis-en un autre.
        </p>
      {/if}
      <div class="row">
        <div class="label">
          <p class="name" id="{uid}-holo">Afficher l'Holo</p>
          <p class="hint">Alicia flotte sur le bureau, toujours au-dessus ; un clic ouvre une petite discussion.</p>
        </div>
        <button class="switch" role="switch" aria-checked={settings?.showHolo ?? false} aria-labelledby="{uid}-holo" disabled={busy} onclick={() => void screen.toggleHolo()} data-testid="settings-holo"><span class="knob"></span></button>
      </div>
      <div class="row">
        <div class="label">
          <p class="name" id="{uid}-startup">Lancer Alicia au démarrage de Windows</p>
          <p class="hint">Elle démarre discrètement dans la zone de notification.</p>
        </div>
        <button class="switch" role="switch" aria-checked={settings?.launchAtStartup ?? false} aria-labelledby="{uid}-startup" disabled={busy} onclick={() => void screen.toggleStartup()} data-testid="settings-startup"><span class="knob"></span></button>
      </div>
    </section>

    <section aria-labelledby="{uid}-device">
      <h2 id="{uid}-device">Cet appareil</h2>
      <dl>
        <dt>Adresse d'Alicia</dt><dd data-testid="settings-server">{session.serverUrl}</dd>
        <dt>Connexion</dt><dd>{STATUS_LABEL[status]}</dd>
        <dt>Personne</dt><dd>{session.person.name}</dd>
        <dt>Nom de l'appareil</dt><dd>{deviceName}</dd>
        <dt>Version de l'app</dt><dd data-testid="settings-app-version">{appVersion}</dd>
        <dt>Version d'Alicia</dt><dd>{brainVersion ?? "inconnue"}</dd>
      </dl>
      <div class="signout">
        {#if confirming}
          <div class="confirm" role="group" aria-labelledby="{uid}-question" aria-describedby="{uid}-confirm-hint" data-testid="sign-out-confirm" in:fade={{ duration: motion(150) }}>
            <p id="{uid}-question" class="question">Déconnecter cet appareil ?</p>
            <p id="{uid}-confirm-hint" class="hint">Il faudra l'appairer à nouveau.</p>
            <div class="actions">
              <button class="yes" onclick={onSignOut} onkeydown={handleConfirmKeydown} data-testid="sign-out-yes">Oui</button>
              <button class="no" bind:this={cancelButton} onclick={cancelSignOut} onkeydown={handleConfirmKeydown} data-testid="sign-out-cancel">Annuler</button>
            </div>
          </div>
        {:else}
          <button class="danger" bind:this={signOutButton} onclick={askSignOut} data-testid="sign-out" in:fade={{ duration: motion(150) }}>Déconnecter cet appareil</button>
        {/if}
      </div>
    </section>

    {#if screen.error}
      <p class="error" role="status" data-testid="settings-error" transition:fade={{ duration: motion(150) }}>{screen.error}</p>
    {/if}
  </div>
</div>

<style>
  .settings { height: 100%; overflow-y: auto; }
  .content { max-width: 720px; margin: 0 auto; padding: 24px 32px 40px; display: flex; flex-direction: column; gap: 24px; }
  h1 { margin: 0; font-size: 22px; }
  section { display: flex; flex-direction: column; gap: 4px; }
  h2 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--night-deep); border-radius: var(--radius); }
  .label { flex: 1; min-width: 0; }
  .name { margin: 0; color: var(--cream); font-weight: 700; }
  .hint { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
  kbd { font: inherit; font-weight: 700; padding: 4px 10px; border-radius: 8px; background: var(--surface); color: var(--cream); }
  button { font: inherit; cursor: pointer; border: 0; transition: background var(--duration) ease, color var(--duration) ease, opacity var(--duration) ease; }
  button:disabled { cursor: default; opacity: 0.6; }
  .link { background: none; color: var(--sage); padding: 4px 6px; border-radius: 6px; }
  .link:hover:not(:disabled) { background: var(--surface); }
  .capture { padding: 6px 12px; border-radius: 8px; background: var(--surface-raised); color: var(--cream); box-shadow: 0 0 0 1px var(--sage); }
  .warning, .error { margin: 4px 2px 0; color: var(--amber); font-size: 13px; }
  .switch { position: relative; width: 40px; height: 22px; flex: none; border-radius: 11px; background: var(--surface-raised); }
  .switch[aria-checked="true"] { background: var(--sage); }
  .knob { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--cream); transition: transform var(--duration) ease; }
  .switch[aria-checked="true"] .knob { transform: translateX(18px); }
  dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; padding: 12px 14px; background: var(--night-deep); border-radius: var(--radius); font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 0; color: var(--cream); overflow-wrap: anywhere; }
  .signout { margin-top: 8px; }
  .danger { background: none; color: var(--amber); padding: 6px 2px; }
  .danger:hover { text-decoration: underline; }
  .confirm { display: flex; flex-direction: column; gap: 2px; }
  .question { margin: 0; color: var(--cream); font-weight: 700; }
  .actions { display: flex; gap: 6px; margin-top: 6px; }
  .actions button { padding: 4px 12px; border-radius: 8px; font-size: 13px; }
  .yes { background: var(--surface-raised); color: var(--amber); font-weight: 700; }
  .no { background: none; color: var(--cream-muted); }
  .actions button:hover { background: var(--surface); }
</style>
```

`apps/desktop/src/renderer/src/components/Sidebar.svelte` :
- importer `import SettingsIcon from "@lucide/svelte/icons/settings";` ;
- retirer `onSignOut` des props (type compris) ;
- supprimer `confirming`, `signOutButton`, `cancelButton`, `returnFocus`, les fonctions `askSignOut`, `cancelSignOut`, `confirmSignOut`, `handleConfirmKeydown` et le dernier `$effect` (« The safe answer gets the focus when the question shows up… ») — ils vivent maintenant dans `SettingsView.svelte` ;
- dans `.views`, après le bouton « Souvenirs », ajouter :
```svelte
      <button
        class="view"
        class:active={view === "settings"}
        aria-current={view === "settings" ? "page" : undefined}
        onclick={() => { onView("settings"); }}
        data-testid="nav-settings"
      ><SettingsIcon size={16} aria-hidden="true" />Réglages</button>
```
- remplacer tout le `<footer>…</footer>` par :
```svelte
    <footer>
      <span class="who" title={personName}>{personName}</span>
    </footer>
```
- styles : supprimer les règles devenues inutiles (`.who` en flex, `.who span`, `.link`, `.link:hover`, `.confirm`, `.confirm .question`, `.hint`, `.actions`, `.actions button`, `.actions .yes:hover, .actions .no:hover`) et ajouter `.who { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`. Garder `.yes`, `.no` et les règles `.ask …` (confirmation de suppression d'une conversation). `svelte-check --fail-on-warnings` signale tout sélecteur oublié.

`apps/desktop/src/renderer/src/components/Shell.svelte` :
- importer `import SettingsView from "./SettingsView.svelte";` ;
- `title` :
```ts
  const title = $derived(
    view === "memories"
      ? "Souvenirs"
      : view === "settings"
        ? "Réglages"
        : (store.conversations.find((c) => c.id === store.activeId)?.title ?? "Nouvelle conversation"),
  );
```
- `<Sidebar … onSignOut={signOut} />` perd `onSignOut={signOut}` ;
- dans `<main>`, après le bloc `{#if view === "memories"}…{/if}` :
```svelte
      {#if view === "settings"}
        <div class="pane" transition:fade={{ duration: motion(180) }}>
          <SettingsView {session} {api} status={shownStatus} onSignOut={signOut} />
        </div>
      {/if}
```

- [ ] **Step 7: Vérifier**

Run: `pnpm --filter @alicia/desktop test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/shared/bridge.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/lib/app-view.ts apps/desktop/src/renderer/src/lib/brain-client.ts apps/desktop/src/renderer/src/lib/settings-screen.svelte.ts apps/desktop/src/renderer/src/components/SettingsView.svelte apps/desktop/src/renderer/src/components/Sidebar.svelte apps/desktop/src/renderer/src/components/Shell.svelte apps/desktop/test/settings-screen.test.ts apps/desktop/test/brain-client.test.ts apps/desktop/e2e/desktop.e2e.ts
git commit -m "feat(desktop): Réglages screen (shortcut, launch at startup, Holo, device), sign-out moved there

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: Le cerveau s'annonce sur le réseau (mDNS)

**Files:**
- Create: `apps/brain/src/discovery.ts`
- Modify: `apps/brain/package.json`, `pnpm-lock.yaml`, `apps/brain/src/config.ts`, `apps/brain/src/cli.ts`
- Test: `apps/brain/test/discovery.test.ts`, `apps/brain/test/config.test.ts`

- [ ] **Step 1: Dépendance**

Run: `npm view bonjour-service version time --json` (attendu : 1.4.4, publiée le 2026-07-28, donc hors délai de quarantaine), puis
```bash
pnpm --filter @alicia/brain add bonjour-service@1.4.4
```
Vérifier l'import nommé depuis l'ESM de Node (aucun socket n'est ouvert, rien n'est construit) :
Run: `cd apps/brain && node --input-type=module -e "import { Bonjour } from 'bonjour-service'; console.log(typeof Bonjour)"`
Expected: `function`.

- [ ] **Step 2: Écrire les tests**

`apps/brain/test/discovery.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { advertiseBrain, type Publisher, type ServiceAnnouncement, SERVICE_TYPE, shouldAdvertise } from "../src/discovery.ts";

function fakePublisher() {
  const published: ServiceAnnouncement[] = [];
  let stops = 0;
  const publisher: Publisher = {
    publish: (announcement) => { published.push(announcement); },
    stop: () => {
      stops++;
      return Promise.resolve();
    },
  };
  return { publisher, published, stops: () => stops };
}

describe("brain discovery (mDNS)", () => {
  test("announces « Alicia sur <machine> » as _alicia._tcp, with its version", () => {
    const { publisher, published } = fakePublisher();
    advertiseBrain({ port: 8780, version: "0.1.0", hostname: "raspberrypi" }, publisher);
    expect(SERVICE_TYPE).toBe("alicia");
    expect(published).toEqual([{ name: "Alicia sur raspberrypi", type: "alicia", port: 8780, txt: { version: "0.1.0" } }]);
  });

  test("stop withdraws the announcement", async () => {
    const { publisher, stops } = fakePublisher();
    await advertiseBrain({ port: 8780, version: "0.1.0", hostname: "mac-mini" }, publisher).stop();
    expect(stops()).toBe(1);
  });

  test("announced only when enabled and reachable from the network", () => {
    expect(shouldAdvertise({ discovery: true, host: "0.0.0.0" })).toBe(true);
    expect(shouldAdvertise({ discovery: true, host: "192.168.1.20" })).toBe(true);
    expect(shouldAdvertise({ discovery: false, host: "0.0.0.0" })).toBe(false);
    expect(shouldAdvertise({ discovery: true, host: "127.0.0.1" })).toBe(false);
    expect(shouldAdvertise({ discovery: true, host: "localhost" })).toBe(false);
    expect(shouldAdvertise({ discovery: true, host: "::1" })).toBe(false);
  });
});
```

Dans `apps/brain/test/config.test.ts` : dans `"applies the defaults"`, ajouter `expect(c.discovery).toBe(true);` ; et ajouter
```ts
  test("discovery can be turned off", () => {
    expect(parseConfig(`${MINIMAL_YAML}discovery: false\n`).discovery).toBe(false);
  });
```

- [ ] **Step 3: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/brain test -- discovery config`
Expected: FAIL (`discovery.ts` introuvable, `discovery` absent de la config).

- [ ] **Step 4: Implémenter**

`apps/brain/src/config.ts`, dans `ConfigSchema`, après `host` :
```ts
  /** Announce the brain on the local network (mDNS), so the desktop app finds it on first launch. */
  discovery: z.boolean().default(true),
```

`apps/brain/src/discovery.ts` :
```ts
import { Bonjour } from "bonjour-service";
import type { Config } from "./config.ts";

/** Service type `_alicia._tcp`, browsed by the desktop app's pairing screen. */
export const SERVICE_TYPE = "alicia";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export interface ServiceAnnouncement {
  name: string;
  type: string;
  port: number;
  txt: Record<string, string>;
}

/** Publishes on the local network (bonjour-service in the brain, a fake in tests). */
export interface Publisher {
  publish(announcement: ServiceAnnouncement): void;
  stop(): Promise<void>;
}

export function bonjourPublisher(onError: (error: unknown) => void): Publisher {
  const bonjour = new Bonjour(undefined, onError);
  // Revue des tâches 11–13 : sans cela, une erreur du socket mDNS arrête le cerveau (voir décision 11).
  guardSocketErrors(bonjour, onError);
  return {
    publish: (announcement) => {
      // A name conflict or a socket error must never bring the brain down.
      bonjour.publish({ ...announcement }).on("error", onError);
    },
    stop: () =>
      new Promise((resolve) => {
        bonjour.unpublishAll(() => {
          bonjour.destroy();
          resolve();
        });
      }),
  };
}

/** Only when enabled and listening beyond this machine (an announced loopback address would be useless). */
export function shouldAdvertise(config: Pick<Config, "discovery" | "host">): boolean {
  return config.discovery && !LOOPBACK.has(config.host);
}

/** Announces « Alicia sur <machine> »; the TXT record carries the version. */
export function advertiseBrain(
  options: { port: number; version: string; hostname: string },
  publisher: Publisher,
): { stop(): Promise<void> } {
  publisher.publish({
    name: `Alicia sur ${options.hostname}`,
    type: SERVICE_TYPE,
    port: options.port,
    txt: { version: options.version },
  });
  return { stop: () => publisher.stop() };
}
```
Si `resolve()` sans argument est refusé, typer la promesse : `new Promise<void>((resolve) => …)`.

`apps/brain/src/cli.ts` : importer `import { hostname } from "node:os";`, `import { advertiseBrain, bonjourPublisher, shouldAdvertise } from "./discovery.ts";` et `import { VERSION } from "./version.ts";`. Dans `start()`, après le `console.log("Alicia écoute sur …")` :
```ts
  const advertisement = shouldAdvertise(config)
    ? advertiseBrain(
        { port: config.port, version: VERSION, hostname: hostname() },
        bonjourPublisher((error) => {
          console.error(`Annonce sur le réseau local impossible : ${error instanceof Error ? error.message : "erreur"}`);
        }),
      )
    : null;
  if (advertisement !== null) console.log(`Annoncée sur le réseau local : « Alicia sur ${hostname()} ».`);
```
et dans `stop`, remplacer `app.close().then(` par `(advertisement === null ? app.close() : advertisement.stop().then(() => app.close())).then(`.

- [ ] **Step 5: Vérifier**

Run: `pnpm --filter @alicia/brain test && pnpm typecheck && pnpm lint`
Expected: PASS. (Aucun test n'ouvre de socket mDNS ; le vrai cerveau de Kévin n'est pas touché : l'annonce ne se fera qu'à son prochain démarrage, après déploiement.)

- [ ] **Step 6: Commit**

```bash
git add apps/brain/package.json pnpm-lock.yaml apps/brain/src/discovery.ts apps/brain/src/config.ts apps/brain/src/cli.ts apps/brain/test/discovery.test.ts apps/brain/test/config.test.ts
git commit -m "feat(brain): announce itself on the local network as _alicia._tcp (mDNS)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Premier lancement — le cerveau trouvé sur le réseau

**Files:**
- Create: `apps/desktop/src/shared/discovery.ts`, `apps/desktop/src/main/discovery.ts`
- Modify: `apps/desktop/package.json`, `pnpm-lock.yaml`, `apps/desktop/src/shared/bridge.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/src/components/PairingScreen.svelte`
- Test: `apps/desktop/test/discovery.test.ts`, `apps/desktop/e2e/desktop.e2e.ts`

- [ ] **Step 1: Dépendance**

```bash
pnpm --filter @alicia/desktop add -D bonjour-service@1.4.4
```
En `devDependencies` : electron-vite l'**embarque** dans le code du processus principal (elle est en JavaScript pur), rien à livrer à part.

- [ ] **Step 2: Écrire les tests**

`apps/desktop/test/discovery.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { type BrainBrowser, BrainDiscovery, brainFromService, staticBrowser } from "../src/main/discovery.ts";
import type { DiscoveredBrain } from "../src/shared/discovery.ts";

const PI: DiscoveredBrain = { name: "Alicia sur pi5", url: "http://192.168.1.20:8780", version: "0.1.0" };
const MAC: DiscoveredBrain = { name: "Alicia sur mac-mini", url: "http://192.168.1.30:8780", version: null };

describe("brainFromService", () => {
  test("uses the IPv4 address the answer came from", () => {
    expect(brainFromService({
      name: "Alicia sur pi5", port: 8780, referer: { address: "192.168.1.20", family: "IPv4" },
      addresses: ["fe80::1", "192.168.1.21"], txt: { version: "0.1.0" },
    })).toEqual(PI);
  });

  test("otherwise the first usable IPv4 listed (not IPv6, not link-local)", () => {
    expect(brainFromService({
      name: "Alicia sur mac-mini", port: 8780, referer: { address: "fe80::2", family: "IPv6" },
      addresses: ["fe80::2", "169.254.3.4", "192.168.1.30"],
    })).toEqual(MAC);
  });

  test("nothing usable is ignored; a strange TXT record is not trusted", () => {
    expect(brainFromService({ name: "Alicia", port: 8780, addresses: ["fe80::2"] })).toBeNull();
    expect(brainFromService({ name: "Alicia", port: 0, addresses: ["10.0.0.5"] })).toBeNull();
    expect(brainFromService({ name: "", port: 8780, addresses: ["10.0.0.5"] })).toBeNull();
    expect(brainFromService({ name: "Alicia", port: 8780, addresses: ["10.0.0.5"], txt: { version: 42 } })?.version).toBeNull();
  });
});

function controllableBrowser() {
  let up: (brain: DiscoveredBrain) => void = () => undefined;
  let down: (name: string) => void = () => undefined;
  let starts = 0;
  let stops = 0;
  const browser: BrainBrowser = {
    start: (onUp, onDown) => {
      starts++;
      up = onUp;
      down = onDown;
      return () => { stops++; };
    },
  };
  return {
    browser,
    up: (brain: DiscoveredBrain) => { up(brain); },
    down: (name: string) => { down(name); },
    counts: () => [starts, stops],
  };
}

describe("BrainDiscovery", () => {
  test("lists the brains found by name, without duplicates, and forgets those gone", () => {
    const lists: string[][] = [];
    const network = controllableBrowser();
    const discovery = new BrainDiscovery(network.browser, (brains) => { lists.push(brains.map((brain) => brain.name)); });
    discovery.start();
    network.up(PI);
    network.up(MAC);
    network.up(PI);
    network.down("Alicia sur pi5");
    expect(lists).toEqual([
      ["Alicia sur pi5"],
      ["Alicia sur mac-mini", "Alicia sur pi5"],
      ["Alicia sur mac-mini", "Alicia sur pi5"],
      ["Alicia sur mac-mini"],
    ]);
    expect(discovery.brains).toEqual([MAC]);
  });

  test("start is idempotent, stop stops looking, a new search starts empty", () => {
    const network = controllableBrowser();
    const discovery = new BrainDiscovery(network.browser, () => undefined);
    discovery.start();
    discovery.start();
    network.up(PI);
    discovery.stop();
    expect(network.counts()).toEqual([1, 1]);
    discovery.start();
    expect(discovery.brains).toEqual([]);
  });

  test("the test browser announces its list at once", () => {
    const lists: DiscoveredBrain[][] = [];
    new BrainDiscovery(staticBrowser([PI]), (brains) => { lists.push(brains); }).start();
    expect(lists).toEqual([[PI]]);
  });
});
```

Ajouter à `apps/desktop/e2e/desktop.e2e.ts` :
```ts
test("first launch: the brain found on the network fills the address", async () => {
  const brain = await startBrain();
  const found = JSON.stringify([{ name: "Alicia sur test", url: brain.url, version: "0.1.0" }]);
  const { page } = await launch(tempDir("alicia-e2e-profile-"), { ALICIA_TEST_BRAINS: found });
  await page.getByTestId("discovered-brain").filter({ hasText: "Alicia sur test" }).waitFor();
  await expect.poll(() => page.getByTestId("pairing-server").inputValue(), POLL).toBe(brain.url);
  await page.getByTestId("pairing-code").fill(brain.app.pairing.generateCode("kevin"));
  await page.getByTestId("pairing-submit").click();
  await page.getByTestId("chat-welcome").waitFor();
});

test("nothing found on the network: the manual address stays, with a hint for Tailscale", async () => {
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await page.getByTestId("discovery-searching").waitFor();
  await page.getByTestId("discovery-none").filter({ hasText: "Tailscale" }).waitFor();
  expect(await page.getByTestId("pairing-server").inputValue()).toBe("http://127.0.0.1:8780");
});
```

- [ ] **Step 3: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/desktop test -- discovery`
Expected: FAIL (modules introuvables).

- [ ] **Step 4: Implémenter le processus principal**

`apps/desktop/src/shared/discovery.ts` :
```ts
import { z } from "zod";

/** A brain found on the local network (mDNS), offered on the pairing screen. */
export const DiscoveredBrain = z.object({
  name: z.string().min(1).max(80),
  url: z.url(),
  version: z.string().max(40).nullable(),
});
export type DiscoveredBrain = z.infer<typeof DiscoveredBrain>;
```

`apps/desktop/src/main/discovery.ts` :
```ts
import { isIPv4 } from "node:net";
import { Bonjour, type Service } from "bonjour-service";
import { z } from "zod";
import { DiscoveredBrain } from "../shared/discovery.ts";

/** The brain announces itself as `_alicia._tcp` (apps/brain/src/discovery.ts). */
export const SERVICE_TYPE = "alicia";
/** Brains started after the search began answer the next query. */
const REQUERY_MS = 4000;
const Txt = z.object({ version: z.string().min(1).max(40) });

/** The parts of an mDNS answer we read (bonjour-service's Service). */
export interface ServiceLike {
  name: string;
  port: number;
  addresses?: string[] | undefined;
  referer?: { address: string; family: string } | undefined;
  txt?: unknown;
}

function usableIPv4(address: string): boolean {
  return isIPv4(address) && !address.startsWith("169.254.");
}

/** The brain an mDNS answer describes, or null when it cannot be reached over IPv4. */
export function brainFromService(service: ServiceLike): DiscoveredBrain | null {
  if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65_535) return null;
  const referer = service.referer?.family === "IPv4" ? service.referer.address : undefined;
  const address = [referer, ...(service.addresses ?? [])].find(
    (candidate): candidate is string => candidate !== undefined && usableIPv4(candidate),
  );
  if (address === undefined) return null;
  const txt = Txt.safeParse(service.txt);
  const brain = DiscoveredBrain.safeParse({
    name: service.name.slice(0, 80),
    url: `http://${address}:${service.port}`,
    version: txt.success ? txt.data.version : null,
  });
  return brain.success ? brain.data : null;
}

/** Something that finds brains; returns how to stop looking. */
export interface BrainBrowser {
  start(onUp: (brain: DiscoveredBrain) => void, onDown: (name: string) => void): () => void;
}

/**
 * Real mDNS, only while the pairing screen looks for a brain: it opens a UDP socket, which Windows' firewall
 * may ask about once.
 */
export function bonjourBrowser(): BrainBrowser {
  return {
    start(onUp, onDown) {
      const bonjour = new Bonjour(undefined, () => {
        // No network for mDNS: the pairing screen falls back to the manual address.
        console.error("mDNS unavailable");
      });
      // Revue des tâches 11–13 : erreurs du socket mDNS captées (voir décision 11 et le code réel).
      guardSocketErrors(bonjour, (error) => { console.error("mDNS unavailable", error); });
      const browser = bonjour.find({ type: SERVICE_TYPE });
      browser.on("up", (service: Service) => {
        const brain = brainFromService(service);
        if (brain !== null) onUp(brain);
      });
      browser.on("down", (service: Service) => {
        onDown(service.name);
      });
      const timer = setInterval(() => {
        browser.update();
      }, REQUERY_MS);
      return () => {
        clearInterval(timer);
        browser.stop();
        bonjour.destroy();
      };
    },
  };
}

/** For tests (ALICIA_TEST_BRAINS): a fixed list, announced at once. */
export function staticBrowser(brains: readonly DiscoveredBrain[]): BrainBrowser {
  return {
    start(onUp) {
      for (const brain of brains) onUp(brain);
      return () => undefined;
    },
  };
}

/** The brains found on the local network while the pairing screen looks for them, sorted by name. */
export class BrainDiscovery {
  readonly #browser: BrainBrowser;
  readonly #onChange: (brains: DiscoveredBrain[]) => void;
  readonly #found = new Map<string, DiscoveredBrain>();
  #stop: (() => void) | null = null;

  constructor(browser: BrainBrowser, onChange: (brains: DiscoveredBrain[]) => void) {
    this.#browser = browser;
    this.#onChange = onChange;
  }

  get brains(): DiscoveredBrain[] {
    return [...this.#found.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }

  start(): void {
    if (this.#stop !== null) return;
    this.#found.clear();
    this.#stop = this.#browser.start(
      (brain) => {
        this.#found.set(brain.name, brain);
        this.#onChange(this.brains);
      },
      (name) => {
        if (this.#found.delete(name)) this.#onChange(this.brains);
      },
    );
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }
}
```
Si TypeScript refuse l'import nommé `{ Bonjour, type Service }` du module `export =`, utiliser `import BonjourModule from "bonjour-service";` puis `new BonjourModule.Bonjour(…)` et `BonjourModule.Service` comme type.

`apps/desktop/src/shared/bridge.ts` : importer `import type { DiscoveredBrain } from "./discovery.ts";` et ajouter
```ts
export interface DiscoveryBridge {
  /** Starts looking for brains on the local network; answers those already found. */
  start(): Promise<DiscoveredBrain[]>;
  stop(): Promise<void>;
  onChange(listener: (brains: DiscoveredBrain[]) => void): Unsubscribe;
}
```
le champ `discovery: DiscoveryBridge;` dans `AliciaBridge`, `discoveryStart: "discovery:start"`, `discoveryStop: "discovery:stop"` dans `INVOKE`, `discovery: "push:discovery"` dans `PUSH`.

`apps/desktop/src/preload/index.ts` : importer `import { DiscoveredBrain } from "../shared/discovery.ts";` et ajouter
```ts
  discovery: {
    start: () => call(z.array(DiscoveredBrain), INVOKE.discoveryStart),
    stop: () => call(z.undefined(), INVOKE.discoveryStop),
    onChange: (listener) => subscribe(PUSH.discovery, z.array(DiscoveredBrain), listener),
  },
```

`apps/desktop/src/main/ipc.ts` : importer `import type { BrainDiscovery } from "./discovery.ts";`, ajouter `discovery: BrainDiscovery;` à `IpcDependencies` et
```ts
  handle(INVOKE.discoveryStart, NONE, () => {
    deps.discovery.start();
    return deps.discovery.brains;
  });
  handle(INVOKE.discoveryStop, NONE, () => {
    deps.discovery.stop();
  });
```

`apps/desktop/src/main/index.ts` :
- imports : `import { z } from "zod";`, `import { DiscoveredBrain } from "../shared/discovery.ts";`, `import { type BrainBrowser, BrainDiscovery, bonjourBrowser, staticBrowser } from "./discovery.ts";`
- au niveau du module, après `osIntegrationOff` :
```ts
/** Real mDNS; in tests, the brains listed in ALICIA_TEST_BRAINS (JSON, validated) and nothing from the network. */
function brainBrowser(): BrainBrowser {
  if (!osIntegrationOff) return bonjourBrowser();
  const raw = process.env["ALICIA_TEST_BRAINS"];
  return staticBrowser(raw === undefined ? [] : z.array(DiscoveredBrain).parse(JSON.parse(raw)));
}
```
- dans `start()`, après la création de `hub` :
```ts
  const discovery = new BrainDiscovery(brainBrowser(), (brains) => {
    windows.broadcast(PUSH.discovery, brains);
  });
```
- passer `discovery` à `registerIpc` ; dans `will-quit`, ajouter `discovery.stop();`.

- [ ] **Step 5: L'écran d'appairage**

`apps/desktop/src/renderer/src/components/PairingScreen.svelte` :
- imports : `import type { DiscoveredBrain } from "../../../shared/discovery.ts";`
- état :
```ts
  /** How long the screen says it is searching before pointing to the manual address. */
  const SEARCH_MS = 6000;
  let brains = $state<DiscoveredBrain[]>([]);
  let searching = $state(true);
  /** Once the person typed an address, a brain found later no longer replaces it. */
  let addressTouched = false;
```
- `onMount` devient :
```ts
  onMount(() => {
    // Address and device name are prefilled: the code is the only thing left to type.
    codeInput?.focus();
    void window.alicia.deviceName().then((name) => {
      if (deviceName === "") deviceName = name;
    });
    const off = window.alicia.discovery.onChange(showBrains);
    void window.alicia.discovery.start().then(showBrains, () => undefined);
    const timer = setTimeout(() => {
      searching = false;
    }, SEARCH_MS);
    return () => {
      off();
      clearTimeout(timer);
      void window.alicia.discovery.stop();
    };
  });

  function showBrains(list: DiscoveredBrain[]): void {
    brains = list;
    if (list.length > 0) searching = false;
    const [only] = list;
    // A single brain at home: its address is filled in for the person.
    if (!addressTouched && list.length === 1 && only !== undefined) serverUrl = only.url;
  }

  function choose(brain: DiscoveredBrain): void {
    serverUrl = brain.url;
    addressTouched = true;
    codeInput?.focus();
  }
```
- sur le champ d'adresse : ajouter `oninput={() => { addressTouched = true; }}` ;
- entre la ligne `{#if notice}…{/if}` et le `<label>` de l'adresse :
```svelte
    <div class="found" aria-live="polite">
      {#if brains.length > 0}
        <p class="found-label" in:fade={{ duration: motion(150) }}>Trouvée sur le réseau</p>
        <ul>
          {#each brains as brain (brain.name)}
            <li in:fade={{ duration: motion(150) }}>
              <button type="button" class="brain" class:selected={serverUrl === brain.url} onclick={() => { choose(brain); }} data-testid="discovered-brain">
                <span class="brain-name">{brain.name}</span>
                <span class="brain-url">{brain.url}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if searching}
        <p class="found-label" data-testid="discovery-searching" in:fade={{ duration: motion(150) }}>Recherche d'Alicia sur le réseau…</p>
      {:else}
        <p class="found-label" data-testid="discovery-none" in:fade={{ duration: motion(150) }}>
          Pas trouvée sur le réseau : saisis son adresse ci-dessous (avec Tailscale, par exemple http://mac-mini:8780).
        </p>
      {/if}
    </div>
```
- styles (la règle générale `button` du fichier vise le bouton « Appairer » : `.brain` la surcharge) :
```css
  .found { width: 100%; display: flex; flex-direction: column; gap: 6px; }
  .found-label { margin: 0; font-size: 13px; color: var(--cream-muted); }
  .found ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .brain {
    margin-top: 0; width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
    padding: 8px 11px; border: 1px solid transparent; background: var(--surface); color: var(--cream);
    font-weight: 400; text-align: left; transition: border-color var(--duration) ease;
  }
  .brain.selected, .brain:hover { border-color: var(--sage); }
  .brain-name { font-weight: 700; }
  .brain-url { font-size: 12px; color: var(--muted); }
```

- [ ] **Step 6: Vérifier**

Run: `pnpm --filter @alicia/desktop test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout PASS (aucun test n'ouvre de socket mDNS : `ALICIA_OS_INTEGRATION=off` remplace le réseau par `ALICIA_TEST_BRAINS`).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/shared/discovery.ts apps/desktop/src/main/discovery.ts apps/desktop/src/shared/bridge.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/components/PairingScreen.svelte apps/desktop/test/discovery.test.ts apps/desktop/e2e/desktop.e2e.ts
git commit -m "feat(desktop): find the brain on the local network on first launch (mDNS), manual address kept

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Le cerveau sert les mises à jour (`/updates/`)

**Files:**
- Modify: `apps/brain/package.json`, `pnpm-lock.yaml`, `apps/brain/src/server/server.ts`, `apps/brain/src/application.ts`
- Test: `apps/brain/test/server-updates.test.ts`

- [ ] **Step 1: Dépendance**

Run: `npm view @fastify/static version peerDependencies time --json` (attendu : 10.1.5, compatible Fastify 5), puis
```bash
pnpm --filter @alicia/brain add @fastify/static@10.1.5
```

- [ ] **Step 2: Écrire les tests**

`apps/brain/test/server-updates.test.ts` :
```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { FakeEngine } from "../src/engine/fake-engine.ts";
import { PairingService } from "../src/identity/pairing.ts";
import { createServer } from "../src/server/server.ts";
import { createTestClock, createTestDb, createTestMemory } from "./helpers.ts";

const dirs: string[] = [];
const INSTALLER = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serverWith(updatesDir?: string) {
  const db = createTestDb();
  const time = createTestClock();
  const repository = new ConversationRepository(db, time.clock);
  return createServer({
    pairing: new PairingService(db, time.clock),
    repository,
    version: "0.1.0",
    chat: {
      repository, engine: new FakeEngine(() => []), memory: createTestMemory(db, time.clock), clock: time.clock, timezone: "Europe/Paris",
    },
    ...(updatesDir !== undefined ? { updatesDir } : {}),
  });
}

/** A data folder like the brain's: the database next to the published versions. */
function publishedUpdates(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "alicia-updates-"));
  dirs.push(dataDir);
  const updatesDir = join(dataDir, "updates");
  mkdirSync(updatesDir);
  writeFileSync(join(updatesDir, "latest.yml"), "version: 0.2.0\npath: Alicia-Setup-0.2.0.exe\n");
  writeFileSync(join(updatesDir, "Alicia-Setup-0.2.0.exe"), INSTALLER);
  writeFileSync(join(updatesDir, ".hidden"), "secret");
  writeFileSync(join(dataDir, "alicia.db"), "database");
  return updatesDir;
}

describe("/updates/", () => {
  test("serves the published versions to anyone (no token); latest.yml is never cached", async () => {
    const app = await serverWith(publishedUpdates());
    const latest = await app.inject({ method: "GET", url: "/updates/latest.yml" });
    expect(latest.statusCode).toBe(200);
    expect(latest.body).toContain("version: 0.2.0");
    expect(latest.headers["cache-control"]).toBe("no-cache");
    const installer = await app.inject({ method: "GET", url: "/updates/Alicia-Setup-0.2.0.exe" });
    expect(installer.statusCode).toBe(200);
    expect(installer.rawPayload).toEqual(INSTALLER);
  });

  test("no listing, no hidden files, nothing outside the folder", async () => {
    const app = await serverWith(publishedUpdates());
    for (const url of ["/updates/", "/updates/.hidden", "/updates/../alicia.db", "/updates/..%2falicia.db", "/updates/%2e%2e/alicia.db"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).not.toBe(200);
      expect(response.body, url).not.toContain("database");
      expect(response.body, url).not.toContain("secret");
    }
  });

  test("without an updates folder, the route does not exist", async () => {
    const app = await serverWith();
    expect((await app.inject({ method: "GET", url: "/updates/latest.yml" })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/brain test -- server-updates`
Expected: FAIL (404 sur `latest.yml`, `updatesDir` inconnu du type).

- [ ] **Step 4: Implémenter**

`apps/brain/src/server/server.ts` :
- `import fastifyStatic from "@fastify/static";`
- dans `ServerDependencies` :
```ts
  /** Published versions of the desktop app, served read-only under /updates/ (omitted in most tests). */
  updatesDir?: string;
```
- dans `createServer`, après l'enregistrement de `@fastify/websocket` :
```ts
  // Desktop app updates (electron-updater, generic provider) and the first download of the installer.
  // Public on purpose: an installer holds no secret, and the brain is only reachable at home or over Tailscale.
  if (deps.updatesDir !== undefined) {
    await app.register(fastifyStatic, {
      root: deps.updatesDir,
      prefix: "/updates/",
      decorateReply: false,
      index: false,
      list: false,
      dotfiles: "deny",
      setHeaders: (response, path) => {
        // electron-updater must always read the current latest.yml.
        if (path.endsWith(".yml")) response.setHeader("cache-control", "no-cache");
      },
    });
  }
```

`apps/brain/src/application.ts`, dans `buildApplication`, au début du `try` :
```ts
    // <dataDir>/updates: where a new version of the desktop app is dropped (README, « Publier une version »).
    const updatesDir = join(config.dataDir, "updates");
    mkdirSync(updatesDir, { recursive: true });
```
et passer `updatesDir,` à `createServer({ … })`.

- [ ] **Step 5: Vérifier**

Run: `pnpm --filter @alicia/brain test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout PASS (l'e2e construit de vrais cerveaux avec `buildApplication` : le dossier `updates` est créé dans leur dossier temporaire).

- [ ] **Step 6: Commit**

```bash
git add apps/brain/package.json pnpm-lock.yaml apps/brain/src/server/server.ts apps/brain/src/application.ts apps/brain/test/server-updates.test.ts
git commit -m "feat(brain): serve desktop app updates read-only under /updates/

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Installateur NSIS et mises à jour automatiques

**Files:**
- Create: `apps/desktop/electron-builder.yml`, `apps/desktop/src/shared/updates.ts`, `apps/desktop/src/main/updater.ts`
- Modify: `apps/desktop/package.json`, `pnpm-lock.yaml`, `.gitignore`, `eslint.config.js`, `apps/desktop/src/shared/bridge.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/src/components/SettingsView.svelte`
- Test: `apps/desktop/test/updater.test.ts`, `apps/desktop/e2e/desktop.e2e.ts`

- [ ] **Step 1: Dépendances**

Run: `npm view electron-builder dist-tags time --json` et `npm view electron-updater dist-tags time --json`.
Expected (relevé du 2026-10-04) : `electron-builder` 26.17.0 et `electron-updater` 6.8.10 (étiquette `v26`, publiées le 2026-09-26). Prendre les plus récentes **stables** publiées depuis plus d'un jour (jamais les `-alpha`).
```bash
pnpm --filter @alicia/desktop add electron-updater@6.8.10
pnpm --filter @alicia/desktop add -D electron-builder@26.17.0
```
`electron-updater` va en `dependencies` : electron-vite la laisse **externe** (elle est chargée à l'exécution depuis `node_modules`, et electron-builder l'emporte dans l'installateur). Si pnpm signale des scripts de construction ignorés, ne les autoriser (`allowBuilds`) que si `dist` échoue sans eux, en le signalant.

- [ ] **Step 2: Écrire les tests**

`apps/desktop/test/updater.test.ts` :
```ts
import { describe, expect, test, vi } from "vitest";
import { CHECK_EVERY_MS, type UpdateEngine, UpdateController, updateFeedUrl } from "../src/main/updater.ts";
import type { UpdateStatus } from "../src/shared/updates.ts";

function setup(withEngine = true) {
  const feeds: string[] = [];
  const counts = { checks: 0, installs: 0 };
  let failNext = false;
  let emit: (status: UpdateStatus) => void = () => undefined;
  const engine: UpdateEngine = {
    setFeed: (url) => { feeds.push(url); },
    check: () => {
      counts.checks++;
      if (!failNext) return Promise.resolve();
      failNext = false;
      return Promise.reject(new Error("brain unreachable"));
    },
    install: () => { counts.installs++; },
    subscribe: (listener) => { emit = listener; },
  };
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const statuses: UpdateStatus[] = [];
  const controller = new UpdateController(
    withEngine ? engine : null,
    (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    (status) => { statuses.push(status); },
  );
  return {
    controller, feeds, counts, timers, statuses,
    emit: (status: UpdateStatus) => { emit(status); },
    failNextCheck: () => { failNext = true; },
  };
}

const SERVER = "http://192.168.1.20:8780";

describe("UpdateController", () => {
  test("the feed is the paired brain's /updates/", () => {
    expect(updateFeedUrl(SERVER)).toBe("http://192.168.1.20:8780/updates/");
  });

  test("a dev build has no updates", () => {
    const { controller, statuses } = setup(false);
    controller.setServer(SERVER);
    expect(controller.status).toEqual({ state: "disabled" });
    expect(statuses).toEqual([]);
  });

  test("checks the paired brain now, then every 6 hours", () => {
    const { controller, feeds, counts, timers } = setup();
    controller.setServer(SERVER);
    expect(feeds).toEqual(["http://192.168.1.20:8780/updates/"]);
    expect(controller.status).toEqual({ state: "idle" });
    expect(counts.checks).toBe(1);
    expect(timers.map((timer) => timer.ms)).toEqual([CHECK_EVERY_MS]);
    timers[0]?.run();
    expect(counts.checks).toBe(2);
  });

  test("a downloaded update can be installed; periodic checks stop", () => {
    const { controller, counts, timers, emit } = setup();
    controller.setServer(SERVER);
    controller.install();
    expect(counts.installs).toBe(0);
    emit({ state: "ready", version: "0.2.0" });
    expect(controller.status).toEqual({ state: "ready", version: "0.2.0" });
    timers[0]?.run();
    expect(counts.checks).toBe(1);
    controller.install();
    expect(counts.installs).toBe(1);
  });

  test("signing out turns updates off and cancels the checks", () => {
    const { controller, timers } = setup();
    controller.setServer(SERVER);
    controller.setServer(null);
    expect(controller.status).toEqual({ state: "disabled" });
    expect(timers[0]?.cancelled).toBe(true);
  });

  test("a failed check shows as an error", async () => {
    const { controller, failNextCheck } = setup();
    failNextCheck();
    controller.setServer(SERVER);
    await vi.waitFor(() => { expect(controller.status).toEqual({ state: "error" }); });
  });
});
```

Dans `apps/desktop/e2e/desktop.e2e.ts`, test « Réglages… », juste avant `// Signing out is in Réglages now.` :
```ts
  // Development build: updates only exist in the installed app.
  await expect.poll(() => second.page.getByTestId("settings-updates").textContent(), POLL).toContain("app installée");
```

- [ ] **Step 3: Vérifier que ça échoue**

Run: `pnpm --filter @alicia/desktop test -- updater`
Expected: FAIL (`updater.ts` introuvable).

- [ ] **Step 4: Implémenter le contrôleur**

`apps/desktop/src/shared/updates.ts` :
```ts
import { z } from "zod";

/** Where the automatic update stands (shown in Réglages and the tray). */
export const UpdateStatus = z.discriminatedUnion("state", [
  /** Development build, or not paired: no updates. */
  z.object({ state: z.literal("disabled") }),
  z.object({ state: z.literal("idle") }),
  z.object({ state: z.literal("checking") }),
  z.object({ state: z.literal("up_to_date") }),
  z.object({ state: z.literal("downloading"), percent: z.number().min(0).max(100) }),
  z.object({ state: z.literal("ready"), version: z.string().max(40) }),
  z.object({ state: z.literal("error") }),
]);
export type UpdateStatus = z.infer<typeof UpdateStatus>;
```

`apps/desktop/src/main/updater.ts` :
```ts
import electronUpdater from "electron-updater";
import type { UpdateStatus } from "../shared/updates.ts";

/** What the controller needs from electron-updater (a fake in tests). */
export interface UpdateEngine {
  setFeed(url: string): void;
  check(): Promise<void>;
  install(): void;
  subscribe(listener: (status: UpdateStatus) => void): void;
}

export const CHECK_EVERY_MS = 6 * 3_600_000;

/** The brain serves the published versions under /updates/ (apps/brain/src/server/server.ts). */
export function updateFeedUrl(serverUrl: string): string {
  return `${serverUrl}/updates/`;
}

/** Automatic updates from the paired brain: checked at startup and every 6 hours, installed on quit or on demand. */
export class UpdateController {
  readonly #engine: UpdateEngine | null;
  readonly #schedule: (run: () => void, ms: number) => () => void;
  readonly #onStatus: (status: UpdateStatus) => void;
  #status: UpdateStatus = { state: "disabled" };
  #cancelCheck: (() => void) | null = null;

  /** `engine` is null in a development build. */
  constructor(
    engine: UpdateEngine | null,
    schedule: (run: () => void, ms: number) => () => void,
    onStatus: (status: UpdateStatus) => void,
  ) {
    this.#engine = engine;
    this.#schedule = schedule;
    this.#onStatus = onStatus;
    engine?.subscribe((status) => {
      this.#set(status);
    });
  }

  get status(): UpdateStatus {
    return this.#status;
  }

  /** Paired with a brain (or signed out: null). */
  setServer(serverUrl: string | null): void {
    this.#cancelCheck?.();
    this.#cancelCheck = null;
    if (this.#engine === null) return;
    if (serverUrl === null) {
      this.#set({ state: "disabled" });
      return;
    }
    this.#engine.setFeed(updateFeedUrl(serverUrl));
    this.#set({ state: "idle" });
    this.#check();
  }

  /** Restarts into the downloaded version (otherwise it installs when Alicia quits). */
  install(): void {
    if (this.#status.state === "ready") this.#engine?.install();
  }

  #check(): void {
    const engine = this.#engine;
    if (engine === null || this.#status.state === "ready") return;
    void engine.check().catch(() => {
      this.#set({ state: "error" });
    });
    this.#cancelCheck = this.#schedule(() => {
      this.#cancelCheck = null;
      this.#check();
    }, CHECK_EVERY_MS);
  }

  #set(status: UpdateStatus): void {
    this.#status = status;
    this.#onStatus(status);
  }
}

/** electron-updater with a generic provider; the feed (the paired brain) is set at run time. Installed app only. */
export function electronUpdateEngine(options: { beforeInstall: () => void }): UpdateEngine {
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  return {
    setFeed: (url) => {
      autoUpdater.setFeedURL({ provider: "generic", url });
    },
    check: async () => {
      await autoUpdater.checkForUpdates();
    },
    install: () => {
      // quitAndInstall closes the windows before `before-quit`: let them really close.
      options.beforeInstall();
      autoUpdater.quitAndInstall();
    },
    subscribe: (listener) => {
      autoUpdater.on("checking-for-update", () => {
        listener({ state: "checking" });
      });
      autoUpdater.on("update-not-available", () => {
        listener({ state: "up_to_date" });
      });
      autoUpdater.on("update-available", () => {
        listener({ state: "downloading", percent: 0 });
      });
      autoUpdater.on("download-progress", (progress) => {
        listener({ state: "downloading", percent: Math.round(progress.percent) });
      });
      autoUpdater.on("update-downloaded", (event) => {
        listener({ state: "ready", version: event.version });
      });
      autoUpdater.on("error", () => {
        listener({ state: "error" });
      });
    },
  };
}
```
`electron-updater` est en CommonJS : l'import par défaut donne son `module.exports` ; `autoUpdater` n'est créé qu'au premier accès, donc jamais en développement ni dans l'e2e (`electronUpdateEngine` n'est appelé que si `app.isPackaged`).

- [ ] **Step 5: Brancher**

`apps/desktop/src/shared/bridge.ts` : importer `import type { UpdateStatus } from "./updates.ts";` et ajouter
```ts
export interface UpdatesBridge {
  status(): Promise<UpdateStatus>;
  /** Restarts into the downloaded version. */
  install(): Promise<void>;
  onChange(listener: (status: UpdateStatus) => void): Unsubscribe;
}
```
le champ `updates: UpdatesBridge;` dans `AliciaBridge`, `updatesStatus: "updates:status"`, `updatesInstall: "updates:install"` dans `INVOKE`, `updates: "push:updates"` dans `PUSH`.

`apps/desktop/src/preload/index.ts` : importer `import { UpdateStatus } from "../shared/updates.ts";` et ajouter
```ts
  updates: {
    status: () => call(UpdateStatus, INVOKE.updatesStatus),
    install: () => call(z.undefined(), INVOKE.updatesInstall),
    onChange: (listener) => subscribe(PUSH.updates, UpdateStatus, listener),
  },
```

`apps/desktop/src/main/ipc.ts` : importer `import type { UpdateController } from "./updater.ts";`, ajouter `updates: UpdateController;` à `IpcDependencies` et
```ts
  handle(INVOKE.updatesStatus, NONE, () => deps.updates.status);
  handle(INVOKE.updatesInstall, NONE, () => {
    deps.updates.install();
  });
```

`apps/desktop/src/main/index.ts` :
- `import { electronUpdateEngine, UpdateController } from "./updater.ts";`
- dans `start()`, après `discovery` :
```ts
  const updates = new UpdateController(
    app.isPackaged ? electronUpdateEngine({ beforeInstall: () => { windows.prepareQuit(); } }) : null,
    schedule,
    (status) => {
      windows.broadcast(PUSH.updates, status);
      refreshTray();
    },
  );
```
- `trayItems()` : `updateReady: updates.status.state === "ready"` ;
- `onTrayAction` : `case "install-update": updates.install(); return;` (supprimer le commentaire « Offered once updates exist ») ;
- `setSession` : ajouter `updates.setServer(next?.serverUrl ?? null);` ;
- passer `updates` à `registerIpc` ;
- après `settings.start();` : `updates.setServer(current?.serverUrl ?? null);`.

`apps/desktop/src/renderer/src/components/SettingsView.svelte` :
- imports : `import type { UpdateStatus } from "../../../shared/updates.ts";` et `import { mirror } from "../lib/mirror.ts";`
- état : `let update = $state<UpdateStatus>({ state: "disabled" });`
- dans `onMount`, à la fin :
```ts
    return mirror(() => window.alicia.updates.status(), (listener) => window.alicia.updates.onChange(listener), (status) => {
      update = status;
    });
```
- fonction :
```ts
  function updateLabel(status: UpdateStatus): string {
    switch (status.state) {
      case "disabled":
        return "Les mises à jour automatiques fonctionnent dans l'app installée, une fois appairée.";
      case "idle":
      case "up_to_date":
        return `Alicia est à jour (version ${appVersion}).`;
      case "checking":
        return "Recherche d'une mise à jour…";
      case "downloading":
        return `Téléchargement de la mise à jour… ${status.percent} %`;
      case "ready":
        return `La version ${status.version} est prête.`;
      case "error":
        return "Impossible de vérifier les mises à jour pour l'instant.";
    }
  }
```
- après la section « Cet appareil » :
```svelte
    <section aria-labelledby="{uid}-updates">
      <h2 id="{uid}-updates">Mises à jour</h2>
      <div class="row">
        <p class="label hint" data-testid="settings-updates">{updateLabel(update)}</p>
        {#if update.state === "ready"}
          <button class="link" onclick={() => void window.alicia.updates.install()} data-testid="settings-update-install" transition:fade={{ duration: motion(150) }}>Redémarrer pour installer</button>
        {/if}
      </div>
    </section>
```

- [ ] **Step 6: Configuration de l'installateur**

`apps/desktop/package.json` : ajouter en tête `"version": "0.1.0"`, `"description": "Alicia, l'assistante de la maison"`, `"author": "pandarvis"`, et le script
```json
    "dist": "electron-vite build && electron-builder --win nsis --publish never"
```
(Ne **pas** ajouter `productName` ici : cela changerait le profil de développement ; le nom « Alicia » n'est donné qu'à l'app installée, ci-dessous.)

`apps/desktop/electron-builder.yml` :
```yaml
# Windows installer: NSIS, per user (no admin rights), no code signing. Updates come from the paired brain.
appId: fr.pandarvis.alicia # same id as app.setAppUserModelId: notifications show as « Alicia »
productName: Alicia
copyright: Copyright © 2026 pandarvis
# The installed app is named « Alicia » (profile %APPDATA%\Alicia, its own single-instance lock),
# separate from the development build (@alicia/desktop).
extraMetadata:
  name: alicia
  productName: Alicia
directories:
  output: dist
  buildResources: build
files:
  - out/**/*
  - build/icon.png
  - build/icon.ico
  - package.json
asar: true
npmRebuild: false # no native module in the desktop app
electronLanguages:
  - fr
  - en-US
win:
  target:
    - nsis
  icon: build/icon.ico
  artifactName: Alicia-Setup-${version}.${ext}
nsis:
  oneClick: true
  perMachine: false
  allowElevation: false
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: Alicia
  runAfterFinish: true
  deleteAppDataOnUninstall: false
# Required for latest.yml and app-update.yml; the real feed (the paired brain) is set at run time.
publish:
  - provider: generic
    url: http://alicia.invalid/updates/
```

`.gitignore` : ajouter `apps/desktop/dist/` sous `apps/desktop/out/`.
`eslint.config.js` : ajouter `"**/dist/**"` à la liste `ignores`.

- [ ] **Step 7: Vérifier le code**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout PASS.

- [ ] **Step 8: Construire l'installateur (sans l'exécuter)**

Run: `pnpm --filter @alicia/desktop dist` (le premier lancement télécharge Electron pour Windows, NSIS et les outils d'electron-builder : réseau nécessaire, quelques minutes).
Expected : se termine sans erreur et produit
- `apps/desktop/dist/Alicia-Setup-0.1.0.exe`,
- `apps/desktop/dist/Alicia-Setup-0.1.0.exe.blockmap`,
- `apps/desktop/dist/latest.yml`,
- `apps/desktop/dist/win-unpacked/Alicia.exe`.

Puis vérifier :
- `cat apps/desktop/dist/latest.yml` → `version: 0.1.0`, `path: Alicia-Setup-0.1.0.exe`, un `sha512` ;
- `cat apps/desktop/dist/win-unpacked/resources/app-update.yml` → `provider: generic` ;
- `pnpm dlx @electron/asar list apps/desktop/dist/win-unpacked/resources/app.asar | grep -E "out[/\\\\]main[/\\\\]index.js|out[/\\\\]preload[/\\\\]index.cjs|out[/\\\\]renderer[/\\\\]index.html|build[/\\\\]icon.ico|node_modules[/\\\\]electron-updater[/\\\\]package.json"` → les cinq lignes ;
- `pnpm dlx @electron/asar extract-file apps/desktop/dist/win-unpacked/resources/app.asar package.json` puis lire le `package.json` extrait (dans le dossier courant, à supprimer ensuite) → `"name": "alicia"`, `"productName": "Alicia"`, `"version": "0.1.0"`.

En cas d'erreur « Cannot create symbolic link : le client ne dispose pas d'un privilège nécessaire » (extraction des outils de signature) : **ne pas** modifier les réglages de Windows ; s'arrêter et demander à Kévin d'activer le mode développeur de Windows (ou de lancer une fois la commande dans un terminal administrateur), puis relancer. En dernier recours seulement, et en le signalant : `signAndEditExecutable: false` sous `win:` (l'exécutable perdrait son icône et ses informations de version).
Si `node_modules/electron-updater` manque dans l'asar (pnpm), lire la sortie d'electron-builder sur la collecte des dépendances et corriger la configuration plutôt que d'embarquer la dépendance par d'autres moyens ; signaler la solution retenue.

**Ne pas lancer l'installateur** ni `win-unpacked/Alicia.exe` : l'app installée utilise le vrai profil Windows (raccourci global, entrée de démarrage) ; c'est la vérification manuelle de Kévin (tâche 16).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/electron-builder.yml .gitignore eslint.config.js apps/desktop/src/shared/updates.ts apps/desktop/src/main/updater.ts apps/desktop/src/shared/bridge.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/components/SettingsView.svelte apps/desktop/test/updater.test.ts apps/desktop/e2e/desktop.e2e.ts
git commit -m "feat(desktop): per-user NSIS installer and automatic updates from the paired brain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Documentation et vérification finale

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-04-alicia-socle-design.md`

- [ ] **Step 1: README**

Dans la section « App de bureau (Windows) » de `README.md`, ajouter après le bloc existant :
````markdown
### Sur le PC

- **Une seule Alicia** : relancer l'app ramène la fenêtre existante. Fermer la fenêtre la range dans la
  zone de notification (clic gauche : rouvrir ; clic droit : Holo, lancement au démarrage, quitter).
- **Notifications** : quand Alicia répond alors que sa fenêtre est cachée (ou à une question posée par la
  barre Spotlight), la réponse arrive en notification Windows ; un clic ouvre la conversation.
- **L'Holo** : Alicia flotte sur le bureau, toujours au-dessus, et reflète ce qu'elle fait. Elle se déplace à
  la souris (sa place est retenue) ; un clic ouvre une petite discussion.
- **Spotlight** : `Ctrl+Alt+A` (modifiable dans Réglages) ouvre une barre au centre de l'écran ; Entrée envoie.
- **Réglages** : raccourci, lancement au démarrage, Holo, informations de l'appareil, déconnexion.
- **Premier lancement** : l'app cherche le cerveau sur le réseau local (mDNS, service `_alicia._tcp`) ; sinon,
  saisir son adresse (Tailscale). Le cerveau s'annonce tout seul ; `discovery: false` dans sa config pour couper.

### Installer et publier une version

```bash
pnpm --filter @alicia/desktop dist   # → apps/desktop/dist/Alicia-Setup-<version>.exe + latest.yml
```
- Installation par utilisateur, sans droits admin (`%LOCALAPPDATA%\Programs\Alicia`), sans signature de code
  (Windows SmartScreen peut demander « Exécuter quand même » la première fois).
- **Publier** : augmenter `version` dans `apps/desktop/package.json`, lancer `dist`, puis copier
  `latest.yml`, `Alicia-Setup-<version>.exe` et `Alicia-Setup-<version>.exe.blockmap` dans
  `<dataDir>/updates/` **sur la machine du cerveau**. Les apps installées vérifient au démarrage et toutes les
  six heures, téléchargent, et installent en quittant (ou tout de suite depuis Réglages / le menu).
- **Premier téléchargement** : `http://<cerveau>:8780/updates/Alicia-Setup-<version>.exe` dans un navigateur
  (la route `/updates/` est publique : un installateur ne contient aucun secret).
````

- [ ] **Step 2: Spec**

Dans `docs/superpowers/specs/2026-10-04-alicia-socle-design.md`, section « Distribution » : remplacer `(`/mises-a-jour/`)` par `(`/updates/`, publique en lecture seule)`.

- [ ] **Step 3: Vérification finale**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout au vert. Puis `git status --short` : aucun fichier non suivi oublié (en dehors de `apps/desktop/dist/`, ignoré).

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-10-04-alicia-socle-design.md
git commit -m "docs: desktop app on the PC (tray, Holo, Spotlight, Réglages, discovery, installer and updates)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Vérification manuelle par Kévin (à lui demander, ne pas faire à sa place)**

Sur son PC, avec l'installateur `apps/desktop/dist/Alicia-Setup-0.1.0.exe` :
1. Installer (pas de demande de droits admin ; SmartScreen possible) ; l'app démarre, l'icône Alicia est dans la zone de notification.
2. Premier lancement : le cerveau est-il trouvé sur le réseau (le pare-feu Windows peut demander l'autorisation une fois) ? Sinon, l'adresse manuelle marche-t-elle (Tailscale) ?
3. Appairer ; l'Holo apparaît en bas à droite ; le déplacer, l'ouvrir, lui écrire ; le cacher par le menu de la zone de notification.
4. `Ctrl+Alt+A` depuis une autre application : la barre s'ouvre au-dessus de tout ; Entrée ; la notification arrive au nom d'« Alicia » ; son clic ouvre la conversation.
5. Fermer la fenêtre pendant une réponse : notification. Relancer l'app depuis le menu Démarrer : la fenêtre existante revient (pas de deuxième Alicia).
6. Réglages : changer le raccourci, activer « Lancer au démarrage », redémarrer la session Windows : Alicia démarre dans la zone de notification, sans fenêtre.
7. Mise à jour : passer `version` à `0.1.1`, `pnpm --filter @alicia/desktop dist`, copier les trois fichiers dans `<dataDir>/updates/` du cerveau de test, relancer l'app : Réglages finit par afficher « La version 0.1.1 est prête » ; « Redémarrer pour installer » ; l'app redémarre en 0.1.1.

---

## Couverture de la spec par ce plan

| Exigence (spec : App Electron, Distribution ; plan 4a « Reportés au plan 4b ») | Tâche |
|---|---|
| Une seule instance, la deuxième ramène la fenêtre | 8 |
| Zone de notification : ouvrir, afficher / masquer l'Holo, lancer au démarrage, quitter | 3, 8, 9 |
| Fermer la fenêtre la cache au lieu de quitter | 8 |
| Notifications Windows quand Alicia répond fenêtre cachée | 4, 5, 8 |
| État partagé entre fenêtres (une connexion, une humeur, une session) | 1, 4, 5, 7 |
| Holo : transparent, sans cadre, toujours au-dessus, déplaçable, position mémorisée, clic = mini-chat, reflète l'état (repos, écoute, réflexion, parle, succès, alerte, erreur, idée) | 5, 6, 9 |
| Transitions fluides (Holo, mini-chat, Spotlight, écrans, listes) | 9, 10, 11, 13 |
| Spotlight : raccourci global configurable (`Ctrl+Alt+A`), barre centrée, Entrée envoie et ferme, réponse en notification, clic = conversation | 2, 3, 10, 11 |
| Écran Réglages : raccourci, démarrage, Holo, adresse du cerveau et appareil, déconnexion | 11, 15 |
| Premier lancement : découverte mDNS, adresse manuelle en repli (Tailscale) | 12, 13 |
| Distribution : NSIS par utilisateur sans admin, icône existante | 15 |
| `electron-updater` générique pointant sur le cerveau, route servie depuis `<dataDir>/updates` | 14, 15 |
| Sécurité Electron conservée (sandbox, preload CJS, expéditeur vérifié, messages validés par Zod) | 7, 8, 9, 11, 13, 15 |
| Tests Playwright des parcours clés (fermer = cacher, Holo, Spotlight → notification, réglages conservés), jamais de clic souris système, aucun effet de bord système | 8, 9, 10, 11, 13, 15 |

Hors de ce plan : clic traversant la zone transparente de l'Holo agrandi ; voix dans l'Holo (sous-projet 3) ; signature de code ; écrans Maison et Comptes (leurs plans).

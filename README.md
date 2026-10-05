# Alicia

Assistante familiale (Alice + IA), refonte d'Alice sur le Claude Agent SDK.
Spec : `docs/superpowers/specs/2026-10-04-alicia-socle-design.md`.

## Prérequis
- Node (dernière LTS), pnpm (`corepack enable`)
- Pour le mode subscription : `claude setup-token` (Claude Code) pour obtenir le jeton

## Installation
```bash
pnpm install
cp apps/brain/alicia.config.example.yaml apps/brain/alicia.config.yaml
cp apps/brain/.env.example apps/brain/.env   # puis renseigner le secret du mode choisi
```

## Commandes (depuis la racine)
```bash
pnpm test && pnpm typecheck && pnpm lint
pnpm --filter @alicia/brain alicia                     # aide
pnpm --filter @alicia/brain alicia start               # Ctrl+C : arrêt propre
pnpm --filter @alicia/brain alicia pair kevin
pnpm --filter @alicia/brain alicia chat --code 123456
pnpm --filter @alicia/brain alicia devices             # appareils appairés (id, personne, dates)
pnpm --filter @alicia/brain alicia revoke <id>         # coupe un appareil, même connecté
pnpm --filter @alicia/brain alicia backup              # sauvegarde la base maintenant
pnpm --filter @alicia/brain alicia check-engine
pnpm --filter @alicia/brain alicia import-alice --chroma <chroma.sqlite3> [--rules <regles.json>]
```
Les commandes s'exécutent dans `apps/brain` : la config y est lue
(`alicia.config.yaml`, ou le chemin donné par `ALICIA_CONFIG`).
Les secrets sont lus dans l'environnement (pas de chargement automatique de `.env`). Lancer
`tsx` avec l'option Node `--env-file` (le script `alicia` ne la transmet pas) :
`cd apps/brain && pnpm exec tsx --env-file=.env src/cli.ts start`.
Ne pas faire `source .env` dans le shell : si la clé contient une espace parasite, le shell
en affiche une partie dans son message d'erreur.

## Mémoire

Alicia a une mémoire durable, commune à la famille ou personnelle à chacun (SQLite, recherche
par mots-clés et par sens). Elle la consulte et l'alimente elle-même ; oublier est « doux » :
un souvenir oublié disparaît tout de suite, puis est purgé pour de bon après 30 jours (au
démarrage du cerveau).

- **Premier démarrage** : les vecteurs de sens sont calculés en local (modèle
  `multilingual-e5-small`, aucun quota, rien ne sort de la maison). Le modèle (~120 Mo) est
  téléchargé **une seule fois, à la première utilisation de la mémoire** (pas au lancement),
  dans `data/models` ; la première recherche ou le premier souvenir est donc plus lent. Les
  tests automatiques n'utilisent jamais le vrai modèle.
- **Import de l'ancienne Alice** : à lancer **sur le Pi**, contre les données de production de
  l'ancienne Alice (ou une copie), depuis `apps/brain` :
  ```bash
  pnpm exec tsx src/cli.ts import-alice \
    --chroma <…>/data/memory/chroma.sqlite3 --rules <…>/data/regles.json
  ```
  Les souvenirs et les règles de la maison arrivent comme souvenirs **communs**. La commande est
  idempotente (relançable sans doublon) et refuse ce qui ressemble à un secret (mot de passe,
  code, IBAN…) ; elle affiche le bilan : créés, doublons, déjà importés, refusés. `--rules` est
  facultatif.
- **API `/memories`** (jeton d'appareil en `Authorization: Bearer`, toujours limitée à ce que la
  personne a le droit de voir : le commun et son perso) : `GET /memories?scope=&kind=&q=`,
  `POST /memories`, `PATCH /memories/:id`, `DELETE /memories/:id` (oubli doux),
  `GET /memories?forgotten=true` (corbeille), `POST /memories/:id/restore` (récupérer),
  `GET /memories/test?q=` (banc d'essai, ne compte pas comme un rappel). Elle sert l'écran
  « Souvenirs » de l'app. `DELETE /conversations/:id` supprime une conversation (refusé avec
  `409` pendant une réponse d'Alicia).

Dans l'app, l'activité d'Alicia indique ce qu'elle fait avec sa mémoire (« Alicia fouille dans sa
mémoire… », « Alicia retient ça… »).

## Sauvegardes, journal et réseau

- **Sauvegarde nocturne** : le cerveau démarré (`start`) copie sa base chaque nuit, à partir de 3 h (heure du
  `timezone` de la config), avec l'API de sauvegarde de SQLite, dans `<dataDir>/backups/alicia-AAAA-MM-JJ.db`.
  Il garde les **14 plus récentes**. S'il était éteint à 3 h, il rattrape au démarrage. `alicia backup` en fait
  une tout de suite.
- **Restaurer** : arrêter le cerveau, remplacer `<dataDir>/alicia.db` par la copie choisie, supprimer
  `alicia.db-wal` et `alicia.db-shm` s'ils existent, relancer.
- **Journal** : le détail des tours (modèle, tokens, outils, durée) est effacé au-delà de 90 jours, au même moment.
- **Appairage** : 5 codes faux en 15 minutes depuis une même adresse bloquent cette adresse (en plus de la limite
  globale de 5 par minute). Sur Internet, une adresse IPv6 compte pour tout son /64 ; sur un réseau local
  (y compris Tailscale), chaque adresse compte seule. Un appairage réussi remet le compteur de l'adresse à zéro.
- **Origines web** : seule l'app de bureau peut appeler le cerveau depuis une page web ; `allowedOrigins` (config)
  ajoute des origines exactes, pour la future PWA. Une autre origine reçoit 403, en HTTP comme en WebSocket.
- **Connexions** : le cerveau sonde chaque connexion toutes les 30 s et coupe celles qui ne répondent plus ; l'app
  se reconnecte d'elle-même après 75 s de silence.

## Vérification réelle (manuelle, consomme un peu de quota)

À faire une fois, avec l'abonnement de Kévin, pour valider le moteur SDK de bout en bout.

1. Préparer la config et le jeton :
   ```bash
   cp apps/brain/alicia.config.example.yaml apps/brain/alicia.config.yaml
   claude setup-token
   ```
   Copier le jeton affiché, **sur une seule ligne**, dans `apps/brain/.env`
   (`CLAUDE_CODE_OAUTH_TOKEN=...`), puis :
   ```bash
   cd apps/brain && pnpm exec tsx --env-file=.env src/cli.ts check-engine
   ```
   Attendu : un `{ type: "session", ... }`, un ou plusieurs `{ type: "text", text: "ok" ... }`,
   puis `{ type: "done", inputTokens: …, outputTokens: … }`.
2. Dans un premier terminal : `cd apps/brain && pnpm exec tsx --env-file=.env src/cli.ts start`.
3. Dans un second terminal :
   ```bash
   pnpm --filter @alicia/brain alicia pair kevin
   pnpm --filter @alicia/brain alicia chat --code <code affiché>
   ```
   Attendu : « Connecté en tant que Kévin ».
   - « Bonjour » → la réponse arrive en morceaux.
   - « Tu te souviens de ce que je viens de dire ? » → Alicia s'appuie sur le message
     précédent (preuve de la reprise de session).
   - « Réfléchis bien : combien font 17 × 23 ? » → la ligne de fin affiche `opus`.

## App de bureau (Windows)

```bash
pnpm --filter @alicia/desktop dev        # lance l'app en développement
pnpm --filter @alicia/desktop test       # tests unitaires
pnpm --filter @alicia/desktop test:e2e   # bout en bout : construit l'app, lance un cerveau de test (FakeEngine)
pnpm --filter @alicia/desktop mascot     # régénère les images de la mascotte depuis design/
```
Premier lancement : saisir l'adresse du cerveau (par défaut `http://127.0.0.1:8780`, ou
l'adresse HTTPS Tailscale) et un code obtenu avec `pnpm exec tsx src/cli.ts pair <personne>`
(depuis `apps/brain`). La session (adresse + jeton d'appareil) est chiffrée par Windows
(DPAPI, via `safeStorage`) dans le profil de l'utilisateur ; « Déconnecter cet appareil » dans
Réglages l'efface. Un appareil révoqué côté cerveau (`revoke <id>`) revient à l'écran d'appairage.

### Écran « Souvenirs »

Entrée « 🧠 Souvenirs » dans le menu de gauche. Kévin et Élodie y voient le commun et leurs
propres souvenirs, jamais ceux de l'autre.

- **Liste** (à gauche) : onglets Tout / Famille / Moi / Corbeille, recherche par mots, filtres
  par type, tri récents / plus utilisés / qui dorment (jamais rappelés, ou pas depuis 60 jours :
  la carte est atténuée). « + » ajoute un souvenir à la main.
- **Fiche** (à droite) : texte, Moi / Famille, type, épingle 📌, provenance (le lien rouvre la
  conversation d'origine), nombre d'utilisations. « Oublier » demande confirmation.
- **Corbeille** : les souvenirs oubliés depuis moins de 30 jours, avec « Récupérer ».
- **Banc d'essai** : « Tester comme question » montre, dans l'ordre exact, ce qu'Alicia
  retrouverait pour cette question, avec la raison (mots en commun, sens proche) et la
  proximité. Ne compte pas comme un rappel.
- **Supprimer une conversation** : survoler la conversation dans le menu → 🗑 → « Oui ».
  Définitif (messages compris) ; les souvenirs qui en viennent sont conservés. Impossible pendant
  qu'Alicia y répond.

### Sur le PC

- **Une seule Alicia** : relancer l'app ramène la fenêtre existante. Fermer la fenêtre la range dans la
  zone de notification (clic gauche : rouvrir ; clic droit : Holo, lancement au démarrage, quitter).
- **Notifications** : quand Alicia répond alors que sa fenêtre est cachée, réduite ou derrière une autre
  application (ou à une question posée par la barre Spotlight), la réponse arrive en notification Windows ;
  un clic ouvre la conversation.
- **L'Holo** : Alicia flotte sur le bureau, toujours au-dessus, et reflète ce qu'elle fait. Elle se déplace à
  la souris (sa place est retenue, d'un écran à l'autre) ; un clic ouvre une petite discussion, Échap la
  referme. L'Holo replié ne prend jamais le focus : il se pilote **à la souris seulement** ; le clavier
  fonctionne une fois la discussion ouverte.
- **Spotlight** : `Ctrl+Alt+A` (modifiable dans Réglages) ouvre une barre au centre de l'écran ; Entrée envoie.
- **Réglages** : raccourci, lancement au démarrage, Holo, informations de l'appareil, mises à jour,
  déconnexion. Pendant la saisie d'un nouveau raccourci, l'ancien est mis de côté. Sur un clavier AZERTY,
  `Ctrl+Alt` + une touche dont AltGr ne tape rien (ex. `&`) donne le chiffre (`Ctrl+Alt+1`) quand Chromium
  fournit la disposition du clavier (`navigator.keyboard.getLayoutMap()`) ; sinon la combinaison est refusée.
  « Lancer au démarrage » suit Windows : désactivé dans les applications de démarrage de Windows, il apparaît
  décoché au lancement suivant.
- **Premier lancement** : l'app cherche le cerveau sur le réseau local (mDNS, service `_alicia._tcp`) ; sinon,
  saisir son adresse (Tailscale). Le cerveau s'annonce tout seul (« Alicia sur <machine> ») ;
  `discovery: false` dans sa config pour couper. Un port mDNS (5353) indisponible n'empêche ni le cerveau
  ni l'app de tourner : l'annonce ou la recherche est simplement abandonnée (message dans le journal).

### Installer et publier une version

```bash
pnpm --filter @alicia/desktop dist   # → apps/desktop/dist/Alicia-Setup-<version>.exe + latest.yml
```
- Installation par utilisateur, sans droits admin (`%LOCALAPPDATA%\Programs\Alicia`), sans signature de code
  (Windows SmartScreen peut demander « Exécuter quand même » la première fois). L'app installée s'appelle
  « Alicia » : son profil (`%APPDATA%\Alicia`) est distinct de celui du développement.
- **Publier** : augmenter `version` dans `apps/desktop/package.json`, lancer `dist`, puis copier
  `latest.yml`, `Alicia-Setup-<version>.exe` et `Alicia-Setup-<version>.exe.blockmap` dans
  `<dataDir>/updates/` **sur la machine du cerveau**. Les apps installées vérifient au démarrage et toutes les
  six heures, téléchargent, et installent en quittant (ou tout de suite depuis Réglages / le menu).
- **Premier téléchargement** : `http://<cerveau>:8780/updates/Alicia-Setup-<version>.exe` dans un navigateur
  (la route `/updates/` est publique : un installateur ne contient aucun secret).

### Vérifications manuelles (sur le vrai PC, pas automatisables)

Les tests automatiques remplacent le système par un enregistreur (`ALICIA_OS_INTEGRATION=off`) : ce qui suit
ne peut être vérifié que sur le vrai profil Windows, avec l'installateur `apps/desktop/dist/Alicia-Setup-<version>.exe`.

1. **Installation** : pas de demande de droits admin ; SmartScreen (« Informations complémentaires » →
   « Exécuter quand même ») ; raccourcis Bureau et menu Démarrer ; l'exe et l'installateur portent l'icône
   d'Alicia.
2. **Zone de notification** : l'icône est là ; clic gauche rouvre ; clic droit : Ouvrir, Afficher l'Holo,
   Lancer au démarrage, Quitter (Quitter ferme vraiment l'app).
3. **Premier lancement / mDNS** : le cerveau (redémarré, `discovery` actif) est trouvé et son adresse remplie ;
   le pare-feu Windows peut demander l'autorisation une fois ; l'adresse manuelle (Tailscale) marche aussi.
   Le cerveau journalise « Annoncée sur le réseau local : « Alicia sur <machine> ». ».
4. **Holo** : apparaît en bas à droite ; la mascotte ne saute pas quand la discussion s'ouvre ou se ferme ;
   déplacement à la souris, y compris **entre deux écrans d'échelles différentes** (125 % / 100 %) ; la place
   est retenue ; **brancher / débrancher un écran** pendant qu'il est affiché le ramène sur un écran existant ;
   le masquer et le réafficher depuis le menu.
5. **Spotlight** : `Ctrl+Alt+A` depuis une autre application ouvre la barre au-dessus de tout ; Entrée ; la
   notification arrive au nom d'« Alicia » ; son clic ouvre la conversation.
6. **Notifications** : fermer la fenêtre pendant une réponse → notification ; relancer l'app depuis le menu
   Démarrer → la fenêtre existante revient (pas de deuxième Alicia).
7. **Réglages, raccourci** : en changer (l'ancien ne doit pas ouvrir Spotlight pendant la saisie) ; sur un
   clavier **AZERTY**, `Ctrl+Alt+&` doit donner `Ctrl+Alt+1` et `Ctrl+Alt+E` être refusé (€). Si
   `Ctrl+Alt+&` est refusé, vérifier dans la console de la fenêtre que
   `await navigator.keyboard.getLayoutMap()` répond (le gestionnaire de permissions qui refuse tout pourrait le
   bloquer : la règle stricte s'applique alors).
8. **Lancer au démarrage** : l'activer, fermer la session Windows et la rouvrir : Alicia démarre dans la zone
   de notification, sans fenêtre ; relancer l'app à la main alors ramène bien la fenêtre. Le désactiver dans
   Paramètres Windows → Applications → Démarrage : au lancement suivant, la case est décochée.
9. **Fermeture de session / arrêt** avec Alicia ouverte : rien ne bloque la fermeture de Windows.
10. **Mise à jour réelle** : passer `version` à `0.1.1`, `dist`, copier les trois fichiers dans
    `<dataDir>/updates/` du cerveau, relancer l'app : Réglages finit par afficher « La version 0.1.1 est
    prête » ; « Redémarrer pour installer » ; l'app redémarre en 0.1.1 (Réglages → Version de l'app).
11. **Développement** : `pnpm --filter @alicia/desktop dev` — le rechargement à chaud (HMR) fonctionne
    toujours avec la CSP resserrée (`connect-src 'self' http: https:`, sans `ws:`).

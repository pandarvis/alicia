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
(DPAPI, via `safeStorage`) dans le profil de l'utilisateur ; « Déconnecter » dans le menu
l'efface. Un appareil révoqué côté cerveau (`revoke <id>`) revient à l'écran d'appairage.

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

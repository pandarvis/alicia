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
```
Les commandes s'exécutent dans `apps/brain` : la config y est lue
(`alicia.config.yaml`, ou le chemin donné par `ALICIA_CONFIG`).
Les secrets sont lus dans l'environnement (pas de chargement automatique de `.env`) :
- soit exporter les variables avant la commande (Git Bash) :
  `set -a; source apps/brain/.env; set +a`
- soit lancer `tsx` directement avec l'option Node `--env-file` (le script `alicia` ne la
  transmet pas) : `cd apps/brain && pnpm exec tsx --env-file=.env src/cli.ts start`.

## Vérification réelle (manuelle, consomme un peu de quota)

À faire une fois, avec l'abonnement de Kévin, pour valider le moteur SDK de bout en bout.

1. Préparer la config et le jeton :
   ```bash
   cp apps/brain/alicia.config.example.yaml apps/brain/alicia.config.yaml
   claude setup-token
   ```
   Copier le jeton affiché dans `apps/brain/.env` (`CLAUDE_CODE_OAUTH_TOKEN=...`), puis :
   ```bash
   set -a; source apps/brain/.env; set +a
   pnpm --filter @alicia/brain alicia check-engine
   ```
   Attendu : un `{ type: "session", ... }`, un ou plusieurs `{ type: "text", text: "ok" ... }`,
   puis `{ type: "done", inputTokens: …, outputTokens: … }`.
2. Dans un premier terminal : `pnpm --filter @alicia/brain alicia start`.
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

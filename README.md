# Alicia

Assistante familiale (Alice + IA), refonte d'Alice sur le Claude Agent SDK.
Spec : `docs/superpowers/specs/2026-10-04-alicia-socle-design.md`.

## Prérequis
- Node (dernière LTS), pnpm (`corepack enable`)
- Pour le mode abonnement : `claude setup-token` (Claude Code) pour obtenir le jeton

## Installation
```bash
pnpm install
cp apps/cerveau/alicia.config.example.yaml apps/cerveau/alicia.config.yaml
cp apps/cerveau/.env.example apps/cerveau/.env   # puis renseigner le secret du mode choisi
```

## Commandes (depuis la racine)
```bash
pnpm test && pnpm typecheck && pnpm lint
pnpm --filter @alicia/cerveau alicia                     # aide
pnpm --filter @alicia/cerveau alicia demarrer            # Ctrl+C : arrêt propre
pnpm --filter @alicia/cerveau alicia appairer kevin
pnpm --filter @alicia/cerveau alicia discuter --code 123456
pnpm --filter @alicia/cerveau alicia verifier-moteur
```
Les commandes s'exécutent dans `apps/cerveau` : la config y est lue
(`alicia.config.yaml`, ou le chemin donné par `ALICIA_CONFIG`).
Les secrets sont lus dans l'environnement : charger `.env` avec
`node --env-file` ou exporter les variables avant la commande
(`set -a; source apps/cerveau/.env; set +a` en Git Bash).

## Vérification réelle (manuelle, consomme un peu de quota)

À faire une fois, avec l'abonnement de Kévin, pour valider le moteur SDK de bout en bout.

1. Préparer la config et le jeton :
   ```bash
   cp apps/cerveau/alicia.config.example.yaml apps/cerveau/alicia.config.yaml
   claude setup-token
   ```
   Copier le jeton affiché dans `apps/cerveau/.env` (`CLAUDE_CODE_OAUTH_TOKEN=...`), puis :
   ```bash
   set -a; source apps/cerveau/.env; set +a
   pnpm --filter @alicia/cerveau alicia verifier-moteur
   ```
   Attendu : un `{ type: "session", ... }`, un ou plusieurs `{ type: "texte", texte: "ok" ... }`,
   puis `{ type: "fin", tokensEntree: …, tokensSortie: … }`.
2. Dans un premier terminal : `pnpm --filter @alicia/cerveau alicia demarrer`.
3. Dans un second terminal :
   ```bash
   pnpm --filter @alicia/cerveau alicia appairer kevin
   pnpm --filter @alicia/cerveau alicia discuter --code <code affiché>
   ```
   Attendu : « Connecté en tant que Kévin ».
   - « Bonjour » → la réponse arrive en morceaux.
   - « Tu te souviens de ce que je viens de dire ? » → Alicia s'appuie sur le message
     précédent (preuve de la reprise de session).
   - « Réfléchis bien : combien font 17 × 23 ? » → la ligne de fin affiche `opus`.

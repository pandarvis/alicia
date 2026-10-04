# Brief — nouvelle mascotte d'Alicia

## Qui est Alicia
Alicia (Alice + IA) est l'assistante IA d'un foyer : deux adultes, une maison équipée en domotique.
Elle discute, pilote la maison (chauffage, volets, chauffe-eau, énergie solaire), gère l'agenda
et les courses, et propose des idées d'elle-même. Son caractère : **espiègle, démonstrative,
complice**, jamais servile.

## Mascotte actuelle (à refaire)
Le dossier `references/` contient les 13 poses de la mascotte actuelle : une figurine chibi façon
« Alice au pays des merveilles » (couettes blondes, nœud noir, robe rouge et tablier blanc, rendu
vinyle mat sur fond studio gris). Poses : `neutre`, `trois-quart`, `profil`, `assis`, `ecoute`,
`reflexion`, `veille`, `alerte`, `bug`, `colere`, `victoire`, `chante`, `violon`.

La direction de la nouvelle version reste ouverte (style, silhouette, matière). Les références
servent de point de départ, pas de contrainte.

## Où elle vivra
1. **Mascotte détachée sur le bureau** (façon client ChatGPT/Codex) : flotte au-dessus des
   fenêtres, environ **100 à 140 px de haut**. Elle doit rester lisible et expressive à cette taille.
2. **Dans l'app** (tableau de bord sombre) : accueil du chat, indicateur d'état.
3. **Icône d'app / barre des tâches** : une déclinaison buste ou tête lisible à **32-48 px**.
4. **Écran kiosk du salon** et **app mobile (PWA)**.

## Palette de l'interface (fonds sur lesquels elle sera posée)
| Rôle | Hex |
|---|---|
| Fond nuit | `#16213E` (surfaces `#121A32`, `#1E2A4A`) |
| Accent sauge | `#8FB9A8` |
| Crème (textes, fond clair) | `#F3EBDD` |
| Ambre (chaleur, alertes douces) | `#D9A45B` |
Elle doit fonctionner **sur fond sombre comme sur fond crème**.

## États nécessaires (même personnage, même échelle)
| État | Quand |
|---|---|
| neutre / repos | par défaut |
| veille | inactive depuis un moment |
| écoute | l'utilisateur parle (voix) ou tape |
| réflexion | elle travaille (enchaîne des actions) |
| parle | elle répond |
| succès / victoire | action réussie |
| alerte | quelque chose demande attention |
| erreur / bug | une action a échoué |
| propose une idée | elle suggère quelque chose (« eurêka ») |

## Livrables souhaités
- **PNG à fond transparent**, haute définition (≥ 1 600 px de haut), **même échelle et même
  point d'ancrage des pieds** sur toutes les poses (pour enchaîner les états sans saut).
- Idéalement des calques séparés (yeux, bouche, bras) ou un SVG, pour animer le clignement et la
  parole dans l'app.
- Une planche de personnage (face, trois-quart, profil) pour garder la cohérence.
- Les mêmes noms de fichiers que les états ci-dessus.

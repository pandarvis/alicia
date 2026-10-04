# Brief — nouvelle mascotte d'Alicia

## Qui est Alicia
Alicia (Alice + IA) est l'assistante IA d'un foyer : deux adultes, une maison équipée en domotique.
Elle discute, pilote la maison (chauffage, volets, chauffe-eau, énergie solaire), gère l'agenda
et les courses, et propose des idées d'elle-même. Son caractère : **espiègle, démonstrative,
complice**, jamais servile.

## Références d'origine
Le dossier `references/` contient les 13 poses de l'ancienne mascotte : une figurine chibi façon
« Alice au pays des merveilles » (couettes blondes, nœud noir, robe rouge et tablier blanc, rendu
vinyle mat sur fond studio gris). Poses : `neutre`, `trois-quart`, `profil`, `assis`, `ecoute`,
`reflexion`, `veille`, `alerte`, `bug`, `colere`, `victoire`, `chante`, `violon`.

## Direction validée — 4 octobre 2026
La version **papier découpé kawaii v2, avec yeux haricot**, est retenue pour Alicia.
Elle conserve les couettes blondes, le nœud noir, la robe rouge corail et le tablier crème,
avec une grande tête arrondie, des joues rosées et des mimiques espiègles. Le rendu est mat,
en couches de papier légèrement texturées avec de fines ombres entre les couches.
Les yeux ouverts sont brun foncé avec une petite pastille crème en papier ; les états veille
et victoire conservent leurs yeux fermés.

Les **neuf images validées** se trouvent dans [`papier-decoupe/v2/`](papier-decoupe/v2/) :
`neutre.png`, `veille.png`, `ecoute.png`, `reflexion.png`, `parle.png`, `victoire.png`,
`alerte.png`, `bug.png` et `idee.png`.

- [Pack des images validées](papier-decoupe/poses-v2.zip).
- [Aperçu à 128 px sur fond nuit et crème](papier-decoupe/v2/apercu-128px.png).
- [Prompts, sources et paramètres d'export](papier-decoupe/v2/manifest.json).
- [Vérification des exports](papier-decoupe/v2/verification.json).

Les PNG ont un vrai fond transparent et un canevas commun de **2 048 × 2 048 px**.
Le bord inférieur opaque des semelles est à **y = 1 900 px** ; le centre des pieds est
à **x = 1 024 px**, avec une tolérance de 0,5 px. Les sources natives de 1 254 × 1 254 px
sont conservées dans `papier-decoupe/v2/sources/` ; les exports ont été rééchantillonnés.
Pour l'intégration et les prochaines déclinaisons, prendre cette v2 comme référence.

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

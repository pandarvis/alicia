# Alicia — Écran « Souvenirs » et banc d'essai — Design

**Date :** 2026-10-04
**Statut :** validé avec Kévin (maquette « B » choisie, `.superpowers/brainstorm/507-1791140841/content/souvenirs-layout.html`)
**Suite de :** plan 2 (mémoire). Les séances « Faisons connaissance » (Alicia interviewe la famille) viendront **après**, dans leur propre spec.

## But

Que Kévin et Élodie puissent, depuis l'app de bureau, **voir, alimenter, corriger et trier** la mémoire d'Alicia, **comprendre ce qu'elle retrouverait** pour une question, et **faire le ménage** dans leurs conversations.

## Écran « Souvenirs » (disposition B)

- **Accès** : entrée « 🧠 Souvenirs » dans le menu de gauche, à côté de « ✦ Alicia ». Passage chat ↔ souvenirs en transition fluide. La barre du haut affiche « Souvenirs ».
- **Colonne gauche (liste)** :
  - onglets **Tout / Famille / Moi / Corbeille** (chacun voit le commun et le sien, jamais celui de l'autre) ;
  - champ de recherche (mots) + filtres par type (règles, préférences, habitudes, faits, événements) ;
  - tri : **récents**, **plus utilisés**, **qui dorment** (jamais rappelés ou pas rappelés depuis 60 jours) ;
  - carte par souvenir : texte (2 lignes max), 📌 si épinglé, portée et type ; **atténuée si elle dort** ;
  - bouton **« + »** : nouveau souvenir (texte, Moi/Famille, type, épinglé), source « manuel ».
- **Colonne droite (fiche du souvenir sélectionné)** :
  - texte modifiable, portée (Moi/Famille), type, épingle ;
  - **provenance** : « Retenu par Alicia pendant “<titre>” » (lien qui ouvre la conversation), « Ajouté à la main », « Importé de l'ancienne Alice » ;
  - **usage** : « Utilisé N fois, la dernière fois le … » / « Jamais utilisé » ;
  - **Enregistrer** (désactivé tant que rien n'a changé), **Oublier** (confirmation dans l'app) ;
  - erreurs lisibles : secret refusé, texte vide, introuvable (supprimé ailleurs).
- **Corbeille** : souvenirs oubliés depuis moins de 30 jours, avec « oublié le … » et **Récupérer**.
- Sans sélection : un panneau d'aide court (« Choisis un souvenir, ou teste une question »).

## Banc d'essai

- Dans la zone de recherche, action **« Tester comme question »** (ou Entrée avec la case « question » cochée) : appelle le banc d'essai du cerveau.
- Résultat : la liste **exacte et ordonnée** de ce qu'Alicia retrouverait (`memory_search`), chaque ligne avec **pourquoi** : « mots en commun », « sens proche » ou les deux, et un **indicateur de proximité** (barre 0–100 % dérivée de la similarité, normalisée entre le plancher 0,82 et 1).
- Cliquer un résultat ouvre sa fiche.
- Le banc d'essai **ne compte pas comme un rappel**.

## Supprimer une conversation

- Survol d'une conversation dans le menu → icône 🗑 ; clic → confirmation inline dans la ligne (« Supprimer ? Oui / Non ») ; Échap annule.
- Suppression **définitive** de la conversation, de ses messages et de son journal ; les souvenirs qui en sont issus sont **conservés** (lien d'origine remis à vide).
- Refusée si Alicia est en train d'y répondre (« Alicia répond dans cette conversation »).
- Si c'était la conversation ouverte, l'app revient à l'accueil.

## Côté cerveau (API)

| Route | Rôle |
|---|---|
| `GET /memories?forgotten=true` | la corbeille de la personne (commun + sien), oubliés depuis < 30 jours |
| `POST /memories/:id/restore` | récupérer (200 résumé, 404) |
| `GET /memories/test?q=…` | banc d'essai : `[{ memory, rank, textMatch, similarity }]`, sans rappel |
| `DELETE /conversations/:id` | 204 / 404 (pas à soi) / 409 `busy` (tour en cours) |

`MemorySummary` gagne : `source` (`conversation` \| `manual` \| `import`), `conversationId` (uuid ou null), `conversationTitle` (ou null, si la conversation existe encore et appartient à l'appelant), `lastRecalledAt` (ISO ou null), `forgottenAt` (ISO ou null).

## Hors périmètre

Séances « Faisons connaissance » ; écran Souvenirs sur PWA/kiosk ; historique des modifications d'un souvenir ; fusion de doublons assistée.

## Critères de réussite

1. Kévin voit les 45 souvenirs importés + les siens, les filtre, les trie, voit lesquels dorment.
2. Il ajoute, corrige, épingle, déplace (Moi ↔ Famille), oublie puis récupère un souvenir.
3. « Quel est mon plat préféré ? » au banc d'essai montre le souvenir des lasagnes en tête avec ses raisons.
4. Élodie, sur son PC, ne voit jamais les souvenirs « Moi » de Kévin.
5. Il supprime les deux conversations de test ; les souvenirs restent.

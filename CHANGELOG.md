# Notes de version

## v0.1.0 — 2026-10-05

Première version d'Alicia, la refonte d'Alice sur le Claude Agent SDK.

### Le cerveau
- Conversation en direct sur l'abonnement Claude (Sonnet 5.5 par défaut, Opus 5.5 avec « Réfléchir »),
  sessions reprises d'un message à l'autre.
- Appareils appairés par code à 6 chiffres, révocables ; limite d'essais par adresse.
- Mémoire durable commune ou personnelle, cloisonnée entre Kévin et Élodie, recherche par mots et par sens
  (calcul local), fiche permanente, import des souvenirs de l'ancienne Alice.
- Outils : météo, recherche et pages web, lecture des pièces jointes (images, PDF, Word, Excel, texte),
  agenda Google (lire, créer sans invités, modifier et supprimer après accord) et Gmail (chercher, lire,
  préparer des brouillons ; jamais d'envoi).
- Garde-fous : cartes Oui / Non pour les actions sensibles, protection contre les consignes piégées dans
  les pages, documents et mails, lecture de fichiers limitée aux pièces jointes de la conversation.
- Robustesse : sauvegarde nocturne de la base (14 copies), reconnexion automatique, contre-pression,
  erreurs typées, annonce sur le réseau local.

### L'app de bureau (Windows)
- Chat avec mascotte, écran Souvenirs (liste, fiche, corbeille, banc d'essai), écran Comptes, Réglages.
- Holo détachable (bouton « Détacher Alicia »), barre Spotlight (`Ctrl+Alt+A`), zone de notification,
  notifications Windows, une seule instance.
- Pièces jointes par glisser-déposer, collage ou trombone.
- Installateur par utilisateur et mises à jour servies par le cerveau.

### À savoir
- Les migrations de base 0003 à 0006 s'appliquent au premier démarrage : sauvegarder la base avant.
- Google demande une configuration manuelle (voir README, « Comptes Google »).

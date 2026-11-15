<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 alfinium -->

# Autorisations

Sync443 ne demande que ce dont il a besoin (règle « permissions strictement nécessaires » de
[CONCEPTION-COURRIER.md](CONCEPTION-COURRIER.md)). Ce document explique chaque autorisation du
manifeste (`src/manifest.json`) ; toute autorisation ajoutée doit y être justifiée.

## Autorisations demandées à l'installation

| Autorisation | Ce qu'elle permet | Pourquoi Sync443 en a besoin |
|---|---|---|
| `storage` | stockage local de l'extension | Réglages des boîtes, état de la synchro (clés, correspondance des messages, journal des modifications locales), journal de diagnostic. Jamais de mot de passe. |
| `alarms` | minuteries qui survivent à la mise en veille | Actualisation périodique (1, 5, 15, 30 ou 60 min) et nouveaux essais espacés après une erreur. |
| `menus` | entrées de menus contextuels | Commande « Synchroniser » sur les comptes et dossiers de Sync443. |
| `notifications` | notifications du système | Expliquer pourquoi un message n'est pas parti (envoi fermé), signaler une boîte arrêtée. |
| `accountsRead` | lecture des comptes, identités et dossiers, événements des dossiers | Retrouver le compte de chaque boîte et ses dossiers, suivre les dossiers créés, renommés, déplacés ou supprimés par l'utilisateur. |
| `accountsFolders` | création, renommage, déplacement et suppression de dossiers | Reproduire dans Thunderbird l'arborescence des dossiers du serveur. |
| `messagesRead` | lecture des messages (en-têtes, contenu brut), événements des messages | Suivre les messages lus, marqués, déplacés ou supprimés pour les reporter sur le serveur ; lire le brouillon à envoyer (`messages.getRaw`). |
| `messagesImport` | ajout de messages dans un dossier | Importer les messages reçus du serveur. |
| `messagesUpdate` | modification des propriétés des messages | Reporter « lu » et « drapeau » venant du serveur. |
| `messagesMove` | déplacement et copie de messages | Reporter les déplacements faits sur le serveur, mettre à la corbeille les messages supprimés sur le serveur. |
| `messagesDelete` | suppression définitive de messages | Supprimer un message dans la corbeille quand il est supprimé sur le serveur, et le brouillon d'un message envoyé. |
| `compose` | événements des fenêtres de rédaction | Intercepter l'envoi (`compose.onBeforeSend`) pour les identités des comptes de Sync443 : envoi par ActiveSync, jamais par un autre chemin. |
| `compose.save` | enregistrement d'un message en cours de rédaction | Enregistrer le message en brouillon avant de l'envoyer par ActiveSync (`compose.saveMessage`). |

Les autres comptes de Thunderbird ne sont jamais modifiés : le code privilégié vérifie la marque de
Sync443 sur un compte avant toute opération (règle 10 de [SECURITE.md](SECURITE.md)).

## Autorisation demandée au moment voulu

| Autorisation | Quand | Pourquoi |
|---|---|---|
| `https://*/*` (facultative) | à l'enregistrement d'une boîte, pour le **seul** serveur de cette boîte (`https://hôte/*`) | Joindre le serveur ActiveSync. La connexion vérifiée (`sync443Net`) refuse tout hôte pour lequel l'extension n'a pas cette autorisation, et la vérifie de nouveau à chaque lecture et écriture. L'autorisation est retirée quand plus aucune boîte n'utilise ce serveur. |

Le motif d'une autorisation d'hôte ne contient pas de port : `https://mail.exemple.com/*` couvre
tous les ports de ce serveur. Le mot de passe, lui, n'est envoyé qu'à l'origine exacte (schéma,
hôte et port) pour laquelle il a été saisi.

## Code privilégié (« experiments »)

| API | Rôle |
|---|---|
| `sync443Net` | Connexion TLS dont le certificat est jugé avant l'écriture du moindre octet, directe ou par le proxy de Thunderbird. |
| `sync443Account` | Comptes locaux marqués de Sync443 et leur serveur sortant neutre (envoi fermé), mots de passe dans le gestionnaire de Thunderbird (domaine `Sync443`). |

Ces API tournent avec tous les droits de Thunderbird : elles sont réduites au strict nécessaire,
valident chaque argument et ne sont acceptées que depuis la page d'arrière-plan
(règle 11 de [SECURITE.md](SECURITE.md)). À l'installation, Thunderbird les annonce comme un accès
complet et sans restriction à Thunderbird et à l'ordinateur : c'est la raison de leur taille
minimale et de l'audit de chaque étape.

## Non demandées

- `compose.send` : Sync443 n'envoie jamais par le chemin de Thunderbird.
- `accountsIdentities`, `addressBooks`, `tabs`, `webRequest`, `<all_urls>` : inutiles pour le
  courrier. Agenda et contacts (étapes 4 et 5) ajouteront, le cas échéant, leurs propres
  autorisations, justifiées ici.

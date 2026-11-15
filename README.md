# Sync443 – EAS Client for Thunderbird

[![Tests](https://github.com/alfinium/sync443/actions/workflows/tests.yml/badge.svg)](https://github.com/alfinium/sync443/actions/workflows/tests.yml)

Extension Thunderbird qui synchronise un compte **Exchange ActiveSync** en passant **uniquement
par HTTPS** (le port 443). Elle est faite pour les réseaux restrictifs — hôtels, sites clients,
réseaux d'entreprise — où IMAP et SMTP sont bloqués mais où le web passe.

Courrier, dossiers, envoi, agenda, contacts et tâches, dans les deux sens, pour autant de boîtes
que nécessaire. Windows, macOS et Linux.

> **État : réécriture en cours, pas encore installable.**
> Les fondations (étape 1 sur 6) sont terminées, testées et auditées. La première version
> utilisable, pour le courrier, sera publiée dans les
> [Releases](https://github.com/alfinium/sync443/releases) sous forme de fichier `.xpi`
> à la fin de l'étape 3. L'avancement est suivi dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Sommaire

- [Fonctions](#fonctions)
- [Compatibilité](#compatibilité)
- [Installation](#installation)
- [Configuration](#configuration)
- [Réseau et proxy](#réseau-et-proxy)
- [Sécurité](#sécurité)
- [Vie privée](#vie-privée)
- [Développement](#développement)
- [Licence](#licence)

## Fonctions

| Fonction | État |
|---|---|
| Connexion vérifiée (certificat contrôlé avant tout envoi), proxy détecté automatiquement | fait (étape 1) |
| Protocole ActiveSync 12.1 à 14.1, négociation des règles du serveur, effacement à distance toujours refusé | fait (étape 1) |
| Comptes Thunderbird dédiés, mots de passe dans le gestionnaire de Thunderbird | étape 2 |
| Plusieurs boîtes, configuration en quelques champs | étapes 2 et 6 |
| Courrier : dossiers, messages, lu / drapeau / déplacement / suppression dans les deux sens | étape 3 |
| Arrivée immédiate des messages (« push »), ou actualisation périodique | étape 3 |
| Envoi par ActiveSync, sans SMTP, copie dans les Envoyés du serveur | étape 3 |
| Agenda et tâches, réunions et invitations | étape 4 |
| Contacts | étape 5 |
| Bouton « Synchroniser », page de réglages, journal | étape 6 |

## Compatibilité

- **Thunderbird :** 140 ESR et versions suivantes. Le développement se fait sur Thunderbird 160.
- **Systèmes :** Windows, macOS et Linux.
- **Serveurs :** tout serveur Exchange ActiveSync 12.1 à 14.1 qui accepte l'authentification par
  identifiant et mot de passe. Par exemple :
  - SOGo (dont mailcow) ;
  - Exchange Server installé sur site ;
  - grommunio ;
  - Z-Push.
- **Non pris en charge :**
  - **Microsoft 365 / Exchange Online :** ActiveSync y exige OAuth2, qui n'est pas encore géré.
  - **Proxy d'entreprise exigeant sa propre authentification :** l'extension le signale et n'envoie rien.

## Installation

*Quand une version sera publiée :*

1. Télécharger le fichier `sync443-<version>.xpi` depuis les
   [Releases](https://github.com/alfinium/sync443/releases).
2. Dans Thunderbird : **Outils → Modules complémentaires et thèmes**, roue dentée,
   **Installer un module depuis un fichier…**, choisir le fichier.
3. Accepter les autorisations demandées. Celles-ci permettent :
   - les comptes et dossiers locaux, l'agenda et les contacts ;
   - l'accès au seul serveur configuré.

## Configuration

Pour chaque boîte, il suffira de renseigner :
- l'adresse e-mail et le mot de passe ;
- le nom de la boîte ;
- le serveur (par exemple `mail.exemple.com`, sans `/Microsoft-Server-ActiveSync`) ;
- la fréquence de synchronisation (dès réception, ou toutes les N minutes) ;
- la période de courrier à synchroniser.

**Conseil :** si le serveur le permet (c'est le cas de mailcow), utilisez un **mot de passe
d'application** réservé à ActiveSync. Il se révoque seul et n'ouvre pas tout le compte.

## Réseau et proxy

Rien à configurer : l'extension demande à Thunderbird quel chemin il emprunterait pour joindre le
serveur, selon ses réglages ou ceux du système.

| Situation | Comportement |
|---|---|
| Connexion directe | connexion chiffrée ouverte par l'extension |
| Proxy SOCKS | traversé, chiffrement de bout en bout |
| Proxy HTTP | tunnel `CONNECT` ouvert par l'extension, chiffrement de bout en bout |
| Proxy qui déchiffre le HTTPS | détecté, connexion refusée avant tout envoi |
| Proxy exigeant une authentification | non pris en charge, signalé |
| Portail captif d'hôtel | connexion refusée tant que le portail intercepte, reprise automatique ensuite |

## Sécurité

Le modèle de sécurité complet est décrit dans [docs/SECURITE.md](docs/SECURITE.md). L'essentiel :

- **Le mot de passe ne part que vers le serveur pour lequel il a été saisi.** Aucune redirection
  n'est suivie, et changer de serveur oblige à retaper le mot de passe.
- **Le certificat est contrôlé avant le moindre octet de requête**, sur la connexion même qui
  portera le mot de passe. Il doit être émis par une autorité publique (comme Let's Encrypt), ou
  par une autorité privée explicitement approuvée pour ce serveur.
  - Une interception est refusée avant que rien ne soit envoyé.
  - Une connexion qui ne passe que par une exception de sécurité est refusée aussi.
- **Un effacement à distance demandé par le serveur est toujours refusé.**
- **Tout ce qui vient du serveur est validé et plafonné** avant usage.
- **Les erreurs ne s'acharnent pas.** Après un mot de passe refusé, plus aucune tentative
  automatique ; les autres erreurs espacent les essais.

**Limite connue :** ActiveSync, tel que la plupart des serveurs le proposent, n'accepte que
l'authentification « Basic », où le mot de passe accompagne chaque requête. Les mesures ci-dessus
en réduisent le risque, et un mot de passe d'application le limite encore.

**Audits :** chaque étape se termine par un audit de sécurité indépendant. Voir
[docs/audits/](docs/audits/).

**Signaler une vulnérabilité :** voir [SECURITY.md](SECURITY.md). Pas de ticket public, s'il vous plaît.

## Vie privée

- Aucune télémétrie, aucune statistique.
- Le seul serveur contacté est le serveur ActiveSync configuré.
- Les mots de passe sont rangés dans le gestionnaire de mots de passe de Thunderbird. Pensez à
  activer son mot de passe principal.
- Le journal de l'extension ne contient pas de contenu personnel (ni objet, ni adresse, ni texte).

## Développement

### Prérequis

| Outil | Rôle |
|---|---|
| Python 3.9 ou plus récent | lanceurs de tests et contrôles |
| Node.js 18 ou plus récent | tests unitaires (sous macOS, le moteur JavaScript intégré suffit) |
| Thunderbird | test de bout en bout de la connexion vérifiée |

### Commandes

Sous Windows, remplacer `python3` par `py -3`.

| Commande | Rôle |
|---|---|
| `python3 -I tools/unit_tests.py` | tests unitaires et aléatoires du cœur |
| `python3 -I tests/e2e/net/run_net_test.py` | connexion vérifiée dans un vrai Thunderbird, sans interface, avec un profil jetable. Utilise la variable `THUNDERBIRD` pour choisir l'exécutable ; détection automatique sinon. |
| `python3 -I tools/check_source_chars.py` | refuse les caractères invisibles ou bidirectionnels dans le code |
| `python3 -I tools/provenance_check.py --ref <dossier>` | vérifie qu'aucun code d'un projet tiers n'a été repris |

Les tests unitaires tournent automatiquement sous Windows, macOS et Linux à chaque envoi sur GitHub.

### Organisation et méthode

L'organisation du code, les étapes et la méthode sont décrites dans
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Quelques règles :

- **Le code est écrit à partir des spécifications publiques :**
  - Microsoft [MS-ASCMD], [MS-ASWBXML], [MS-ASPROV], [MS-ASHTTP], [MS-ASDTYPE], [MS-ASCAL], [MS-ASCNTC], [MS-ASTASK] ;
  - IETF RFC 9110 et 9112 (HTTP), RFC 5545 (iCalendar), RFC 6350 (vCard), RFC 5322 (courrier).
- **Aucune ligne n'est reprise d'un autre projet.**
- **Tout ce qui vient du serveur passe par la validation** de `src/core/sanitize.mjs` et `src/core/protocol.mjs`.
- **Le code privilégié reste minimal**, il valide chaque argument et borne ses ressources.
- **Chaque correction de sécurité est accompagnée d'un test** de non-régression.

## Licence

[MIT](LICENSE).

Exchange et ActiveSync sont des marques de Microsoft ; Thunderbird est une marque de la Fondation
Mozilla. Sync443 n'est affilié ni à Microsoft, ni à Mozilla, ni aux projets TbSync / EAS-4-TbSync.

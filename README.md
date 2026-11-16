# Sync443 – EAS Client for Thunderbird

[![Tests](https://github.com/alfinium/sync443/actions/workflows/tests.yml/badge.svg)](https://github.com/alfinium/sync443/actions/workflows/tests.yml)

Extension qui apporte à Thunderbird la prise en charge native d'**Exchange ActiveSync**. Un compte
ActiveSync s'y utilise comme n'importe quel autre compte, sans passerelle intermédiaire, avec tout
serveur ou produit qui propose ce protocole : SOGo (et donc mailcow), Exchange Server, grommunio,
Z-Push, etc.

Courrier, dossiers, envoi, agenda, contacts et tâches, dans les deux sens, pour autant de boîtes
que nécessaire. Comme le prévoit ActiveSync, tout passe par une connexion HTTPS vers le serveur :
ni IMAP ni SMTP à configurer. Windows, macOS et Linux.

> **État : version 0.1.0, le courrier.** Boîtes, dossiers, messages et envoi sont pris en charge,
> testés et audités. L'agenda, les contacts et les tâches suivront (étapes 4 et 5). Le fichier
> `.xpi` se trouve dans les [Releases](https://github.com/alfinium/sync443/releases) ;
> l'avancement est suivi dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
| Connexion vérifiée (certificat contrôlé avant tout envoi), proxy détecté automatiquement | 0.1.0 |
| Protocole ActiveSync 12.1 à 14.1, négociation des règles du serveur, effacement à distance toujours refusé | 0.1.0 |
| Comptes Thunderbird dédiés, mots de passe dans le gestionnaire de Thunderbird | 0.1.0 |
| Plusieurs boîtes, configuration en quelques champs | 0.1.0 |
| Choix, pour chaque boîte, des éléments à synchroniser : courrier, agenda, contacts, tâches (un, plusieurs ou les quatre) | 0.1.0 (seul le courrier est synchronisé pour l'instant) |
| Courrier : dossiers, messages, lu / drapeau / déplacement / suppression dans les deux sens | 0.1.0 |
| Arrivée immédiate des messages (« push »), ou actualisation périodique | 0.1.0 |
| Envoi par ActiveSync, copie dans les Envoyés du serveur | 0.1.0 |
| Bouton « Synchroniser », page de réglages, journal de diagnostic | 0.1.0 |
| Agenda et tâches, réunions et invitations | étape 4 |
| Contacts | étape 5 |
| Finitions (assistant, réglages avancés) | étape 6 |

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

1. Télécharger le fichier `sync443-<version>.xpi` depuis les
   [Releases](https://github.com/alfinium/sync443/releases).
2. Dans Thunderbird : **Outils → Modules complémentaires et thèmes**, roue dentée,
   **Installer un module depuis un fichier…**, choisir le fichier.
3. Accepter les autorisations demandées. Le détail de chacune est dans
   [docs/PERMISSIONS.md](docs/PERMISSIONS.md). L'accès au réseau n'est demandé qu'au moment
   d'ajouter une boîte, et pour son seul serveur.

L'extension n'est pas encore signée par Mozilla : Thunderbird l'installe depuis un fichier, sans
passer par addons.thunderbird.net.

**Vérifier le fichier téléchargé (facultatif) :** chaque version est construite par GitHub à
partir du dépôt, de façon reproductible.
- Son empreinte est publiée à côté, dans `SHA256SUMS.txt`.
- Sa provenance est signée : `gh attestation verify sync443-<version>.xpi --repo alfinium/sync443`
  confirme qu'il a été construit par ce dépôt.
- `python3 -I tools/build_xpi.py` reconstruit le même fichier à partir des sources de l'étiquette
  correspondante.

## Configuration

Ouvrir les réglages par **Outils → Réglages de Sync443…** (ou par le bouton **Synchroniser** de
la barre d'outils, tant qu'aucune boîte n'est configurée), puis **Ajouter une boîte**. Pour chaque
boîte, il suffit de renseigner :
- l'adresse e-mail et le mot de passe (et l'identifiant de connexion, s'il diffère de l'adresse) ;
- le nom de la boîte, tel qu'il apparaîtra dans Thunderbird ;
- le serveur (par exemple `mail.exemple.com`, sans `/Microsoft-Server-ActiveSync`) ;
- **les éléments à synchroniser :** courrier, agenda, contacts, tâches. Un seul, plusieurs ou les
  quatre. Ce qui n'est pas coché n'est jamais téléchargé. Dans la version 0.1.0, seul le courrier
  est synchronisé ; les autres choix sont enregistrés pour les versions suivantes ;
- la fréquence de synchronisation (dès réception, ou toutes les N minutes) ;
- la période de courrier à synchroniser.

Les réglages vérifient la connexion (serveur, certificat, mot de passe) avant d'enregistrer quoi
que ce soit. Chaque boîte devient un compte Thunderbird à part, avec ses dossiers ; ses messages
partent par ActiveSync, jamais par un autre serveur d'envoi.

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
| Portail captif (Wi-Fi public) | connexion refusée tant que le portail intercepte, reprise automatique ensuite |

## Sécurité

Le modèle de sécurité complet est décrit dans [docs/SECURITE.md](docs/SECURITE.md). L'essentiel :

- **Le mot de passe ne part que vers le serveur pour lequel il a été saisi.** Aucune redirection
  n'est suivie, et changer de serveur oblige à retaper le mot de passe.
- **Le certificat est contrôlé avant le moindre octet de requête**, sur la connexion même qui
  portera le mot de passe. Il doit être émis par une autorité publique reconnue par Thunderbird
  (comme Let's Encrypt). Approuver une autorité privée pour un serveur donné viendra dans une
  version suivante.
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
- Seuls les éléments choisis (courrier, agenda, contacts, tâches) sont téléchargés.
- Les mots de passe sont rangés dans le gestionnaire de mots de passe de Thunderbird. Pensez à
  activer son mot de passe principal.
- Le journal de l'extension ne contient pas de contenu personnel (ni objet, ni adresse, ni texte).

## Développement

### Prérequis

| Outil | Rôle |
|---|---|
| Python 3.9 ou plus récent | lanceurs de tests et contrôles |
| Node.js 18 ou plus récent | tests unitaires (sous macOS, le moteur JavaScript intégré suffit) |
| Thunderbird 140 ou plus récent | tests de bout en bout (connexion, comptes, courrier) |

### Commandes

Sous Windows, remplacer `python3` par `py -3`.

| Commande | Rôle |
|---|---|
| `python3 -I tools/unit_tests.py` | tests unitaires et aléatoires du cœur |
| `python3 -I tests/e2e/net/run_net_test.py` | connexion vérifiée dans un vrai Thunderbird, sans interface, avec un profil jetable |
| `python3 -I tests/e2e/account/run_account_test.py` | comptes, « Dossiers locaux », serveur d'envoi neutre et mots de passe, dans un vrai Thunderbird |
| `python3 -I tests/e2e/mail/run_mail_test.py` | courrier de bout en bout contre un faux serveur ActiveSync en TLS : boîtes, dossiers, messages, envoi, archivage, redémarrage, suppression d'une boîte (`--no-server-archives` : serveur sans dossier « Archives ») |
| `python3 -I tools/build_xpi.py` | construit `dist/sync443-<version>.xpi`, de façon reproductible ; refuse tout fichier de test |
| `python3 -I tools/check_source_chars.py` | refuse les caractères invisibles ou bidirectionnels dans le code |
| `python3 -I tools/provenance_check.py --ref <dossier>` | vérifie qu'aucun code d'un projet tiers n'a été repris |

Les tests de bout en bout trouvent Thunderbird seuls, ou par la variable `THUNDERBIRD`. Ils
utilisent un profil jetable et ne touchent jamais le profil de l'utilisateur.

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

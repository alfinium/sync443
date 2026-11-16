# Sync443 – EAS Client for Thunderbird

[![Tests](https://github.com/alfinium/sync443/actions/workflows/tests.yml/badge.svg)](https://github.com/alfinium/sync443/actions/workflows/tests.yml)

Sync443 est une extension pour Thunderbird qui prend en charge nativement le protocole
**Exchange ActiveSync** (EAS). Chaque boîte ActiveSync devient un compte Thunderbird à part
entière, sans passerelle ni configuration IMAP ou SMTP : tous les échanges passent par une
connexion HTTPS vers le serveur.

**Version actuelle : 0.1.0.** Elle prend en charge le courrier : dossiers, messages et envoi.
L'agenda, les tâches et les contacts sont prévus dans les versions suivantes
([feuille de route](docs/ARCHITECTURE.md)).

## Fonctions

| Fonction | Disponibilité |
|---|---|
| Courrier : dossiers, messages, états lu et suivi, déplacements et suppressions, dans les deux sens | 0.1.0 |
| Réception immédiate ou synchronisation périodique | 0.1.0 |
| Envoi par ActiveSync, avec copie dans les éléments envoyés du serveur | 0.1.0 |
| Plusieurs boîtes ; choix, pour chacune, des éléments synchronisés | 0.1.0 (courrier seulement) |
| Page de réglages, synchronisation manuelle, journal de diagnostic | 0.1.0 |
| Agenda, tâches et invitations | prévu |
| Contacts | prévu |

## Compatibilité

| | |
|---|---|
| Thunderbird | 140 ESR et versions ultérieures (vérifiée sur 140.17 ESR et 160) |
| Systèmes | Windows, macOS, Linux |
| Langues | Interface en allemand, anglais, espagnol, français, italien, japonais, polonais, portugais (Brésil), russe et tchèque, selon la langue de l'application ; anglais pour toute autre langue. Le journal de diagnostic reste en français. |
| Serveurs | Exchange Server sur site, et tout serveur Exchange ActiveSync 12.1 à 14.1 acceptant l'authentification par identifiant et mot de passe |
| Non pris en charge | Microsoft 365 / Exchange Online (OAuth2) ; proxy exigeant sa propre authentification ; certificat émis par une autorité privée |

## Installation

1. Télécharger `sync443-<version>.xpi` depuis les
   [Releases](https://github.com/alfinium/sync443/releases).
2. Dans Thunderbird : **Outils → Modules complémentaires et thèmes**, roue dentée,
   **Installer un module depuis un fichier…**.
3. Accepter les autorisations demandées ([détail](docs/PERMISSIONS.md)). L'accès au réseau n'est
   demandé qu'à l'ajout d'une boîte, et pour son seul serveur.

L'extension n'est pas encore distribuée sur addons.thunderbird.net.

Chaque fichier publié est construit par GitHub Actions, de façon reproductible. Il peut être
vérifié :
- par son empreinte, publiée dans `SHA256SUMS.txt` ;
- par son attestation de provenance :
  `gh attestation verify sync443-<version>.xpi --repo alfinium/sync443` ;
- en le reconstruisant à partir de l'étiquette correspondante : `python3 -I tools/build_xpi.py`.

## Configuration

**Outils → Réglages de Sync443… → Ajouter une boîte**, puis renseigner :
- l'adresse électronique, le mot de passe et, s'il diffère de l'adresse, l'identifiant de
  connexion ;
- le nom du compte dans Thunderbird ;
- le serveur, sous la forme `mail.exemple.com` ;
- les éléments à synchroniser : courrier, agenda, contacts, tâches ;
- la fréquence de synchronisation et la période de courrier conservée.

La connexion (serveur, certificat, identifiants) est vérifiée avant tout enregistrement. Lorsque
le serveur le permet, l'emploi d'un mot de passe d'application réservé à ActiveSync est
recommandé.

## Réseau

Aucun réglage n'est nécessaire. L'extension emprunte le chemin que Thunderbird utiliserait :
connexion directe, proxy HTTP ou proxy SOCKS, selon ses réglages ou ceux du système. Le
chiffrement reste de bout en bout. Un proxy qui déchiffre le trafic HTTPS est détecté, et la
connexion est refusée avant tout envoi.

## Sécurité

- Le certificat du serveur est vérifié avant l'envoi de toute donnée, sur la connexion même qui
  porte les identifiants. Une exception de sécurité de Thunderbird ne suffit pas.
- Le mot de passe n'est transmis qu'au serveur pour lequel il a été saisi. Aucune redirection
  n'est suivie.
- Toute demande d'effacement à distance est refusée.
- Les données reçues du serveur sont validées et bornées avant usage.
- Après un refus d'authentification, aucune nouvelle tentative automatique n'a lieu.

ActiveSync repose le plus souvent sur l'authentification « Basic », où le mot de passe accompagne
chaque requête. Ce risque est réduit par les mesures ci-dessus et par l'emploi d'un mot de passe
d'application.

Modèle de sécurité : [docs/SECURITE.md](docs/SECURITE.md). Audits : [docs/audits/](docs/audits/).
Signalement d'une vulnérabilité : [SECURITY.md](SECURITY.md).

## Vie privée

Aucune télémétrie. Seul le serveur ActiveSync configuré est contacté, et seuls les éléments
choisis sont téléchargés. Les mots de passe sont conservés dans le gestionnaire de mots de passe
de Thunderbird. Le journal de diagnostic ne contient ni contenu, ni objet, ni adresse.

## Développement

Prérequis : Python 3.9 ou ultérieur ; Node.js 18 ou ultérieur (sous macOS, le moteur JavaScript
du système suffit) ; Thunderbird 140 ou ultérieur pour les tests de bout en bout. Sous Windows,
remplacer `python3` par `py -3`.

| Commande | Rôle |
|---|---|
| `python3 -I tools/unit_tests.py` | tests unitaires |
| `python3 -I tests/e2e/net/run_net_test.py` | tests de bout en bout : connexion |
| `python3 -I tests/e2e/account/run_account_test.py` | tests de bout en bout : comptes et mots de passe |
| `python3 -I tests/e2e/mail/run_mail_test.py` | tests de bout en bout : courrier, contre un serveur ActiveSync simulé |
| `python3 -I tools/build_xpi.py` | construction reproductible de `dist/sync443-<version>.xpi` |
| `python3 -I tools/check_source_chars.py` | refus des caractères invisibles ou bidirectionnels |
| `python3 -I tools/provenance_check.py --ref <dossier>` | contrôle de l'absence de code repris d'un autre projet |

Les tests de bout en bout utilisent un profil jetable. Le chemin de Thunderbird peut être indiqué
par la variable `THUNDERBIRD` ; la langue de l'interface, pour le test du courrier, par l'option
`--locale=en-US` (ou `fr`).

Le code est écrit à partir des spécifications publiques (Microsoft MS-ASCMD, MS-ASWBXML,
MS-ASPROV, MS-ASHTTP, MS-ASDTYPE ; IETF RFC 9110, 9112, 5322, 5545 et 6350), sans reprise de code
d'autres projets. Architecture et méthode : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Licence

[MIT](LICENSE).

Exchange et ActiveSync sont des marques de Microsoft ; Thunderbird est une marque de la Fondation
Mozilla. Sync443 n'est affilié ni à Microsoft, ni à Mozilla, ni aux projets TbSync et
EAS-4-TbSync.

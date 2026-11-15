# Sync443 – EAS Client for Thunderbird

Extension Thunderbird qui synchronise un compte **Exchange ActiveSync** (SOGo/mailcow, Exchange
Server, Zimbra, grommunio…) en passant **uniquement par HTTPS**, le port 443. Elle est faite pour
les réseaux restrictifs (hôtels, sites clients) où IMAP et SMTP sont bloqués mais où le web passe.

Courrier, dossiers, envoi, agenda, contacts et tâches, dans les deux sens. Windows, macOS et Linux.

> **État :** réécriture complète en cours. Ce dépôt ne contient pas encore de version
> installable. L'avancement est suivi dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Sécurité

Le modèle de sécurité de la version en cours d'écriture est décrit dans
[docs/SECURITE.md](docs/SECURITE.md). En bref :

- **Le mot de passe ne part que vers le serveur pour lequel il a été saisi.**
  - Aucune redirection n'est suivie.
  - Changer de serveur oblige à retaper le mot de passe.
- **Le certificat du serveur est contrôlé avant l'envoi du moindre octet de requête**, sur la connexion même qui portera le mot de passe.
  - Une connexion interceptée (proxy qui déchiffre le HTTPS) est refusée sans que rien n'y ait été écrit.
  - Fonctionne en direct comme à travers le proxy du réseau, sans rien configurer.
- **Un effacement à distance demandé par le serveur est toujours refusé.**
- **Tout ce qui vient du serveur est validé et plafonné** avant usage.
- **Aucune donnée n'est envoyée ailleurs** qu'au serveur ActiveSync configuré.

ActiveSync, tel que la plupart des serveurs le proposent, n'accepte que l'authentification
« Basic » : le mot de passe accompagne chaque requête. C'est une limite du protocole côté serveur.
Les mesures ci-dessus en réduisent le risque, et un **mot de passe d'application** réservé à
ActiveSync, quand le serveur en propose, le limite encore.

Pour signaler une vulnérabilité : voir [SECURITY.md](SECURITY.md).

## Développement

| Commande | Rôle |
|---|---|
| `python3 -I tools/unit_tests.py` | tests unitaires et aléatoires du cœur, sur Windows, macOS ou Linux (Node.js, ou JavaScriptCore sous macOS) |
| `python3 -I tools/check_source_chars.py` | refuse les caractères invisibles ou bidirectionnels dans le code |
| `python3 -I tools/provenance_check.py --ref <dossier>` | vérifie qu'aucun code d'un projet tiers n'a été repris |

Le code est écrit à partir des spécifications publiques : Microsoft [MS-ASCMD], [MS-ASWBXML],
[MS-ASPROV], [MS-ASHTTP], [MS-ASDTYPE], [MS-ASCAL], [MS-ASCNTC], [MS-ASTASK] ; IETF RFC 5545,
RFC 6350, RFC 5322.

## Licence

[MIT](LICENSE).

Exchange et ActiveSync sont des marques de Microsoft ; Thunderbird est une marque de la Fondation
Mozilla. Sync443 n'est affilié ni à Microsoft, ni à Mozilla, ni aux projets TbSync / EAS-4-TbSync.

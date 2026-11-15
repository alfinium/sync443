<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 alfinium -->

# Journal des modifications

Une section par version publiée, la plus récente en tête. La section d'une version sert de notes
de publication à son fichier `.xpi` dans les
[Releases](https://github.com/alfinium/sync443/releases).

## 0.1.0

Première version utilisable : le **courrier**, dans les deux sens, par HTTPS uniquement.

### Nouveautés

- **Boîtes Exchange ActiveSync :** autant de boîtes que nécessaire, chacune dans son propre compte
  Thunderbird. Les mots de passe sont rangés dans le gestionnaire de mots de passe de Thunderbird.
- **Dossiers :** création, renommage, déplacement et suppression, dans les deux sens. Les noms
  sont rendus valables sur Windows, macOS et Linux.
- **Messages :** réception, lu, drapeau, déplacement et suppression, dans les deux sens.
- **Arrivée immédiate** des messages (« dès réception »), ou actualisation toutes les 1, 5, 15, 30
  ou 60 minutes. Période de courrier au choix, d'un jour à tout.
- **Envoi par ActiveSync,** sans SMTP, avec copie dans les Envoyés du serveur.
- **Envoi « fermé » :** un message d'un compte Sync443 part par ActiveSync ou pas du tout. En cas
  d'échec, la fenêtre de rédaction reste ouverte, le message est gardé en brouillon et une
  notification explique pourquoi.
- **Bouton « Synchroniser »** dans la barre d'outils.
- **Page de réglages :** état de chaque boîte, synchronisation à la demande, modification,
  suppression avec confirmation ; choix des éléments à synchroniser (courrier, agenda, contacts,
  tâches) ; journal de diagnostic.
- **Filet contre les suppressions en masse :** si le serveur supprime d'un coup beaucoup de
  messages d'un dossier, ces suppressions sont retenues jusqu'à votre confirmation dans les
  réglages.

### Sécurité et vie privée

- Le certificat du serveur est contrôlé **avant l'envoi du moindre octet**, sur la connexion même
  qui porte le mot de passe ; une interception est refusée avant que rien ne parte.
- Le mot de passe ne part que vers le serveur pour lequel il a été saisi. Changer de serveur
  oblige à le retaper.
- L'accès réseau est demandé pour le seul serveur de chaque boîte, et retiré quand plus aucune
  boîte ne l'utilise.
- Un effacement à distance demandé par le serveur est toujours refusé.
- Le journal ne contient ni contenu de message, ni objet, ni adresse. Le débogage s'arrête seul au
  bout d'une heure.
- Aucune télémétrie.

### Limites connues

- **Agenda, contacts et tâches :** le choix est enregistré mais pas encore synchronisé
  (« bientôt »).
- **Microsoft 365 / Exchange Online** (OAuth2) : pas encore pris en charge.
- **Proxy exigeant sa propre authentification :** pas encore pris en charge ; l'extension le
  signale et n'envoie rien.
- **Signature et chiffrement** (OpenPGP, S/MIME) : pas appliqués aux messages envoyés par
  Sync443 ; un brouillon chiffré n'est pas envoyé.

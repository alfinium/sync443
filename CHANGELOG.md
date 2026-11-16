<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 alfinium -->

# Journal des modifications

Une section par version publiée, la plus récente en tête. La section d'une version sert de notes
de publication à son fichier `.xpi` dans les
[Releases](https://github.com/alfinium/sync443/releases).

## Non publié

### Nouveautés

- **Interface en anglais et en français,** selon la langue de Thunderbird ; l'anglais est la
  langue par défaut. Sont traduits : la page de réglages, les notifications d'envoi, le bouton
  « Synchroniser », les menus, ainsi que le nom et la description de l'extension. Les textes
  français sont inchangés.
- Les erreurs du moteur sont affichées selon leur code. En français, la raison détaillée reste
  affichée telle quelle ; dans une autre langue, elle figure en info-bulle.

### Inchangé

- Le journal de diagnostic reste en français.

### Développement

- `tools/build_xpi.py` vérifie les traductions (`src/_locales`) : catalogue de la langue par
  défaut présent, messages non vides, clés `__MSG_…__` du manifeste existantes.
- Nouveau test unitaire `tests/unit/i18n.test.mjs` : mêmes clés et mêmes paramètres dans chaque
  langue, toute clé employée existe, tout message est employé.
- `tests/e2e/mail/run_mail_test.py --locale=en-US` : le scénario vérifie la langue de la page de
  réglages, du bouton et du manifeste.

## 0.1.0

Première version utilisable : le **courrier** d'une boîte Exchange ActiveSync, dans les deux sens.
Vérifiée sur Thunderbird 140.17 ESR et Thunderbird 160.

### Nouveautés

- **Boîtes Exchange ActiveSync :** autant de boîtes que nécessaire, chacune dans son propre compte
  Thunderbird. Les mots de passe sont rangés dans le gestionnaire de mots de passe de Thunderbird.
- **Dossiers :** création, renommage, déplacement et suppression, dans les deux sens. Les noms
  sont rendus valables sur Windows, macOS et Linux.
- **Messages :** réception, lu, drapeau, déplacement et suppression, dans les deux sens.
- **Archiver** (touche A) range le message dans le dossier « Archives » du serveur, créé au besoin.
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
- **Filet contre les suppressions en masse :** si le serveur supprime beaucoup de messages d'un
  dossier (d'un coup ou peu à peu sur 24 heures), ou fait disparaître plusieurs dossiers à la fois,
  ces suppressions sont retenues. Dans les réglages, vous les confirmez, ou vous gardez les copies
  locales. Une liste de dossiers sans boîte de réception est refusée.

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
- **Copie cachée (Cci) :** ActiveSync n'a pas d'enveloppe. L'en-tête `Bcc` part donc avec le
  message jusqu'au serveur, qui en tire les destinataires et le retire avant la remise, comme le
  fait Exchange. Sync443 ne peut pas le retirer lui-même sans perdre ces destinataires.
- Aucune télémétrie.

### Limites connues

- **Agenda, contacts et tâches :** le choix est enregistré mais pas encore synchronisé
  (« bientôt »).
- **Certificat d'une autorité privée :** pas encore pris en charge ; le certificat du serveur doit
  être émis par une autorité publique reconnue par Thunderbird (comme Let's Encrypt).
- **Microsoft 365 / Exchange Online** (OAuth2) : pas encore pris en charge.
- **Proxy exigeant sa propre authentification :** pas encore pris en charge ; l'extension le
  signale et n'envoie rien.
- **Décocher le courrier** arrête sa synchronisation, mais le compte local et ses messages restent
  en place ; leur suppression après confirmation viendra plus tard.
- **Un message déplacé vers un dossier du compte qui n'existe que dans Thunderbird** (les modèles,
  par exemple) est détaché du serveur : la copie du serveur reste où elle était, rien n'y est
  supprimé. Déplacé vers un autre compte (« Dossiers locaux », par exemple), il quitte la boîte :
  sur le serveur, il va dans les Éléments supprimés, comme avec IMAP.
- **Cas rares côté serveur** (dossiers renumérotés et renommés en même temps, serveur non conforme) :
  un dossier peut être téléchargé une seconde fois, sans que rien ne soit supprimé. Le détail est
  dans [docs/audits/etape-2-3.md](https://github.com/alfinium/sync443/blob/main/docs/audits/etape-2-3.md).
- **Signature et chiffrement** (OpenPGP, S/MIME) : pas encore pris en charge. Un message pour
  lequel la signature ou le chiffrement est demandé n'est pas envoyé : la fenêtre de rédaction
  reste ouverte et une notification l'explique.

# Conception — étapes 2 et 3 : comptes et courrier

Ce document fixe les contrats entre modules pour la première version utilisable (0.1.0, courrier).
Chaque module a un seul auteur à la fois ; les interfaces ci-dessous font foi. Les règles de
[SECURITE.md](SECURITE.md) s'appliquent partout.

## Périmètre de la 0.1.0

- **Boîtes et configuration :** plusieurs boîtes, page de réglages, choix des éléments (seul le
  courrier est synchronisé dans cette version ; agenda, contacts et tâches sont enregistrés mais
  ignorés, avec la mention « bientôt »).
- **Courrier, dans les deux sens :**
  - dossiers (créer, renommer, déplacer, supprimer) ;
  - messages (réception, lu, drapeau, déplacement, suppression) ;
  - arrivée immédiate (Ping) ou actualisation périodique ;
  - envoi par ActiveSync.
- **Commandes :** bouton « Synchroniser », menus.
- **Hors périmètre :** agenda, tâches, contacts (étapes 4 et 5).

## Identité des messages

Thunderbird renumérote ses messages à chaque démarrage : **jamais d'identifiant Thunderbird
conservé d'une session à l'autre.**

- **Côté serveur**, un message est un `ServerId` dans une collection (dossier).
- **Côté Thunderbird**, un message est un **Message-ID dans un dossier**.
  - Un message reçu sans Message-ID en reçoit un, stable, avant import : `<hex@sync443.invalid>`, où `hex` = 32 caractères hexadécimaux de SHA-256 du message.
- **Correspondance par collection :** `items: Map<ServerId, MessageId>`, plus l'index inverse `Map<MessageId, Set<ServerId>>` construit en mémoire.
- **Aucun alias.** Un ajout du serveur dont le Message-ID est déjà dans le dossier :
  - si le message local n'est rattaché à aucun ServerId, il est rattaché ;
  - sinon, une copie distincte est importée.
- **Suppression locale :** un message local n'est supprimé que si **plus aucun** ServerId n'y renvoie.
- **Resynchro complète** (SyncKey "0", Status 3) : la table de la collection est vidée puis reconstruite.

## Données enregistrées (par boîte, `store.mailbox(id)`)

| Enregistrement | Contenu |
|---|---|
| `proto` | `{ asVersion, policyKey }` (client) |
| `health` | santé (`sync/health.mjs`) |
| `hierarchy` | `{ syncKey }` |
| `folders` (Map) | `ServerId → { parentId, name, type }` (tel que validé par `protocol.parseFolderSync`) |
| `coll:<ServerId>` (via `recordName`) | `{ syncKey, path, items: [[ServerId, MessageId], …] }`, où `path` est le chemin du dossier local (ex. `/Inbox/Projets`) |
| `journal` | modifications locales en attente (voir plus bas) |
| `pendingDeletes` | suppressions du serveur retenues par le seuil de suppression en masse |

## Code privilégié `sync443Account` (étape 2)

Espace de noms `sync443Account`, page d'arrière-plan seulement, chaque argument validé, erreurs
« `CODE: raison` » comme `sync443Net`.

**Comptes :**
- `ensureAccount({ mailboxId, email, name, fullName? })` → `{ accountKey, identityId, created }`.
  - Si un compte marqué pour ce `mailboxId` existe, il est mis à jour : nom, adresse ; le nom complet seulement si l'identité n'en a pas.
  - Sinon, un compte local (type `none`) est créé, avec ses dossiers par défaut. Il est marqué par les préférences de serveur `sync443.owner` (identifiant de l'extension) et `sync443.mailbox` (`mailboxId`).
  - **Envoi fermé :** l'identité est rattachée à un serveur sortant neutre, marqué lui aussi (hôte `sync443.invalid`). Si l'extension est désactivée, un envoi échoue au lieu de partir par un autre fournisseur.
- `listAccounts()` → `[{ accountKey, mailboxId }]` : comptes marqués seulement.
- `accountOfIdentity(identityId)` → `{ accountKey, mailboxId } | null`.
- `removeAccount(accountKey)` → `boolean` : comptes marqués seulement, jamais « Dossiers locaux ». Supprime aussi le serveur sortant neutre s'il ne sert plus.
- `setSpecialUse(accountKey, folderPath, use)`, avec `use` ∈ `inbox | drafts | trash | sent | junk | archives | templates | outbox` : comptes marqués seulement.

**Mots de passe** (domaine `Sync443` du gestionnaire de Thunderbird ; `origin` strictement `https://hôte[:port]`) :
- `getPassword(origin, username)` → `string | null`
- `setPassword(origin, username, password)`
- `removePassword(origin, username)`

## Cœur du courrier (pur, testable seul)

**`core/sha256.mjs`** : `sha256(bytes) → Uint8Array(32)` (FIPS 180-4).

**`core/mime.mjs`** — tout en octets, en temps linéaire, bloc d'en-têtes de tête plafonné à 1 Mio :
- `messageIdOf(bytes)` → `string | null` : Message-ID du bloc d'en-têtes de tête, sans chevrons, comme Thunderbird l'expose (`headerMessageId`).
- `ensureMessageId(bytes)` → `{ bytes, messageId, synthetic }`.
- `stripInternalHeaders(bytes)` : retire des messages **reçus** les en-têtes que Thunderbird interprète (`X-Mozilla-Status`, `X-Mozilla-Status2`, `X-Mozilla-Keys`, `X-Account-Key`, `X-Identity-Key`…), pour qu'un expéditeur ne puisse pas fixer des drapeaux ou des étiquettes.
- `cleanDraft(bytes)` : retire d'un brouillon **à envoyer** les en-têtes internes de Thunderbird, en tête **et dans chaque partie MIME** (`X-Mozilla-*`, `X-Account-Key`, `X-Identity-Key`, `Fcc`, `X-Mozilla-Cloud-Part`…), quelle que soit la taille des en-têtes.

**`core/mail-codec.mjs`** :
- `readEmail(applicationData)` → `{ read, flagged, mime, truncated }`.
  - `read`, `flagged` : `true`, `false` ou `null` si absent.
  - `mime` : `Uint8Array | null`.
- `changeEmail({ read?, flagged? })` → éléments `ApplicationData` d'un `Change`.
- `mailOptions({ filterType })` → éléments `Options` (période, corps MIME complet).

**`core/folder-tree.mjs`** :
- **Types de dossiers :**
  - `MAIL_TYPES` : 1, 2, 3, 4, 5, 6, 12 ;
  - `CALENDAR_TYPES` : 8, 13 ;
  - `CONTACT_TYPES` : 9, 14 ;
  - `TASK_TYPES` : 7, 15 ;
  - `specialUse(type)` : 2 → inbox, 3 → drafts, 4 → trash, 5 → sent, 6 → outbox, sinon `null`.
- `applyChanges(folders, changes)` → nouvelle `Map`, à partir de `protocol.parseFolderSync`.
- `buildTree(folders, { kinds })` → `{ nodes: Map<ServerId, { parentId, name, type, depth }>, rejected: [{ serverId, reason }] }`.
  - Ne garde que les types des éléments choisis.
  - Rejette les cycles, les parents inconnus, une profondeur au-delà de 32 et plus de 5000 dossiers.
- `localPaths(tree)` → `Map<ServerId, path>`, chemins locaux **un pour un** :
  - Les dossiers spéciaux vont sur les dossiers spéciaux locaux (par drapeau, jamais par nom).
  - Ailleurs, les noms sont rendus valables sur Windows, macOS et Linux :
    - `/ \ : * ? " < > |` deviennent `_` ;
    - points et espaces finaux retirés ;
    - noms réservés de Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`COM9`, `LPT1`…`LPT9`, extension comprise) suffixés de `_` ;
    - 100 caractères au plus.
  - Les collisions entre frères (casse ignorée), et avec les noms des dossiers spéciaux à la racine, reçoivent un suffixe ` (2)`, ` (3)`… dans l'ordre des ServerId : le résultat est déterministe.

## Moteur de synchro (étape 3)

**Adaptateurs** (`tb/`), seule partie qui touche aux API de Thunderbird, remplaçables par des doubles dans les tests :
- **`tb/mail-store.mjs`** — dossiers et messages d'un compte, par chemin :
  - dossiers : `folderExists`, `createFolder(parentPath, name)`, `renameFolder`, `moveFolder`, `deleteFolder`, `listFolders()` ;
  - messages : `findByMessageId(path, mid)` → `[{ id, flags }]`, `importMessage(path, bytes, flags)` → `{ id }`, `setFlags(id, flags)`, `moveMessages(ids, path)`, `deleteMessages(ids, { permanent })` ;
  - échéance d'import (60 s) ;
  - chaque écriture déclare son écho attendu (voir `sync/echo.mjs`).
- **`tb/events.mjs`** : abonne `messages.onUpdated/onMoved/onDeleted` et `folders.onCreated/onRenamed/onMoved/onDeleted`. Il traduit chaque événement d'un compte marqué en intention locale (`{ kind, path, messageId?, flags?, toPath? }`), sauf s'il s'agit d'un écho de nos propres écritures.

**`sync/echo.mjs`** : attentes d'écho, appariées par valeur, consommées une fois, durée de vie 30 s, nombre plafonné.

**`sync/journal.mjs`** : file persistante des modifications locales.
- `{ id, op: "flags" | "move" | "delete" | "folderCreate" | "folderRename" | "folderMove" | "folderDelete", … }`
- Une entrée n'est retirée qu'après une **réponse positive du serveur pour elle** ; un refus définitif est journalisé et retiré.
- **Suppression locale définitive :** `Delete` avec `DeletesAsMoves=1` (vers les éléments supprimés du serveur), sauf depuis la corbeille.
- **Suppression d'un dossier :** un dossier n'est supprimé sur le serveur que s'il était dans la corbeille, et jamais un dossier spécial.

**`sync/mail.mjs`** : synchro d'une collection.
- Sync avec `WindowSize` 50 et `MoreAvailable` borné (au plus 20 lots par passage).
- Les ajouts sont importés après `stripInternalHeaders` et `ensureMessageId`.
- **Suppressions venues du serveur :**
  - hors corbeille, la copie locale va dans la corbeille locale ;
  - dans la corbeille, elle est supprimée.
- **Seuil de suppression en masse :** plus de 50 suppressions et plus de 20 % du dossier dans un même passage. Les suppressions sont alors retenues dans `pendingDeletes`, la boîte est bloquée (`MASS_DELETE`), et l'utilisateur confirme dans les réglages.
- **La SyncKey n'avance** que si tout le lot est traité ; un élément qui échoue est mis en quarantaine (journalisé, ignoré) sans bloquer les autres.

**`sync/push.mjs`** : boucle Ping.
- Seulement sur les dossiers des éléments choisis.
- L'intervalle s'adapte dans les deux sens.
- Délai minimal entre deux Ping, et recul en cas d'erreur.

**`sync/mailbox.mjs`** : orchestration d'une boîte.
- Un verrou par boîte que rien ne lève de force, et une annulation réelle (`AbortController`).
- Santé et espacement des essais (`sync/health.mjs`).
- Ordre d'un passage :
  1. FolderSync ;
  2. dossiers locaux ;
  3. journal ;
  4. collections.

## Arrière-plan, envoi, réglages

**`background.mjs`** : boîtes, minuteries (`alarms`), Ping, menus, bouton « Synchroniser » (pastille « … » ou « ! »), messages de la page de réglages.

**`send.mjs` — envoi fermé :**
1. Pour une identité d'un compte marqué, l'envoi de Thunderbird est toujours annulé.
2. L'extension enregistre le brouillon, le lit (`messages.getRaw`), applique `cleanDraft`, l'envoie par `SendMail` (copie dans les Envoyés du serveur), supprime le brouillon local et ferme la fenêtre.
3. Un deuxième clic pendant un envoi est ignoré.
4. En cas d'échec, la fenêtre reste ouverte et une notification explique pourquoi.
5. L'envoi par un autre chemin n'est jamais tenté.

**Réglages** (`options/`) :
- **Liste des boîtes :** état, « Synchroniser », « Modifier », « Supprimer » avec confirmation.
- **Formulaire :**
  - e-mail, mot de passe, nom, serveur ;
  - fréquence (dès réception, 1, 5, 15, 30, 60 min) ;
  - période (1 jour à tout) ;
  - **cases courrier, agenda, contacts, tâches** (au moins une ; agenda, contacts et tâches marqués « bientôt »).
- **Changement d'origine :** le mot de passe doit être retapé.
- **Permission d'hôte :** demandée pour la seule origine du serveur, retirée quand plus aucune boîte ne l'utilise.
- **Journal :** sans contenu personnel. Le débogage s'éteint seul au bout d'une heure.
- **Interface :** aucune donnée insérée en HTML (`textContent` uniquement), politique de contenu par défaut.

**Manifeste :**
- identifiant `sync443@alfinium.github.io`, version `0.1.0` ;
- `strict_min_version` `140.0` ;
- permissions strictement nécessaires ;
- `optional_permissions` `https://*/*` ;
- expériences `sync443Net` et `sync443Account`.

**Construction et publication :**
- `tools/build_xpi.py` produit `dist/sync443-<version>.xpi`, de façon reproductible (fichiers triés, dates fixes).
- Une étiquette `v<version>` poussée sur GitHub lance l'atelier `release.yml` : tests unitaires, construction, publication du `.xpi` dans les Releases.

## Tests

- **Unitaires** : chaque module du cœur et du moteur, avec des doubles des adaptateurs.
- **De bout en bout** (`tests/e2e/mail/`) :
  - Thunderbird sans interface, extension construite, faux serveur ActiveSync **en TLS** avec une autorité de test épinglée par la boîte de test ;
  - scénario : ajout de boîtes, première synchro, actions locales, push, envoi, redémarrage de Thunderbird, suppression en masse retenue, suppression de boîte.

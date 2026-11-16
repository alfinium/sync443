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
- **Message-ID lu strictement.** Celui d'un message n'est pris que si Thunderbird ne peut pas le lire autrement (voir `core/mime.mjs`). Sinon le message en reçoit un, stable, avant import :
  - `<hex@sync443.invalid>`, où `hex` = 32 caractères hexadécimaux de SHA-256 du message ;
  - ses anciens champs Message-ID sont renommés `X-Sync443-Original-Message-ID`.
- **Relu après import.** Le Message-ID gardé est celui que Thunderbird a lu (`headerMessageId`), celui que portent ses événements. S'il est inutilisable (blancs, caractères de contrôle), ou si une autre copie du dossier l'a déjà, cette copie (la nôtre, tout juste importée) est supprimée définitivement, et le message est réimporté une fois sous un identifiant propre ; si cela échoue encore, cette seconde copie est supprimée aussi et l'élément est mis en quarantaine. Gardée, même à la corbeille, une telle copie compterait contre l'autre message.
- **Correspondance par collection :**
  - `items: Map<ServerId, MessageId>`, plus l'index inverse `Map<MessageId, Set<ServerId>>` construit en mémoire ;
  - pour chaque ServerId, une empreinte du message importé : 16 chiffres hexadécimaux de son SHA-256.
- **Aucun alias.** Un ajout du serveur dont le Message-ID est déjà dans le dossier :
  - est rattaché à une copie locale qu'aucun ServerId ne tient, seulement si les preuves le disent. Pendant une resynchro complète : l'empreinte que la table avait pour ce Message-ID. Sinon : la date et l'adresse de l'expéditeur de la copie, telles que Thunderbird les a lues ;
  - le Message-ID seul ne suffit jamais : n'importe quel expéditeur peut reprendre celui d'un autre message ;
  - sinon, une copie distincte est importée sous son propre identifiant, tiré du message, de la collection et du ServerId : le même élément a toujours le même. Une copie distincte faite par un passage précédent est retrouvée, pas refaite.
- **Suppression locale :** un message local n'est supprimé que si **plus aucun** ServerId n'y renvoie.
- **Hors période.** Un élément qui sort de la période choisie (`SoftDelete`) garde son lien dans une table à part (`aged`) :
  - la copie locale reste, le message aussi sur le serveur ;
  - ce que l'utilisateur en fait part quand même : suppression par `MoveItems` vers la corbeille du serveur, drapeaux par `Change`, déplacement par `MoveItems` ;
  - ce lien survit à une resynchro complète du même dossier (Status 3 : les ServerId restent valables) ; il n'est oublié que si le serveur répond que l'élément n'existe plus.
- **Resynchro complète** (SyncKey "0", Status 3, dossier local changé ou recréé) : la table est vidée puis reconstruite.
  - Ce qu'elle tenait sert de preuve (empreintes) pour rattacher les copies locales.
  - Les modifications locales en attente sont respectées : un message supprimé ou déplacé par l'utilisateur est relié sans être réimporté, et le journal envoie ensuite la suppression ; des drapeaux pas encore envoyés ne sont pas écrasés par ceux du serveur.
  - Relié sans réimport : seulement l'élément dont l'empreinte est celle de la table d'avant, jamais un élément qui reprend son Message-ID. Ces liens sans copie locale (`held`) sont les premiers que la suppression ou le déplacement envoie.
  - Une reconstruction peut prendre plusieurs passages (un grand dossier). Tant qu'elle dure, une modification sur un message pas encore relié attend (« wait » : ni envoyée, ni comptée comme un essai, ni réglée « à vide ») ; elle part une fois la table complète.
- **Réponse vide** (HTTP 200 sans corps : le serveur n'a rien de nouveau, Exchange répond ainsi pour un dossier sans changement) : la SyncKey reste, et une table en reconstruction est complète (un dossier vide répond ainsi juste après son lot initial) ; jamais à une SyncKey "0", qui doit recevoir sa clé. Les commandes envoyées dans la requête ne sont pas tenues pour reçues ; les messages hors période supprimés partent quand même (`MoveItems`).

## Données enregistrées (par boîte, `store.mailbox(id)`)

| Enregistrement | Contenu |
|---|---|
| `proto` | `{ asVersion, policyKey }` (client) |
| `health` | santé (`sync/health.mjs`), dont `failedItems` : éléments du serveur dont l'import échoue encore |
| `hierarchy` | `{ syncKey }` |
| `folders` (Map) | `ServerId → { parentId, name, type }` (tel que validé par `protocol.parseFolderSync`) |
| `coll:<ServerId>` (via `recordName`) | instantané de la table d'une collection : `{ gen, syncKey, path, items: [[ServerId, MessageId, empreinte], …], aged, quarantine, failed, prior, full, more, window, held }`, où `path` est le chemin du dossier local (ex. `/Inbox/Projets`) |
| `cseg:<ServerId>:<n>` | changements de cette table depuis l'instantané (1000 au plus par enregistrement), avec la SyncKey et les petits champs à jour ; un nouvel instantané est écrit quand ils dépassent la taille de la table |
| `journal` | `{ v: 2, seq }` : numéro de la dernière modification locale |
| `journal:<n>` | modifications locales en attente, par morceaux de 500 (voir plus bas) |
| `pendingDeletes` (Map) | `CollectionId → { items, at, retained, base }` : suppressions du serveur pas encore décidées, ou retenues par le seuil ; `base` est la taille du dossier avant elles. Retrait d'un dossier entier retenu : `{ folder: { path }, messages, retained: true }`, `messages` comptés dans le dossier local |
| `layout` (Map) | `ServerId → { path, ready }` : dossier local de chaque collection synchronisée (pour rattacher une modification locale à sa collection, et pour le Ping) |
| `archives` | `{ serverId }` : dossier du serveur lié au dossier d'archives local |
| `renaming` (Map) | `ServerId → chemin` : nom temporaire choisi pour un dossier, noté juste avant de le renommer |

Une table s'écrit par morceaux : un lot de 50 messages réécrit un segment, jamais toute la table.

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

**Mots de passe** (domaine `Sync443` du gestionnaire de Thunderbird ; `origin` strictement `https://hôte[:port]`) :
- `getPassword(origin, username)` → `string | null`
- `setPassword(origin, username, password)`
- `removePassword(origin, username)`

## Cœur du courrier (pur, testable seul)

**`core/sha256.mjs`** : `sha256(bytes) → Uint8Array(32)` (FIPS 180-4).

**`core/mime.mjs`** — tout en octets, en temps linéaire :
- `messageIdOf(bytes)` → `string | null` : Message-ID du bloc d'en-têtes de tête, sans chevrons, lu strictement pour être la valeur que Thunderbird garde (`headerMessageId`) quel que soit le lecteur qu'il utilise. `null` sauf si :
  - le bloc d'en-têtes se termine dans le premier Mio ;
  - jusqu'au champ, le bloc ne commence pas par une ligne de continuation, n'a ni NUL ni CR isolé, et chaque ligne a des deux-points après un nom bien formé (« Message-ID : » est refusé) ;
  - un seul champ s'appelle Message-ID dans tout le bloc ;
  - sa valeur, dépliée, est exactement `<id>` ou un mot seul (pas de commentaire, pas de second mot) : 1 à 998 caractères ASCII visibles, sauf `< > ( ) " \`.
- `ensureMessageId(bytes)` → `{ bytes, messageId, synthetic }` : sans Message-ID lisible, le message en reçoit un par `replaceMessageId`.
- `replaceMessageId(bytes, id)` : le message sous un autre Message-ID.
  - Chaque champ Message-ID du bloc de tête est renommé `X-Sync443-Original-Message-ID`, quelle que soit la taille du bloc : aucun lecteur ne peut en prendre un ancien.
  - Le nouveau champ est mis en tête.
  - Si le message commence par un blanc, un champ vide `X-Sync443-Continuation` suit le nôtre : cette ligne s'y replie, jamais sur le Message-ID.
- `dateOf(bytes)`, `fromAddressOf(bytes)`, `addressOf(texte)` : date (en millisecondes) et adresse de l'expéditeur, pour comparer un élément du serveur à une copie locale.
- `stripInternalHeaders(bytes)` : retire des messages **reçus** les en-têtes que Thunderbird interprète (`X-Mozilla-Status`, `X-Mozilla-Status2`, `X-Mozilla-Keys`, `X-Account-Key`, `X-Identity-Key`…), pour qu'un expéditeur ne puisse pas fixer des drapeaux ou des étiquettes.
- `cleanDraft(bytes)` : retire d'un brouillon **à envoyer** les en-têtes internes de Thunderbird, en tête **et dans chaque partie MIME** (`X-Mozilla-*`, `X-Account-Key`, `X-Identity-Key`, `Fcc`, `X-Mozilla-Cloud-Part`…), quelle que soit la taille des en-têtes. Une ligne de délimiteur coûte au plus la longueur de la plus longue frontière, quelle que soit la profondeur d'imbrication.

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
- `localPaths(tree, { archives })` → `Map<ServerId, path>`, chemins locaux **un pour un** :
  - Les dossiers spéciaux vont sur les dossiers spéciaux locaux (par drapeau, jamais par nom).
  - `archives` : le ServerId du dossier lié aux archives (enregistrement `archives`, jamais choisi par son nom). Il va sur `/Archives`, avec ses sous-dossiers.
  - Ailleurs, les noms sont rendus valables sur Windows, macOS et Linux, et tels que Thunderbird range le dossier sous son nom (sinon il prend un nom de fichier haché, et le chemin du dossier ne porte plus son nom) :
    - `/ \ : * ? " < > | ; #` deviennent `_` ;
    - un `.` initial devient `_` ;
    - points et espaces finaux retirés, un `~` final devient `_` ;
    - noms réservés de Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`COM9`, `LPT1`…`LPT9`, extension comprise) suffixés de `_` ;
    - un nom qui finit par `.msf` ou `.sbd` (casse ignorée), comme les fichiers de Thunderbird à côté d'un dossier, suffixé de `_` ;
    - 55 unités UTF-16 au plus.
  - Les collisions entre frères (casse ignorée), et avec les noms des dossiers spéciaux à la racine, reçoivent un suffixe ` (2)`, ` (3)`… dans l'ordre des ServerId : le résultat est déterministe.
  - À la racine, un nom qui ressemble à un nom réservé reçoit aussi un suffixe : casse, largeur, accents, lettres d'autres alphabets dessinées comme des lettres latines (« Inbox » écrit avec un I cyrillique), `I l 1`, `0 o`.

## Moteur de synchro (étape 3)

**Adaptateurs** (`tb/`), seule partie qui touche aux API de Thunderbird, remplaçables par des doubles dans les tests :
- **`tb/mail-store.mjs`** — dossiers et messages d'un compte, par chemin :
  - dossiers : `folderExists`, `createFolder(parentPath, name)`, `renameFolder`, `moveFolder`, `listFolders()` → `[{ path, name, specialUse }]` (`name` : le nom que montre Thunderbird, qui peut différer du dernier segment du chemin) ;
  - messages : `findByMessageId(path, mid)` → `[{ id, flags, date, author }]`, `listMessages(path)`, `importMessage(path, bytes, flags, { messageId })` → `{ id, messageId }` (le Message-ID que Thunderbird a lu), `setFlags(id, flags)`, `moveMessages(ids, path)`, `deleteMessages(ids, { permanent })`, `discardImport(id)` (suppression définitive d'une copie que cette session vient d'importer, et de rien d'autre) ;
  - échéance d'import (60 s) ;
  - chaque écriture déclare son écho attendu (voir `sync/echo.mjs`) ;
  - un import non lu est ensuite marqué lu puis non lu, pour que le fichier du dossier le dise non lu ;
  - un message importé est gardé en entier (voir `sync/echo.mjs`) avec les drapeaux écrits, avant l'import : Thunderbird change ses drapeaux tout seul après la copie (marqué lu pour effacer « nouveau », non lu de nouveau, suivi), un nombre de fois qui dépend de sa version.
- **`tb/events.mjs`** : abonne `messages.onUpdated/onMoved/onDeleted` et `folders.onCreated/onRenamed/onMoved/onDeleted`. Il traduit chaque événement d'un compte marqué en intention locale (`{ kind, path, messageId?, flags?, toPath? }`), sauf s'il s'agit d'un écho de nos propres écritures.

**`sync/echo.mjs`** : attentes d'écho, appariées par valeur, consommées une fois, durée de vie 30 s, nombre plafonné.
- **Garde d'un message importé** : l'état de ses drapeaux tel que le moteur l'a écrit, 30 s au plus.
  - Un événement de drapeau sur ce message attend la fin des écritures du moteur, puis compare l'état du message à ce moment avec l'état gardé.
  - Égal : rien à envoyer (marques de Thunderbird ou du moteur, ou changement déjà défait). Différent : c'est un changement de l'utilisateur, envoyé, et la garde retient ce nouvel état.
  - Aucun délai à deviner : un changement réel n'est jamais avalé, même si la file d'événements prend du retard.

**`sync/journal.mjs`** : file persistante des modifications locales.
- `{ id, op: "flags" | "move" | "delete" | "folderCreate" | "folderRename" | "folderMove" | "folderDelete", path, messageId?, flags?, toPath?, src?, dst?, … }`
- **Collection d'origine.** Une modification d'un message garde les ServerId des collections où elle a été faite : `src`, et `dst` pour un déplacement. Elle part vers ce dossier du serveur même si les dossiers locaux ont bougé entre-temps (dossier renommé sur le serveur, autre dossier qui prend son nom).
- Une entrée n'est retirée qu'après une **réponse positive du serveur pour elle** ; un refus définitif est journalisé et retiré.
- Un refus passager garde l'entrée. Ses essais se comptent une fois par série de passages (`run({ round })`), pas par passage ; au bout de 20 séries, elle est abandonnée et journalisée.
- Une entrée qui n'a pas pu partir (« wait » : dossier en reconstruction, SyncKey initiale) reste sans qu'un essai soit compté, 100 séries au plus ; au-delà, ses essais se comptent de nouveau.
- Dossiers repris sous de nouveaux ServerId (réinitialisation du partenariat) : `rebind` réécrit `src` et `dst` des entrées en attente d'un coup (des ServerId peuvent passer à d'autres dossiers, voire s'échanger), écrit avant que les anciennes tables partent. Le ServerId d'une table qui part alors que ce ServerId désigne un autre dossier est retiré : l'entrée ne garde que son dossier local (`path`, `toPath`). Pendant l'étape des dossiers locaux, `recordIntent` attend : une modification faite à ce moment reçoit déjà les nouveaux ServerId.
- **Écriture par morceaux** de 500 entrées (`journal:<n>`) : une modification de plus réécrit un morceau, jamais tout le journal.
  - Les écritures sont regroupées : une écriture commence 20 ms après le premier changement et emporte tout ce qui a changé entre-temps.
  - `append` rend la main dès que l'entrée est en mémoire, comme un événement en attente ; `flush()` et `close()` attendent l'écriture.
  - `{ v: 2 }` dans l'enregistrement `journal` marque le format, pour qu'une version suivante le reconnaisse.
- **Suppression locale définitive :** `Delete` avec `DeletesAsMoves=1` (vers les éléments supprimés du serveur), sauf depuis la corbeille.
- **Suppression d'un dossier :** un dossier n'est supprimé sur le serveur que s'il était dans la corbeille, et jamais un dossier spécial.

**`sync/mail.mjs`** : synchro d'une collection.
- Sync avec `WindowSize` 50 et `MoreAvailable` borné (au plus 20 lots par passage).
- Les ajouts sont importés après `stripInternalHeaders` et `ensureMessageId`, puis rattachés au Message-ID que Thunderbird a lu.
- **Import en échec :** l'élément est gardé (`failed`) et redemandé (`Fetch`) à la fin du passage de la collection, 5 fois au plus, puis mis en quarantaine. Leur nombre est dans la santé (`failedItems`). Un élément illisible, sans contenu ou tronqué est mis en quarantaine tout de suite.
- **Suppressions venues du serveur :**
  - hors corbeille, la copie locale va dans la corbeille locale ;
  - dans la corbeille, elle est supprimée.
- **Seuil de suppression en masse :** plus de 50 suppressions et plus de 20 % du dossier.
  - Compté sur toute la série de suppressions d'une collection, jusqu'à ce que le serveur n'ait plus rien à envoyer (sur plusieurs passages s'il le faut), par rapport à la taille du dossier avant elles. Rien n'est appliqué avant.
  - Compté aussi sur une fenêtre glissante de 24 h : un serveur qui supprime un peu à chaque passage est arrêté de la même façon. La fenêtre survit à une resynchro complète et passe à la collection qui reprend un dossier ; seule une confirmation de l'utilisateur la fait repartir.
  - Au-delà, les suppressions sont retenues dans `pendingDeletes`, la boîte est bloquée (`MASS_DELETE`), et l'utilisateur confirme dans les réglages.
- **Table remise à zéro** (Status 3, dossier local changé ou recréé, suppressions refusées) : ses suppressions retenues sont abandonnées, elles agiraient sur d'autres copies.
- **Déplacements locaux :**
  - vers un dossier synchronisé : `MoveItems` ;
  - vers un dossier sans équivalent sur le serveur (dossier purement local) : la copie du serveur reste où elle est, seul le lien est oublié. **Jamais une suppression** ;
  - `MoveItems` accepté sans `DstMsgId` : la source perd le lien, la destination rattachera le message à sa prochaine synchro.
- **La SyncKey n'avance** que si tout le lot est traité ; un élément qui échoue n'empêche pas les autres.

**`sync/push.mjs`** : boucle Ping.
- Seulement sur les dossiers des éléments choisis, déjà synchronisés (enregistrement `layout`).
- L'intervalle s'adapte dans les deux sens.
- Délai minimal entre deux Ping, et recul en cas d'erreur.

**`sync/mailbox.mjs`** : orchestration d'une boîte.
- Un verrou par boîte que rien ne lève de force, et une annulation réelle (`AbortController`).
- Santé et espacement des essais (`sync/health.mjs`).
- Ordre d'un passage :
  1. FolderSync ; une liste de dossiers sans boîte de réception (type 2) est refusée et rien n'est changé. Une liste reprise de zéro (clé refusée, réinitialisation du partenariat) n'est enregistrée qu'à la fin de l'étape 2 : un passage arrêté entre les deux la reprend de zéro et refait le rapprochement ;
  2. dossiers locaux ;
  3. journal ;
  4. collections.
- **Dossiers locaux** (étape 2) :
  - Chaque collection a son propre dossier local, ou aucun pendant ce passage : **jamais deux collections sur un même dossier**. Si cela arrivait malgré tout, aucune des deux n'est synchronisée.
  - Les déplacements et renommages sont planifiés ensemble : un dossier ne prend une place qu'une fois libérée ; un cycle (deux dossiers qui échangent leurs noms) passe par un nom temporaire « Sync443 n » ; un dossier spécial local ne bouge jamais, sa collection en cède la place si une autre en a besoin.
  - Les dossiers sont désignés par leur nom (celui que montre Thunderbird), jamais par le dernier segment de leur chemin.
  - Un dossier que le journal va changer (création, renommage ou déplacement local pas encore envoyé) est laissé tel quel.
  - Chaque déplacement ou renommage local est enregistré aussitôt. Le nom temporaire est noté avant le renommage (enregistrement `renaming`) : un passage arrêté juste après retrouve le dossier sous ce nom, et seulement celui-là (jamais un dossier de l'utilisateur au nom semblable). La collection est alors reconstruite avec sa propre table comme preuve : ce qui manque revient.
- **Dossiers disparus du serveur :**
  - si une nouvelle collection doit être à la même place (nouveaux ServerId après une réinitialisation de l'appareil), elle reprend le dossier local : rien à la corbeille, rien de retéléchargé. Elle reçoit l'ancienne table comme preuve et sa fenêtre glissante, et les modifications locales en attente la suivent (journal réécrit avant que l'ancienne table parte) ;
  - quand la liste des dossiers est reprise de zéro, aucun ServerId n'est cru sur parole (le serveur peut avoir renuméroté ses dossiers, voire échangé leurs ServerId). Chaque table est rapprochée à nouveau :
    1. par sa place : le dossier du serveur qui veut ce dossier local le reprend, comme ci-dessus (s'il a le même ServerId, la table reste telle quelle) ;
    2. sinon par son ServerId, si ce dossier du serveur n'a repris aucune autre table et garde son type (simple renommage ou déplacement : le dossier local suit) ;
    3. sinon, si son ServerId désigne désormais un autre dossier, la table part et son dossier local reste en place, hors synchro ; ses modifications en attente ne gardent que leur dossier local et n'atteignent jamais l'autre dossier ;
    4. une table dont le ServerId n'existe plus est un dossier disparu, comme d'habitude ;
  - sinon le dossier local va à la corbeille locale ; s'il y est déjà, il y reste : **jamais supprimé à cause du serveur** ;
  - seuil : si les dossiers disparus contiennent assez de messages pour une suppression en masse, ou si au moins trois dossiers et au moins la moitié des dossiers de la boîte disparaissent d'un coup, le retrait est retenu et confirmé comme une suppression en masse. Les messages sont comptés dans les dossiers locaux (sous-dossiers locaux compris), pas dans les tables, qu'un serveur peut vider d'abord par une resynchro. Refusé, les dossiers restent en local, sans synchro.
- **Archives :** le dossier d'archives local (`/Archives`, celui de l'action « Archiver ») est lié par son ServerId (enregistrement `archives`) à un dossier du serveur ; archiver devient un déplacement ordinaire (`MoveItems`).
  - Le dossier « Archives » à la racine du serveur (dossier ordinaire, nom comparé sans égard à la casse) est lié dès la liste des dossiers : il va sur `/Archives`, jamais à côté en « /Archives (2) ».
  - S'il n'existe pas, il est créé sur le serveur la première fois qu'un message synchronisé est archivé.
  - Tenu en « /Archives (2) » par une version antérieure : ses messages rejoignent `/Archives` (déplacés, pas retéléchargés), sa table est gardée, ses sous-dossiers suivent, et l'ancien dossier, vidé, va à la corbeille locale.
  - Le lien tombe si ce dossier quitte la racine ou part dans la corbeille du serveur (supprimé sur le webmail) : `/Archives` redevient local, le dossier du serveur reçoit son propre dossier local, et l'archivage suivant crée un nouveau dossier « Archives » à la racine. Il tombe aussi quand, dans une liste reprise de zéro, son ServerId désigne un dossier d'un autre nom (renuméroté) : le dossier « Archives » à la racine est alors lié de nouveau.
- **Noms envoyés au serveur :** un dossier créé ou renommé localement part avec le nom que l'utilisateur lui a donné ; un dossier déplacé garde son nom du serveur, jamais un nom local décoré (« X (2) », « CON_ »).
- **`close()`** : arrête le passage en cours et l'attend, arrête le Ping, écrit le journal. Ensuite l'instance n'écrit plus rien : `run()` rend la main sans passage, `recordIntent()` est refusé (code `CLOSED`). L'arrière-plan l'appelle avant de remplacer le moteur d'une boîte, pour que deux moteurs ne travaillent jamais sur les mêmes enregistrements.

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

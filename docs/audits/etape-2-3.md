# Audit de sécurité — étapes 2 et 3 (comptes, courrier, envoi)

**Périmètre :** tout ce qui s'ajoute à l'étape 1 pour la version 0.1.0.
- `src/experiments/sync443Account/` : comptes marqués, « Dossiers locaux », serveur d'envoi neutre, mots de passe (code privilégié).
- `src/background.mjs`, `src/send.mjs`, `src/options/`, `src/log.mjs` : orchestration, envoi fermé, réglages, journal.
- `src/core/` (MIME, arbre des dossiers, éléments de courrier) et `src/sync/`, `src/tb/` : le moteur de synchro du courrier.
- `tools/build_xpi.py` et `.github/workflows/` : construction et publication.

**Méthode :**
- Deux audits indépendants, par des relecteurs qui n'avaient pas écrit le code :
  - comptes, envoi, réglages et publication ;
  - cœur du courrier et moteur de synchro.
- Un test de bout en bout dans un vrai Thunderbird, contre un faux serveur ActiveSync en TLS, qui a lui aussi trouvé des défauts.
- Six tours de vérification des corrections par un relecteur indépendant : chaque tour rejoue toutes les preuves de concept précédentes et cherche ce que les corrections ont pu casser. Le dernier ne trouve plus ni faille élevée ni faille moyenne.
- Une relecture de propreté avant publication : code mort, branches impossibles, restes, commentaires périmés, doublons.
- Chaque constat a été vérifié avant d'être retenu, presque toujours par une preuve de concept. Chaque correction est couverte par un test qui échoue avant elle et passe après :
  - `tests/unit/audit-engine.test.mjs` (moteur), `background.test.mjs` (arrière-plan), `send.test.mjs` (envoi) ;
  - `tests/e2e/account/` (code privilégié) et `tests/e2e/mail/` (courrier de bout en bout).

**Bilan :**
- Toutes les failles élevées et moyennes trouvées sont corrigées. Les écarts acceptés sont listés à la fin.
- Deux corrections ont conduit à retirer un mécanisme plutôt qu'à en ajouter : les alias de dossiers, et l'attente fixe de 5 secondes après un import.

## Comptes, envoi, réglages, publication

| Gravité | Constat | Correction |
|---|---|---|
| Élevée | Profil sans « Dossiers locaux » : Thunderbird adoptait le compte Sync443 comme ses « Dossiers locaux ». L'extension le perdait, et l'envoi ne passait plus par ActiveSync | Préférence lue directement, jamais par l'accesseur qui adopte ; vrais « Dossiers locaux » créés avant le premier compte ; réparation si la préférence désigne un compte Sync443 |
| Moyenne | Envoi « fermé » contournable : l'utilisateur pouvait retirer ou remplacer le serveur d'envoi neutre de l'identité | `checkSendRoute` avant chaque envoi et au démarrage ; réparation immédiate quand Thunderbird signale un changement (serveur retiré, identité rattachée ailleurs, valeurs du serveur neutre modifiées) |
| Moyenne | Serveur d'envoi neutre joignable par le DNS : un réseau hostile et une autorité d'interception recevaient le message | Serveur neutre sur 127.0.0.1, port 1, TLS exigé, sans authentification |
| Moyenne | Message à chiffrer ou à signer envoyé en clair quand les brouillons ne sont pas chiffrés | Envoi refusé si la signature ou le chiffrement est demandé ; contrôle du type du brouillon en seconde ligne |
| Faible | Fenêtre de rédaction déverrouillée pendant l'envoi ; brouillon lu sans vérifier son compte | Verrou par fenêtre ; identité et dossier du brouillon vérifiés après l'enregistrement |
| Faible | Nom affiché choisi par le serveur refusé par le code privilégié après l'enregistrement du mot de passe | Même règle de caractères partout ; compte préparé avant le mot de passe, tout annulé en cas d'échec |
| Faible | Adresses e-mail dans le journal | Une boîte est désignée par son identifiant |
| Faible | Matériel et code de test dans le paquet publié | Construction : fichiers de test refusés, blocs de test retirés de l'arrière-plan puis vérifiés absents |
| Faible | Empreintes de certificat gardées après un changement de serveur | Oubliées quand l'origine change |
| Faible | Suppression d'un compte : dossier effacé sans vérifier où il se trouve | Fichiers effacés seulement dans le dossier Mail du profil, jamais ceux d'un autre serveur |
| Faible | Serveur neutre devenu serveur d'envoi par défaut de Thunderbird | Jamais désigné par l'extension ; rendu au serveur de l'utilisateur quand il en existe un |
| Faible | Autorisation d'accès au serveur gardée après un enregistrement échoué | Retirée |
| Faible | Deux boîtes de même serveur et même identifiant partageaient un mot de passe enregistré | Refusé |
| Faible | Changement de serveur non atomique ; ajout et suppression de boîtes concurrents | Ancien mot de passe retiré après l'enregistrement seulement ; opérations sur les boîtes en série |
| Faible | Règles de l'identifiant de connexion différentes selon les modules | Alignées sur le code privilégié |
| Renforcement | Politique de sécurité du contenu implicite | Politique explicite dans le manifeste |
| Renforcement | Paquet publié sans moyen de vérification | Empreinte SHA-256 et attestation de provenance signée à chaque publication |

## Moteur du courrier

| Gravité | Constat | Correction |
|---|---|---|
| Élevée | Une chaîne de renommages sur le serveur rattachait deux dossiers du serveur à un seul dossier local ; les suppressions de l'utilisateur étaient perdues | Planification globale des déplacements, noms temporaires enregistrés pour rompre les cycles, jamais deux collections sur un dossier |
| Moyenne | Actions locales perdues lors d'une resynchronisation complète, y compris sur plusieurs passages | Le journal attend la fin de la reconstruction ; rien n'est réimporté de ce que l'utilisateur a supprimé ou déplacé |
| Moyenne | Actions liées aux chemins, réattribués avant d'être rejouées | Actions liées aux identifiants de dossier du serveur, réécrites lors d'une reprise de dossiers |
| Moyenne | Seuil de suppression en masse inopérant au-delà de 5 000 messages | Seuil jugé sur toute la série, plus une fenêtre de 24 heures |
| Moyenne | Disparition de dossiers hors seuil ; liste de dossiers vide acceptée | Disparitions comptées et retenues ; liste sans boîte de réception refusée ; aucun dossier local supprimé définitivement par le serveur |
| Moyenne | « Archiver » supprimait le message sur le serveur | Archives liées à un dossier « Archives » du serveur ; un déplacement vers un dossier purement local ne supprime rien sur le serveur |
| Moyenne | Messages sortis de la période synchronisée : actions de l'utilisateur perdues | Liens gardés à part, actions envoyées |
| Moyenne | Un Message-ID réutilisé détournait une copie locale lors d'une resynchronisation | Rattachement seulement sur preuve (empreinte du message) |
| Moyenne | Journal réécrit en entier à chaque action (coût quadratique) | Journal par morceaux, écritures regroupées |
| Moyenne | Réinitialisation de l'appareil côté serveur : actions en attente perdues, ou envoyées vers un dossier dont le serveur a réutilisé le numéro | Correspondance des dossiers réécrite dans le journal au moment de la reprise ; numéro réutilisé traité comme un nouveau dossier |
| Moyenne | Marques posées par Thunderbird pendant un import prises pour des actions de l'utilisateur | Message importé jugé sur son état une fois les écritures du moteur terminées, sans délai deviné |
| Faible | Message-ID lu différemment par Thunderbird ; copies en double | Identifiant relu après import ; copie en conflit retirée |
| Faible | Noms de dossiers que Thunderbird range sous un autre nom de fichier | Noms limités à 55 caractères, caractères et suffixes réservés traités |
| Faible | Un échec d'import perdait le message | Message redemandé au serveur, échecs affichés dans les réglages |
| Faible | Remplacement du moteur pendant un passage | Arrêt complet de l'ancien moteur avant le nouveau, actions transmises dans l'ordre |
| Faible | Suppressions retenues gardées après un changement de dossier | Abandonnées à chaque réinitialisation |
| Faible | Un dossier « Archives » existant sur le serveur créait des doublons (« Archives (2) ») | Lié dès la première synchro |
| Faible | Fichier de dossier : message non lu enregistré comme lu | Marqué de nouveau après l'import |
| Moyenne | Dossiers renumérotés par le serveur (réinitialisation, migration) : deux dossiers qui échangent leurs numéros mélangeaient leurs copies locales | Sur une liste de dossiers reprise de zéro, chaque dossier est retrouvé d'abord par son emplacement, puis par son numéro |
| Moyenne | Réponse vide du serveur (dossier sans changement, comme Exchange l'envoie) : la reconstruction d'un dossier vide ne se terminait jamais ; actions locales en attente sans fin, dix passages à chaque synchro | La réponse vide termine la reconstruction (jamais pour une première synchro) ; commandes non acquittées gardées |

## Points connus, à corriger dans une version suivante

Trouvés par le dernier tour de vérification ; aucun ne supprime de message.
- **Chaîne de renommages vue lors d'une liste de dossiers reprise de zéro** (« Projets » renommé « Projets 2025 », puis « Projets 2026 » renommé « Projets ») : le dossier local passe au mauvais dossier du serveur, l'autre est retéléchargé. Sans reprise de zéro, le même enchaînement est suivi correctement.
- **Serveur non conforme qui répond vide alors qu'il lui reste des éléments** au milieu d'une reconstruction : une suppression locale en attente peut être considérée comme faite sans avoir été envoyée.
- **Élément redemandé (Fetch) auquel le serveur répond vide :** redemandé à chaque passage.

## Écarts acceptés

- **Authentification « Basic » d'ActiveSync :** le mot de passe accompagne chaque requête. Risque réduit par la connexion vérifiée, la liaison à l'origine et un mot de passe d'application ; il ne se ferme qu'avec une autre authentification côté serveur.
- **Copie cachée (Cci) :** l'en-tête part avec le message vers le serveur, qui le retire (ActiveSync n'a pas d'enveloppe).
- **Mot de passe rangé comme un identifiant HTTP** (domaine « Sync443 ») dans le gestionnaire de Thunderbird.
- **Actions faites quand l'extension ne tourne pas :** non vues.
- **Message déplacé vers un dossier purement local :** reste aussi dans son dossier du serveur, et peut revenir après une resynchronisation complète.
- **Courrier décoché :** la synchro s'arrête, le compte local reste en place.
- **Garde d'import (30 s) :** cas limites documentés dans [SECURITE.md](../SECURITE.md), sans perte.
- **Rattachement par date et expéditeur** quand aucune empreinte n'est disponible : champs contrôlés par l'expéditeur.
- **Accusés de lecture (MDN) :** passeraient par le serveur d'envoi neutre, donc échouent.
- **Autorité privée :** pas encore de réglage pour épingler un certificat.
- **Publication :** la protection des étiquettes `v*` est un réglage du dépôt GitHub.
- **Plateformes :** les tests unitaires tournent sous Windows, macOS et Linux. Les tests de bout en bout n'ont été lancés que sous macOS avec Thunderbird 160 ; Thunderbird 140 ESR reste à vérifier (`THUNDERBIRD=<chemin>`).

# Modèle de sécurité

Ce document décrit ce que Sync443 protège, contre qui, et comment. Il fait foi pour le code : une
règle écrite ici et non respectée par le code est un bug de sécurité.

## Ce qu'il faut protéger

| Bien | Pourquoi c'est sensible |
|---|---|
| Le mot de passe de la boîte | Il ouvre le compte. Avec l'authentification Basic, il accompagne chaque requête. |
| Le contenu des boîtes | Mails, pièces jointes, agendas, contacts, sur le serveur comme dans Thunderbird. |
| La capacité d'envoyer au nom de l'utilisateur | Mails et invitations partent de son adresse. |
| Les autres comptes, agendas et carnets de Thunderbird | L'extension a des droits étendus ; elle ne doit toucher qu'à ce qui est à elle. |
| Thunderbird lui-même | Le code privilégié (API « experiments ») tourne avec tous les droits de Thunderbird. |

## Contre qui

| Attaquant | Ce qu'il contrôle |
|---|---|
| **Le réseau** | Le trafic, y compris un proxy qui déchiffre le HTTPS avec une autorité installée sur l'ordinateur. |
| **Un serveur malveillant ou compromis** | Chaque octet des réponses : structure WBXML, identifiants, noms, règles, demandes d'effacement. |
| **N'importe quel expéditeur** | Le contenu des mails et des invitations, que le serveur relaie tel quel. |
| **Une autre extension ou un programme local** | Ce que Thunderbird et le système lui permettent. |

## Règles

### Mot de passe et transport

1. **Le mot de passe n'est envoyé qu'à l'origine pour laquelle il a été saisi** : schéma, hôte et port.
   - Aucune redirection n'est suivie (`redirect: "error"`).
   - Une réponse 451 « utilisez un autre serveur » est signalée, jamais suivie.
   - Changer le serveur d'une boîte exige de retaper le mot de passe.
2. **HTTPS uniquement**, sans exception, y compris dans les versions de test.
   - L'adresse du serveur est analysée strictement :
     - pas d'identifiants dans l'adresse ;
     - pas de joker ;
     - pas d'écriture détournée de l'adresse locale (`127.1`, `[::ffff:127.0.0.1]`…).
3. **Le certificat est contrôlé avant l'envoi du moindre octet de requête, sur la connexion même qui portera le mot de passe.**
   - L'extension ouvre elle-même chaque connexion : directement, ou à travers le proxy que Thunderbird utiliserait (SOCKS, ou proxy HTTP via un tunnel `CONNECT` ouvert par l'extension). Le chiffrement va toujours de bout en bout jusqu'au serveur.
   - Une fois la négociation TLS terminée, la chaîne de certificats est jugée. Elle n'est acceptée que si elle aboutit à une autorité publique intégrée à Thunderbird, ou à un certificat explicitement approuvé pour ce serveur (empreinte épinglée). En 0.1.0, aucun réglage ne permet encore d'épingler une empreinte : seules les versions de test le font, pour leur faux serveur.
   - Refusée : la connexion est fermée sans qu'aucun octet de requête n'y ait été écrit.
   - Acceptée : la requête est écrite sur cette même connexion. Thunderbird n'intervient pas dans l'échange HTTP, qui est formé et lu par l'extension avec des limites strictes.
   - Un proxy qui déchiffrerait le HTTPS est donc détecté avant d'avoir pu lire quoi que ce soit.
   - Une connexion acceptée seulement grâce à une exception de sécurité ajoutée dans Thunderbird est refusée elle aussi.
   - Les connexions de l'extension sont anonymes : aucun certificat client n'est jamais proposé, et elles ne partagent pas le cache de sessions TLS de Thunderbird.
   - Seuls le serveur et le port configurés sont joignables. Les ports que Thunderbird interdit pour HTTPS sont refusés.
   - Une réponse doit annoncer sa longueur : une connexion coupée par le réseau ne peut pas passer pour une réponse complète.
4. **Les échecs ne s'acharnent pas.**
   - Après un refus du mot de passe, un refus d'accès ou une demande d'effacement, aucune tentative automatique : l'utilisateur doit agir.
   - Un certificat refusé est signalé à l'utilisateur. Rien n'ayant été envoyé, les essais continuent, espacés : un portail captif d'hôtel disparaît de lui-même une fois la connexion ouverte.
   - Les autres erreurs espacent les essais (30 s, 1 min, 2 min… 30 min), ou respectent le délai demandé par le serveur.
5. **Effacement à distance : toujours refusé.**
   - Rien n'est jamais effacé.
   - La synchro s'arrête jusqu'à ce que l'utilisateur la relance.
   - Les règles de sécurité du serveur sont acquittées comme « reçues mais pas appliquées » : l'extension ne prétend pas les respecter.

### Données reçues du serveur

6. **Une seule porte d'entrée.** Chaque réponse passe par un module de validation qui produit des objets typés :
   - identifiants vérifiés (1 à 64 caractères, sans caractère de contrôle) ;
   - textes nettoyés : caractères de contrôle, de sens d'écriture et invisibles retirés des noms ;
   - nombres bornés ;
   - dates au format exact.
   - Un élément invalide est écarté et compté, jamais deviné.
7. **Tout est plafonné.**
   - Taille des réponses, lue en flux et coupée au-delà de la limite.
   - Nombre d'éléments et profondeur du WBXML.
   - Nombre d'éléments par dossier, nombre de dossiers.
   - Un document WBXML incomplet est refusé, jamais appliqué à moitié.
8. **Aucune chaîne venue de l'extérieur ne devient un nom de propriété** d'un objet JavaScript : `Map` partout.
9. **Formats écrits par l'extension, avec échappement systématique** : WBXML (le caractère NUL est refusé), iCalendar, vCard.

### Thunderbird

10. **L'extension ne touche qu'à ce qui est à elle.**
    - Les comptes, agendas et carnets qu'elle crée portent une marque, vérifiée par le code privilégié avant toute opération.
    - Les requêtes d'autres extensions vers le même serveur ne sont jamais interceptées.
11. **Code privilégié minimal.**
    - Seulement les fonctions nécessaires, chacune validant ses arguments et bornant ses ressources (connexions, écritures, mémoire).
    - Elles sont réservées à la page d'arrière-plan. C'est une protection d'appoint : toute page de l'extension peut atteindre l'arrière-plan. Toutes les pages sont donc traitées comme également sensibles : politique de contenu stricte, et jamais de donnée du serveur insérée comme HTML.
    - Aucune fonction de test dans les versions publiées : `tools/build_xpi.py` refuse tout fichier de test et retire de `background.mjs` les blocs marqués `// <test-hooks>`, puis vérifie qu'il n'en reste rien.
12. **Envoi « fermé ».** Si l'extension ne peut pas envoyer un message par ActiveSync, il n'est pas envoyé par un autre chemin.

### Vie privée

13. **Le journal ne contient pas de contenu personnel.**
    - En mode débogage, seules les valeurs techniques (statuts, clés, identifiants) apparaissent.
    - Le moteur de synchro désigne une boîte par son identifiant, un dossier par son ServerId, une modification locale par son numéro : jamais un nom de boîte, une adresse, un nom de dossier, un Message-ID ou un sujet. Une erreur de Thunderbird n'y figure que par son code.
    - Le débogage s'éteint seul.
14. **Aucune télémétrie.** Le seul serveur contacté est le serveur ActiveSync configuré.
15. **Minimisation.** Seuls les éléments que l'utilisateur a choisis pour la boîte (courrier, agenda, contacts, tâches) sont demandés au serveur et stockés dans Thunderbird.

### Intégrité du courrier

16. **Le serveur ne détruit rien d'un coup.**
    - Une liste de dossiers sans boîte de réception est refusée : rien n'est changé.
    - Seuil de suppression en masse : plus de 50 suppressions et plus de 20 % du dossier, comptées sur toute la série de suppressions d'un dossier (même répartie sur plusieurs passages), et sur 24 heures glissantes, que ni une resynchro complète ni la reprise d'un dossier ne remettent à zéro. Au-delà, rien n'est appliqué : la boîte est bloquée jusqu'à ce que l'utilisateur confirme ou refuse.
    - Les dossiers qui disparaissent du serveur sont comptés aussi : par les messages de leurs dossiers locaux, et par leur nombre (au moins trois, et au moins la moitié des dossiers de la boîte, d'un coup).
    - Ce que le serveur supprime va à la corbeille locale. Seuls des messages déjà dans la corbeille locale sont supprimés définitivement, ou une copie que le moteur vient lui-même d'importer en double (jamais le courrier de l'utilisateur) ; un dossier local ne l'est jamais à cause du serveur.
    - Des suppressions retenues sont abandonnées si la table de leur dossier est remise à zéro : elles ne s'appliquent jamais à d'autres copies.
17. **Un Message-ID ne suffit pas à désigner un message.** N'importe quel expéditeur peut reprendre celui d'un autre message.
    - Il est lu strictement ; un message dont le Message-ID se lit de plusieurs façons en reçoit un propre, et ses anciens champs Message-ID sont renommés.
    - Après l'import, c'est le Message-ID lu par Thunderbird qui compte.
    - Un élément du serveur n'est rattaché à une copie locale existante que sur preuve : l'empreinte du contenu connue avant une resynchro complète, ou la date et l'adresse de l'expéditeur. Sinon il est importé à part : il ne prend jamais la place d'un autre message.
    - Pendant une resynchro, seul l'élément à l'empreinte connue reprend un message que l'utilisateur a supprimé ou déplacé ; la suppression ou le déplacement part vers lui, jamais vers un élément qui reprend son Message-ID.
    - Un Message-ID que Thunderbird lit autrement et qu'une autre copie du dossier porte déjà n'est pas lié : le message reçoit un identifiant propre.
18. **Un dossier du serveur, un dossier local.**
    - Jamais deux dossiers du serveur sur un même dossier local, même pendant une suite de renommages faite d'un coup sur le serveur (planifiée, avec un nom temporaire si besoin).
    - Les noms locaux sont tels que Thunderbird range chaque dossier sous son nom ; un nom qui ressemble à un nom réservé à la racine (« Inbox » en lettres d'un autre alphabet) est suffixé.
    - Un dossier spécial est choisi par son type, jamais par son nom ; le dossier des archives est lié par son ServerId.
    - Après une liste des dossiers reprise de zéro (clé refusée, réinitialisation du partenariat), aucun ServerId n'est cru sur parole : chaque table est rapprochée d'abord par sa place (le dossier local que veut un dossier du serveur), puis par son ServerId si ce dossier n'a repris aucune autre table et garde son type. Une table dont le ServerId désigne désormais un autre dossier part ; son dossier local reste, hors synchro. La liste n'est enregistrée qu'une fois ce rapprochement fait.
19. **Une action de l'utilisateur part là où elle a été faite.**
    - Chaque modification locale garde les ServerId des dossiers concernés : elle n'est jamais appliquée à un autre dossier du serveur qui aurait pris le même nom. Après une réinitialisation du partenariat, elle suit le dossier sous son nouveau ServerId ; si ce dossier n'a pu être rapproché, elle ne garde que son dossier local et ne part vers aucun autre.
    - Elle ne quitte le journal qu'après une réponse positive du serveur pour elle, ou un refus définitif (journalisé). Pendant la reconstruction d'un dossier, elle attend : jamais réglée sans rien envoyer.
    - Un message sorti de la période garde son lien, même après une resynchro complète : ce que l'utilisateur en fait part au serveur.
    - Un message déplacé vers un dossier purement local n'est jamais supprimé sur le serveur.
    - Les drapeaux que Thunderbird pose lui-même à l'import ne repartent pas vers le serveur : un message importé est jugé sur son état une fois les écritures du moteur finies, si bien qu'un changement de l'utilisateur n'est jamais pris pour l'une de ces marques, ni avalé.

## Limite connue, risque accepté

**L'authentification Basic** est une limite du protocole tel que la plupart des serveurs le proposent. Le risque résiduel est réduit par trois mesures :
- un identifiant dédié, à périmètre restreint et révocable : un mot de passe d'application limité à ActiveSync, côté serveur ;
- le transport TLS strict (règles 2 et 3) ;
- la liaison à l'origine (règle 1).

**Linux avec les autorités du système (p11-kit) :** sur certaines distributions, Thunderbird lit les autorités de certification du système à la place des siennes. Il faut alors vérifier qu'une autorité ajoutée localement n'y est pas présentée comme « intégrée » ; c'est un point à contrôler sur ces distributions.

**Écarts acceptés du courrier** (rien n'est perdu, mais Thunderbird et le serveur peuvent différer) :
- un message déplacé vers un dossier purement local reste aussi dans son dossier du serveur ; une resynchro complète de ce dossier peut le faire réapparaître ;
- ce que l'utilisateur fait pendant que l'extension ne tourne pas n'est pas vu ;
- sous Windows, un nom de dossier avec des caractères hors de la page de code du système peut être rangé par Thunderbird sous un nom de fichier haché : le moteur compare les noms des dossiers, pas leurs chemins, mais ce cas n'est vérifié que par les tests unitaires ;
- un message tout juste importé est suivi 30 s par une garde. Dans ces 30 s : un message de même Message-ID déplacé dans ce dossier partage la garde ; un changement fait par l'utilisateur pendant l'import lui-même est défait par le moteur (le message garde l'état du serveur) ; les événements d'un import lent attendent sa fin. Après 30 s, une marque de Thunderbird arrivée très en retard serait prise pour un changement de l'utilisateur et renverrait au serveur l'état qu'il a déjà ;
- après une liste des dossiers reprise de zéro, les dossiers sont rapprochés par leur place, puis par leur ServerId : un dossier renommé ou déplacé au moment même où le serveur renumérote ses dossiers est retéléchargé (l'ancien dossier local reste hors synchro, ou va à la corbeille s'il a disparu) ; un nouveau dossier créé à la place d'un dossier renommé reprend le dossier local (ses messages y restent en copies locales) et le dossier renommé est retéléchargé ; deux dossiers qui échangent leurs ServerId et sont tous deux renommés ou déplacés à ce moment-là, ou deux dossiers qui échangent leurs noms à ce moment-là (rien ne les distingue de ServerId échangés), peuvent mêler leurs copies locales ;
- pendant l'étape des dossiers locaux, les événements locaux attendent en mémoire : un appel de Thunderbird sur les dossiers qui ne rendrait jamais la main les retiendrait (rien n'est perdu tant que Thunderbird tourne) ;
- hors resynchro complète, un élément du serveur est rattaché à une copie locale qu'aucun élément ne tient si la date et l'adresse de l'expéditeur concordent (cas d'un lot rejoué après un arrêt). Ces deux champs sont choisis par l'expéditeur : celui qui reprendrait le Message-ID, la date et l'expéditeur d'un message que l'utilisateur a copié lui-même dans ce dossier ferait passer son élément pour cette copie, et ne serait pas affiché à part. Les copies que le moteur a reliées (y compris hors période) ne sont jamais concernées.

**Proxy d'entreprise exigeant sa propre authentification :** pas encore pris en charge. L'extension le signale et n'envoie rien plutôt que de passer par un chemin dont elle ne contrôlerait pas le certificat.

Le constat ne se fermera complètement qu'avec une authentification plus forte prise en charge par le serveur (OAuth2, certificat client).

## Vérifications

- **Tests :** chaque règle a ses tests unitaires (`tools/unit_tests.py`), y compris des tests aléatoires du décodeur WBXML.
- **Audit à chaque étape :** un audit de sécurité indépendant clôt chaque étape de développement. Chaque constat est vérifié, corrigé et couvert par un test (pour le moteur de courrier : `tests/unit/audit-engine.test.mjs`, un ou plusieurs tests par constat).
- **Code source :** aucun caractère invisible ou bidirectionnel n'y est accepté (`tools/check_source_chars.py`).
- **Provenance :** aucune ligne n'est reprise d'un projet tiers (`tools/provenance_check.py`).

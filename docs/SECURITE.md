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
   - Une fois la négociation TLS terminée, la chaîne de certificats est jugée. Elle n'est acceptée que si elle aboutit à une autorité publique intégrée à Thunderbird, ou à un certificat que l'utilisateur a explicitement approuvé pour ce serveur (autorité privée).
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
    - Aucune fonction de test dans les versions publiées.
12. **Envoi « fermé ».** Si l'extension ne peut pas envoyer un message par ActiveSync, il n'est pas envoyé par un autre chemin.

### Vie privée

13. **Le journal ne contient pas de contenu personnel.**
    - En mode débogage, seules les valeurs techniques (statuts, clés, identifiants) apparaissent.
    - Le débogage s'éteint seul.
14. **Aucune télémétrie.** Le seul serveur contacté est le serveur ActiveSync configuré.

## Limite connue, risque accepté

**L'authentification Basic** est une limite du protocole tel que la plupart des serveurs le proposent. Le risque résiduel est réduit par trois mesures :
- un identifiant dédié, à périmètre restreint et révocable : un mot de passe d'application limité à ActiveSync, côté serveur ;
- le transport TLS strict (règles 2 et 3) ;
- la liaison à l'origine (règle 1).

**Linux avec les autorités du système (p11-kit) :** sur certaines distributions, Thunderbird lit les autorités de certification du système à la place des siennes. Il faut alors vérifier qu'une autorité ajoutée localement n'y est pas présentée comme « intégrée » ; c'est un point à contrôler sur ces distributions.

**Proxy d'entreprise exigeant sa propre authentification :** pas encore pris en charge. L'extension le signale et n'envoie rien plutôt que de passer par un chemin dont elle ne contrôlerait pas le certificat.

Le constat ne se fermera complètement qu'avec une authentification plus forte prise en charge par le serveur (OAuth2, certificat client).

## Vérifications

- **Tests :** chaque règle a ses tests unitaires (`tools/unit-tests.sh`), y compris des tests aléatoires du décodeur WBXML.
- **Audit à chaque étape :** un audit de sécurité indépendant clôt chaque étape de développement. Chaque constat est vérifié, corrigé et couvert par un test.
- **Code source :** aucun caractère invisible ou bidirectionnel n'y est accepté (`tools/check_source_chars.py`).
- **Provenance :** aucune ligne n'est reprise d'un projet tiers (`tools/provenance_check.py`).

# Architecture et avancement

## Objectifs

1. **Sécurité** : voir [SECURITE.md](SECURITE.md). Chaque règle de ce document est garantie par construction et couverte par des tests.
2. **Intégrité** : ne jamais perdre ni détruire une donnée par erreur, ni sur le serveur ni dans Thunderbird.
3. **Code propre à ce projet**, sous licence MIT, écrit à partir des spécifications publiques. Aucune ligne n'est reprise d'un autre projet.
4. **Généricité** : tout serveur Exchange ActiveSync 14.x. L'authentification est conçue pour accueillir OAuth2 plus tard.
5. **Sobriété** : des synchros proportionnelles aux changements, et aucun travail pour ce qui n'appartient pas à l'extension.
6. **Cohabitation** : aucune interférence avec d'autres extensions, y compris d'autres clients ActiveSync.
   - noms d'API privilégiées propres ;
   - identifiant d'appareil propre à chaque boîte ;
   - requêtes des autres extensions jamais interceptées.

7. **Tous les systèmes** : Windows, macOS et Linux.
   - Le code de l'extension n'utilise que des API de Thunderbird, identiques partout ; le proxy est détecté selon les réglages de chaque système.
   - Ce qui dépend du système est traité explicitement : noms de dossiers (caractères et noms réservés de Windows, comme `CON` ou `NUL`, casse ignorée par macOS et Windows), fins de ligne (LF imposé dans le dépôt).
   - L'outillage de développement (tests, contrôles) tourne sur les trois systèmes.

Thunderbird 140 ESR minimum.

## Organisation du code

```
src/
  background.mjs          orchestration : boîtes, moteurs, minuteries, menus, bouton
  send.mjs                envoi fermé : un message d'un compte Sync443 part par ActiveSync ou pas du tout
  log.mjs                 journal de diagnostic (sans contenu personnel), débogage limité à une heure ; en français
  i18n.mjs                textes de l'interface (browser.i18n) ; échecs du moteur affichés selon leur code
  _locales/               traductions : les dix langues les plus employées dans Thunderbird, en par défaut
  core/                   sans Thunderbird : testable seul
    utf8.mjs, base64.mjs  encodages, sans dépendance
    codepages.mjs         tables WBXML d'ActiveSync [MS-ASWBXML]
    wbxml.mjs             codec WBXML plafonné, document complet obligatoire
    sanitize.mjs          la porte unique des valeurs venues de l'extérieur
    server.mjs            adresse du serveur, analyse stricte
    protocol.mjs          requêtes construites à partir de valeurs vérifiées, réponses lues en objets validés
    tls-policy.mjs        décision : ce certificat peut-il porter le mot de passe ?
    http1.mjs             requête HTTP/1.1 formée et réponse lue par l'extension, limites strictes
    backoff.mjs           espacement des essais
    sha256.mjs            empreintes (Message-ID synthétiques, empreintes de messages)
    mime.mjs              en-têtes : Message-ID strict, en-têtes internes retirés, brouillon nettoyé avant envoi
    mail-codec.mjs        éléments de courrier ActiveSync lus en objets validés
    folder-tree.mjs       arbre des dossiers du serveur → chemins locaux valables sur tous les systèmes
    ical.mjs, vcard.mjs, recurrence.mjs, timezones.mjs   (étapes suivantes)
  transport/
    client.mjs            ActiveSync sur connexion vérifiée : certificat jugé avant toute écriture, erreurs typées
  sync/
    store.mjs             stockage versionné, enregistrements en Map
    health.mjs            blocage après erreur grave, espacement des essais
    mailbox.mjs           une boîte : dossiers, ordre des collections, seuils, arrêt propre
    mail.mjs              une collection de courrier : réception, envoi des changements, reconstruction
    journal.mjs           actions locales en attente, acquittées une à une, stockées par morceaux
    echo.mjs              écritures de l'extension reconnues, pour ne pas les renvoyer au serveur
    push.mjs              arrivée immédiate (Ping)
    calendar.mjs, contacts.mjs   (étapes suivantes)
  tb/
    mail-store.mjs        écritures dans le compte Thunderbird de la boîte, et seulement lui
    events.mjs            actions de l'utilisateur dans Thunderbird → intentions pour le journal
  experiments/
    sync443Net/           connexion vérifiée : TCP direct ou via le proxy, TLS, informations de certificat,
                          puis seulement écriture et lecture d'octets
    sync443Account/       comptes marqués, « Dossiers locaux » protégés, serveur d'envoi neutre,
                          mots de passe (gestionnaire de Thunderbird)
  options/                page de réglages
tests/unit/               tests unitaires et aléatoires (JavaScriptCore ou Node)
tests/e2e/                bout en bout dans un vrai Thunderbird : net (connexion), account (comptes), mail (courrier)
tools/                    lanceur de tests (tout système), contrôles du code source et de provenance, construction du .xpi
```

## Choix des éléments synchronisés

Pour chaque boîte, l'utilisateur choisit ce qui est synchronisé : **courrier, agenda, contacts,
tâches**. Un seul, plusieurs ou les quatre ; il en faut au moins un.

| Comportement | Détail |
|---|---|
| Par défaut | les quatre |
| Ce qui n'est pas choisi | jamais demandé au serveur, ni stocké dans Thunderbird ; les dossiers correspondants sont ignorés à la liste des dossiers, et absents de la surveillance « dès réception » (Ping) |
| Ajouter un élément | création de ce qu'il faut dans Thunderbird, puis première synchro de cet élément |
| Retirer un élément | la synchro de cet élément s'arrête aussitôt, et les actions locales sur ses copies ne sont plus enregistrées. Prévu à l'étape 6 : après confirmation, les copies locales sont supprimées (agendas, carnets, ou compte de courrier). Rien n'est jamais touché sur le serveur. En 0.1.0, les copies locales du courrier restent en place |
| Agenda sans courrier | à trancher à l'étape 4. Pour envoyer des invitations, Thunderbird a besoin d'une identité de messagerie, donc d'un compte : soit un compte minimal sans dossier synchronisé, soit agenda sans envoi d'invitations |

Le modèle est en place depuis l'étape 1 (`sync` dans `src/sync/store.mjs`, validé et testé pour
les 15 combinaisons). La page de réglages le présente sous forme de cases à cocher depuis la
0.1.0, et chaque étape de synchro le respecte : en 0.1.0, seul le courrier est synchronisé.

## Étapes

| Étape | Contenu | État |
|---|---|---|
| **1. Fondations** | WBXML, validation, protocole, connexion vérifiée, HTTP/1.1, client ActiveSync, stockage, espacement des essais | **terminée** : 321 tests unitaires, 191 vérifications de bout en bout dans Thunderbird, [audit](audits/etape-1.md) fait et corrigé |
| **2. Code privilégié** | comptes marqués, « Dossiers locaux » protégés, serveur d'envoi neutre, mots de passe, identité | **terminée** (API agenda reportée à l'étape 4) : 335 vérifications de bout en bout dans Thunderbird |
| **3. Courrier** | identité des messages par Message-ID et empreinte, suppressions avec filet, seuil de suppression en masse, verrou par boîte, journal des modifications acquittées, envoi fermé, archives ; noms de dossiers valables sur Windows, macOS et Linux | **terminée** : 703 tests unitaires, 150 vérifications de bout en bout du courrier dans Thunderbird, [audit](audits/etape-2-3.md) fait et corrigé ; publiée en 0.1.0 |
| **4. Agenda et tâches** | iCalendar écrit par l'extension, récurrence bornée, fuseaux, invitations confirmées | à faire |
| **5. Contacts** | vCard écrit par l'extension, carnets marqués | à faire |
| **6. Finition** | assistant, réglages avancés (dont l'épinglage d'une autorité privée), suppression des copies locales d'un élément décoché, validation sur serveurs réels | à faire (page de réglages, cases à cocher et journal livrés dès la 0.1.0) |

## Méthode, à chaque étape

1. **Écriture en parallèle**, chaque fichier ayant un seul auteur à la fois.
2. **Tests unitaires et aléatoires** ; tests de bout en bout dès qu'il y a une extension à charger.
3. **Audit de sécurité indépendant** par des relecteurs qui n'ont pas écrit le code. Chaque constat est vérifié, corrigé, puis couvert par un test.
4. **Contrôles automatiques** : caractères invisibles refusés, provenance du code vérifiée.
5. **Avant chaque publication** : recherche de secrets, relecture des documents.

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
  background.mjs          orchestration : boîtes, files, minuteries, menus, bouton
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
    ical.mjs, vcard.mjs, recurrence.mjs, timezones.mjs, mime.mjs   (étapes suivantes)
  transport/
    client.mjs            ActiveSync sur connexion vérifiée : certificat jugé avant toute écriture, erreurs typées
  sync/
    store.mjs             stockage versionné, enregistrements en Map
    health.mjs            blocage après erreur grave, espacement des essais
    mailbox.mjs, journal.mjs, mail.mjs, folders.mjs, calendar.mjs, contacts.mjs   (étapes suivantes)
  experiments/
    sync443Net/           connexion vérifiée : TCP direct ou via le proxy, TLS, informations de certificat,
                          puis seulement écriture et lecture d'octets
                          (comptes, mots de passe et agenda : étape 2)
  options/                page de réglages (étape 6)
tests/unit/               tests unitaires et aléatoires (JavaScriptCore)
tools/                    lanceur de tests (tout système), contrôles du code source et de provenance
```

## Étapes

| Étape | Contenu | État |
|---|---|---|
| **1. Fondations** | WBXML, validation, protocole, connexion vérifiée, HTTP/1.1, client ActiveSync, stockage, espacement des essais | **terminée** : 321 tests unitaires, 191 vérifications de bout en bout dans Thunderbird, [audit](audits/etape-1.md) fait et corrigé |
| **2. Code privilégié** | comptes marqués, mots de passe, identité ; API agenda minimale | à faire |
| **3. Courrier** | identité des messages par Message-ID, suppressions avec filet, seuil de suppression en masse, verrou par boîte, journal des modifications acquittées, envoi fermé ; noms de dossiers valables sur Windows, macOS et Linux | à faire |
| **4. Agenda et tâches** | iCalendar écrit par l'extension, récurrence bornée, fuseaux, invitations confirmées | à faire |
| **5. Contacts** | vCard écrit par l'extension, carnets marqués | à faire |
| **6. Finition** | page de réglages, journal, documentation, validation sur serveurs réels | à faire |

## Méthode, à chaque étape

1. **Écriture en parallèle**, chaque fichier ayant un seul auteur à la fois.
2. **Tests unitaires et aléatoires** ; tests de bout en bout dès qu'il y a une extension à charger.
3. **Audit de sécurité indépendant** par des relecteurs qui n'ont pas écrit le code. Chaque constat est vérifié, corrigé, puis couvert par un test.
4. **Contrôles automatiques** : caractères invisibles refusés, provenance du code vérifiée.
5. **Avant chaque publication** : recherche de secrets, relecture des documents.

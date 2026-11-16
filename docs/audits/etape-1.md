# Audit de sécurité — étape 1 (fondations)

**Périmètre :** le code de l'étape 1, c'est-à-dire tout ce qui transporte le mot de passe et lit les réponses du serveur.
- `src/core/` : WBXML, validation, protocole, adresse du serveur, politique de certificat, HTTP/1.1, espacement des essais.
- `src/transport/client.mjs` : client ActiveSync.
- `src/experiments/sync443Net/` : connexion vérifiée, code privilégié.
- `src/sync/` : stockage, santé des boîtes.

**Méthode :**
- Quatre relectures indépendantes, par des relecteurs qui n'avaient pas écrit le code :
  - le cœur ;
  - le premier transport ;
  - HTTP/1.1 et le client ;
  - le module privilégié.
- Chaque constat a été vérifié avant d'être retenu, la plupart par une preuve de concept.
- Les auteurs des tests ont aussi relevé des défauts.
- Chaque correction est couverte par un test de non-régression : `tests/unit/audit-*.test.mjs`, et `tests/e2e/net/` pour le module privilégié.

**Bilan :**
- Toutes les failles trouvées sont corrigées.
- La plus grave a conduit à changer de conception : le certificat n'était contrôlé qu'après l'envoi du mot de passe.

## Le changement de conception

**Première conception :**
- La pile HTTP de Thunderbird transportait les requêtes, et l'extension inspectait le certificat avec `webRequest`.
- L'audit a démontré qu'une extension ne voit le certificat qu'à l'arrivée de la réponse, donc **après** l'écriture de la requête et de son mot de passe.
- Une requête préalable sans mot de passe ne protège que sa propre connexion. Un intercepteur qui la laisse passer peut capturer le mot de passe sur la connexion suivante ; le relecteur l'a fait.

**Conception retenue :**
- L'extension ouvre elle-même chaque connexion, directement ou à travers le proxy du système (SOCKS, ou tunnel `CONNECT` pour un proxy HTTP).
- Elle attend la fin de la négociation TLS et juge la chaîne de certificats.
- Elle n'écrit la requête que sur cette même connexion, et seulement si la chaîne est acceptée.
- Le test de bout en bout dans un vrai Thunderbird le prouve : 164 vérifications, en direct, à travers un proxy HTTP et à travers un proxy SOCKS, en TLS 1.2 et 1.3. Sur toute connexion refusée, le serveur reçoit **zéro octet** de requête.

## Constats et corrections

| Gravité | Constat | Correction |
|---|---|---|
| Élevée | Certificat contrôlé après l'envoi du mot de passe (pile HTTP de Thunderbird) | Connexion vérifiée ouverte par l'extension (voir ci-dessus) |
| Moyenne | Adresse IPv6 non canonique : le contrôle du certificat ne reconnaissait pas le serveur et laissait passer | Adresses IPv6 écrites sous forme canonique, comme Thunderbird ; contrôle de cohérence avec son analyseur d'URL |
| Moyenne | Décodeur WBXML : les morceaux de texte n'étaient pas comptés dans les limites (plus d'1 Go de mémoire à partir de 16 Mo) | Morceaux comptés comme des éléments, morceaux vides ignorés, valeurs copiées |
| Moyenne | Module privilégié : écritures empilées sans limite, mémoire de Thunderbird épuisable | Une écriture à la fois par connexion, 1 Mio au plus par écriture, découpage côté client |
| Moyenne | Contournement du contrôle de certificat lors d'une négociation directe des règles du serveur | Contrôle avant toute requête, quel que soit le chemin |
| Moyenne | Hôte de connexion non lié à l'origine déclarée : le mot de passe pouvait partir vers un autre hôte | Hôte et port vérifiés contre l'origine, puis figés |
| Faible | Refus de la machine locale contournable (`127.1`, `0x7f.0.0.1`, `[::ffff:127.0.0.1]`, alias `localhost.localdomain`…) | Analyse stricte des adresses ; alias locaux connus refusés |
| Faible | Nom d'émetteur d'un certificat intercepteur affiché tel quel | Nom nettoyé, présenté comme falsifiable ; épinglage limité au certificat du serveur ou à la racine |
| Faible | Noms de dossiers : caractères invisibles, de remplissage, empilés | Normalisation NFC, suppression des caractères invisibles, refus des noms sans caractère visible |
| Faible | Nom de dossier réécrit en silence avant envoi au serveur | Refusé au lieu d'être réécrit |
| Faible | Réponses du protocole : éléments invalides gardés, doublons, listes sans plafond | Écartés et comptés, doublons refusés, plafonds |
| Faible | Journal de débogage : caractères de contrôle et de sens d'écriture venus du serveur | Neutralisés |
| Faible | Réponse coupée par le réseau prise pour une réponse vide (un succès) | Plus de `Connection: close` ; toute réponse doit annoncer sa longueur |
| Faible | Après l'envoi, une erreur TLS se présentait comme « certificat refusé, rien n'a été envoyé » | Indicateur `sent` ; erreur requalifiée |
| Faible | Envoi non borné dans le temps | Échéance commune à tout l'échange |
| Faible | Conditions passagères traitées comme fatales (trop de connexions, délais non entiers) | Requalifiées, délais entiers |
| Faible | Annulation perdue pendant l'ouverture de connexion, ou après la dernière lecture | Prise en compte à chaque étape |
| Faible | Tout port du serveur autorisé joignable, y compris ceux que Thunderbird interdit | Ports interdits refusés |
| Faible | Un serveur pouvait déclencher le sélecteur de certificat client de Thunderbird | Connexions anonymes |
| Faible | Suppression d'une boîte pendant une écriture : données laissées derrière elle | Écriture et index sous un même verrou, écritures refusées après suppression, nettoyage au démarrage |
| Faible | Délais d'espacement non numériques possibles | Délai toujours fini, entre 1 s et un jour |
| Info | Règles du serveur acquittées comme appliquées | Acquittées comme non appliquées (statut 3) |
| Info | Caractères invisibles dans le code source (« Trojan Source ») | Retirés ; `tools/check_source_chars.py` les refuse désormais |

## Points connus, non corrigés à ce stade

- **Toute page de l'extension peut atteindre l'arrière-plan,** donc le module privilégié. La restriction à l'arrière-plan est une protection d'appoint : toutes les pages sont traitées comme également sensibles.
- **Proxy exigeant sa propre authentification :** non pris en charge. L'extension le signale et n'envoie rien.
- **Linux avec les autorités du système (p11-kit) :** comportement de « racine intégrée » à vérifier sur ces distributions.
- **Thunderbird 140 ESR :** vérifié depuis, sur 140.17.0 ESR. Un certificat refusé y était signalé comme une connexion interrompue (connexion bien refusée, message trompeur) ; corrigé, voir [l'audit des étapes 2 et 3](etape-2-3.md#thunderbird-140-esr).

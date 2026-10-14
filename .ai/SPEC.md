# SPEC — MCP Paperless accessible de partout, derrière le SSO

Statut : **validée le 2026-10-14** (réponses de Sébastien aux questions 1–8). Ne pas modifier sans son accord.

Référence côté SSO : `offshore-auth`, branche `MCP-auth`, fichier `.ai/SPEC-MCP-PAPERLESS.md`
(contrat détaillé : métadonnées, format du 401, validation du JWT). Cette SPEC le reprend
et ajoute le déploiement et les critères d'acceptation.

## 1. Objectif

Sébastien utilise le MCP Paperless depuis claude.ai web, l'app mobile, Claude Desktop et
Claude Code sur son PC. Le serveur tourne sur le VPS (Coolify), à l'adresse publique
`https://paperless-mcp.offshoreservices.fr/mcp`. En v1, seul Sébastien y a accès :
compte SSO `auth.offshoreservices.fr` avec le rôle `paperless`.

## 2. Périmètre

Dans le périmètre :
- Transport HTTP (`/mcp`, `/sse`, `/messages`) protégé par OAuth 2.0 (ressource protégée, RFC 9728).
- Validation locale du JWT émis par offshore-auth (JWKS, EdDSA, `typ: at+jwt`).
- Appels à Paperless avec le jeton du compte Paperless « claude » (lecture seule), jamais avec le jeton du client.
- Déploiement par Coolify depuis le `Dockerfile` du fork, branche `main`, TLS par Traefik.
- Lecture des gros documents par morceaux (`get_document_content` avec `offset` / `max_length`).
- Fonctions de la branche `feat/import-workflow-tools`, qui devient le `main` du fork.

Hors périmètre (plus tard) :
- Autres utilisateurs et droits Paperless par utilisateur (tous les utilisateurs SSO verraient ce que voit le compte « claude »).
- Restriction des outils d'écriture selon `app_role`.
- Chatbot pour les techniciens.
- Toute PR vers `baruchiro/paperless-mcp`.

## 3. Règles du fork

- Les PR visent toujours `SebastienBelmon/paperless-mcp`, jamais `baruchiro/paperless-mcp`.
- Le dépôt GitHub par défaut de `gh` est le fork (`gh repo set-default SebastienBelmon/paperless-mcp`).
- Les workflows d'upstream qui publient (`release.yml` : npm et image Docker ; `stale.yml`) ne tournent pas sur le fork.
- `.ai/todo.md` n'est jamais commité.

## 4. Configuration

| Variable | Valeur en production | Secret |
|---|---|---|
| `PAPERLESS_URL` | URL publique HTTPS de Paperless (voir DECISIONS.md) | non |
| `PAPERLESS_API_KEY` | Jeton du compte Paperless « claude » | **oui** |
| `PAPERLESS_PUBLIC_URL` | URL publique de Paperless (liens dans les réponses) | non |
| `OAUTH_ISSUER` | `https://auth.offshoreservices.fr/api/auth` | non |
| `OAUTH_JWKS_URL` | `https://auth.offshoreservices.fr/api/auth/jwks` | non |
| `MCP_RESOURCE` | `https://paperless-mcp.offshoreservices.fr/mcp` | non |

`MCP_RESOURCE` est identique, caractère pour caractère, à l'entrée `OAUTH_RESOURCES`
d'offshore-auth et à l'URL saisie dans les clients.

## 5. Clients

| Client | Comment il se connecte | Client OAuth dans offshore-auth |
|---|---|---|
| claude.ai web, mobile, Claude Desktop | Connecteur personnalisé ajouté une fois dans claude.ai, partagé par les trois | « Claude (Paperless) », redirect `https://claude.ai/api/mcp/auth_callback` |
| Claude Code (PC) | `claude mcp add --transport http --client-id <id> --client-secret --callback-port <port> paperless https://paperless-mcp.offshoreservices.fr/mcp` | Second client, redirect `http://localhost:<port>/callback` |

offshore-auth n'a pas d'enregistrement dynamique (DCR) : Claude Code doit utiliser un
client pré-enregistré. Le second client est du travail côté offshore-auth, hors de ce dépôt.

## 6. Comportement attendu

1. Le mode HTTP ne démarre pas sans les 5 variables `PAPERLESS_URL`, `PAPERLESS_API_KEY`,
   `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, `MCP_RESOURCE` (code de sortie 1, message clair).
2. `GET /.well-known/oauth-protected-resource` et `GET /.well-known/oauth-protected-resource/mcp`
   répondent sans authentification avec le document RFC 9728.
3. Toute requête sur `/mcp`, `/sse`, `/messages` sans JWT valide reçoit
   `401` + `WWW-Authenticate: Bearer resource_metadata="<origine>/.well-known/oauth-protected-resource/mcp"`.
4. Un JWT valide = signature EdDSA du JWKS, `iss` = `OAUTH_ISSUER`, `aud` contient
   `MCP_RESOURCE`, `typ` = `at+jwt`, non expiré (tolérance 30 s).
5. Le jeton du client n'est jamais transmis à Paperless ni écrit dans les logs.
   Les logs contiennent `sub`, `client_id`, `jti`.
6. Le mode stdio ne change pas (jeton Paperless en argument ou variable d'environnement).
7. Le flag `--no-auth` et le jeton Paperless en `Bearer` n'existent plus en HTTP.

## 7. Critères d'acceptation

### A. Tests e2e automatisés

Lieu : GitHub Actions du fork (`.github/workflows/e2e.yml`), Paperless 2.x et 3.x en Docker,
modes CLI et Docker. Le test crée sa propre paire de clés EdDSA, sert un JWKS local et signe
ses JWT (émetteur de test). Aucun mode « auth de test » dans le serveur.

| # | Critère | Attendu |
|---|---|---|
| A1 | `GET /.well-known/oauth-protected-resource/mcp` et `/.well-known/oauth-protected-resource` | 200, JSON avec `resource`, `authorization_servers`, `scopes_supported` contenant `openid` et `offline_access` |
| A2 | `POST /mcp` sans en-tête `Authorization` | 401 + `WWW-Authenticate` exact du §6.3 |
| A3 | `POST /mcp` avec un jeton opaque ou un jeton d'API Paperless | 401 |
| A4 | `POST /mcp` avec un JWT d'une autre audience | 401 |
| A5 | `POST /mcp` avec un JWT expiré | 401 |
| A6 | `POST /mcp` avec un JWT d'un autre émetteur ou signé par une autre clé | 401 |
| A7 | `POST /mcp` avec un JWT `HS256` ou `alg: none` | 401 |
| A8 | Client MCP avec un JWT valide : `tools/list` | succès, contient `get_document_content` |
| A9 | Avec un JWT valide : scénario e2e actuel (création, liste, recherche, téléchargement, champs perso, règles mail) | tous les tests passent |
| A10 | `get_document_content` avec `offset` et `max_length` sur un document | renvoie le bon morceau et la longueur totale |
| A11 | `/sse` sans jeton | 401 |
| A12 | Démarrage HTTP sans `OAUTH_ISSUER` (ou `OAUTH_JWKS_URL`, ou `MCP_RESOURCE`) | sortie code 1 |
| A13 | Logs du serveur après A8 | contiennent `sub=` et `jti=`, ne contiennent pas le JWT |

Les jobs `CI` (tests unitaires) et `E2E Tests` sont verts sur la branche. Le build Docker réussit.

### B. Recette en production (manuelle, après accord de déploiement)

| # | Critère | Attendu |
|---|---|---|
| B1 | `curl https://paperless-mcp.offshoreservices.fr/.well-known/oauth-protected-resource/mcp` | 200, document du §6.2, en moins de 10 s |
| B2 | `curl -X POST https://paperless-mcp.offshoreservices.fr/mcp` | 401 + `WWW-Authenticate` |
| B3 | claude.ai web : ajout du connecteur, connexion SSO avec le compte de Sébastien | connecteur actif, outils visibles |
| B4 | claude.ai web : « liste mes 5 derniers documents » puis lecture par morceaux d'un gros manuel | réponses correctes |
| B5 | claude.ai mobile et Claude Desktop (même compte claude.ai) | mêmes outils, même résultat que B4 |
| B6 | Claude Code : `claude mcp add …` (§5), connexion SSO, même demande que B4 | même résultat que B4 |
| B7 | Une heure après B3 et B6 | l'appel suivant marche sans nouvelle connexion (refresh token) |
| B8 | Outil d'écriture (ex. `create_tag`) | erreur, rien n'est créé dans Paperless |
| B9 | Compte SSO sans rôle `paperless` | accès refusé par le SSO, aucun outil disponible |
| B10 | Désactivation des clients OAuth dans offshore-auth | plus d'accès (plan de retour arrière) |

## 8. Définition de « fini »

Tous les critères A1–A13 sont verts dans GitHub Actions du fork, et la recette B1–B10 est
faite après accord de déploiement.

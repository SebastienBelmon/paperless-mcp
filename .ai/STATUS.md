# STATUS

Dernière mise à jour : 2026-10-14

## État

- SPEC validée le 2026-10-14 (`.ai/SPEC.md`).
- `main` du fork = upstream `54b0bc5` + PR #1 du fork (`e6deec8`, squash) : lecture par morceaux,
  `fields`, doublons, tâches, workflows, chemins de fichiers, permissions des tags,
  **mode HTTP protégé par OAuth** et e2e avec émetteur JWT de test.
- Critères A1–A13 : verts dans GitHub Actions (PR #1, Paperless 2.x et 3.x), et en local.
- SSO : PR #12 et #13 d'offshore-auth fusionnées et déployées le 2026-10-14 (JWT pour la ressource MCP,
  redirect `http://localhost` acceptée, `client_secret_post` accepté, log `[oauth] … refusé`).
  Un seul client `paperless` pour claude.ai et Claude Code (port de retour 31418).
- GitHub : fork public, lié à baruchiro, aucune PR chez baruchiro. Workflows actifs : `ci.yml`, `e2e.yml`.
  Désactivés : `release.yml`, `docker-publish.yml`, `stale.yml`. `gh` vise le fork par défaut.
- Prod : `https://paperless-mcp.offshoreservices.fr` en ligne (Coolify, `main` du fork). B1 et B2 OK le 2026-10-14.

## Recette B (SPEC §7.B)

| # | État |
|---|---|
| B1, B2 | OK le 2026-10-14 |
| B3 | OK : connecteur claude.ai actif après la PR offshore-auth #13 |
| B7 | OK côté claude.ai : appel réussi plus d'1 h après la connexion, sans nouvelle connexion |
| B4, B5, B6, B8, B9, B10 | Pas encore confirmés par Sébastien |

## Connu, non corrigé

- Un 2e `npm run build` échoue (TS5055) : `tsconfig.json` n'exclut pas `build/`. Faire `rm -rf build` en local.
- `docker-compose.e2e.yml` utilise Paperless 2.14.7, refusé par l'API v9 (HTTP 406). Tester en local avec 2.20.
- SSO : la page `/consent` ne vérifie pas le rôle `paperless` (risque faible : `/oauth2/token` refuse avec `no_app_access`).

## À faire (ordre)

1. Finir la recette : B4 (gros manuel par morceaux), B5 (mobile, Desktop), B6 et B7 (Claude Code),
   B8 (écriture refusée), B9 (compte sans rôle), B10 (désactivation du client).
2. Ensuite : base du chatbot pour les techniciens (consulter les manuels depuis le téléphone).

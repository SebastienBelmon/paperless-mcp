# STATUS

Dernière mise à jour : 2026-10-14

## État

- SPEC validée le 2026-10-14 (`.ai/SPEC.md`).
- `main` du fork = upstream `54b0bc5` + PR #1 du fork (`e6deec8`, squash) : lecture par morceaux,
  `fields`, doublons, tâches, workflows, chemins de fichiers, permissions des tags,
  **mode HTTP protégé par OAuth** et e2e avec émetteur JWT de test.
- Critères A1–A13 : verts dans GitHub Actions (PR #1, Paperless 2.x et 3.x), et en local.
- SSO : PR #12 d'offshore-auth fusionnée et déployée le 2026-10-14 (JWT pour la ressource MCP,
  redirect `http://localhost` acceptée en prod pour Claude Code, option A). Un seul client `paperless`
  pour claude.ai et Claude Code (port de retour 31418).
- GitHub : fork public, lié à baruchiro, aucune PR chez baruchiro. Workflows actifs : `ci.yml`, `e2e.yml`.
  Désactivés : `release.yml`, `docker-publish.yml`, `stale.yml`. `gh` vise le fork par défaut.
- Prod : `https://paperless-mcp.offshoreservices.fr` en ligne (Coolify, `main` du fork). B1 et B2 OK le 2026-10-14.

## Connu, non corrigé

- Un 2e `npm run build` échoue (TS5055) : `tsconfig.json` n'exclut pas `build/`. Faire `rm -rf build` en local.
- `docker-compose.e2e.yml` utilise Paperless 2.14.7, refusé par l'API v9 (HTTP 406). Tester en local avec 2.20.
- Le worktree `content-range` (branche `feat/import-workflow-tools`) est fusionné : il peut être archivé.

## À faire (ordre)

1. Sébastien suit `.ai/TUTO-CONNEXION.md` : client « Claude (Paperless) », ressource, rôle, claude.ai, Claude Code.
2. Recette B3–B10 (SPEC §7.B).

# STATUS

Dernière mise à jour : 2026-10-14

## État

- SPEC validée le 2026-10-14 (`.ai/SPEC.md`).
- `main` du fork = upstream `54b0bc5` + PR #1 du fork (`e6deec8`, squash) : lecture par morceaux,
  `fields`, doublons, tâches, workflows, chemins de fichiers, permissions des tags,
  **mode HTTP protégé par OAuth** et e2e avec émetteur JWT de test.
- Critères A1–A13 : verts dans GitHub Actions (PR #1, Paperless 2.x et 3.x), et en local.
- Côté SSO : offshore-auth, branche `MCP-auth`, émet les JWT pour la ressource MCP
  (vérifié en dev le 2026-10-03). Pas encore commité ni déployé. Il manque le client OAuth pour Claude Code.
- GitHub : fork public, lié à baruchiro, aucune PR chez baruchiro. Workflows actifs : `ci.yml`, `e2e.yml`.
  Désactivés : `release.yml`, `docker-publish.yml`, `stale.yml`. `gh` vise le fork par défaut.
- Coolify : rien de configuré. DNS `paperless-mcp.offshoreservices.fr` créé chez Nordnet.

## Connu, non corrigé

- Un 2e `npm run build` échoue (TS5055) : `tsconfig.json` n'exclut pas `build/`. Faire `rm -rf build` en local.
- `docker-compose.e2e.yml` utilise Paperless 2.14.7, refusé par l'API v9 (HTTP 406). Tester en local avec 2.20.
- Le worktree `content-range` (branche `feat/import-workflow-tools`) est fusionné : il peut être archivé.

## À faire (ordre)

1. offshore-auth : commit et déploiement de `MCP-auth`, clients « Claude (Paperless) » et « Claude Code (Paperless) » (accord demandé).
2. Coolify : application depuis le `Dockerfile`, branche `main`, variables du SPEC §4 (accord demandé).
3. Recette B1–B10.

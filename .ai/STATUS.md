# STATUS

Dernière mise à jour : 2026-10-14

## État

- SPEC validée le 2026-10-14 (`.ai/SPEC.md`).
- `main` du fork = `upstream/main` (commit `54b0bc5`) + les fichiers `.ai/`.
- Travail du fork sur la branche `feat/import-workflow-tools` (worktree `content-range`,
  `/home/seni/jean/paperless-mcp/content-range`), poussée, 4 commits :
  lecture par morceaux (`offset` / `max_length`), argument `fields`, correctif enhancer,
  détection de doublons, suivi des tâches, outils workflows, chemins de fichiers, permissions des tags.
  Cette branche deviendra le `main` du fork.
- Non commité dans ce worktree : passage du mode HTTP en ressource OAuth (`src/auth.ts`,
  `src/auth.test.ts`, `src/index.ts`, `src/server.ts`, README, CLAUDE.md, changeset).
  D'après `.ai/todo.md` du worktree : 136 tests unitaires OK le 2026-10-03 (non revérifié).
- Côté SSO : offshore-auth, branche `MCP-auth`, émet les JWT pour la ressource MCP
  (vérifié en dev le 2026-10-03). Pas encore commité ni déployé. Il manque le client OAuth pour Claude Code.
- GitHub : le fork est public et lié à `baruchiro/paperless-mcp`. Les Actions sont activées,
  mais aucun workflow n'a encore tourné. `gh` vise le fork par défaut.
- Coolify : rien de configuré. Le DNS de `paperless-mcp.offshoreservices.fr` est créé chez Nordnet.

## À faire (ordre)

1. Désactiver `release.yml` et `stale.yml` sur le fork (accord demandé).
2. Commiter l'OAuth sur `feat/import-workflow-tools`.
3. Adapter `e2e/` et `.github/workflows/e2e.yml` (émetteur JWT de test) pour A1–A13.
4. Faire passer CI et E2E dans GitHub Actions du fork.
5. Fusionner dans `main` du fork (accord demandé).
6. offshore-auth : commit et déploiement de `MCP-auth`, clients « Claude (Paperless) » et « Claude Code (Paperless) ».
7. Coolify : application depuis le `Dockerfile`, branche `main`, variables du §4 (accord demandé).
8. Recette B1–B10.

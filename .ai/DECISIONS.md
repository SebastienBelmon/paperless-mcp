# DECISIONS

Format : date — choix — raison — alternative écartée.

## 2026-10-14 — Fichiers de pilotage dans `.ai/` du dépôt, commités sur le fork

- Choix : `SPEC.md`, `STATUS.md`, `DECISIONS.md` dans `.ai/`, commités (accord de Sébastien). `.ai/todo.md` reste hors Git via `.git/info/exclude` (la ligne `.ai/` qui ignorait tout le dossier a été retirée).
- Raison : sources de vérité du projet, visibles dans tous les worktrees. Le fork n'envoie pas de PR à upstream, donc la règle « pas de fichiers de planification » d'`AGENTS.md` ne s'applique pas.
- Alternative écartée : garder les fichiers hors Git (perdus entre worktrees).

## 2026-10-14 — La SPEC reprend le contrat OAuth d'offshore-auth

- Choix : `.ai/SPEC.md` renvoie à `offshore-auth/.ai/SPEC-MCP-PAPERLESS.md` pour le détail du contrat et ajoute le déploiement et les critères d'acceptation.
- Raison : une seule source pour le contrat entre le SSO et le MCP ; le code non commité du worktree `content-range` le suit déjà.
- Alternative écartée : réécrire un contrat différent (risque d'écart avec le SSO).

## 2026-10-14 — Le MCP appelle Paperless par son URL publique HTTPS

- Choix : `PAPERLESS_URL` = URL publique HTTPS de Paperless.
- Raison : aucun changement sur le déploiement Paperless existant. Le réseau interne demande d'activer « Connect To Predefined Network » sur le service Paperless (redéploiement) et d'utiliser un nom de conteneur avec UUID (https://coolify.io/docs/services/configuration/networking). Le surcoût d'un aller-retour par Traefik sur le même VPS est faible.
- Alternative écartée : réseau interne `coolify` (à revoir si la latence ou l'exposition publique de Paperless pose problème).

## 2026-10-14 — `gh` vise le fork par défaut

- Choix : `gh repo set-default SebastienBelmon/paperless-mcp` dans le dépôt local.
- Raison : pour un fork, `gh pr create` propose upstream par défaut. Sébastien ne veut aucune PR vers `baruchiro/paperless-mcp`.
- Alternative écartée : compter sur `--repo` à chaque commande (oubli facile).

## 2026-10-14 — Claude Code via un client OAuth pré-enregistré

- Choix : Claude Code utilise `--client-id`, `--client-secret` et `--callback-port`, avec un second client dans offshore-auth (redirect `http://localhost:<port>/callback`).
- Raison : offshore-auth n'a pas d'enregistrement dynamique (DCR). Claude Code accepte des identifiants pré-configurés (https://code.claude.com/docs/en/mcp).
- Alternative écartée : ajouter le DCR à offshore-auth (plus de surface d'attaque pour un seul utilisateur).

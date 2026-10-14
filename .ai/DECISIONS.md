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

- Choix : Claude Code utilise `--client-id`, `--client-secret` et `--callback-port` (redirect `http://localhost:<port>/callback`). Le « second client » prévu ici est remplacé par un client unique : voir la décision « option A » ci-dessous.
- Raison : offshore-auth n'a pas d'enregistrement dynamique (DCR). Claude Code accepte des identifiants pré-configurés (https://code.claude.com/docs/en/mcp).
- Alternative écartée : ajouter le DCR à offshore-auth (plus de surface d'attaque pour un seul utilisateur).

## 2026-10-14 — SSO : redirect `http://localhost` acceptée en production (option A)

- Choix (validé par Sébastien) : offshore-auth accepte les redirect URIs `http://localhost` en production pour tous les clients. Un seul client, clé `paperless`, sert claude.ai et Claude Code (port 31418).
- Raison : Claude Code reçoit le code sur `localhost`. Un code volé ne sert à rien sans le secret du client (test 4b de `mcp-flow-test.py`). Une 2e clé d'appli contournerait le rôle `paperless`, car le MCP ne vérifie pas `app_key`.
- Alternative écartée : option B, autoriser `localhost` seulement pour le client `paperless` (plus de code pour un seul admin).

## 2026-10-14 — SSO : `client_secret_post` accepté sur `/oauth2/token` (option A)

- Choix (validé par Sébastien) : offshore-auth accepte le secret dans l'en-tête Basic **ou** dans le corps, pour un client enregistré en `client_secret_basic` (PR offshore-auth #13). Chaque échec de `/oauth2/token` ou `/oauth2/consent` écrit une ligne `[oauth] … refusé`, sans secret.
- Raison : claude.ai envoie le secret dans le corps et recevait `400 invalid_client`, sans log (https://github.com/doemefu/homelab/issues/175). Claude Code utilise Basic. Le secret et PKCE restent obligatoires.
- Alternative écartée : option B, passer le client en `client_secret_post` en base (Claude Code ne marcherait plus).

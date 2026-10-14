# Tuto : mettre le MCP Paperless en ligne avec Coolify

Durée : 15 minutes environ. Tu as besoin de :
- ton accès à Coolify : https://coolify.offshoreservices.fr ;
- ton accès à Paperless, avec le mot de passe du compte **claude** ;
- l'adresse de ton Paperless (celle que tu tapes dans le navigateur, par exemple `https://paperless.offshoreservices.fr`).

Le DNS de `paperless-mcp.offshoreservices.fr` est déjà fait chez Nordnet. Rien d'autre à préparer.

> Ce tuto met le serveur en ligne. Il sera déjà protégé : sans connexion au SSO, personne ne peut l'utiliser.
> Le branchement à claude.ai et Claude Code viendra après, quand le SSO sera prêt.

---

## Étape 1 — Copier la clé Paperless du compte « claude »

Le serveur parle à Paperless avec cette clé. C'est un mot de passe : ne la colle nulle part ailleurs que dans Coolify.

1. Ouvre Paperless et connecte-toi avec le compte **claude**.
2. En haut à droite, clique sur le nom du compte, puis sur **My Profile** (Mon profil).
3. Cherche la ligne **API Auth Token**.
   - Une clé est déjà affichée ? Copie-la avec le bouton de copie.
   - Aucune clé ? Clique sur le bouton avec la flèche ronde pour en créer une, puis copie-la.
4. Garde la clé de côté (dans ton gestionnaire de mots de passe, par exemple).

⚠️ Ne clique pas sur la flèche ronde si une clé existe déjà : cela crée une nouvelle clé, et l'ancienne ne marche plus. Tout ce qui l'utilise encore (un MCP local sur ton PC, par exemple) tomberait en panne.

---

## Étape 2 — Créer l'application dans Coolify

1. Ouvre Coolify, puis le même projet que offshore-auth.
2. Clique sur **+ New Resource**, puis sur **Application**.
3. Choisis la source GitHub, comme pour offshore-auth.
   - Choisis le dépôt **SebastienBelmon/paperless-mcp**.
   - Le dépôt n'est pas dans la liste ? Va sur GitHub → **Settings** → **Applications** → l'application Coolify → **Configure**, puis ajoute `paperless-mcp` à la liste des dépôts autorisés. Reviens dans Coolify et recharge la page.
4. Branche : **main**.
5. **Build Pack** : choisis **Dockerfile**. Laisse le reste par défaut (`/Dockerfile`, dossier `/`).
6. Clique sur **Continue** (ou **Save**).

## Étape 3 — Régler l'adresse et le port

Dans l'onglet **General** de la nouvelle application :

1. **Domains** : écris `https://paperless-mcp.offshoreservices.fr`. Pas de `/` à la fin.
2. **Ports Exposes** : écris `3000`.
3. Clique sur **Save**.

Coolify obtient tout seul le certificat HTTPS.

## Étape 4 — Ajouter les réglages (variables)

Ouvre l'onglet **Environment Variables**. Ajoute ces 5 lignes, une par une, et copie les noms **exactement**, en majuscules.

| Nom | Valeur |
|---|---|
| `PAPERLESS_URL` | l'adresse de ton Paperless, par exemple `https://paperless.offshoreservices.fr` (pas de `/` à la fin) |
| `PAPERLESS_API_KEY` | la clé copiée à l'étape 1 |
| `OAUTH_ISSUER` | `https://auth.offshoreservices.fr/api/auth` |
| `OAUTH_JWKS_URL` | `https://auth.offshoreservices.fr/api/auth/jwks` |
| `MCP_RESOURCE` | `https://paperless-mcp.offshoreservices.fr/mcp` |

Pour chaque ligne :
- la case **Build Variable** (ou **Available at Buildtime**) doit rester **décochée** ;
- pour `PAPERLESS_API_KEY`, coche **Is Literal** si la case existe, et si possible marque-la comme secret (icône de cadenas).

⚠️ `MCP_RESOURCE` doit être recopiée au caractère près : `https`, tout en minuscules, `/mcp` à la fin, rien après. Si elle diffère d'une seule lettre, la connexion échouera plus tard.

Clique sur **Save**.

## Étape 5 — Activer les mises à jour automatiques

1. Onglet **General** (ou **Advanced**) : active **Auto Deploy**.
2. Chaque fois que le `main` du fork change sur GitHub, Coolify reconstruit le serveur tout seul.

## Étape 6 — Lancer

1. Clique sur **Deploy** en haut à droite.
2. Attends 2 à 4 minutes. L'état passe à **Running** (en vert).
3. Ouvre l'onglet **Logs**. Tu ne dois voir aucune ligne qui commence par `HTTP mode requires…` ou `Usage:`. Si tu en vois une, une variable de l'étape 4 manque ou est mal écrite.

---

## Étape 7 — Vérifier (2 clics)

1. Ouvre cette adresse dans ton navigateur :
   https://paperless-mcp.offshoreservices.fr/.well-known/oauth-protected-resource
   Tu dois voir un petit texte qui contient `"resource":"https://paperless-mcp.offshoreservices.fr/mcp"` et `auth.offshoreservices.fr`. ✅
2. Ouvre ensuite :
   https://paperless-mcp.offshoreservices.fr/mcp
   Tu dois voir `{"error":"unauthorized"}`. ✅ C'est normal et c'est voulu : la porte est fermée sans connexion au SSO.

Les deux sont bons ? Le serveur est en ligne. Dis-le-moi, et je passe au branchement de claude.ai et Claude Code.

---

## Si ça ne marche pas

| Ce que tu vois | Cause probable | Que faire |
|---|---|---|
| Le déploiement échoue pendant le build | Coolify n'a pas accès au dépôt | Refais l'étape 2.3 (autoriser `paperless-mcp` dans GitHub) |
| L'état reste rouge, et les logs disent `HTTP mode requires…` | Une des 3 variables `OAUTH_…` ou `MCP_RESOURCE` manque | Vérifie les noms à l'étape 4, puis **Redeploy** |
| Les logs disent `Usage: paperless-mcp …` | `PAPERLESS_URL` ou `PAPERLESS_API_KEY` manque | Vérifie l'étape 4, puis **Redeploy** |
| La page affiche « 404 page not found » ou « Bad Gateway » | Mauvais domaine ou mauvais port | Vérifie l'étape 3 (`https://…` et `3000`), puis **Redeploy** |
| Le navigateur parle d'un certificat non valide | Le certificat est encore en cours de création | Attends 2 minutes et recharge |

Bloqué ? Envoie-moi une capture des logs. Masque la clé Paperless si elle apparaît.

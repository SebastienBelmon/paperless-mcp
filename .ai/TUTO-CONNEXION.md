# Tuto : brancher claude.ai et Claude Code au MCP Paperless

À faire **après** :
- le tuto Coolify (`TUTO-COOLIFY.md`) : le serveur répond sur https://paperless-mcp.offshoreservices.fr ;
- la mise à jour du SSO (je te préviens quand elle est en ligne).

Durée : 15 minutes environ. Un seul « client » sert à claude.ai (web, mobile, Desktop) **et** à Claude Code.

---

## Étape 1 — Créer l'application dans le SSO

1. Ouvre https://auth.offshoreservices.fr/admin/apps et connecte-toi.
2. Clique sur **Nouvelle application**.
3. Remplis le formulaire :

| Champ | Valeur |
|---|---|
| Nom | `Claude (Paperless)` |
| Clé | `paperless` |
| URL d'accueil | `https://claude.ai/` |
| Redirect URIs (une par ligne) | `https://claude.ai/api/mcp/auth_callback` |
| | `http://localhost:31418/callback` |

4. Laisse le champ « URL de retour après déconnexion » vide.
5. Clique sur **Créer l'application**.

## Étape 2 — Copier l'identifiant et le secret

Juste après la création, la page affiche 2 valeurs :
- le **client ID** ;
- le **secret**.

⚠️ Le secret n'est affiché **qu'une seule fois**. Copie les deux dans ton gestionnaire de mots de passe tout de suite.

Si tu l'as perdu : sur la fiche de l'application, utilise « Régénérer le secret ». Dans ce cas, il faut le changer dans claude.ai **et** dans Claude Code.

## Étape 3 — Lier l'application au serveur Paperless

1. Reste sur la fiche de l'application « Claude (Paperless) ».
2. Descends jusqu'au bloc **Jetons pour serveur MCP**.
3. Coche `https://paperless-mcp.offshoreservices.fr/mcp`.
4. Clique sur **Enregistrer les ressources**.

Tu ne vois pas ce bloc ? La mise à jour du SSO n'est pas encore en ligne, ou la variable `OAUTH_RESOURCES` manque dans Coolify. Dis-le-moi.

## Étape 4 — Te donner le droit d'accès

1. Ouvre https://auth.offshoreservices.fr/admin.
2. Ouvre ton compte.
3. Dans la liste des applications, active **Claude (Paperless)** et choisis le rôle `user` ou `admin` (les deux marchent pour l'instant).
4. Enregistre.

Sans ce rôle, la connexion est refusée. C'est ce qui protège l'accès.

---

## Étape 5 — Brancher claude.ai (web, mobile et Desktop)

À faire **une seule fois**, sur le site claude.ai. L'app mobile et Claude Desktop le reprennent tout seuls.

1. Ouvre https://claude.ai → **Paramètres** → **Connecteurs**.
2. Clique sur **Ajouter un connecteur personnalisé**.
3. Nom : `Paperless`. URL : `https://paperless-mcp.offshoreservices.fr/mcp`
4. Ouvre **Paramètres avancés**. Colle le **client ID** et le **secret** de l'étape 2.
5. Clique sur **Ajouter**, puis sur **Se connecter**.
6. Une page du SSO s'ouvre. Connecte-toi, puis accepte.
7. Tu reviens sur claude.ai. Le connecteur est marqué comme connecté. ✅

Test : dans une nouvelle conversation, demande « Liste mes 5 derniers documents Paperless ».

Ensuite, vérifie sur ton téléphone (app Claude) et dans Claude Desktop : le connecteur Paperless doit déjà être là.

⚠️ Si claude.ai affiche une erreur qui contient `invalid_client` : **arrête-toi là** et envoie-moi une capture. Ne change rien dans le SSO.

## Étape 6 — Brancher Claude Code (sur ton PC)

1. Ouvre un terminal et tape (remplace `<client id>` par ta valeur) :

   ```
   claude mcp add --transport http --scope user --client-id <client id> --client-secret --callback-port 31418 paperless https://paperless-mcp.offshoreservices.fr/mcp
   ```

2. Le terminal te demande le secret : colle-le (il ne s'affiche pas, c'est normal), puis Entrée.
3. Lance `claude`, puis tape `/mcp`.
4. Choisis **paperless**, puis **Authenticate**.
5. Le navigateur ouvre le SSO. Connecte-toi. La page affiche ensuite un message de succès, et tu peux la fermer.
6. Dans Claude Code, `/mcp` montre maintenant **paperless** comme connecté. ✅

`--scope user` rend Paperless disponible dans tous tes projets, pas seulement dans le dossier courant.

---

## Étape 7 — Derniers contrôles (le lendemain, c'est bien)

| Contrôle | Attendu |
|---|---|
| Plus d'1 h après la connexion, refais une demande dans claude.ai et Claude Code | Ça marche sans te reconnecter |
| Demande à Claude de créer un tag dans Paperless | Refusé (le compte « claude » est en lecture seule) |

## En cas de problème

| Ce que tu vois | Que faire |
|---|---|
| Le SSO affiche « accès refusé » ou te renvoie sur la page d'accueil | Vérifie l'étape 4 (rôle `paperless`) |
| claude.ai : `invalid_client` | Stop, envoie-moi une capture |
| Claude Code : erreur de port, ou « address already in use » | Ferme les autres sessions Claude Code et réessaie |
| Claude Code : `redirect_uri` invalide | Vérifie l'étape 1 : `http://localhost:31418/callback`, tout en minuscules |

**Pour tout couper d'un coup** : ouvre la fiche « Claude (Paperless) » dans `/admin/apps`, puis clique sur **Désactiver**. claude.ai et Claude Code perdent l'accès dans l'heure.

> ⚠️ **ÉCOSYSTÈME GROUPEMES — BACKEND & AUTH PARTAGÉS. LIS CECI AVANT TOUTE CHOSE.**
>
> Ce fichier est CANONIQUE dans `~/mesoutils` et recopié à l'identique dans
> toutes les apps par `sync-convex.sh`. Ne l'édite que dans `~/mesoutils`.

# Architecture (à connaître avant d'écrire une ligne)

Les **7 apps** — Mes Outils (`~/mesoutils`), Recycapp (`~/recycapp`), Klyde
(`~/klyde`), Cycle en Bray (`~/cycleenbray`), Bennes Pro (`~/bennepro`),
Pointeuse (`~/pointeuselsdb`), Feedback (`~/feedback`) — partagent :

- **UN déploiement Convex de PRODUCTION** : `prod:hip-marten-394`
  (`https://hip-marten-394.eu-west-1.convex.cloud`). Données réelles,
  **pas de staging**.
- **UNE instance Clerk de PRODUCTION** : issuer `https://clerk.groupemes.fr`
  (`pk_live_…`, identique dans les 7 `.env.local`). Mêmes comptes et mêmes
  `clerkId` dans toutes les apps.
- **UN dossier `convex/` canonique** : `~/mesoutils/convex`. Les `convex/` des
  autres dépôts sont des **copies en lecture seule** pour le typecheck local.

Chaque app a son propre dépôt GitHub et son propre projet Vercel — mais Vercel
ne déploie que le **frontend**. Le backend est commun : casser une fonction ou
une table Convex peut casser les 7 apps d'un coup. C'est la cause classique de
« je modifie l'app X et une fonctionnalité de l'app Y meurt ».

## Règles backend (Convex)

1. **Édite le backend UNIQUEMENT dans `~/mesoutils/convex/`** — même pour une
   fonctionnalité de CETTE app. Jamais dans la copie locale.
2. **Déploie UNIQUEMENT depuis `~/mesoutils`** : `cd ~/mesoutils && npx convex
   deploy`. Ne lance **jamais** `npx convex dev` ni `npx convex deploy` depuis
   un autre dépôt.
3. ⚠️ **Le déploiement publie le WORKING TREE de `~/mesoutils`, pas un
   commit.** Fais `git -C ~/mesoutils status` avant de déployer : tout ce qui
   est modifié partira en prod. Ne déploie **jamais** depuis un worktree ou un
   checkout « propre » : tu écraserais du travail non commité déjà en prod
   (incident réel : fonctions et index bennespro supprimés de prod pendant une
   minute). Après un déploiement, commite le travail correspondant au plus vite.
4. **Lance `bash ~/mesoutils/scripts/sync-convex.sh` AVANT et APRÈS** toute
   intervention sur n'importe quelle app. Il réaligne les copies `convex/` et
   ces instructions. **Toute NOUVELLE app doit être ajoutée à `SIBLINGS` dans ce
   script** : sans ça, sa copie `convex/` dérive en silence et son frontend
   typecheck contre un backend qui n'existe pas.
5. **Avant de modifier ou supprimer une fonction/table/champ partagé, grep son
   nom dans les `src/` des 7 dépôts** (`grep -rl "nomFonction"
   ~/mesoutils/src ~/recycapp/src ~/klyde/src ~/cycleenbray/src ~/bennepro/src
   ~/pointeuselsdb/src ~/feedback/src`). Une fonction sans usage dans CETTE app
   peut être vitale ailleurs.
6. **Schéma : changements ADDITIFS seulement** (nouveau champ `v.optional`,
   nouvelle table, nouvel index). Renommer, supprimer ou rétrécir un champ =
   migration en 3 temps (élargir → migrer les données → rétrécir), validée sur
   les 7 apps. Ne « nettoie » jamais un champ que tu crois inutilisé.
7. **Les données sont réelles.** Pas de mutation de test contre la prod ;
   vérifie en lecture (`npx convex run … --prod`, `npx convex data … --prod`,
   `npx convex logs --prod`). `CONVEX_DEPLOYMENT` est vide dans `.env.local` :
   préfixe tes commandes avec `CONVEX_DEPLOYMENT=prod:hip-marten-394` et
   `--prod`. Si un test en écriture est indispensable, passe par une
   `internalAction`/`internalQuery` temporaire, puis **supprime-la et
   redéploie**.
8. **`npx convex function-spec` renvoie des identifiants `module.js:fonction`**
   (ex. `bennespro.js:getMyCompany`), pas `module:fonction`. Un grep au mauvais
   format conclut à tort qu'une fonction n'existe pas (cause de l'incident du
   point 3).

## Règles auth (Clerk)

- **Une seule instance Clerk PROD.** `VITE_CLERK_PUBLISHABLE_KEY` doit rester
  la clé `pk_live_…` (issuer `clerk.groupemes.fr`) dans les 7 apps, et
  `convex/auth.config.ts` pointe sur ce même issuer. Ne réintroduis **jamais**
  une clé dev/test dans une app : ses utilisateurs obtiennent d'autres
  `identity.subject` et « perdent » leurs données dans les 7 apps.
- **`CLERK_SECRET_KEY` vit dans les variables d'env du déploiement Convex
  prod** (`npx convex env list --prod`), jamais dans les `.env.local` ni dans
  le code.
- **API Clerk depuis Convex : utilise les helpers de
  `~/mesoutils/convex/lib.ts`** (`fetchAllClerkUsers`,
  `fetchInternalClerkDirectory`, `clerkPrimaryEmail`) au lieu de refaire un
  `fetch`. Ils paginent par petits lots : des réponses volumineuses (~59 Ko)
  sont déjà arrivées tronquées dans le runtime Convex (« Unterminated string in
  JSON at position 32764 »), ce qui vidait silencieusement des listes
  d'utilisateurs.
- **Annuaire interne** = comptes `@eco-solidaire.fr` de Clerk prod. La table
  Convex `users` ne contient que les comptes déjà connectés — ce n'est pas la
  source de vérité pour « tous les utilisateurs ».
- **Permissions centralisées** : table `crmPermissions`, `pageKey` namespacés
  par app (`mesoutils:…`, `recyclerie:…`, …), administrées depuis la page admin
  de Mes Outils. Ne crée pas de système de rôles parallèle dans une app.

## Règles frontend partagé (portail d'authentification)

Les 8 apps web partagent la même instance Clerk et **le même écran de connexion
/ inscription** (« Auth Switch » : formulaire qui glisse, panneaux qui se
croisent).

- **Source de vérité** : `~/mesoutils/src/components/ui/auth-switch.tsx` et le
  bloc CSS entre `/* >>> AUTH-PORTAL >>> */` et `/* <<< AUTH-PORTAL <<< */`
  dans `~/mesoutils/src/index.css`. N'édite le portail QUE là.
- **Propage avec `bash ~/mesoutils/scripts/sync-auth-portal.sh`**, puis
  typecheck les apps touchées. Sans ça, la copie dérive : Recycapp, Cycle en
  Bray et Bennes Pro se sont retrouvées avec le `.tsx` mais sans le CSS, donc
  un portail sans mise en page ni animation.
- **Ce qui reste propre à chaque app** : les props de `<AuthSwitch>` (nom,
  logo, liens légaux, lien de retour) et, seulement si sa palette
  `--color-brand-*` ne suffit pas, les variables `--auth-page-bg`,
  `--auth-circle`, `--auth-shadow`, `--auth-accent` dans son `:root`.
- Le composant est **volontairement sans react-router** (`<a>` et
  `window.location`) : Klyde n'a pas de routeur et doit pouvoir l'utiliser tel
  quel. N'y réintroduis pas `Link`/`useNavigate`.
- `~/recyccaisse` est hors périmètre : app Expo/React Native, sans DOM.

## Check-list de fin d'intervention (obligatoire)

1. `bash ~/mesoutils/scripts/sync-convex.sh` relancé (et
   `sync-auth-portal.sh` si le portail d'authentification a bougé).
2. Typecheck OK : `npx tsc -p convex/tsconfig.json --noEmit` et
   `npx tsc -p tsconfig.app.json --noEmit` dans l'app touchée.
3. Fonction/table partagée modifiée → usages greppés dans les 7 dépôts.
4. Backend déployé depuis `~/mesoutils` uniquement, état du working tree connu
   et commité.
5. Frontend : un push sur `main` du dépôt d'une app déclenche son déploiement
   Vercel **PRODUCTION**. Ne pushe `main` que si c'est voulu ; les branches
   donnent des Previews.

---

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

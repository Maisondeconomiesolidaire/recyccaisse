# Recyc Caisse — caisse mobile de la Recyclerie

Application Android de l'accueil : on scanne le QR code affiché sous un article
de la vitrine, on identifie le client, et le montant part sur le lecteur
**BBPOS WisePad 3** apparié en Bluetooth.

## Pourquoi une app native

Le WisePad 3 est un lecteur *mobile* (mPOS). Stripe ne le pilote que depuis ses
SDK **iOS, Android et React Native** : il est explicitement non pris en charge
par le SDK JavaScript et par l'intégration pilotée par serveur. Aucune page web
— ni même une app Windows type Electron, qui reste du Chromium — ne peut donc
lui parler. D'où cette app.

Le kiosk web de Recycapp continue d'afficher la vitrine et ses QR codes ; c'est
seulement l'encaissement qui a déménagé ici.

## Backend

Aucun backend propre : l'app parle au **déploiement Convex partagé** de
l'écosystème (`prod:hip-marten-394`), via les fonctions de `convex/terminal.ts`
(module canonique dans `~/mesoutils/convex`, recopié ici en lecture seule par
`sync-convex.sh`).

Le montant n'est jamais calculé sur la tablette : `terminal.startPayment` relit
le prix sur l'article et crée le PaymentIntent `card_present`. La vente n'est
enregistrée qu'après relecture du statut chez Stripe par
`terminal.finalizePayment`.

## Mise en route

```bash
cp .env.example .env.local     # puis renseigner la clé Clerk pk_live_…
npm install
```

`react-dom` est figé sur la version exacte de `react` (19.2.3). Il ne sert pas
à une app native, mais `@clerk/clerk-expo` le déclare en peer dependency : npm
y installerait sinon la dernière version, qui exige un `react` plus récent que
celui figé par Expo — et le `npm ci` du serveur de build échoue sur ce conflit.

`.env.local` sert au développement local. Pour les builds EAS, les mêmes
valeurs sont déclarées dans `eas.json` : `.env.local` étant ignoré par git, il
n'est pas envoyé au serveur de build, et l'app démarrerait sans backend. Les
deux valeurs concernées sont publiques par nature (elles voyagent de toute
façon dans l'APK) ; la clé secrète Stripe, elle, ne quitte jamais Convex.

Le SDK Terminal contient du code natif : **Expo Go ne suffit pas**, il faut un
*development build*.

```bash
# Build cloud (nécessite un compte Expo)
npx eas-cli build --platform android --profile preview

# ou build local, avec Android Studio installé
npx expo run:android
```

Installer l'APK obtenu sur la tablette, puis :

1. se connecter avec un compte staff de l'écosystème (même annuaire Clerk que
   Mes Outils) ;
2. accepter les autorisations **appareil photo**, **Bluetooth** et
   **localisation** — Stripe impose la localisation pour encaisser au terminal,
   ce n'est pas contournable ;
3. appuyer sur **Connecter** dans la barre du haut, WisePad 3 allumé à moins
   d'un mètre.

⚠️ **N'appairez pas le lecteur dans les réglages Bluetooth d'Android.** Stripe
est formel : un lecteur appairé au système devient invisible pour le SDK, donc
pour l'application. S'il y figure déjà, choisissez « Oublier cet appareil »
avant de réessayer. C'est l'app qui gère l'appairage, y compris la
confirmation du code à six chiffres exigée depuis novembre 2025.

## Prérequis côté Stripe

- Un **emplacement Terminal** doit exister sur le compte
  (Dashboard → Terminal → Emplacements) : un lecteur Bluetooth se connecte
  toujours à un emplacement, qui porte l'adresse déclarée.
- Le lecteur se met à jour tout seul à la première connexion. Le WisePad 3
  livré est en microprogramme `4.01.00.24` et configuration
  `Prod_EU_W1_on_v16` : la mise à jour vers la version française courante peut
  prendre plusieurs minutes, lecteur branché.

## Écrans

Un seul parcours, volontairement : **Scannez le produit** → article →
*Client existant* / *Nouveau client* → **paiement sur le lecteur** → vendu.

import { ConvexReactClient } from "convex/react";

const url = process.env.EXPO_PUBLIC_CONVEX_URL;
if (!url) {
  throw new Error(
    "EXPO_PUBLIC_CONVEX_URL manquante : copiez .env.example vers .env.local.",
  );
}

/**
 * Un seul déploiement Convex pour tout l'écosystème Groupe MES : cette caisse
 * lit et écrit les mêmes articles et les mêmes commandes que Recycapp.
 */
export const convex = new ConvexReactClient(url, { unsavedChangesWarning: false });

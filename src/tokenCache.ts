import * as SecureStore from "expo-secure-store";
import type { TokenCache } from "@clerk/clerk-expo";

/**
 * Session Clerk conservée dans le trousseau chiffré de l'appareil : la tablette
 * de l'accueil ne doit pas redemander une connexion à chaque ouverture.
 */
export const tokenCache: TokenCache = {
  async getToken(key) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      // Trousseau illisible (appareil verrouillé, migration) : on repart d'une
      // session vide plutôt que de bloquer l'app sur une exception.
      return null;
    }
  },
  async saveToken(key, value) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // Sans persistance, la session ne survit pas à la fermeture : gênant,
      // pas bloquant.
    }
  },
};

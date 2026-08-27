import { mutation } from "./_generated/server";

/**
 * Génère une URL d'upload temporaire pour envoyer une photo vers le stockage
 * Convex. Public : utilisé par les formulaires clients (aérogommage / collecte)
 * et par le CRM (photos d'articles).
 */
export const generateUploadUrl = mutation(async (ctx) => {
  return await ctx.storage.generateUploadUrl();
});

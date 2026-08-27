/**
 * QR codes d'articles imprimés à l'avance (Recycapp).
 *
 * Le flux historique imposait de créer la fiche article AVANT de pouvoir
 * imprimer son QR code, donc de retrouver l'objet ensuite pour y coller
 * l'étiquette. Ici, on imprime d'abord une planche de codes vierges, on les
 * colle au fil de la collecte, et la fiche se crée en scannant le code déjà
 * posé sur l'objet.
 *
 * La référence a le même format que `articles.internalReference` (6 chiffres) :
 * un code du pool se comporte, une fois attribué, exactement comme une
 * référence générée à la création.
 */
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireAnyCrmPermission, requireCrmPermission } from "./lib";
import type { Id } from "./_generated/dataModel";

/** Nombre maximum de codes générés en une fois (une planche A4 en tient 4 × n). */
const MAX_BATCH = 200;

export function normalizeReference(raw: string): string {
  return raw.trim().replace(/\D/g, "");
}

/**
 * Tire une référence à 6 chiffres libre — ni déjà dans le pool, ni portée par
 * un article existant.
 */
function generateReference(taken: Set<string>): string {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const candidate = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  throw new Error("Impossible de générer une référence unique.");
}

async function takenReferences(ctx: QueryCtx): Promise<Set<string>> {
  const [codes, articles] = await Promise.all([
    ctx.db.query("articleQrCodes").collect(),
    ctx.db.query("articles").collect(),
  ]);
  return new Set([
    ...codes.map((code) => code.reference),
    ...articles
      .map((article) => article.internalReference)
      .filter((value): value is string => Boolean(value)),
  ]);
}

/** Le pool complet : codes libres d'abord, puis ceux déjà attribués. */
export const list = query({
  args: { onlyFree: v.optional(v.boolean()) },
  handler: async (ctx, { onlyFree }) => {
    await requireAnyCrmPermission(ctx, [
      ["articles", "read"],
      ["caisse", "read"],
    ]);
    const codes = await ctx.db.query("articleQrCodes").order("desc").collect();
    const visible = onlyFree ? codes.filter((code) => !code.articleId) : codes;
    return Promise.all(
      visible.map(async (code) => ({
        ...code,
        articleTitle: code.articleId
          ? ((await ctx.db.get(code.articleId))?.title ?? null)
          : null,
      })),
    );
  },
});

/** Combien de codes restent à coller. */
export const freeCount = query({
  args: {},
  handler: async (ctx) => {
    await requireAnyCrmPermission(ctx, [
      ["articles", "read"],
      ["caisse", "read"],
    ]);
    const codes = await ctx.db.query("articleQrCodes").collect();
    return codes.filter((code) => !code.articleId).length;
  },
});

/** Un code scanné : libre, déjà pris, ou inconnu. */
export const getByReference = query({
  args: { reference: v.string() },
  handler: async (ctx, { reference }) => {
    await requireAnyCrmPermission(ctx, [
      ["articles", "read"],
      ["caisse", "read"],
    ]);
    const code = await ctx.db
      .query("articleQrCodes")
      .withIndex("by_reference", (q) => q.eq("reference", normalizeReference(reference)))
      .first();
    if (!code) return null;
    const article = code.articleId ? await ctx.db.get(code.articleId) : null;
    return { ...code, articleTitle: article?.title ?? null };
  },
});

/** Génère une planche de codes vierges, prêts à imprimer et à coller. */
export const generate = mutation({
  args: { count: v.number() },
  handler: async (ctx, { count }) => {
    await requireCrmPermission(ctx, "articles", "create");
    const total = Math.floor(count);
    if (!Number.isFinite(total) || total < 1) {
      throw new Error("Indiquez un nombre de QR codes à générer.");
    }
    if (total > MAX_BATCH) {
      throw new Error(`Maximum ${MAX_BATCH} QR codes par génération.`);
    }

    const taken = await takenReferences(ctx);
    const batchAt = Date.now();
    const created: Array<{ id: Id<"articleQrCodes">; reference: string }> = [];
    for (let i = 0; i < total; i += 1) {
      const reference = generateReference(taken);
      const id = await ctx.db.insert("articleQrCodes", {
        reference,
        batchAt,
        createdAt: Date.now(),
      });
      created.push({ id, reference });
    }
    return created;
  },
});

/** Supprime un code encore libre (planche mal imprimée, étiquette perdue). */
export const remove = mutation({
  args: { id: v.id("articleQrCodes") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "articles", "delete");
    const code = await ctx.db.get(id);
    if (!code) return;
    if (code.articleId) {
      throw new Error("Ce QR code est déjà attribué à un article.");
    }
    await ctx.db.delete(id);
  },
});

/**
 * Réserve un code du pool pour un article en cours de création.
 *
 * Renvoie la référence à inscrire sur l'article. Lève si le code est inconnu ou
 * déjà porté par un autre article — deux objets ne peuvent pas partager une
 * étiquette.
 */
export async function claimQrCode(
  ctx: MutationCtx,
  reference: string,
  articleId: Id<"articles">,
): Promise<string> {
  const normalized = normalizeReference(reference);
  const code = await ctx.db
    .query("articleQrCodes")
    .withIndex("by_reference", (q) => q.eq("reference", normalized))
    .first();
  if (!code) {
    throw new Error(`QR code « ${normalized} » inconnu. Générez-le d'abord.`);
  }
  if (code.articleId && code.articleId !== articleId) {
    throw new Error(`QR code « ${normalized} » déjà utilisé par un autre article.`);
  }
  await ctx.db.patch(code._id, { articleId, assignedAt: Date.now() });
  return normalized;
}

/**
 * Libère les codes d'un article supprimé : l'étiquette est toujours collée
 * quelque part, autant pouvoir la réutiliser.
 */
export async function releaseQrCodes(ctx: MutationCtx, articleId: Id<"articles">) {
  const codes = await ctx.db
    .query("articleQrCodes")
    .withIndex("by_article", (q) => q.eq("articleId", articleId))
    .collect();
  for (const code of codes) {
    await ctx.db.patch(code._id, { articleId: undefined, assignedAt: undefined });
  }
}

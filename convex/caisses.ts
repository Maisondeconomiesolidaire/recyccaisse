/**
 * Caisses de rangement de la recyclerie (Recycapp).
 *
 * Chaque caisse porte un QR code collé dessus. Le code (`CA-0007`) est ce qui
 * est encodé dans le QR : on le scanne à l'ajout d'un article pour l'y ranger,
 * et on le rescanne pour lister tout ce que la caisse contient.
 *
 * Les caisses remplacent l'ancien champ texte libre `articles.location`, qui
 * reste lu en secours tant que le stock n'est pas entièrement rangé.
 */
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireAnyCrmPermission, requireCrmPermission } from "./lib";
import type { Doc, Id } from "./_generated/dataModel";

/** Préfixe des codes de caisse — sert aussi à les distinguer au scan. */
export const CAISSE_CODE_PREFIX = "CA-";

const CODE_PATTERN = /^CA-\d{4,}$/;

/** Normalise un code scanné (casse, espaces, éventuelle URL collée devant). */
function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export function isCaisseCode(raw: string): boolean {
  return CODE_PATTERN.test(normalizeCode(raw));
}

async function nextCaisseCode(ctx: QueryCtx): Promise<string> {
  const all = await ctx.db.query("caisses").collect();
  const max = all.reduce((acc, caisse) => {
    const digits = Number(caisse.code.replace(/\D/g, ""));
    return Number.isFinite(digits) && digits > acc ? digits : acc;
  }, 0);
  return `${CAISSE_CODE_PREFIX}${String(max + 1).padStart(4, "0")}`;
}

async function countArticles(ctx: QueryCtx, caisseId: Id<"caisses">) {
  const articles = await ctx.db
    .query("articles")
    .withIndex("by_caisse", (q) => q.eq("caisseId", caisseId))
    .collect();
  return {
    total: articles.length,
    /** Articles encore présents physiquement (les vendus ont quitté la caisse). */
    remaining: articles.filter((a) => a.status !== "vendu").length,
  };
}

/** Toutes les caisses avec le nombre d'articles qu'elles contiennent. */
export const list = query({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived }) => {
    await requireAnyCrmPermission(ctx, [
      ["articles", "read"],
      ["caisse", "read"],
    ]);
    const caisses = await ctx.db.query("caisses").order("desc").collect();
    const visible = includeArchived ? caisses : caisses.filter((c) => !c.archived);
    return Promise.all(
      visible
        .sort((a, b) => a.code.localeCompare(b.code, "fr", { numeric: true }))
        .map(async (caisse) => ({ ...caisse, counts: await countArticles(ctx, caisse._id) })),
    );
  },
});

async function resolveContents(ctx: QueryCtx, caisse: Doc<"caisses">) {
  const articles = await ctx.db
    .query("articles")
    .withIndex("by_caisse", (q) => q.eq("caisseId", caisse._id))
    .collect();
  const withUrls = await Promise.all(
    articles
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(async (article) => ({
        ...article,
        imageUrls: (
          await Promise.all(article.images.map((id) => ctx.storage.getUrl(id)))
        ).filter((url): url is string => url !== null),
      })),
  );
  return { caisse, articles: withUrls };
}

/** Contenu d'une caisse à partir de son identifiant. */
export const get = query({
  args: { id: v.id("caisses") },
  handler: async (ctx, { id }) => {
    await requireAnyCrmPermission(ctx, [
      ["articles", "read"],
      ["caisse", "read"],
    ]);
    const caisse = await ctx.db.get(id);
    if (!caisse) return null;
    return resolveContents(ctx, caisse);
  },
});

/** Contenu d'une caisse à partir du code lu sur son QR code. */
export const getByCode = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    await requireAnyCrmPermission(ctx, [
      ["articles", "read"],
      ["caisse", "read"],
    ]);
    const normalized = normalizeCode(code);
    const caisse = await ctx.db
      .query("caisses")
      .withIndex("by_code", (q) => q.eq("code", normalized))
      .first();
    if (!caisse) return null;
    return resolveContents(ctx, caisse);
  },
});

/**
 * Crée une caisse. Le code est généré automatiquement (`CA-0001`, `CA-0002`…)
 * et sert directement de valeur du QR code à imprimer.
 */
export const create = mutation({
  args: {
    label: v.optional(v.string()),
    zone: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { label, zone, notes }) => {
    await requireCrmPermission(ctx, "articles", "create");
    const code = await nextCaisseCode(ctx);
    return ctx.db.insert("caisses", {
      code,
      label: label?.trim() || undefined,
      zone: zone?.trim() || undefined,
      notes: notes?.trim() || undefined,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("caisses"),
    label: v.optional(v.string()),
    zone: v.optional(v.string()),
    notes: v.optional(v.string()),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, label, zone, notes, archived }) => {
    await requireCrmPermission(ctx, "articles", "update");
    const caisse = await ctx.db.get(id);
    if (!caisse) throw new Error("Caisse introuvable.");
    await ctx.db.patch(id, {
      label: label?.trim() || undefined,
      zone: zone?.trim() || undefined,
      notes: notes?.trim() || undefined,
      archived: archived ?? caisse.archived,
    });
  },
});

/** Supprime une caisse vide (les articles rangés dedans sont d'abord détachés). */
export const remove = mutation({
  args: { id: v.id("caisses") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "articles", "delete");
    const articles = await ctx.db
      .query("articles")
      .withIndex("by_caisse", (q) => q.eq("caisseId", id))
      .collect();
    if (articles.some((a) => a.status !== "vendu")) {
      throw new Error(
        "Cette caisse contient encore des articles. Videz-la avant de la supprimer.",
      );
    }
    for (const article of articles) {
      await ctx.db.patch(article._id, { caisseId: undefined });
    }
    await ctx.db.delete(id);
  },
});

/** Range (ou sort) un article dans une caisse — utilisé après un scan. */
export const assignArticle = mutation({
  args: {
    articleId: v.id("articles"),
    caisseId: v.union(v.id("caisses"), v.null()),
  },
  handler: async (ctx, { articleId, caisseId }) => {
    await requireCrmPermission(ctx, "articles", "update");
    const article = await ctx.db.get(articleId);
    if (!article) throw new Error("Article introuvable.");
    if (caisseId) {
      const caisse = await ctx.db.get(caisseId);
      if (!caisse) throw new Error("Caisse introuvable.");
    }
    await ctx.db.patch(articleId, { caisseId: caisseId ?? undefined });
  },
});

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireCrmPermission } from "./lib";
import type { Id } from "./_generated/dataModel";

export const createSession = mutation({
  args: {
    articleId: v.id("articles"),
    type: v.string(),
    durationMinutes: v.optional(v.number()),
    technicianId: v.optional(v.id("teamMembers")),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "ateliers", "create");
    const article = await ctx.db.get(args.articleId);
    if (!article) throw new Error("Article introuvable");

    // Move article to "atelier" status
    await ctx.db.patch(args.articleId, { status: "attente" });

    return await ctx.db.insert("atelierSessions", {
      ...args,
      articleReference: article.internalReference ?? args.articleId,
      date: Date.now(),
      status: "en_cours",
      createdAt: Date.now(),
    });
  },
});

export const terminateSession = mutation({
  args: {
    sessionId: v.id("atelierSessions"),
    price: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { sessionId, price, notes }) => {
    await requireCrmPermission(ctx, "ateliers", "update");
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session introuvable");

    await ctx.db.patch(sessionId, {
      status: "termine",
      notes: notes ?? session.notes,
    });

    // Move article to disponible + update price if provided
    if (price !== undefined) {
      await ctx.db.patch(session.articleId, { status: "disponible", price });
    } else {
      await ctx.db.patch(session.articleId, { status: "disponible" });
    }
  },
});

export const listSessions = query({
  args: { status: v.optional(v.union(v.literal("en_cours"), v.literal("termine"))) },
  handler: async (ctx, { status }) => {
    await requireCrmPermission(ctx, "ateliers", "read");
    const sessions = status
      ? await ctx.db.query("atelierSessions").withIndex("by_status", (q) => q.eq("status", status)).order("desc").collect()
      : await ctx.db.query("atelierSessions").order("desc").collect();

    return await Promise.all(
      sessions.map(async (s) => {
        const article = await ctx.db.get(s.articleId);
        const technician = s.technicianId ? await ctx.db.get(s.technicianId) : null;
        let imageUrl: string | null = null;
        if (article?.images?.[0]) {
          imageUrl = await ctx.storage.getUrl(article.images[0] as Id<"_storage">);
        }
        return {
          ...s,
          article: article ? { ...article, imageUrl } : null,
          technicianName: technician?.name ?? null,
        };
      }),
    );
  },
});

export const getArticleForAtelier = query({
  args: { reference: v.string() },
  handler: async (ctx, { reference }) => {
    await requireCrmPermission(ctx, "ateliers", "read");
    const articles = await ctx.db.query("articles").collect();
    const found = articles.find(
      (a) => a.internalReference && a.internalReference === reference,
    );
    if (!found) return null;
    const imageUrls = await Promise.all(
      found.images.map((id: Id<"_storage">) => ctx.storage.getUrl(id)),
    );
    return { ...found, imageUrls: imageUrls.filter(Boolean) as string[] };
  },
});

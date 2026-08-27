import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireCrmPermission } from "./lib";

const originValidator = v.union(
  v.literal("decheterie"),
  v.literal("domicile"),
  v.literal("apport"),
  v.literal("tournee"),
);

// ─── Arrivages ────────────────────────────────────────────────────────────────

export const createArrivage = mutation({
  args: {
    origin: originValidator,
    commune: v.optional(v.string()),
    date: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "arrivages", "create");
    return await ctx.db.insert("arrivages", {
      ...args,
      status: "open",
      createdAt: Date.now(),
    });
  },
});

export const closeArrivage = mutation({
  args: { arrivageId: v.id("arrivages") },
  handler: async (ctx, { arrivageId }) => {
    await requireCrmPermission(ctx, "arrivages", "update");
    await ctx.db.patch(arrivageId, { status: "closed" });
  },
});

export const listOpenArrivages = query({
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "arrivages", "read");
    return await ctx.db.query("arrivages").withIndex("by_status", (q) => q.eq("status", "open")).order("desc").collect();
  },
});

export const getArrivageWithItems = query({
  args: { arrivageId: v.id("arrivages") },
  handler: async (ctx, { arrivageId }) => {
    await requireCrmPermission(ctx, "arrivages", "read");
    const arrivage = await ctx.db.get(arrivageId);
    if (!arrivage) return null;
    const items = await ctx.db
      .query("arrivageItems")
      .withIndex("by_arrivage", (q) => q.eq("arrivageId", arrivageId))
      .order("desc")
      .collect();
    return { arrivage, items };
  },
});

// ─── Arrivage Items ───────────────────────────────────────────────────────────

function makeReference(category: string): string {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const rand = Math.floor(Math.random() * 9000) + 1000;
  const cat = category.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
  return `${cat}-${ymd}-${rand}`;
}

const itemArgs = {
  arrivageId: v.optional(v.id("arrivages")),
  depotId: v.optional(v.id("depots")),
  date: v.number(),
  origin: originValidator,
  commune: v.optional(v.string()),
  category: v.string(),
  subcategory: v.optional(v.string()),
  flux: v.optional(v.string()),
  orientation: v.string(),
  weightKg: v.optional(v.number()),
  tare: v.optional(v.number()),
  quantity: v.number(),
  price: v.optional(v.number()),
  condition: v.optional(v.string()),
  labelInfo: v.optional(v.string()),
};

export const addItem = mutation({
  args: itemArgs,
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "arrivages", "create");
    const reference = makeReference(args.category);

    const itemId = await ctx.db.insert("arrivageItems", {
      ...args,
      reference,
      createdAt: Date.now(),
    });

    return { itemId, reference };
  },
});

// Promote a staged arrivage item to a boutique article (staff validation step).
export const promoteToArticle = mutation({
  args: {
    itemId: v.id("arrivageItems"),
    title: v.optional(v.string()),
    price: v.optional(v.number()),
    condition: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "arrivages", "create");
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item introuvable");
    if (item.articleId) throw new Error("Déjà promu en boutique");

    const title = args.title ?? item.labelInfo?.trim() ?? `${item.category}${item.subcategory ? " – " + item.subcategory : ""}`;

    const articleId = await ctx.db.insert("articles", {
      title,
      description: "",
      price: args.price ?? item.price ?? 0,
      category: item.category,
      subcategory: item.subcategory,
      condition: args.condition ?? item.condition ?? "Bon état",
      internalReference: item.reference,
      images: [],
      status: "attente",
      createdAt: Date.now(),
    });

    await ctx.db.patch(args.itemId, { articleId });
    return { articleId };
  },
});

export const removeItem = mutation({
  args: { itemId: v.id("arrivageItems") },
  handler: async (ctx, { itemId }) => {
    await requireCrmPermission(ctx, "arrivages", "delete");
    const item = await ctx.db.get(itemId);
    if (!item) return;
    await ctx.db.delete(itemId);
  },
});

// ─── Dépôts ───────────────────────────────────────────────────────────────────

export const createDepot = mutation({
  args: {
    origin: originValidator,
    commune: v.optional(v.string()),
    date: v.number(),
    weightKg: v.optional(v.number()),
    defaultCategory: v.optional(v.string()),
    defaultSubcategory: v.optional(v.string()),
    defaultFlux: v.optional(v.string()),
    defaultOrientation: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "arrivages", "create");
    const all = await ctx.db.query("depots").collect();
    const depotNumber = all.length + 1;
    return await ctx.db.insert("depots", {
      ...args,
      depotNumber,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const listPendingDepots = query({
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "arrivages", "read");
    const depots = await ctx.db
      .query("depots")
      .filter((q) => q.neq(q.field("status"), "closed"))
      .order("desc")
      .collect();
    const result = await Promise.all(
      depots.map(async (d) => {
        const itemCount = (
          await ctx.db
            .query("arrivageItems")
            .withIndex("by_depot", (q) => q.eq("depotId", d._id))
            .collect()
        ).length;
        return { ...d, itemCount };
      }),
    );
    return result;
  },
});

export const getDepotWithItems = query({
  args: { depotId: v.id("depots") },
  handler: async (ctx, { depotId }) => {
    await requireCrmPermission(ctx, "arrivages", "read");
    const depot = await ctx.db.get(depotId);
    if (!depot) return null;
    const items = await ctx.db
      .query("arrivageItems")
      .withIndex("by_depot", (q) => q.eq("depotId", depotId))
      .order("desc")
      .collect();
    return { depot, items };
  },
});

export const closeDepot = mutation({
  args: { depotId: v.id("depots") },
  handler: async (ctx, { depotId }) => {
    await requireCrmPermission(ctx, "arrivages", "update");
    await ctx.db.patch(depotId, { status: "closed", closedAt: Date.now() });
  },
});

// ─── Historique ───────────────────────────────────────────────────────────────

export const listHistory = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    await requireCrmPermission(ctx, "arrivages", "read");
    const arrivages = await ctx.db
      .query("arrivages")
      .withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate))
      .order("desc")
      .collect();

    const result = await Promise.all(
      arrivages.map(async (a) => {
        const items = await ctx.db
          .query("arrivageItems")
          .withIndex("by_arrivage", (q) => q.eq("arrivageId", a._id))
          .collect();
        return { ...a, items };
      }),
    );

    // Also fetch standalone items (no arrivageId) in the period
    const standaloneItems = await ctx.db
      .query("arrivageItems")
      .withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate))
      .filter((q) => q.eq(q.field("arrivageId"), undefined))
      .filter((q) => q.eq(q.field("depotId"), undefined))
      .order("desc")
      .collect();

    return { arrivages: result, standaloneItems };
  },
});

export const historyStats = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    await requireCrmPermission(ctx, "arrivages", "read");

    const items = await ctx.db
      .query("arrivageItems")
      .withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate))
      .collect();

    const totalWeight = items.reduce((s, i) => s + (i.weightKg ?? 0) * i.quantity, 0);
    const totalValue = items.reduce((s, i) => s + (i.price ?? 0) * i.quantity, 0);
    const totalArticles = items.reduce((s, i) => s + i.quantity, 0);

    // Use accumulators with plain-string keys for internal computation only
    const catMap: Record<string, number> = {};
    const orientMap: Record<string, number> = {};
    const fluxMap: Record<string, number> = {};
    const originMap: Record<string, number> = {};

    for (const item of items) {
      catMap[item.category] = (catMap[item.category] ?? 0) + item.quantity;
      orientMap[item.orientation] = (orientMap[item.orientation] ?? 0) + item.quantity;
      if (item.flux) fluxMap[item.flux] = (fluxMap[item.flux] ?? 0) + item.quantity;
      originMap[item.origin] = (originMap[item.origin] ?? 0) + item.quantity;
    }

    // Convert to arrays so we never use non-ASCII strings as Convex field names
    const toEntries = (m: Record<string, number>) =>
      Object.entries(m).map(([label, count]) => ({ label, count }));

    const arrivageCount = await ctx.db
      .query("arrivages")
      .withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate))
      .collect()
      .then((a) => a.length);

    return {
      arrivageCount,
      totalArticles,
      totalWeight: Math.round(totalWeight * 10) / 10,
      totalValue: Math.round(totalValue * 100) / 100,
      byCategory: toEntries(catMap),
      byOrientation: toEntries(orientMap),
      byFlux: toEntries(fluxMap),
      byOrigin: toEntries(originMap),
    };
  },
});

// ─── Sorties d'articles arrivés ────────────────────────────────────────────────

/** Motifs de sortie d'un article du stock. */
export const EXIT_MOTIFS = [
  "Vente",
  "Don",
  "Déchèterie",
  "Recyclage / Filière",
  "Casse / Perte",
  "Autre",
] as const;

function itemDisplayName(item: {
  labelInfo?: string;
  category: string;
  subcategory?: string;
}) {
  return (
    item.labelInfo?.trim() ||
    [item.category, item.subcategory].filter(Boolean).join(" – ")
  );
}

/** Recherche d'articles arrivés et non encore sortis (réf., nom, catégorie). */
export const searchItemsForExit = query({
  args: { searchText: v.string() },
  handler: async (ctx, { searchText }) => {
    await requireCrmPermission(ctx, "sorties", "read");
    const q = searchText.trim().toLowerCase();
    if (q.length < 2) return [];

    const items = await ctx.db
      .query("arrivageItems")
      .withIndex("by_date")
      .order("desc")
      .take(800);

    return items
      .filter((i) => !i.exitedAt)
      .filter((i) =>
        [i.reference, i.labelInfo, i.category, i.subcategory]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(q)),
      )
      .slice(0, 25)
      .map((i) => ({
        _id: i._id,
        reference: i.reference,
        name: itemDisplayName(i),
        category: i.category,
        subcategory: i.subcategory ?? null,
        weightKg: i.weightKg ?? null,
        quantity: i.quantity,
        date: i.date,
      }));
  },
});

/** Récupère un article arrivé non sorti par sa référence exacte (scan). */
export const getItemByReference = query({
  args: { reference: v.string() },
  handler: async (ctx, { reference }) => {
    await requireCrmPermission(ctx, "sorties", "read");
    const item = await ctx.db
      .query("arrivageItems")
      .withIndex("by_reference", (q) => q.eq("reference", reference.trim()))
      .first();
    if (!item || item.exitedAt) return null;
    return {
      _id: item._id,
      reference: item.reference,
      name: itemDisplayName(item),
      category: item.category,
      subcategory: item.subcategory ?? null,
      weightKg: item.weightKg ?? null,
      quantity: item.quantity,
      date: item.date,
    };
  },
});

/** Enregistre la sortie d'un article arrivé (motif + date). */
export const recordExit = mutation({
  args: { itemId: v.id("arrivageItems"), motif: v.string() },
  handler: async (ctx, { itemId, motif }) => {
    await requireCrmPermission(ctx, "sorties", "create");
    const item = await ctx.db.get(itemId);
    if (!item) throw new Error("Article introuvable.");
    if (item.exitedAt) throw new Error("Cet article est déjà sorti.");
    await ctx.db.patch(itemId, {
      exitedAt: Date.now(),
      exitMotif: motif.trim() || "Autre",
    });
  },
});

/** Enregistre une sortie de flux (papier, livres, textile…) sans scan d'article individuel. */
export const recordFlowExit = mutation({
  args: {
    date: v.number(),
    origin: originValidator,
    category: v.string(),
    weightKg: v.number(),
    motif: v.string(),
    orientation: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "sorties", "create");
    const reference = makeReference(args.category);
    const labelInfo = args.note?.trim()
      ? `Flux ${args.category} - ${args.note.trim()}`
      : `Flux ${args.category}`;
    const itemId = await ctx.db.insert("arrivageItems", {
      date: args.date,
      origin: args.origin,
      category: args.category,
      flux: "sortie-flux",
      orientation: args.orientation,
      weightKg: args.weightKg,
      quantity: 1,
      labelInfo,
      reference,
      createdAt: Date.now(),
      exitedAt: Date.now(),
      exitMotif: args.motif.trim() || "Autre",
    });
    return { itemId, reference };
  },
});

/** Annule une sortie (remet l'article en stock). */
export const undoExit = mutation({
  args: { itemId: v.id("arrivageItems") },
  handler: async (ctx, { itemId }) => {
    await requireCrmPermission(ctx, "sorties", "create");
    await ctx.db.patch(itemId, { exitedAt: undefined, exitMotif: undefined });
  },
});

/** Sorties récentes + compteurs (articles + poids total) sur une période. */
export const listExits = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    await requireCrmPermission(ctx, "sorties", "read");
    const items = (
      await ctx.db.query("arrivageItems").withIndex("by_date").order("desc").take(2000)
    ).filter(
      (i) => i.exitedAt && i.exitedAt >= startDate && i.exitedAt <= endDate,
    );

    const totalArticles = items.reduce((s, i) => s + i.quantity, 0);
    const totalWeight = items.reduce((s, i) => s + (i.weightKg ?? 0) * i.quantity, 0);
    const byMotif: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    const byOrientation: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const i of items) {
      const m = i.exitMotif ?? "Autre";
      byMotif[m] = (byMotif[m] ?? 0) + i.quantity;
      byOrigin[i.origin] = (byOrigin[i.origin] ?? 0) + i.quantity;
      byOrientation[i.orientation] = (byOrientation[i.orientation] ?? 0) + i.quantity;
      byCategory[i.category] = (byCategory[i.category] ?? 0) + i.quantity;
    }
    const toEntries = (m: Record<string, number>) =>
      Object.entries(m)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);

    return {
      totalArticles,
      totalWeight: Math.round(totalWeight * 10) / 10,
      byMotif: toEntries(byMotif),
      byOrigin: toEntries(byOrigin),
      byOrientation: toEntries(byOrientation),
      byCategory: toEntries(byCategory),
      recent: items.slice(0, 60).map((i) => ({
        _id: i._id,
        reference: i.reference,
        name: itemDisplayName(i),
        motif: i.exitMotif ?? "Autre",
        weightKg: i.weightKg ?? null,
        quantity: i.quantity,
        exitedAt: i.exitedAt!,
      })),
    };
  },
});

/** Historique des dernières arrivées (objets entrants récents). */
export const listRecentArrivals = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "arrivages", "read");
    const items = await ctx.db
      .query("arrivageItems")
      .withIndex("by_date")
      .order("desc")
      .take(15);
    return items.map((i) => ({
      _id: i._id,
      reference: i.reference,
      name:
        i.labelInfo?.trim() ||
        [i.category, i.subcategory].filter(Boolean).join(" – "),
      origin: i.origin,
      orientation: i.orientation,
      weightKg: i.weightKg ?? null,
      quantity: i.quantity,
      createdAt: i.createdAt,
      exited: Boolean(i.exitedAt),
    }));
  },
});

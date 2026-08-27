import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { requireCrmPermission } from "./lib";
import type { Id } from "./_generated/dataModel";
import { scheduleStripeSync } from "./stripeCatalog";
import { createInShopSaleRequest } from "./requests";

const saleItemValidator = v.object({
  articleId: v.id("articles"),
  title: v.string(),
  price: v.number(),
});

async function nextReceiptNumber(ctx: MutationCtx) {
  const all = await ctx.db.query("ventes").collect();
  const n = all.length + 1;
  return `TK-${String(n).padStart(5, "0")}`;
}

async function recordVente(
  ctx: MutationCtx,
  args: {
    items: { articleId: Id<"articles">; title: string; price: number }[];
    discountAmount?: number;
    paymentMethod: "especes" | "cb" | "cheque" | "cheque_cadeau" | "virement";
    amountTendered?: number;
  },
) {
  const subtotal = args.items.reduce((s, i) => s + i.price, 0);
  const discount = args.discountAmount ?? 0;
  const total = Math.max(0, subtotal - discount);
  const change =
    args.amountTendered !== undefined
      ? Math.max(0, args.amountTendered - total)
      : undefined;

  const receiptNumber = await nextReceiptNumber(ctx);

  const venteId = await ctx.db.insert("ventes", {
    date: Date.now(),
    receiptNumber,
    items: args.items,
    subtotal,
    discountAmount: discount > 0 ? discount : undefined,
    total,
    paymentMethod: args.paymentMethod,
    amountTendered: args.amountTendered,
    change,
    createdAt: Date.now(),
  });

  await Promise.all(
    args.items.map(async (item) => {
      await ctx.db.patch(item.articleId, { status: "vendu" });
      await scheduleStripeSync(ctx, item.articleId);
    }),
  );

  return { venteId, receiptNumber, total, change };
}

export const createVente = mutation({
  args: {
    items: v.array(saleItemValidator),
    discountAmount: v.optional(v.number()),
    paymentMethod: v.union(
      v.literal("especes"),
      v.literal("cb"),
      v.literal("cheque"),
      v.literal("cheque_cadeau"),
      v.literal("virement"),
    ),
    amountTendered: v.optional(v.number()),
    /**
     * Client de la vente. Renseigné, la vente crée en plus une demande
     * boutique achevée : c'est ce qui fait apparaître l'achat dans
     * l'historique du client et dans le CRM.
     */
    customer: v.optional(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.string(),
        phone: v.optional(v.string()),
      }),
    ),
    stripePaymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "caisse", "checkout");
    const { customer, stripePaymentIntentId, ...sale } = args;
    const result = await recordVente(ctx, sale);

    let requestId = null;
    if (customer) {
      requestId = await createInShopSaleRequest(ctx, {
        customer: {
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          phone: customer.phone ?? "",
        },
        articles: args.items.map((item) => ({
          articleId: item.articleId,
          articleTitle: item.title,
        })),
        total: result.total,
        // Le CRM ne connaît que deux moyens de paiement sur une demande ;
        // tout ce qui n'est pas de l'espèce est traité comme une carte.
        paymentMethod: args.paymentMethod === "especes" ? "especes" : "cb",
        receiptNumber: result.receiptNumber,
        stripePaymentIntentId,
      });
    }

    return { ...result, requestId };
  },
});

export const listVentes = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    await requireCrmPermission(ctx, "caisse", "read");
    return await ctx.db
      .query("ventes")
      .withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate))
      .order("desc")
      .collect();
  },
});

export const ventesStats = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    await requireCrmPermission(ctx, "caisse", "read");
    const ventes = await ctx.db
      .query("ventes")
      .withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate))
      .collect();

    const totalRevenue = ventes.reduce((s, v) => s + v.total, 0);
    const totalArticles = ventes.reduce((s, v) => s + v.items.length, 0);
    const byPayment: Record<string, number> = {};
    for (const v of ventes) {
      byPayment[v.paymentMethod] = (byPayment[v.paymentMethod] ?? 0) + v.total;
    }

    return {
      count: ventes.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalArticles,
      byPayment,
    };
  },
});

export const getArticleByReference = query({
  args: { reference: v.string() },
  handler: async (ctx, { reference }) => {
    await requireCrmPermission(ctx, "caisse", "read");
    const found = await ctx.db
      .query("articles")
      .withIndex("by_internalReference", (q) => q.eq("internalReference", reference))
      .first();
    if (!found) return null;
    const imageUrls = await Promise.all(
      found.images.map((id: Id<"_storage">) => ctx.storage.getUrl(id)),
    );
    return { ...found, imageUrls: imageUrls.filter(Boolean) as string[] };
  },
});

export const searchArticlesForSale = query({
  args: { searchText: v.string() },
  handler: async (ctx, { searchText }) => {
    await requireCrmPermission(ctx, "caisse", "read");
    const normalized = searchText.trim().toLowerCase();
    if (normalized.length < 2) {
      return [];
    }

    const digitSearch = searchText.replace(/\D/g, "");
    const articles = await ctx.db
      .query("articles")
      .withIndex("by_status", (q) => q.eq("status", "disponible"))
      .order("desc")
      .take(50);

    const matches = articles
      .filter((article) => {
        const haystack = [
          article.title,
          article.internalReference,
          article.category,
          article.subcategory,
        ]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.trim().toLowerCase());

        const textMatch = haystack.some((value) => value.includes(normalized));
        const digitMatch =
          digitSearch.length > 0 &&
          [article.internalReference]
            .filter((value): value is string => Boolean(value))
            .map((value) => value.replace(/\D/g, ""))
            .some((value) => value.includes(digitSearch));

        return textMatch || digitMatch;
      })
      .slice(0, 8);

    return await Promise.all(
      matches.map(async (article) => {
        const imageUrls = await Promise.all(
          article.images.map((id: Id<"_storage">) => ctx.storage.getUrl(id)),
        );
        return {
          _id: article._id,
          title: article.title,
          price: article.price,
          reference: article.internalReference ?? "",
          imageUrls: imageUrls.filter(Boolean) as string[],
        };
      }),
    );
  },
});

const saleCustomerValidator = v.object({
  firstName: v.string(),
  lastName: v.string(),
  email: v.string(),
  phone: v.optional(v.string()),
});

export const createStripeCheckoutDraft = internalMutation({
  args: {
    items: v.array(saleItemValidator),
    discountAmount: v.optional(v.number()),
    createdBy: v.string(),
    customer: v.optional(saleCustomerValidator),
  },
  handler: async (ctx, args) => {
    const subtotal = args.items.reduce((sum, item) => sum + item.price, 0);
    const total = Math.max(0, subtotal - (args.discountAmount ?? 0));
    return await ctx.db.insert("stripeCheckoutDrafts", {
      items: args.items,
      discountAmount: args.discountAmount,
      total,
      createdBy: args.createdBy,
      customer: args.customer,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const attachStripeSessionToDraft = internalMutation({
  args: {
    draftId: v.id("stripeCheckoutDrafts"),
    stripeSessionId: v.string(),
  },
  handler: async (ctx, { draftId, stripeSessionId }) => {
    await ctx.db.patch(draftId, { stripeSessionId });
    return null;
  },
});

export const finalizeStripeCheckoutDraft = internalMutation({
  args: {
    draftId: v.id("stripeCheckoutDrafts"),
    stripeSessionId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, { draftId, stripeSessionId, stripePaymentIntentId }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) {
      throw new Error("Brouillon Stripe introuvable.");
    }

    if (draft.status === "completed" && draft.receiptNumber && draft.venteId) {
      return {
        venteId: draft.venteId,
        receiptNumber: draft.receiptNumber,
        total: draft.total,
        requestId: draft.requestId ?? null,
      };
    }

    if (draft.stripeSessionId && draft.stripeSessionId !== stripeSessionId) {
      throw new Error("Cette session Stripe ne correspond pas au brouillon enregistré.");
    }

    const result = await recordVente(ctx as MutationCtx, {
      items: draft.items,
      discountAmount: draft.discountAmount,
      paymentMethod: "cb",
    });

    const requestId = draft.customer
      ? await createInShopSaleRequest(ctx as MutationCtx, {
          customer: {
            firstName: draft.customer.firstName,
            lastName: draft.customer.lastName,
            email: draft.customer.email,
            phone: draft.customer.phone ?? "",
          },
          articles: draft.items.map((item) => ({
            articleId: item.articleId,
            articleTitle: item.title,
          })),
          total: result.total,
          paymentMethod: "cb",
          receiptNumber: result.receiptNumber,
          stripePaymentIntentId,
        })
      : null;

    await ctx.db.patch(draftId, {
      stripeSessionId,
      stripePaymentIntentId,
      status: "completed",
      venteId: result.venteId,
      receiptNumber: result.receiptNumber,
      ...(requestId ? { requestId } : {}),
      completedAt: Date.now(),
    });

    return { ...result, requestId };
  },
});

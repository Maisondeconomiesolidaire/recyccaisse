import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  env,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { requireCrmPermission } from "./lib";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Liens de paiement — boutique Recycapp.
 *
 * Deux usages depuis le CRM :
 *  - « Envoyer le lien de paiement » sur une demande boutique : le client
 *    reçoit par email un lien vers une page de paiement identique au checkout
 *    de la boutique ;
 *  - « Lien de paiement » sur un article : on copie l'URL pour l'envoyer
 *    soi-même (SMS, WhatsApp, messagerie…).
 *
 * Le montant est figé à la création et n'est jamais transmis par le navigateur.
 */

const TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]).join("");
}

function shopUrl() {
  return (env.APP_URL ?? "https://recycapp.groupemes.fr").replace(/\/$/, "");
}

export function paymentLinkUrl(token: string) {
  return `${shopUrl()}/paiement/${token}`;
}

/**
 * Articles facturables et somme correspondante.
 *
 * `allowSold` est utilisé quand le lien vient d'une demande existante : ses
 * articles ont souvent déjà été basculés en « vendu » au moment de la mise de
 * côté, et c'est justement cette demande qu'il s'agit de faire régler. Pour un
 * lien ad hoc, en revanche, un article vendu ne doit pas être revendu.
 */
async function priceArticles(
  ctx: QueryCtx | MutationCtx,
  articleIds: Id<"articles">[],
  { allowSold = false }: { allowSold?: boolean } = {},
) {
  const articles: Doc<"articles">[] = [];
  let amount = 0;
  for (const articleId of articleIds) {
    const article = await ctx.db.get(articleId);
    if (!article) throw new ConvexError("Article introuvable.");
    if (article.status === "vendu" && !allowSold) {
      throw new ConvexError(
        `« ${article.title} » est déjà vendu : impossible d'en générer un lien de paiement.`,
      );
    }
    articles.push(article);
    amount += article.price;
  }
  if (articles.length === 0) {
    throw new ConvexError("Aucun article à facturer sur cette demande.");
  }
  if (amount <= 0) {
    throw new ConvexError("Le montant du lien doit être supérieur à 0 €.");
  }
  return { articles, amount: Math.round(amount * 100) / 100 };
}

/* ─── CRM ─────────────────────────────────────────────────────────────────── */

/**
 * Crée un lien de paiement (ou renvoie celui déjà en attente pour la même
 * demande, pour ne pas multiplier les URL valides sur un même dossier).
 */
export const create = mutation({
  args: {
    articleIds: v.optional(v.array(v.id("articles"))),
    requestId: v.optional(v.id("requests")),
  },
  handler: async (ctx, { articleIds, requestId }) => {
    await requireCrmPermission(ctx, requestId ? "demandes" : "articles", "update");
    const identity = await ctx.auth.getUserIdentity();

    let targetIds = articleIds ?? [];
    let customer: Doc<"requests">["customer"] | undefined;

    if (requestId) {
      const request = await ctx.db.get(requestId);
      if (!request) throw new ConvexError("Demande introuvable.");
      if (request.payment?.status === "paid") {
        throw new ConvexError("Cette demande est déjà payée.");
      }
      customer = request.customer;
      if (targetIds.length === 0) {
        targetIds = (request.articles ?? []).map((a) => a.articleId);
        if (targetIds.length === 0 && request.article) {
          targetIds = [request.article.articleId];
        }
      }

      const existing = await ctx.db
        .query("paymentLinks")
        .withIndex("by_request", (q) => q.eq("requestId", requestId))
        .collect();
      const pending = existing.find((link) => link.status === "pending");
      if (pending) return { token: pending.token, amount: pending.amount, reused: true };
    }

    const { amount } = await priceArticles(ctx, targetIds, {
      allowSold: Boolean(requestId),
    });
    const token = generateToken();
    await ctx.db.insert("paymentLinks", {
      token,
      articleIds: targetIds,
      requestId,
      customer,
      amount,
      status: "pending",
      createdAt: Date.now(),
      createdBy: identity?.email ?? undefined,
    });
    return { token, amount, reused: false };
  },
});

/** Liens rattachés à une demande, pour l'affichage CRM. */
export const listForRequest = query({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    await requireCrmPermission(ctx, "demandes", "read");
    const links = await ctx.db
      .query("paymentLinks")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .order("desc")
      .collect();
    return links.map((link) => ({ ...link, url: paymentLinkUrl(link.token) }));
  },
});

export const markSent = internalMutation({
  args: { linkId: v.id("paymentLinks") },
  handler: async (ctx, { linkId }) => {
    await ctx.db.patch(linkId, { sentAt: Date.now() });
  },
});

export const byTokenInternal = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) =>
    ctx.db
      .query("paymentLinks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique(),
});

/** Envoie le lien par email au client de la demande. */
export const sendByEmail = action({
  args: { requestId: v.id("requests") },
  handler: async (
    ctx,
    { requestId },
  ): Promise<{ token: string; email: string }> => {
    const created: { token: string; amount: number; reused: boolean } =
      await ctx.runMutation(api.paymentLinks.create, { requestId });

    const link = await ctx.runQuery(internal.paymentLinks.byTokenInternal, {
      token: created.token,
    });
    if (!link) throw new ConvexError("Lien de paiement introuvable.");
    const email = link.customer?.email;
    if (!email) throw new ConvexError("Cette demande n'a pas d'adresse email : renseignez-la avant d'envoyer le lien.");

    const details = await ctx.runQuery(internal.paymentLinks.articleTitles, {
      token: created.token,
    });

    await ctx.runAction(internal.emails.sendPaymentLink, {
      email,
      name: [link.customer?.firstName, link.customer?.lastName]
        .filter(Boolean)
        .join(" ")
        .trim(),
      amount: link.amount,
      url: paymentLinkUrl(created.token),
      articleTitles: details.titles,
    });
    await ctx.runMutation(internal.paymentLinks.markSent, { linkId: link._id });
    return { token: created.token, email };
  },
});

export const articleTitles = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const link = await ctx.db
      .query("paymentLinks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    const titles: string[] = [];
    for (const articleId of link?.articleIds ?? []) {
      const article = await ctx.db.get(articleId);
      if (article) titles.push(article.title);
    }
    return { titles };
  },
});

/* ─── Page publique ───────────────────────────────────────────────────────── */

/** Contenu du lien, sans authentification : c'est le token qui fait foi. */
export const getPublic = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const link = await ctx.db
      .query("paymentLinks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!link) return null;

    const articles = [];
    for (const articleId of link.articleIds) {
      const article = await ctx.db.get(articleId);
      if (!article) continue;
      articles.push({
        id: article._id as string,
        title: article.title,
        price: article.price,
        imageUrl: article.images[0]
          ? await ctx.storage.getUrl(article.images[0])
          : null,
        sold: article.status === "vendu",
      });
    }

    return {
      status: link.status,
      amount: link.amount,
      articles,
      // Uniquement de quoi personnaliser la page : pas d'adresse ni de téléphone.
      customerFirstName: link.customer?.firstName,
      customerEmail: link.customer?.email,
      paidAt: link.paidAt,
    };
  },
});

/** Enregistre le PaymentIntent en cours sur le lien. */
export const attachPaymentIntent = internalMutation({
  args: { token: v.string(), stripePaymentIntentId: v.string() },
  handler: async (ctx, { token, stripePaymentIntentId }) => {
    const link = await ctx.db
      .query("paymentLinks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!link) throw new ConvexError("Lien de paiement introuvable.");
    await ctx.db.patch(link._id, { stripePaymentIntentId });
  },
});

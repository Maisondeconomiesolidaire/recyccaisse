import { ConvexError, v } from "convex/values";
import { action, env } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { accessAllows } from "./lib";
import type { Id } from "./_generated/dataModel";

function buildStripeBody(params: Record<string, string>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    body.append(key, value);
  }
  return body;
}

function buildCheckoutReturnUrl(
  baseUrl: string,
  params: Record<string, string>,
  includeSessionId = false,
) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let result = url.toString();
  if (includeSessionId) {
    const separator = result.includes("?") ? "&" : "?";
    result += `${separator}session_id={CHECKOUT_SESSION_ID}`;
  }
  return result;
}

export const startTestCheckout = action({
  args: {
    items: v.array(
      v.object({
        articleId: v.id("articles"),
        title: v.string(),
        price: v.number(),
      }),
    ),
    discountAmount: v.optional(v.number()),
    returnUrl: v.string(),
    /** Client de la vente : la demande boutique est créée à l'encaissement. */
    customer: v.optional(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.string(),
        phone: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "caisse", "checkout")) {
      throw new Error("Accès CRM insuffisant.");
    }
    const secretKey = env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error(
        "STRIPE_SECRET_KEY n'est pas configurée côté Convex. Ajoutez votre clé Stripe test avant d'encaisser par carte.",
      );
    }

    const draftId: Id<"stripeCheckoutDrafts"> = await ctx.runMutation(
      internal.ventes.createStripeCheckoutDraft,
      {
        items: args.items,
        discountAmount: args.discountAmount,
        createdBy: access.email ?? "caisse",
        customer: args.customer,
      },
    );

    const subtotal = args.items.reduce((sum, item) => sum + item.price, 0);
    const total = Math.max(0, subtotal - (args.discountAmount ?? 0));
    if (total <= 0) {
      throw new Error(
        "Le montant doit être supérieur à 0 € pour un paiement Stripe test.",
      );
    }
    const successUrl = buildCheckoutReturnUrl(
      args.returnUrl,
      {
        stripe_status: "success",
        draft_id: draftId,
      },
      true,
    );

    const cancelUrl = buildCheckoutReturnUrl(args.returnUrl, {
      stripe_status: "cancelled",
      draft_id: draftId,
    });

    const itemSummary = args.items
      .map((item) => item.title.trim())
      .slice(0, 3)
      .join(", ");
    const description =
      args.items.length > 3
        ? `${itemSummary}...`
        : itemSummary || "Paiement boutique";

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: buildStripeBody({
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        "payment_method_types[0]": "card",
        locale: "fr",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "eur",
        "line_items[0][price_data][unit_amount]": String(Math.round(total * 100)),
        "line_items[0][price_data][product_data][name]": "Paiement boutique GDR",
        "line_items[0][price_data][product_data][description]": description,
        "metadata[draftId]": draftId,
      }),
    });

    const payload = (await response.json()) as {
      error?: { message?: string };
      id?: string;
      url?: string;
    };

    if (!response.ok || !payload.id || !payload.url) {
      throw new Error(
        payload.error?.message ||
          "Stripe n'a pas pu créer la session de paiement test.",
      );
    }

    await ctx.runMutation(internal.ventes.attachStripeSessionToDraft, {
      draftId,
      stripeSessionId: payload.id,
    });

    return { checkoutUrl: payload.url };
  },
});

export const confirmTestCheckout = action({
  args: {
    draftId: v.id("stripeCheckoutDrafts"),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "caisse", "checkout")) {
      throw new Error("Accès CRM insuffisant.");
    }
    if (args.sessionId === "{CHECKOUT_SESSION_ID}") {
      throw new Error(
        "Stripe n'a pas remplacé le session_id dans l'URL de retour. Relancez le paiement après la mise à jour du flux Checkout.",
      );
    }
    const secretKey = env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error(
        "STRIPE_SECRET_KEY n'est pas configurée côté Convex. Impossible de vérifier le paiement Stripe.",
      );
    }

    const sessionResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${args.sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      },
    );
    const session = (await sessionResponse.json()) as {
      id?: string;
      metadata?: { draftId?: string };
      payment_status?: string;
      payment_intent?: string;
      status?: string;
      error?: { message?: string };
    };

    if (!sessionResponse.ok || !session.id) {
      throw new Error(
        session.error?.message ||
          "Impossible de récupérer la session Stripe de test.",
      );
    }

    if (session.metadata?.draftId !== args.draftId) {
      throw new Error("Le paiement Stripe ne correspond pas au brouillon attendu.");
    }

    if (session.payment_status !== "paid") {
      throw new Error("Le paiement Stripe test n'est pas marqué comme payé.");
    }

    const result: {
      venteId: Id<"ventes">;
      receiptNumber: string;
      total: number;
      change?: number;
      requestId: Id<"requests"> | null;
    } = await ctx.runMutation(internal.ventes.finalizeStripeCheckoutDraft, {
      draftId: args.draftId,
      stripeSessionId: session.id,
      stripePaymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : undefined,
    });

    return result;
  },
});

export const startPublicCartCheckout = action({
  args: {
    articleIds: v.array(v.id("articles")),
    customer: v.object({
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      phone: v.string(),
      address: v.optional(v.string()),
      postalCode: v.optional(v.string()),
      city: v.optional(v.string()),
    }),
    comment: v.optional(v.string()),
    returnUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const secretKey = env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error(
        "STRIPE_SECRET_KEY n'est pas configurée côté Convex. Ajoutez votre clé Stripe test avant d'activer le paiement en ligne.",
      );
    }

    const draft: { draftId: Id<"publicStripeCheckoutDrafts">; total: number } =
      await ctx.runMutation(
      internal.requests.createPublicStripeCheckoutDraft,
      {
        articleIds: args.articleIds,
        customer: args.customer,
        comment: args.comment,
      },
    );

    if (draft.total <= 0) {
      throw new Error(
        "Le montant du panier doit être supérieur à 0 € pour un paiement Stripe test.",
      );
    }

    const successUrl = buildCheckoutReturnUrl(
      args.returnUrl,
      {
        stripe_status: "success",
        draft_id: draft.draftId,
      },
      true,
    );

    const cancelUrl = buildCheckoutReturnUrl(args.returnUrl, {
      stripe_status: "cancelled",
      draft_id: draft.draftId,
    });

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: buildStripeBody({
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        "payment_method_types[0]": "card",
        locale: "fr",
        customer_email: args.customer.email,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "eur",
        "line_items[0][price_data][unit_amount]": String(Math.round(draft.total * 100)),
        "line_items[0][price_data][product_data][name]": "Commande boutique en ligne GDR",
        "line_items[0][price_data][product_data][description]": `${args.articleIds.length} article${args.articleIds.length > 1 ? "s" : ""} depuis la boutique en ligne`,
        "metadata[draftId]": draft.draftId,
      }),
    });

    const payload = (await response.json()) as {
      error?: { message?: string };
      id?: string;
      url?: string;
    };

    if (!response.ok || !payload.id || !payload.url) {
      throw new Error(
        payload.error?.message ||
          "Stripe n'a pas pu créer la session de paiement test.",
      );
    }

    await ctx.runMutation(internal.requests.attachStripeSessionToPublicDraft, {
      draftId: draft.draftId,
      stripeSessionId: payload.id,
    });

    return { checkoutUrl: payload.url };
  },
});

export const confirmPublicCartCheckout = action({
  args: {
    draftId: v.id("publicStripeCheckoutDrafts"),
    sessionId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ requestId: Id<"requests"> }> => {
    if (args.sessionId === "{CHECKOUT_SESSION_ID}") {
      throw new Error(
        "Stripe n'a pas remplacé le session_id dans l'URL de retour. Relancez le paiement après la mise à jour du flux Checkout.",
      );
    }
    const secretKey = env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error(
        "STRIPE_SECRET_KEY n'est pas configurée côté Convex. Impossible de vérifier le paiement Stripe.",
      );
    }

    const sessionResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${args.sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      },
    );
    const session = (await sessionResponse.json()) as {
      id?: string;
      metadata?: { draftId?: string };
      payment_status?: string;
      payment_intent?: string;
      error?: { message?: string };
    };

    if (!sessionResponse.ok || !session.id) {
      throw new Error(
        session.error?.message ||
          "Impossible de récupérer la session Stripe de test.",
      );
    }

    if (session.metadata?.draftId !== args.draftId) {
      throw new Error("Le paiement Stripe ne correspond pas au panier attendu.");
    }

    if (session.payment_status !== "paid") {
      throw new Error("Le paiement Stripe test n'est pas marqué comme payé.");
    }

    const result: { requestId: Id<"requests"> } = await ctx.runMutation(
      internal.requests.finalizePublicStripeCheckout,
      {
      draftId: args.draftId,
      stripeSessionId: session.id,
      stripePaymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : undefined,
      },
    );

    return result;
  },
});

/* ─── Boutique en ligne : paiement custom (Payment Element) ────────────────
 *
 * Flux « custom » : au lieu de rediriger vers la page Checkout hébergée par
 * Stripe, l'app crée un PaymentIntent et affiche son propre écran de paiement.
 * Stripe ne voit jamais la carte transiter par nos serveurs — le Payment
 * Element parle directement à Stripe avec le `client_secret` renvoyé ici.
 */

/** Clé Stripe de la boutique Recycapp (distincte de la caisse et de Bennes Pro). */
export function recycappSecretKey(): string {
  const key = env.RECYCAPP_STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "Paiement en ligne indisponible : RECYCAPP_STRIPE_SECRET_KEY n'est pas configurée côté Convex.",
    );
  }
  return key;
}

export async function stripeRequest<T>(
  path: string,
  secretKey: string,
  body?: Record<string, string>,
): Promise<T> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body: buildStripeBody(body) } : {}),
  });
  const payload = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(payload.error?.message || "Erreur Stripe.");
  }
  return payload;
}

/**
 * Prépare le paiement d'un panier : verrouille le montant côté serveur (le
 * client n'envoie que les identifiants d'articles) et renvoie le `client_secret`
 * que le Payment Element utilisera.
 */
export const createPublicCartPaymentIntent = action({
  args: {
    articleIds: v.array(v.id("articles")),
    customer: v.object({
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      phone: v.string(),
      address: v.optional(v.string()),
      postalCode: v.optional(v.string()),
      city: v.optional(v.string()),
    }),
    comment: v.optional(v.string()),
    /** Bon de réduction saisi au panier. La remise est appliquée côté serveur. */
    discountCode: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    draftId: Id<"publicStripeCheckoutDrafts">;
    clientSecret: string;
    paymentIntentId: string;
    total: number;
    subtotal: number;
    discountPercent?: number;
    discountAmount?: number;
  }> => {
    const secretKey = recycappSecretKey();

    const draft: {
      draftId: Id<"publicStripeCheckoutDrafts">;
      total: number;
      subtotal: number;
      discountPercent?: number;
      discountAmount?: number;
    } = await ctx.runMutation(internal.requests.createPublicStripeCheckoutDraft, {
      articleIds: args.articleIds,
      customer: args.customer,
      comment: args.comment,
      discountCode: args.discountCode,
    });

    if (draft.total <= 0) {
      throw new ConvexError("Le montant du panier doit être supérieur à 0 €.");
    }

    const fullName = `${args.customer.firstName} ${args.customer.lastName}`.trim();
    const intent = await stripeRequest<{ id: string; client_secret: string }>(
      "payment_intents",
      secretKey,
      {
        amount: String(Math.round(draft.total * 100)),
        currency: "eur",
        "automatic_payment_methods[enabled]": "true",
        description: `Boutique en ligne — ${args.articleIds.length} article${
          args.articleIds.length > 1 ? "s" : ""
        }`,
        receipt_email: args.customer.email,
        "shipping[name]": fullName || args.customer.email,
        "shipping[phone]": args.customer.phone,
        "shipping[address][line1]": args.customer.address ?? "",
        "shipping[address][postal_code]": args.customer.postalCode ?? "",
        "shipping[address][city]": args.customer.city ?? "",
        "shipping[address][country]": "FR",
        "metadata[draftId]": draft.draftId,
        "metadata[source]": "recycapp-boutique",
      },
    );

    await ctx.runMutation(internal.requests.attachStripePaymentIntentToPublicDraft, {
      draftId: draft.draftId,
      stripePaymentIntentId: intent.id,
    });

    return {
      draftId: draft.draftId,
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      total: draft.total,
      subtotal: draft.subtotal,
      discountPercent: draft.discountPercent,
      discountAmount: draft.discountAmount,
    };
  },
});

/**
 * Confirme la commande APRÈS encaissement : le statut est relu chez Stripe, on
 * ne fait jamais confiance au navigateur pour dire qu'un paiement a réussi.
 */
export const confirmPublicCartPayment = action({
  args: {
    draftId: v.id("publicStripeCheckoutDrafts"),
    paymentIntentId: v.string(),
  },
  handler: async (ctx, args): Promise<{ requestId: Id<"requests"> }> => {
    const secretKey = recycappSecretKey();

    const intent = await stripeRequest<{
      id: string;
      status: string;
      amount_received?: number;
      metadata?: { draftId?: string };
    }>(`payment_intents/${args.paymentIntentId}`, secretKey);

    if (intent.metadata?.draftId !== args.draftId) {
      throw new ConvexError("Ce paiement ne correspond pas au panier attendu.");
    }
    if (intent.status !== "succeeded") {
      throw new ConvexError(
        "Le paiement n'est pas confirmé par Stripe. Aucune commande n'a été enregistrée.",
      );
    }

    return await ctx.runMutation(internal.requests.finalizePublicStripeCheckout, {
      draftId: args.draftId,
      stripePaymentIntentId: intent.id,
    });
  },
});

/* ─── Liens de paiement (CRM → client) ────────────────────────────────────── */

/** Prépare le paiement d'un lien : le montant vient du lien, jamais du client. */
export const createPaymentIntentForLink = action({
  args: {
    token: v.string(),
    customer: v.optional(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.string(),
        phone: v.string(),
      }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ clientSecret: string; paymentIntentId: string; amount: number }> => {
    const secretKey = recycappSecretKey();

    const link = await ctx.runQuery(internal.paymentLinks.byTokenInternal, {
      token: args.token,
    });
    if (!link) throw new ConvexError("Ce lien de paiement n'existe pas ou a été supprimé.");
    if (link.status === "paid") throw new ConvexError("Cette commande est déjà réglée.");
    if (link.status === "cancelled") throw new ConvexError("Ce lien de paiement a été annulé.");

    const email = args.customer?.email ?? link.customer?.email;
    const intent = await stripeRequest<{ id: string; client_secret: string }>(
      "payment_intents",
      secretKey,
      {
        amount: String(Math.round(link.amount * 100)),
        currency: "eur",
        "automatic_payment_methods[enabled]": "true",
        description: `Lien de paiement boutique — ${link.articleIds.length} article${
          link.articleIds.length > 1 ? "s" : ""
        }`,
        ...(email ? { receipt_email: email } : {}),
        "metadata[paymentLinkToken]": args.token,
        "metadata[source]": "recycapp-lien-paiement",
      },
    );

    await ctx.runMutation(internal.paymentLinks.attachPaymentIntent, {
      token: args.token,
      stripePaymentIntentId: intent.id,
    });

    return {
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      amount: link.amount,
    };
  },
});

/** Confirme le paiement d'un lien après relecture du statut chez Stripe. */
export const confirmPaymentLink = action({
  args: {
    token: v.string(),
    paymentIntentId: v.string(),
    customer: v.optional(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.string(),
        phone: v.string(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ requestId: Id<"requests"> | null }> => {
    const secretKey = recycappSecretKey();

    const intent = await stripeRequest<{
      id: string;
      status: string;
      metadata?: { paymentLinkToken?: string };
    }>(`payment_intents/${args.paymentIntentId}`, secretKey);

    if (intent.metadata?.paymentLinkToken !== args.token) {
      throw new ConvexError("Ce paiement ne correspond pas au lien attendu.");
    }
    if (intent.status !== "succeeded") {
      throw new ConvexError(
        "Le paiement n'est pas confirmé par Stripe. Aucune commande n'a été enregistrée.",
      );
    }

    return await ctx.runMutation(internal.requests.finalizePaymentLink, {
      token: args.token,
      stripePaymentIntentId: intent.id,
      customer: args.customer,
    });
  },
});

/* ─── Remboursement d'une commande boutique ──────────────────────────────── */

/**
 * Rembourse intégralement le paiement Stripe d'une demande boutique.
 *
 * Deux clés Stripe ont encaissé des commandes au fil du temps : la clé
 * Recycapp (flux actuel, Payment Element et liens de paiement) et l'ancienne
 * clé Checkout. On tente la clé Recycapp puis, seulement si Stripe dit ne pas
 * connaître ce PaymentIntent, l'ancienne — sinon une vieille commande serait
 * irremboursable depuis le CRM.
 */
export const refundBoutiqueRequest = action({
  args: { requestId: v.id("requests") },
  handler: async (
    ctx,
    args,
  ): Promise<{ refundId: string; amount: number }> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "demandes", "update")) {
      throw new ConvexError("Accès CRM insuffisant.");
    }

    const details = await ctx.runQuery(internal.requests.paymentForRefund, {
      requestId: args.requestId,
    });
    if (!details) throw new ConvexError("Demande introuvable.");
    const payment = details.payment;
    if (!payment) {
      throw new ConvexError("Cette demande n'a aucun paiement enregistré.");
    }
    if (payment.stripeRefundId) {
      throw new ConvexError("Cette commande a déjà été remboursée.");
    }
    if (payment.status !== "paid" || !payment.stripePaymentIntentId) {
      throw new ConvexError(
        "Aucun paiement Stripe encaissé : il n'y a rien à rembourser.",
      );
    }

    const paymentIntentId = payment.stripePaymentIntentId;
    const keys = [
      env.RECYCAPP_STRIPE_SECRET_KEY,
      env.STRIPE_SECRET_KEY,
    ].filter((key): key is string => Boolean(key));
    if (keys.length === 0) {
      throw new ConvexError(
        "Remboursement indisponible : aucune clé Stripe n'est configurée côté Convex.",
      );
    }

    let refund: { id: string; amount: number } | null = null;
    let lastError = "";
    for (const secretKey of keys) {
      try {
        refund = await stripeRequest<{ id: string; amount: number }>(
          "refunds",
          secretKey,
          {
            payment_intent: paymentIntentId,
            "metadata[requestId]": String(args.requestId),
            "metadata[source]": "recycapp-crm-remboursement",
          },
        );
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Erreur Stripe.";
        // « No such payment_intent » = mauvaise clé, on essaie la suivante.
        if (!/no such payment_intent/i.test(lastError)) break;
      }
    }

    if (!refund) {
      throw new ConvexError(lastError || "Stripe a refusé le remboursement.");
    }

    const amount = refund.amount / 100;
    await ctx.runMutation(internal.requests.markRefunded, {
      requestId: args.requestId,
      stripeRefundId: refund.id,
      refundedAmount: amount,
      refundedBy: access.email ?? undefined,
    });

    return { refundId: refund.id, amount };
  },
});

/**
 * Encaissement sans contact en boutique, via Stripe Terminal.
 *
 * ⚠️ « Tap to Pay » (le téléphone du vendeur en guise de terminal) n'est PAS
 * accessible depuis un navigateur : Stripe ne le propose que par ses SDK iOS et
 * Android, donc depuis une application native. Ce module pilote donc un LECTEUR
 * Stripe Terminal (WisePOS E, Stripe Reader S700, ou un téléphone enregistré
 * comme lecteur Tap to Pay par l'app Stripe) : le CRM crée le PaymentIntent au
 * montant exact et le pousse sur le lecteur, qui affiche la somme et attend le
 * sans-contact. Aucun montant n'est saisi à la main sur le terminal.
 *
 * Tant qu'aucun lecteur n'est enregistré sur le compte Stripe, la caisse
 * propose les autres moyens de paiement et explique ce qu'il manque.
 *
 * ─── Deux intégrations cohabitent ici ───────────────────────────────────────
 *
 * 1. CAISSE DU CRM (ci-dessous) : intégration « pilotée par serveur ». Elle ne
 *    marche qu'avec un lecteur INTELLIGENT connecté à Internet (WisePOS E,
 *    Stripe Reader S700/S710), poussé depuis le navigateur du CRM.
 *
 * 2. CAISSE MOBILE (fin de fichier) : l'app Android « Recyc Caisse » et son
 *    lecteur BBPOS WisePad 3 en Bluetooth. Un lecteur mobile ne se pilote NI
 *    depuis une page web NI par l'API : il exige un SDK Terminal iOS/Android/
 *    React Native. Ce module ne lui fournit donc que le jeton de connexion, le
 *    montant verrouillé et l'enregistrement de la commande.
 */
import { ConvexError, v } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { accessAllows, normalizeEmail, requireStaff } from "./lib";
import { ensureClerkCustomer } from "./crmClients";
import { findKnownCustomer } from "./kiosk";
import { recycappSecretKey, stripeRequest } from "./stripe";

type Reader = {
  id: string;
  label: string | null;
  status: string | null;
  deviceType: string | null;
};

async function requireCaisseAccess(ctx: ActionCtx) {
  const access = await ctx.runQuery(api.permissions.myAccess, {});
  if (!accessAllows(access, "caisse", "checkout")) {
    throw new ConvexError("Accès CRM insuffisant.");
  }
}

/** Lecteurs enregistrés sur le compte Stripe. Liste vide = pas de matériel. */
export const listReaders = action({
  args: {},
  handler: async (ctx): Promise<Reader[]> => {
    await requireCaisseAccess(ctx);
    const secretKey = recycappSecretKey();
    const response = await stripeRequest<{
      data?: Array<{
        id?: string;
        label?: string;
        status?: string;
        device_type?: string;
      }>;
    }>("terminal/readers?limit=20", secretKey);

    return (response.data ?? [])
      .filter((reader): reader is { id: string } & typeof reader =>
        typeof reader.id === "string",
      )
      .map((reader) => ({
        id: reader.id,
        label: reader.label ?? null,
        status: reader.status ?? null,
        deviceType: reader.device_type ?? null,
      }));
  },
});

/**
 * Pousse le montant sur le lecteur et attend le sans-contact.
 *
 * Le PaymentIntent est créé ici, au montant calculé côté serveur : le vendeur
 * ne tape jamais de somme sur le terminal, donc pas d'écart possible entre le
 * panier et ce qui est débité.
 */
export const collectOnReader = action({
  args: {
    readerId: v.string(),
    amount: v.number(),
    description: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ paymentIntentId: string; status: string }> => {
    await requireCaisseAccess(ctx);
    const secretKey = recycappSecretKey();

    const amountCents = Math.round(args.amount * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw new ConvexError("Le montant à encaisser doit être supérieur à 0 €.");
    }

    const intent = await stripeRequest<{ id: string; status: string }>(
      "payment_intents",
      secretKey,
      {
        amount: String(amountCents),
        currency: "eur",
        "payment_method_types[0]": "card_present",
        capture_method: "automatic",
        description: args.description ?? "Vente en boutique",
        "metadata[source]": "recycapp-caisse",
      },
    );

    await stripeRequest(
      `terminal/readers/${args.readerId}/process_payment_intent`,
      secretKey,
      { payment_intent: intent.id },
    );

    return { paymentIntentId: intent.id, status: intent.status };
  },
});

/** État d'un encaissement en cours : la caisse interroge jusqu'au succès. */
export const paymentStatus = action({
  args: { paymentIntentId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: string; lastError: string | null }> => {
    await requireCaisseAccess(ctx);
    const secretKey = recycappSecretKey();
    const intent = await stripeRequest<{
      status?: string;
      last_payment_error?: { message?: string };
    }>(`payment_intents/${args.paymentIntentId}`, secretKey);

    return {
      status: intent.status ?? "unknown",
      lastError: intent.last_payment_error?.message ?? null,
    };
  },
});

/** Annule l'encaissement en cours et libère le lecteur. */
export const cancelOnReader = action({
  args: { readerId: v.string(), paymentIntentId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<null> => {
    await requireCaisseAccess(ctx);
    const secretKey = recycappSecretKey();
    await stripeRequest(
      `terminal/readers/${args.readerId}/cancel_action`,
      secretKey,
      {},
    ).catch(() => null);
    if (args.paymentIntentId) {
      await stripeRequest(
        `payment_intents/${args.paymentIntentId}/cancel`,
        secretKey,
        {},
      ).catch(() => null);
    }
    return null;
  },
});

/* ─── Caisse mobile : app Android + BBPOS WisePad 3 ────────────────────────
 *
 * Le lecteur mobile se pilote depuis le SDK Terminal de l'app, jamais d'ici.
 * Les fonctions suivantes lui servent de socle : jeton de connexion, article
 * scanné, client, montant verrouillé, puis enregistrement de la vente.
 */

/**
 * Jeton de connexion du SDK Terminal.
 *
 * Réservé au staff : ce secret permet de se connecter à n'importe quel lecteur
 * du compte Stripe et d'encaisser avec.
 */
export const connectionToken = action({
  args: {},
  handler: async (ctx): Promise<{ secret: string }> => {
    await ctx.runQuery(internal.terminal.assertStaff, {});
    const token = await stripeRequest<{ secret: string }>(
      "terminal/connection_tokens",
      recycappSecretKey(),
      {},
    );
    return { secret: token.secret };
  },
});

/** Garde d'authentification des actions (une action n'accède pas à la base). */
export const assertStaff = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    return null;
  },
});


/**
 * Emplacements Terminal du compte Stripe.
 *
 * Un lecteur Bluetooth se connecte toujours *à un emplacement* : c'est lui qui
 * porte l'adresse déclarée à Stripe. La caisse retient le sien, mais doit
 * pouvoir le choisir à la première mise en service.
 */
export const locations = action({
  args: {},
  handler: async (ctx): Promise<Array<{ id: string; displayName: string }>> => {
    await ctx.runQuery(internal.terminal.assertStaff, {});
    const response = await stripeRequest<{
      data: Array<{ id: string; display_name?: string }>;
    }>("terminal/locations?limit=100", recycappSecretKey());
    return response.data.map((location) => ({
      id: location.id,
      displayName: location.display_name ?? location.id,
    }));
  },
});

/**
 * Article scanné : ce que la caisse a besoin d'afficher avant d'encaisser.
 *
 * Le QR code de la vitrine encode l'URL `/acheter/<articleId>` : l'app en
 * extrait l'identifiant et appelle cette requête.
 */
export const scannedArticle = query({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    await requireStaff(ctx);
    const article = await ctx.db.get(articleId);
    if (!article) return null;
    const imageUrl = article.images[0] ? await ctx.storage.getUrl(article.images[0]) : null;
    return {
      _id: article._id,
      title: article.title,
      price: article.price,
      condition: article.condition,
      category: article.category,
      imageUrl,
      available: article.status === "disponible",
      status: article.status,
    };
  },
});

/**
 * Client déjà connu, à son adresse email.
 *
 * Réservé au staff, contrairement au parcours vitrine : ici la réponse porte
 * l'identité complète, pour que la caisse n'ait pas à la ressaisir.
 */
export const knownCustomer = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireStaff(ctx);
    return await findKnownCustomer(ctx, email);
  },
});


/** Article et son pendant dans le catalogue Stripe, pour l'encaissement. */
export const articleForCharge = internalQuery({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    const article = await ctx.db.get(articleId);
    if (!article) return null;
    return {
      title: article.title,
      price: article.price,
      category: article.category,
      stripeProductId: article.stripeProductId ?? null,
      stripePriceId: article.stripePriceId ?? null,
    };
  },
});

/**
 * Prépare l'encaissement : verrouille le montant et ouvre un PaymentIntent
 * `card_present` que le SDK Terminal présentera au lecteur.
 *
 * Rien n'est débité ici : l'app appelle ensuite `collectPaymentMethod` puis
 * `confirmPaymentIntent` sur le lecteur, et revient par `finalize`.
 */
export const startPayment = action({
  args: {
    articleId: v.id("articles"),
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    draftId: Id<"publicStripeCheckoutDrafts">;
    paymentIntentId: string;
    clientSecret: string;
    amount: number;
  }> => {
    await ctx.runQuery(internal.terminal.assertStaff, {});
    const secretKey = recycappSecretKey();
    const email = normalizeEmail(args.email);
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw new ConvexError("Adresse email invalide.");
    }

    const known = await ctx.runQuery(internal.kiosk.knownCustomerByEmail, { email });
    const firstName = (args.firstName ?? "").trim() || known?.firstName || "";
    const lastName = (args.lastName ?? "").trim() || known?.lastName || "";
    if (!firstName || !lastName) {
      throw new ConvexError("Indiquez le prénom et le nom du client.");
    }

    const draft: { draftId: Id<"publicStripeCheckoutDrafts">; total: number } =
      await ctx.runMutation(internal.requests.createPublicStripeCheckoutDraft, {
        articleIds: [args.articleId],
        customer: {
          firstName,
          lastName,
          email,
          phone: (args.phone ?? "").trim() || known?.phone || "",
        },
        comment: "Achat en boutique (terminal de paiement).",
      });

    if (draft.total <= 0) {
      throw new ConvexError("Le montant de cet article doit être supérieur à 0 €.");
    }

    const amount = Math.round(draft.total * 100);
    // L'article vendu voyage avec le paiement : sans lui, le Dashboard Stripe
    // n'affiche qu'un montant, impossible à rapprocher d'un objet. Le
    // PaymentIntent n'accepte pas de lignes de commande — c'est la description
    // et les métadonnées qui portent l'information, dont l'identifiant du
    // produit du catalogue Stripe quand l'article y est synchronisé.
    const article = await ctx.runQuery(internal.terminal.articleForCharge, {
      articleId: args.articleId,
    });
    const intent = await stripeRequest<{ id: string; client_secret: string }>(
      "payment_intents",
      secretKey,
      {
        amount: String(amount),
        currency: "eur",
        "payment_method_types[0]": "card_present",
        capture_method: "automatic",
        receipt_email: email,
        description: article?.title ?? "Article de la recyclerie",
        "metadata[draftId]": draft.draftId,
        "metadata[source]": "recycapp-terminal",
        "metadata[articleId]": String(args.articleId),
        ...(article?.title ? { "metadata[articleTitle]": article.title } : {}),
        ...(article?.category ? { "metadata[articleCategory]": article.category } : {}),
        ...(article?.stripeProductId
          ? { "metadata[stripeProductId]": article.stripeProductId }
          : {}),
        ...(article?.stripePriceId ? { "metadata[stripePriceId]": article.stripePriceId } : {}),
      },
    );

    await ctx.runMutation(internal.requests.attachStripeSessionToPublicDraft, {
      draftId: draft.draftId,
      stripeSessionId: intent.id,
    });

    return {
      draftId: draft.draftId,
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      amount,
    };
  },
});

/**
 * Enregistre la commande une fois le paiement accepté par le lecteur.
 *
 * Le statut est relu chez Stripe : la tablette n'est jamais crue sur parole,
 * pas plus que le navigateur du client dans le parcours vitrine.
 */
export const finalizePayment = action({
  args: {
    draftId: v.id("publicStripeCheckoutDrafts"),
    paymentIntentId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ requestId: Id<"requests">; accountCreated: boolean }> => {
    await ctx.runQuery(internal.terminal.assertStaff, {});
    const secretKey = recycappSecretKey();

    const intent = await stripeRequest<{
      id: string;
      status?: string;
      metadata?: { draftId?: string };
    }>(`payment_intents/${args.paymentIntentId}`, secretKey);

    if (intent.metadata?.draftId !== args.draftId) {
      throw new ConvexError("Ce paiement ne correspond pas à l'article attendu.");
    }
    if (intent.status !== "succeeded") {
      throw new ConvexError(
        `Paiement non confirmé par Stripe (${intent.status ?? "statut inconnu"}). Aucune commande n'a été enregistrée.`,
      );
    }

    const { requestId }: { requestId: Id<"requests"> } = await ctx.runMutation(
      internal.requests.finalizePublicStripeCheckout,
      {
        draftId: args.draftId,
        stripeSessionId: intent.id,
        stripePaymentIntentId: intent.id,
      },
    );

    // Vente en boutique : le client repart avec l'article, il n'y a pas de
    // retrait à attendre comme pour une commande en ligne.
    await ctx.runMutation(internal.requests.completeTerminalSale, { requestId });

    // Le compte client est un plus : son échec ne remet pas en cause la vente.
    let accountCreated = false;
    const clerkSecret = process.env.CLERK_SECRET_KEY;
    const buyer = await ctx.runQuery(internal.kiosk.customerOfRequest, { requestId });
    if (clerkSecret && buyer?.email) {
      const result = await ensureClerkCustomer(clerkSecret, {
        email: buyer.email,
        firstName: buyer.firstName,
        lastName: buyer.lastName,
        signupPath: "/acheter",
      });
      accountCreated = Boolean(result.clerkId) && !result.reused;
      if (result.warning) {
        console.error(`Compte client non créé (${buyer.email}) : ${result.warning}`);
      }
    }

    return { requestId, accountCreated };
  },
});

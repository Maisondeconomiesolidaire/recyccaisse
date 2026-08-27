/**
 * Achat depuis la vitrine (kiosque), sur le téléphone du client.
 *
 * Chaque annonce affiche un QR code : le client le scanne, tombe sur la page
 * d'achat de CET article, se présente en deux champs, et paie par Stripe
 * Checkout. Aucune connexion n'est demandée — devant une vitrine, un écran de
 * login fait abandonner.
 *
 * Le compte Clerk n'est créé qu'APRÈS l'encaissement : un formulaire public qui
 * crée des comptes à la demande serait un robinet à faux comptes. Payer d'abord
 * garantit qu'un compte correspond à un vrai client.
 */
import { ConvexError, v } from "convex/values";
import { action, internalQuery, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib";
import { ensureClerkCustomer } from "./crmClients";
import { recycappSecretKey, stripeRequest } from "./stripe";

type KnownCustomer = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

/**
 * Retrouve un client à son adresse email, parmi ses demandes passées et les
 * fiches importées.
 *
 * INTERNE À DESSEIN : la réponse porte l'identité du client. Une requête
 * publique qui renverrait un nom pour n'importe quelle adresse permettrait de
 * moissonner le fichier client une adresse à la fois.
 */
export const knownCustomerByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<KnownCustomer | null> =>
    await findKnownCustomer(ctx, email),
});

/**
 * Recherche partagée : la caisse au terminal en a besoin depuis une `query`,
 * et une query ne peut pas appeler une autre query sans rendre le typage
 * circulaire.
 */
export async function findKnownCustomer(
  ctx: QueryCtx,
  email: string,
): Promise<KnownCustomer | null> {
  const target = normalizeEmail(email);
  if (!target) return null;

  const requests = await ctx.db.query("requests").order("desc").take(2000);
  const fromRequest = requests.find(
    (request) => normalizeEmail(request.customer.email) === target,
  );
  if (fromRequest) {
    return {
      firstName: fromRequest.customer.firstName,
      lastName: fromRequest.customer.lastName,
      email: fromRequest.customer.email,
      phone: fromRequest.customer.phone,
    };
  }

  const imported = await ctx.db
    .query("crmCustomers")
    .withIndex("by_email", (q) => q.eq("email", target))
    .first();
  if (imported) {
    return {
      firstName: imported.firstName,
      lastName: imported.lastName,
      email: imported.email,
      phone: imported.phone,
    };
  }
  return null;
}

/**
 * L'adresse correspond-elle à un client connu ?
 *
 * Ne renvoie qu'un booléen : de quoi orienter le formulaire, rien de plus. Les
 * coordonnées, elles, sont relues côté serveur au moment de la commande.
 */
export const isKnownCustomer = query({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ known: boolean }> => {
    const target = normalizeEmail(email);
    if (!target) return { known: false };

    const imported = await ctx.db
      .query("crmCustomers")
      .withIndex("by_email", (q) => q.eq("email", target))
      .first();
    if (imported) return { known: true };

    const requests = await ctx.db.query("requests").order("desc").take(2000);
    return {
      known: requests.some(
        (request) => normalizeEmail(request.customer.email) === target,
      ),
    };
  },
});

/** Article vendu en vitrine : disponibilité et prix, pour la page d'achat. */
export const articleForPurchase = query({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    const article = await ctx.db.get(articleId);
    if (!article) return null;
    const imageUrl = article.images[0]
      ? await ctx.storage.getUrl(article.images[0])
      : null;
    return {
      _id: article._id,
      title: article.title,
      price: article.price,
      condition: article.condition,
      category: article.category,
      imageUrl,
      available: article.status === "disponible",
    };
  },
});

/**
 * Ouvre le paiement d'un article : Stripe Checkout, hébergé par Stripe.
 *
 * Le montant vient de l'article relu en base — le téléphone du client n'envoie
 * qu'un identifiant. Un client connu n'a que son email à saisir : ses
 * coordonnées sont reprises ici, côté serveur, et ne transitent jamais par le
 * navigateur.
 */
export const startCheckout = action({
  args: {
    articleId: v.id("articles"),
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    phone: v.optional(v.string()),
    returnUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{ checkoutUrl: string }> => {
    const secretKey = recycappSecretKey();
    const email = normalizeEmail(args.email);
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw new ConvexError("Adresse email invalide.");
    }

    const known = await ctx.runQuery(internal.kiosk.knownCustomerByEmail, { email });
    const firstName = (args.firstName ?? "").trim() || known?.firstName || "";
    const lastName = (args.lastName ?? "").trim() || known?.lastName || "";
    if (!firstName || !lastName) {
      throw new ConvexError(
        "Nous ne vous connaissons pas encore : indiquez votre prénom et votre nom.",
      );
    }

    const draft: {
      draftId: Id<"publicStripeCheckoutDrafts">;
      total: number;
    } = await ctx.runMutation(internal.requests.createPublicStripeCheckoutDraft, {
      articleIds: [args.articleId],
      customer: {
        firstName,
        lastName,
        email,
        phone: (args.phone ?? "").trim() || known?.phone || "",
      },
      comment: "Achat depuis la vitrine (QR code).",
    });

    if (draft.total <= 0) {
      throw new ConvexError("Le montant de cet article doit être supérieur à 0 €.");
    }

    const returnUrl = new URL(args.returnUrl);
    returnUrl.searchParams.set("draft_id", draft.draftId);
    const successUrl = `${returnUrl.toString()}&status=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${returnUrl.toString()}&status=cancelled`;

    const session = await stripeRequest<{ id: string; url: string }>(
      "checkout/sessions",
      secretKey,
      {
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        locale: "fr",
        customer_email: email,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "eur",
        "line_items[0][price_data][unit_amount]": String(
          Math.round(draft.total * 100),
        ),
        "line_items[0][price_data][product_data][name]": "Article de la recyclerie",
        "metadata[draftId]": draft.draftId,
        "metadata[source]": "recycapp-vitrine",
        // Le même identifiant sur le PaymentIntent : le webhook
        // `payment_intent.succeeded` enregistre alors la commande même si le
        // client ferme son onglet avant de revenir.
        "payment_intent_data[metadata][draftId]": draft.draftId,
        "payment_intent_data[metadata][source]": "recycapp-vitrine",
      },
    );

    await ctx.runMutation(internal.requests.attachStripeSessionToPublicDraft, {
      draftId: draft.draftId,
      stripeSessionId: session.id,
    });

    return { checkoutUrl: session.url };
  },
});

/**
 * Confirme la commande au retour de Stripe.
 *
 * Le statut est relu chez Stripe : on ne croit jamais le navigateur sur parole.
 * Le compte client n'est créé qu'ici, une fois l'argent encaissé.
 */
export const confirmCheckout = action({
  args: {
    draftId: v.id("publicStripeCheckoutDrafts"),
    sessionId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ requestId: Id<"requests">; accountCreated: boolean }> => {
    const secretKey = recycappSecretKey();

    const session = await stripeRequest<{
      id: string;
      payment_status?: string;
      payment_intent?: string;
      customer_details?: { email?: string };
      metadata?: { draftId?: string };
    }>(`checkout/sessions/${args.sessionId}`, secretKey);

    if (session.metadata?.draftId !== args.draftId) {
      throw new ConvexError("Ce paiement ne correspond pas à l'article attendu.");
    }
    if (session.payment_status !== "paid") {
      throw new ConvexError(
        "Le paiement n'est pas confirmé par Stripe. Aucune commande n'a été enregistrée.",
      );
    }

    const { requestId }: { requestId: Id<"requests"> } = await ctx.runMutation(
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

    // Le compte est un plus : son échec ne remet pas en cause la commande.
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

/** Coordonnées enregistrées sur une commande, pour la création du compte. */
export const customerOfRequest = internalQuery({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }): Promise<KnownCustomer | null> => {
    const request = await ctx.db.get(requestId);
    if (!request) return null;
    return {
      firstName: request.customer.firstName,
      lastName: request.customer.lastName,
      email: normalizeEmail(request.customer.email),
      phone: request.customer.phone,
    };
  },
});

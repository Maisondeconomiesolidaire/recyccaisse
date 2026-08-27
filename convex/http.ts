import { httpRouter } from "convex/server";
import { env, httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const http = httpRouter();

/**
 * Sert un fichier du stockage Convex en octets directs (HTTP 200, sans
 * redirection signée) — fiable pour les images d'emails (proxy Gmail, etc.).
 * Exemple : GET /email/image?id=<storageId>
 */
http.route({
  path: "/email/image",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return new Response("Missing id", { status: 400 });
    const blob = await ctx.storage.get(id as Id<"_storage">);
    if (!blob) return new Response("Not found", { status: 404 });
    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": blob.type || "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }),
});

/* ─── Webhook Stripe — boutique en ligne Recycapp ──────────────────────────
 *
 * Stripe nous appelle directement, sans passer par le navigateur du client :
 * c'est ce qui garantit que la commande est enregistrée même si l'acheteur
 * ferme son onglet, si le retour de 3-D Secure échoue, ou si le moyen de
 * paiement se confirme de façon différée (SEPA, wallets…).
 *
 * URL à déclarer dans Stripe :
 *   https://hip-marten-394.eu-west-1.convex.site/stripe/recycapp
 */

/** Comparaison à temps constant : ne fuite pas la signature attendue. */
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Vérifie l'en-tête `Stripe-Signature` (schéma v1 : HMAC-SHA256 de
 * « timestamp.payload »). Sans cette vérification, n'importe qui pourrait
 * poster une fausse confirmation de paiement.
 */
async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, ...rest] = part.split("=");
      return [key.trim(), rest.join("=")];
    }),
  ) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) return false;

  // Rejoue impossible au-delà de 5 minutes.
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${parts.t}.${payload}`),
  );
  return timingSafeEqual(toHex(signature), parts.v1);
}

/**
 * Événements du CATALOGUE Stripe, redescendus dans le stock Recycapp.
 *
 * Le sens principal reste Recycapp → Stripe ; ces événements ferment la boucle
 * pour ce qui est fait depuis le dashboard Stripe ou un canal de vente Stripe.
 * Nos propres écritures en produisent aussi : les mutations appelées ici sont
 * donc sans effet quand l'état décrit est déjà atteint, ce qui coupe court aux
 * allers-retours.
 */
const CATALOG_EVENTS = new Set([
  "product.deleted",
  "product.updated",
  "price.created",
  "price.updated",
  "checkout.session.completed",
]);

async function handleCatalogEvent(
  ctx: { runMutation: ActionCtx["runMutation"]; scheduler: ActionCtx["scheduler"] },
  type: string,
  object: {
    id?: string;
    active?: boolean;
    product?: string;
    unit_amount?: number;
    currency?: string;
    metadata?: { draftId?: string };
  },
) {
  if (type === "product.deleted") {
    if (object.id) {
      await ctx.runMutation(internal.stripeCatalog.applyProductDeleted, {
        stripeProductId: object.id,
      });
    }
    return;
  }

  if (type === "product.updated") {
    if (object.id && typeof object.active === "boolean") {
      await ctx.runMutation(internal.stripeCatalog.applyProductActive, {
        stripeProductId: object.id,
        active: object.active,
      });
    }
    return;
  }

  if (type === "price.created" || type === "price.updated") {
    // Un price archivé ne dit rien du prix en vigueur : seul un price actif en
    // euros, rattaché à un de nos produits, fait foi.
    if (
      object.product &&
      object.id &&
      object.active !== false &&
      object.currency === "eur" &&
      typeof object.unit_amount === "number"
    ) {
      await ctx.runMutation(internal.stripeCatalog.applyPriceChange, {
        stripeProductId: object.product,
        stripePriceId: object.id,
        unitAmount: object.unit_amount,
      });
    }
    return;
  }

  if (type === "checkout.session.completed" && object.id) {
    // Une session portant un `draftId` est une commande de la boutique ou de
    // la vitrine : elle a son propre circuit, qui marque les articles vendus
    // ET enregistre la commande. Les marquer vendus ici les rendrait
    // indisponibles avant que la commande existe, et la finalisation
    // échouerait sur un article « déjà vendu ».
    if (object.metadata?.draftId) return;

    // Les lignes de la session ne sont pas dans le webhook : il faut les
    // redemander à Stripe, donc passer par une action.
    await ctx.scheduler.runAfter(
      0,
      internal.stripeCatalog.applySoldCheckoutSession,
      { sessionId: object.id },
    );
  }
}

http.route({
  path: "/stripe/recycapp",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = env.RECYCAPP_STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      console.error("Webhook Stripe reçu mais RECYCAPP_STRIPE_WEBHOOK_SECRET n'est pas configurée.");
      return new Response("Webhook non configuré", { status: 500 });
    }

    // Le corps brut est indispensable : la signature porte sur les octets reçus.
    const payload = await request.text();
    const valid = await verifyStripeSignature(
      payload,
      request.headers.get("Stripe-Signature"),
      secret,
    );
    if (!valid) return new Response("Signature invalide", { status: 400 });

    const event = JSON.parse(payload) as {
      type?: string;
      data?: {
        object?: {
          id?: string;
          status?: string;
          object?: string;
          active?: boolean;
          product?: string;
          unit_amount?: number;
          currency?: string;
          default_price?: string | { id?: string };
          metadata?: { draftId?: string; paymentLinkToken?: string };
        };
      };
    };
    const intent = event.data?.object;

    // Catalogue : ce qui est fait côté Stripe redescend dans le stock.
    if (event.type && CATALOG_EVENTS.has(event.type)) {
      await handleCatalogEvent(ctx, event.type, event.data?.object ?? {});
      return new Response("ok", { status: 200 });
    }

    if (event.type !== "payment_intent.succeeded") {
      // Les autres événements sont acquittés sans traitement.
      return new Response("ok", { status: 200 });
    }

    const draftId = intent?.metadata?.draftId;
    const paymentLinkToken = intent?.metadata?.paymentLinkToken;
    if ((!draftId && !paymentLinkToken) || !intent?.id) {
      console.error("payment_intent.succeeded sans panier ni lien de paiement exploitable.");
      return new Response("ok", { status: 200 });
    }

    try {
      // Idempotent dans les deux cas : si la commande a déjà été créée par le
      // navigateur, la mutation renvoie simplement la demande existante.
      if (paymentLinkToken) {
        await ctx.runMutation(internal.requests.finalizePaymentLink, {
          token: paymentLinkToken,
          stripePaymentIntentId: intent.id,
        });
      } else {
        await ctx.runMutation(internal.requests.finalizePublicStripeCheckout, {
          draftId: draftId as Id<"publicStripeCheckoutDrafts">,
          stripePaymentIntentId: intent.id,
        });
      }
      return new Response("ok", { status: 200 });
    } catch (error) {
      // Un échec ici = un client débité sans commande (article vendu entre
      // temps, par exemple). On renvoie une erreur pour que Stripe réessaie et
      // que l'incident reste visible dans le dashboard.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Finalisation impossible (${paymentLinkToken ? `lien ${paymentLinkToken}` : `brouillon ${draftId}`}) : ${message}`,
      );
      return new Response(message, { status: 500 });
    }
  }),
});

/* ─── OAuth Google — connexion de la boîte Gmail Vinted de Klyd ────────────
 *
 * Google renvoie l'utilisateur ici après le consentement. On échange le `code`
 * contre un refresh token côté serveur (le secret client ne quitte jamais
 * Convex), puis on renvoie l'utilisateur dans Klyd.
 *
 * URI de redirection à déclarer dans Google Cloud Console :
 *   https://hip-marten-394.eu-west-1.convex.site/klyde/gmail/oauth/callback
 */
http.route({
  path: "/klyde/gmail/oauth/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const fallback = (process.env.KLYDE_APP_URL ?? "https://klyd.groupemes.fr").replace(/\/$/, "");

    if (error) {
      return Response.redirect(
        `${fallback}/?gmail=error&message=${encodeURIComponent(error)}`,
        302,
      );
    }
    if (!code || !state) {
      return Response.redirect(
        `${fallback}/?gmail=error&message=${encodeURIComponent("Réponse Google incomplète.")}`,
        302,
      );
    }

    const redirect = await ctx.runAction(internal.klydeGmail.completeOAuth, { code, state });
    return Response.redirect(redirect, 302);
  }),
});

export default http;

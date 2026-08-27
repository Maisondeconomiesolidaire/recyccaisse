/**
 * Bons de réduction de la boutique en ligne.
 *
 * Un bon vaut un pourcentage sur la totalité d'un panier. Il est généré depuis
 * le stock boutique du CRM, puis remis au client. La remise n'est JAMAIS
 * calculée par le navigateur : le pourcentage est relu ici au moment de créer
 * le paiement, et le bon est consommé à l'encaissement.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireCrmPermission } from "./lib";
import type { Doc } from "./_generated/dataModel";

export const MIN_PERCENT = 5;
export const MAX_PERCENT = 80;

const CODE_PREFIX = "RECY";
/**
 * 16 chiffres tirés au sort : un bon ne se devine pas et ne se déduit pas d'un
 * autre. Le préfixe reste lisible pour l'équipe (« RECY… » = bon boutique).
 */
const CODE_DIGITS = 16;

/** Met un code saisi à la main sous sa forme canonique (RECY + chiffres). */
export function normalizeDiscountCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, "");
}

function randomDigits(count: number): string {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  // Le modulo 10 sur un octet penche très légèrement vers les petits chiffres
  // (256 n'est pas un multiple de 10) ; sur un code de 16 chiffres tiré pour
  // être imprévisible, et non pour tirer au sort un gagnant, c'est sans effet.
  return Array.from(bytes, (byte) => String(byte % 10)).join("");
}

async function generateUniqueCode(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = `${CODE_PREFIX}${randomDigits(CODE_DIGITS)}`;
    const existing = await ctx.db
      .query("discountCodes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!existing) return code;
  }
  throw new Error("Impossible de générer un code unique. Réessayez.");
}

/** Le bon désigné par ce code, ou `null` s'il n'existe pas. */
async function byCode(
  ctx: QueryCtx,
  code: string,
): Promise<Doc<"discountCodes"> | null> {
  return await ctx.db
    .query("discountCodes")
    .withIndex("by_code", (q) => q.eq("code", normalizeDiscountCode(code)))
    .unique();
}

/**
 * Contrôle qu'un bon est utilisable et renvoie sa remise.
 *
 * Partagé par la vérification côté client et par la création du paiement : le
 * même refus doit tomber dans les deux cas, sinon un panier « validé » à
 * l'écran échouerait à l'encaissement.
 */
export async function assertUsableDiscount(
  ctx: QueryCtx,
  rawCode: string,
): Promise<Doc<"discountCodes">> {
  const discount = await byCode(ctx, rawCode);
  if (!discount) {
    throw new ConvexError("Ce code promo n'existe pas.");
  }
  if (discount.status === "used") {
    throw new ConvexError("Ce code promo a déjà été utilisé.");
  }
  if (discount.status === "cancelled") {
    throw new ConvexError("Ce code promo a été annulé.");
  }
  return discount;
}

/** Applique une remise à un montant, arrondi au centime. */
export function applyDiscount(subtotal: number, percent: number) {
  const discountAmount = Math.round(subtotal * percent) / 100;
  return {
    discountAmount,
    total: Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100),
  };
}

/* ─── Boutique (public) ───────────────────────────────────────────────────── */

/**
 * Vérifie un code saisi au panier, avant de lancer le paiement.
 *
 * Ne renvoie que le pourcentage : ni l'historique du bon, ni son auteur.
 */
export const check = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const discount = await assertUsableDiscount(ctx, code);
    return { code: discount.code, percent: discount.percent };
  },
});

/* ─── CRM ─────────────────────────────────────────────────────────────────── */

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "articles", "read");
    return await ctx.db.query("discountCodes").order("desc").take(200);
  },
});

/** Génère un bon de réduction. Le code est tiré au sort côté serveur. */
export const create = mutation({
  args: {
    percent: v.number(),
    label: v.optional(v.string()),
    createdBy: v.optional(v.string()),
  },
  handler: async (ctx, { percent, label, createdBy }) => {
    await requireCrmPermission(ctx, "articles", "create");
    const rounded = Math.round(percent);
    if (
      !Number.isFinite(rounded) ||
      rounded < MIN_PERCENT ||
      rounded > MAX_PERCENT
    ) {
      throw new ConvexError(
        `La remise doit être comprise entre ${MIN_PERCENT} % et ${MAX_PERCENT} %.`,
      );
    }

    const code = await generateUniqueCode(ctx);
    const id = await ctx.db.insert("discountCodes", {
      code,
      percent: rounded,
      status: "active",
      label: label?.trim() || undefined,
      createdAt: Date.now(),
      createdBy: createdBy?.trim() || undefined,
    });
    return { id, code, percent: rounded };
  },
});

/**
 * Annule un bon encore actif (perdu, émis par erreur).
 *
 * Un bon déjà consommé n'est pas annulable : sa remise a été encaissée.
 */
export const cancel = mutation({
  args: { id: v.id("discountCodes") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "articles", "update");
    const discount = await ctx.db.get(id);
    if (!discount) throw new ConvexError("Bon de réduction introuvable.");
    if (discount.status === "used") {
      throw new ConvexError("Ce bon a déjà été utilisé : il ne peut plus être annulé.");
    }
    await ctx.db.patch(id, { status: "cancelled", cancelledAt: Date.now() });
    return null;
  },
});

/* ─── Consommation ────────────────────────────────────────────────────────── */

/** Marque un bon consommé par une commande. Idempotent. */
export const markUsed = internalMutation({
  args: {
    id: v.id("discountCodes"),
    requestId: v.id("requests"),
    discountAmount: v.number(),
  },
  handler: async (ctx, { id, requestId, discountAmount }) => {
    const discount = await ctx.db.get(id);
    if (!discount || discount.status === "used") return null;
    await ctx.db.patch(id, {
      status: "used",
      usedAt: Date.now(),
      usedByRequestId: requestId,
      discountAmount,
    });
    return null;
  },
});

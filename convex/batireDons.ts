/**
 * Bâtire — espace client et dons.
 *
 * Une entreprise qui donne des matériaux passe deux fois par les mêmes
 * informations : ses coordonnées et son type de structure. Elles sont saisies
 * une fois dans sa fiche donateur, puis reprises à l'achat comme au don.
 *
 * Un don proposé depuis la boutique attend une décision de l'équipe : accepté,
 * le donateur reçoit les conditions de dépôt ; refusé, il reçoit le motif.
 */
import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  formatUserName,
  hasCrmPermission,
  requireCrmPermission,
  requireUser,
  titleCaseName,
} from "./lib";
import { btCondition, btDonationStatus, btUnit } from "./schema";

const PAGE_DONS = "batire:dons";

/* ─── Fiche donateur ───────────────────────────────────────────────────────── */

const profileFields = {
  company: v.optional(v.string()),
  siret: v.optional(v.string()),
  apeCode: v.optional(v.string()),
  profiles: v.optional(v.array(v.string())),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  phone: v.optional(v.string()),
  address: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  city: v.optional(v.string()),
};

function trimmed(value: string | undefined) {
  const text = value?.trim();
  return text ? text : undefined;
}

async function donorProfile(
  ctx: QueryCtx | MutationCtx,
  clerkId: string,
): Promise<Doc<"btDonorProfiles"> | null> {
  return await ctx.db
    .query("btDonorProfiles")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
    .unique();
}

/** Fiche donateur du compte connecté, complétée par l'identité Clerk. */
export const getMyDonorProfile = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const profile = await donorProfile(ctx, identity.subject);
    const givenName = identity.givenName ?? "";
    const familyName = identity.familyName ?? "";
    return {
      company: profile?.company ?? "",
      siret: profile?.siret ?? "",
      apeCode: profile?.apeCode ?? "",
      profiles: profile?.profiles ?? [],
      firstName: profile?.firstName || (givenName ? titleCaseName(givenName) : ""),
      lastName: profile?.lastName || (familyName ? titleCaseName(familyName) : ""),
      email: profile?.email || identity.email || "",
      phone: profile?.phone ?? "",
      address: profile?.address ?? "",
      postalCode: profile?.postalCode ?? "",
      city: profile?.city ?? "",
      updatedAt: profile?.updatedAt ?? null,
    };
  },
});

export const saveMyDonorProfile = mutation({
  args: profileFields,
  handler: async (ctx, args) => {
    const identity = await requireUser(ctx);
    const now = Date.now();
    const patch = {
      company: trimmed(args.company),
      siret: trimmed(args.siret),
      apeCode: trimmed(args.apeCode)?.toUpperCase(),
      profiles: args.profiles?.filter((value) => value.trim()) ?? [],
      firstName: args.firstName ? titleCaseName(args.firstName) : undefined,
      lastName: args.lastName ? titleCaseName(args.lastName) : undefined,
      email: (identity.email ?? "").toLowerCase() || undefined,
      phone: trimmed(args.phone),
      address: trimmed(args.address),
      postalCode: trimmed(args.postalCode),
      city: trimmed(args.city),
      updatedAt: now,
    };
    const existing = await donorProfile(ctx, identity.subject);
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("btDonorProfiles", {
      clerkId: identity.subject,
      createdAt: now,
      ...patch,
    });
  },
});

/* ─── Dons ─────────────────────────────────────────────────────────────────── */

async function nextDonationReference(ctx: MutationCtx) {
  const all = await ctx.db.query("btDonations").collect();
  return `DON${String(all.length + 1).padStart(4, "0")}`;
}

async function withPhotoUrls(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  donation: Doc<"btDonations">,
) {
  const urls = await Promise.all(donation.photos.map((id) => ctx.storage.getUrl(id)));
  return { ...donation, photoUrls: urls.filter((url): url is string => Boolean(url)) };
}

export const submitDonation = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    category: v.string(),
    family: v.optional(v.string()),
    subcategory: v.optional(v.string()),
    condition: v.optional(btCondition),
    quantity: v.optional(v.number()),
    unit: v.optional(btUnit),
    availableFrom: v.optional(v.number()),
    photos: v.array(v.id("_storage")),
    handover: v.optional(v.union(v.literal("depot"), v.literal("recuperer"))),
    pickupAddress: v.optional(v.string()),
    pickupPostalCode: v.optional(v.string()),
    pickupCity: v.optional(v.string()),
    /** Coordonnées confirmées à l'envoi ; elles mettent la fiche à jour. */
    donor: v.object({
      company: v.optional(v.string()),
      firstName: v.string(),
      lastName: v.string(),
      phone: v.optional(v.string()),
      profiles: v.optional(v.array(v.string())),
      address: v.optional(v.string()),
      postalCode: v.optional(v.string()),
      city: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const identity = await requireUser(ctx);
    const title = args.title.trim();
    if (!title) throw new ConvexError("Donnez un titre au lot.");
    if (!args.category.trim()) throw new ConvexError("Choisissez une catégorie.");
    if (args.photos.length === 0) throw new ConvexError("Ajoutez au moins une photo.");
    const firstName = args.donor.firstName.trim();
    const lastName = args.donor.lastName.trim();
    if (!firstName || !lastName) throw new ConvexError("Indiquez votre prénom et votre nom.");
    const email = (identity.email ?? "").toLowerCase();
    if (!email) throw new ConvexError("Votre compte n'a pas d'adresse email.");
    // Un enlèvement sans adresse n'est pas planifiable : autant le refuser à la
    // saisie plutôt qu'au téléphone.
    const pickupAddress = trimmed(args.pickupAddress);
    if (args.handover === "recuperer" && !pickupAddress) {
      throw new ConvexError("Indiquez l'adresse où récupérer le lot.");
    }

    const now = Date.now();
    const donor = {
      company: trimmed(args.donor.company),
      firstName: titleCaseName(firstName),
      lastName: titleCaseName(lastName),
      email,
      phone: trimmed(args.donor.phone),
      profiles: args.donor.profiles?.filter((value) => value.trim()) ?? [],
      address: trimmed(args.donor.address),
      postalCode: trimmed(args.donor.postalCode),
      city: trimmed(args.donor.city),
    };

    // La fiche donateur suit ce qui vient d'être saisi : sans ça, le formulaire
    // se remplirait encore avec des coordonnées que le donateur vient de
    // corriger.
    const existing = await donorProfile(ctx, identity.subject);
    const profilePatch = { ...donor, updatedAt: now };
    if (existing) await ctx.db.patch(existing._id, profilePatch);
    else await ctx.db.insert("btDonorProfiles", { clerkId: identity.subject, createdAt: now, ...profilePatch });

    const donationId = await ctx.db.insert("btDonations", {
      reference: await nextDonationReference(ctx),
      clerkId: identity.subject,
      donor,
      title,
      description: trimmed(args.description),
      category: args.category.trim(),
      family: trimmed(args.family),
      subcategory: trimmed(args.subcategory),
      condition: args.condition,
      quantity: typeof args.quantity === "number" && args.quantity > 0 ? args.quantity : undefined,
      unit: args.unit,
      availableFrom: args.availableFrom,
      photos: args.photos,
      handover: args.handover ?? "depot",
      pickupAddress,
      pickupPostalCode: trimmed(args.pickupPostalCode),
      pickupCity: trimmed(args.pickupCity),
      status: "nouveau",
      createdAt: now,
      updatedAt: now,
    });

    const donation = await ctx.db.get(donationId);
    await ctx.scheduler.runAfter(0, internal.batireEmails.sendDonationReceived, {
      to: donor.email,
      firstName: donor.firstName,
      reference: donation?.reference ?? "",
      title,
      pickup: args.handover === "recuperer",
    });
    return donationId;
  },
});

/** Les dons du compte connecté, du plus récent au plus ancien. */
export const myDonations = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const donations = await ctx.db
      .query("btDonations")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .order("desc")
      .collect();
    return await Promise.all(donations.map((donation) => withPhotoUrls(ctx, donation)));
  },
});

export const listDonations = query({
  args: { status: v.optional(btDonationStatus), search: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_DONS, "read");
    const donations = args.status
      ? await ctx.db
          .query("btDonations")
          .withIndex("by_status", (q) => q.eq("status", args.status!))
          .order("desc")
          .collect()
      : await ctx.db.query("btDonations").order("desc").take(300);

    const needle = args.search?.trim().toLocaleLowerCase("fr-FR");
    const visible = needle
      ? donations.filter((donation) =>
          [
            donation.title,
            donation.reference,
            donation.donor.company,
            `${donation.donor.firstName} ${donation.donor.lastName}`,
            donation.donor.email,
            donation.category,
          ]
            .filter(Boolean)
            .some((field) => String(field).toLocaleLowerCase("fr-FR").includes(needle)),
        )
      : donations;

    return await Promise.all(visible.map((donation) => withPhotoUrls(ctx, donation)));
  },
});

export const getDonation = query({
  args: { id: v.id("btDonations") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, PAGE_DONS, "read");
    const donation = await ctx.db.get(id);
    return donation ? await withPhotoUrls(ctx, donation) : null;
  },
});

/** Compteur du badge « Dons » : les dons qui attendent une décision. */
export const pendingDonationCount = query({
  args: {},
  handler: async (ctx) => {
    if (!(await hasCrmPermission(ctx, PAGE_DONS, "read"))) return 0;
    const pending = await ctx.db
      .query("btDonations")
      .withIndex("by_status", (q) => q.eq("status", "nouveau"))
      .collect();
    return pending.length;
  },
});

export const setDonationNote = mutation({
  args: { id: v.id("btDonations"), internalNote: v.string() },
  handler: async (ctx, { id, internalNote }) => {
    await requireCrmPermission(ctx, PAGE_DONS, "update");
    await ctx.db.patch(id, { internalNote: trimmed(internalNote), updatedAt: Date.now() });
  },
});

/** Accepte ou refuse un don, et prévient le donateur par email. */
export const decideDonation = mutation({
  args: {
    id: v.id("btDonations"),
    status: v.union(v.literal("accepte"), v.literal("refuse")),
    /** Obligatoire pour un refus : c'est le motif envoyé au donateur. */
    message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_DONS, "update");
    const identity = await requireUser(ctx);
    const donation = await ctx.db.get(args.id);
    if (!donation) throw new ConvexError("Don introuvable.");

    const message = trimmed(args.message);
    if (args.status === "refuse" && !message) {
      throw new ConvexError("Indiquez le motif du refus : il est envoyé au donateur.");
    }

    await ctx.db.patch(args.id, {
      status: args.status,
      decisionMessage: message,
      decidedAt: Date.now(),
      decidedBy: formatUserName(identity),
      updatedAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.batireEmails.sendDonationDecision, {
      to: donation.donor.email,
      firstName: donation.donor.firstName,
      reference: donation.reference,
      title: donation.title,
      accepted: args.status === "accepte",
      pickup: donation.handover === "recuperer",
      message,
    });
  },
});

/**
 * Rattache la fiche matériau créée depuis un don.
 *
 * Le don garde ainsi la trace de ce qu'il est devenu, et l'équipe voit d'un
 * coup d'œil ce qui reste à mettre en stock.
 */
export const markDonationConverted = mutation({
  args: { id: v.id("btDonations"), materialId: v.id("btMaterials") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_DONS, "update");
    const donation = await ctx.db.get(args.id);
    if (!donation) throw new ConvexError("Don introuvable.");
    await ctx.db.patch(args.id, {
      materialId: args.materialId,
      convertedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const donationById = internalQuery({
  args: { id: v.id("btDonations") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

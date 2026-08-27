import { v } from "convex/values";
import { action, env, mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import {
  accessAllows,
  emailForClerkId,
  fetchInternalClerkDirectory,
  formatUserName,
  hasCrmPermission,
  isReservationParticipant,
  photoForClerkId,
  requireCrmPermission,
  requireUser,
} from "./lib";
import { createMesoutilsNotification } from "./mesoutilsNotifications";

const PAGE_KEY = "mesoutils:equipements";

const PERMANENT_DELETE_EMAIL = "lahmerselim@gmail.com";

function canPermanentlyDelete(identity: { email?: string | null }) {
  return identity.email?.trim().toLowerCase() === PERMANENT_DELETE_EMAIL;
}

function ensureRange(start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("Créneau invalide.");
  }
}

function overlaps(startA: number, endA: number, startB: number, endB: number) {
  return startA < endB && endA > startB;
}

/** Photo de profil de l'identité Clerk courante, si présente. */
function pictureUrl(identity: unknown): string | undefined {
  return (identity as { pictureUrl?: string | null }).pictureUrl ?? undefined;
}

function displayName(identity: {
  name?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
}) {
  return formatUserName(identity);
}

async function userForClerkId(ctx: QueryCtx | MutationCtx, clerkId: string | undefined) {
  if (!clerkId) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
    .unique();
}

function userDisplayName(user: Doc<"users"> | null) {
  if (!user) return null;
  return (
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.email.trim() ||
    null
  );
}

/** Détermine pour qui la réservation est posée (soi-même ou un collègue). */
async function resolveReservationTarget(
  ctx: QueryCtx | MutationCtx,
  identity: {
    subject: string;
    name?: string | null;
    givenName?: string | null;
    familyName?: string | null;
    email?: string | null;
  },
  forClerkId: string | undefined,
  forName: string | undefined,
) {
  if (!forClerkId || forClerkId === identity.subject) {
    return { onBehalf: false, clerkId: undefined, name: displayName(identity) };
  }
  const user = await userForClerkId(ctx, forClerkId);
  const name = forName?.trim() || userDisplayName(user);
  if (!name) throw new Error("Utilisateur introuvable.");
  return { onBehalf: true, clerkId: forClerkId, name };
}

/**
 * Emails des personnes autorisées à gérer les équipements (« gestion »), pour
 * les notifier de chaque nouvelle réservation. Inclut les admins et les comptes
 * disposant du droit `manage` sur la page équipements.
 */
async function equipmentManagerEmails(ctx: QueryCtx | MutationCtx) {
  const records = await ctx.db.query("crmPermissions").collect();
  const emails = new Set<string>();
  for (const record of records) {
    if (record.active === false) continue;
    const isAdmin = record.role === "admin";
    const canManage = record.grants.some(
      (grant) => grant.pageKey === PAGE_KEY && grant.actions.includes("manage"),
    );
    if (isAdmin || canManage) {
      const email = record.email.trim().toLowerCase();
      if (email) emails.add(email);
    }
  }
  return [...emails];
}

async function resolveEquipmentPhoto(ctx: QueryCtx | MutationCtx, equipment: Doc<"equipments">) {
  return (equipment.photo ? await ctx.storage.getUrl(equipment.photo) : equipment.photoUrl) ?? null;
}

// ─── Équipements (gestion : droit `manage`) ──────────────────────────────────

export const listEquipments = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const equipments = await ctx.db.query("equipments").order("asc").collect();
    return await Promise.all(
      equipments.map(async (equipment) => ({
        ...equipment,
        photoUrl: await resolveEquipmentPhoto(ctx, equipment),
      })),
    );
  },
});

export const createEquipment = mutation({
  args: {
    name: v.string(),
    category: v.optional(v.string()),
    reference: v.optional(v.string()),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    photo: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    buildingLabel: v.optional(v.string()),
    notes: v.optional(v.string()),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    if (!args.name.trim()) throw new Error("Nom requis.");
    return await ctx.db.insert("equipments", {
      name: args.name.trim(),
      category: args.category?.trim() || undefined,
      reference: args.reference?.trim() || undefined,
      site: args.site,
      photo: args.photo,
      photoUrl: args.photoUrl?.trim() || undefined,
      buildingLabel: args.buildingLabel?.trim() || undefined,
      notes: args.notes?.trim() || undefined,
      active: args.active,
      createdAt: Date.now(),
    });
  },
});

export const updateEquipment = mutation({
  args: {
    equipmentId: v.id("equipments"),
    name: v.string(),
    category: v.optional(v.string()),
    reference: v.optional(v.string()),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    photo: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    buildingLabel: v.optional(v.string()),
    notes: v.optional(v.string()),
    active: v.boolean(),
  },
  handler: async (ctx, { equipmentId, ...patch }) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    await ctx.db.patch(equipmentId, {
      name: patch.name.trim(),
      category: patch.category?.trim() || undefined,
      reference: patch.reference?.trim() || undefined,
      site: patch.site,
      photo: patch.photo,
      photoUrl: patch.photoUrl?.trim() || undefined,
      buildingLabel: patch.buildingLabel?.trim() || undefined,
      notes: patch.notes?.trim() || undefined,
      active: patch.active,
    });
  },
});

export const deleteEquipment = mutation({
  args: { equipmentId: v.id("equipments") },
  handler: async (ctx, { equipmentId }) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    const reservations = await ctx.db
      .query("equipmentReservations")
      .withIndex("by_equipmentId", (q) => q.eq("equipmentId", equipmentId))
      .collect();
    for (const reservation of reservations) await ctx.db.delete(reservation._id);
    await ctx.db.delete(equipmentId);
  },
});

// ─── Réservations d'équipements ──────────────────────────────────────────────

/** Réservations (hors annulées) qui chevauchent la fenêtre, pour l'agenda. */
export const listEquipmentReservations = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    ensureRange(args.start, args.end);
    const reservations = await ctx.db.query("equipmentReservations").collect();
    return reservations.filter(
      (reservation) =>
        reservation.status !== "cancelled" &&
        overlaps(reservation.start, reservation.end, args.start, args.end),
    );
  },
});

/** Tous les équipements actifs avec leur état sur le créneau (libre / occupé). */
export const listEquipmentsForSlot = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    ensureRange(args.start, args.end);
    const equipments = (await ctx.db.query("equipments").collect()).filter((e) => e.active);
    const reservations = await ctx.db.query("equipmentReservations").collect();
    return await Promise.all(
      equipments.map(async (equipment) => {
        const conflict = reservations
          .filter(
            (reservation) =>
              reservation.equipmentId === equipment._id &&
              reservation.status !== "cancelled" &&
              overlaps(reservation.start, reservation.end, args.start, args.end),
          )
          .sort((a, b) => a.start - b.start)[0];
        return {
          ...equipment,
          photoUrl: await resolveEquipmentPhoto(ctx, equipment),
          occupiedBy: conflict
            ? { userName: conflict.userName, start: conflict.start, end: conflict.end }
            : null,
        };
      }),
    );
  },
});

/** Réservations d'équipements de l'utilisateur courant. */
export const listMyEquipmentReservations = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const me = identity.subject;
    const [reservations, equipments] = await Promise.all([
      ctx.db.query("equipmentReservations").collect(),
      ctx.db.query("equipments").collect(),
    ]);
    const info = new Map(
      await Promise.all(
        equipments.map(
          async (equipment) =>
            [
              String(equipment._id),
              { name: equipment.name, photoUrl: await resolveEquipmentPhoto(ctx, equipment) },
            ] as const,
        ),
      ),
    );
    return reservations
      .filter((reservation) => reservation.clerkId === me || reservation.bookedForClerkId === me)
      .map((reservation) => ({
        _id: String(reservation._id),
        assetName: info.get(String(reservation.equipmentId))?.name ?? "Équipement",
        photoUrl: info.get(String(reservation.equipmentId))?.photoUrl ?? null,
        label: reservation.title,
        start: reservation.start,
        end: reservation.end,
        status: reservation.status ?? ("confirmed" as const),
      }))
      .sort((a, b) => b.start - a.start);
  },
});

/**
 * Annuaire « Réserver pour » : uniquement les membres internes
 * (@eco-solidaire.fr) de l'instance Clerk PRODUCTION, hors soi-même. Même source
 * de vérité que l'annuaire des salles (voir `fetchInternalClerkDirectory`).
 */
export const listEquipmentDirectory = action({
  args: {},
  handler: async (ctx): Promise<Array<{ clerkId: string; name: string; imageUrl: string | null }>> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, PAGE_KEY, "create")) {
      throw new Error("Accès insuffisant pour réserver pour un collègue.");
    }
    const secret = env.CLERK_SECRET_KEY;
    if (!secret) throw new Error("Annuaire indisponible : CLERK_SECRET_KEY manquante.");
    return await fetchInternalClerkDirectory(secret, access.email ?? "");
  },
});

export const bookEquipment = mutation({
  args: {
    equipmentId: v.id("equipments"),
    title: v.string(),
    start: v.number(),
    end: v.number(),
    notes: v.optional(v.string()),
    forClerkId: v.optional(v.string()),
    forName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    ensureRange(args.start, args.end);
    if (!args.title.trim()) throw new Error("Objet de la réservation requis.");
    const equipment = await ctx.db.get(args.equipmentId);
    if (!equipment || !equipment.active) throw new Error("Équipement indisponible.");

    const existing = await ctx.db
      .query("equipmentReservations")
      .withIndex("by_equipmentId", (q) => q.eq("equipmentId", args.equipmentId))
      .collect();
    const conflict = existing.find(
      (reservation) =>
        reservation.status !== "cancelled" &&
        overlaps(reservation.start, reservation.end, args.start, args.end),
    );
    if (conflict) {
      throw new Error("Ce créneau est déjà réservé pour cet équipement.");
    }

    const target = await resolveReservationTarget(ctx, identity, args.forClerkId, args.forName);
    // Créneau libre = réservation confirmée automatiquement (comme les salles).
    const reservationId = await ctx.db.insert("equipmentReservations", {
      equipmentId: args.equipmentId,
      clerkId: identity.subject,
      userName: target.name,
      bookedByName: target.onBehalf ? displayName(identity) : undefined,
      bookedForClerkId: target.clerkId,
      title: args.title.trim(),
      start: args.start,
      end: args.end,
      notes: args.notes?.trim() || undefined,
      status: "confirmed",
      createdAt: Date.now(),
    });

    const equipmentImageUrl = (await resolveEquipmentPhoto(ctx, equipment)) ?? undefined;
    await createMesoutilsNotification(ctx, {
      recipientClerkId: target.clerkId ?? identity.subject,
      kind: "equipment_reservation_confirmed",
      title: "Votre réservation d'équipement est confirmée",
      body: `${equipment.name} · ${args.title.trim()}`,
      assetImageUrl: equipmentImageUrl,
      // « Mes réservations » vit désormais dans /reservations : /equipements
      // ne sert plus qu'à gérer le parc.
      href: "/reservations?v=mine",
    });

    const requesterName = target.name;
    const requesterPhotoUrl =
      (target.onBehalf ? await photoForClerkId(ctx, target.clerkId) : pictureUrl(identity)) ??
      undefined;

    const email = target.onBehalf
      ? await emailForClerkId(ctx, target.clerkId)
      : identity.email ?? (await emailForClerkId(ctx, identity.subject));
    if (email) {
      await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendReservationEmail, {
        email,
        name: requesterName,
        assetKind: "equipment",
        assetName: equipment.name,
        label: args.title.trim(),
        start: args.start,
        end: args.end,
        state: "confirmed",
        photoUrl: requesterPhotoUrl,
        assetImageUrl: equipmentImageUrl,
      });
    }

    // Email aux responsables (« gestion ») des équipements. Décalé pour rester
    // sous la limite Resend (2 req/s) avec l'email au demandeur.
    const managerEmails = await equipmentManagerEmails(ctx);
    const recipients = managerEmails.filter((address) => address !== email?.trim().toLowerCase());
    if (recipients.length > 0) {
      await ctx.scheduler.runAfter(1200, internal.mesoutilsEmails.sendEquipmentReservationToManagers, {
        recipients,
        requesterName,
        requesterPhotoUrl,
        equipmentName: equipment.name,
        equipmentImageUrl,
        label: args.title.trim(),
        start: args.start,
        end: args.end,
        note: args.notes?.trim() || undefined,
      });
    }

    return reservationId;
  },
});

export const cancelEquipmentReservation = mutation({
  args: { reservationId: v.id("equipmentReservations") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation) return;
    const isManager = await hasCrmPermission(ctx, PAGE_KEY, "manage");
    if (!isReservationParticipant(reservation, identity.subject) && !isManager) {
      throw new Error("Annulation non autorisée.");
    }
    const equipment = await ctx.db.get(reservation.equipmentId);
    if (canPermanentlyDelete(identity)) {
      await ctx.db.delete(args.reservationId);
      return;
    }
    await ctx.db.patch(args.reservationId, { status: "cancelled" });
    const recipientClerkId = reservation.bookedForClerkId ?? reservation.clerkId;
    const email = await emailForClerkId(ctx, recipientClerkId);
    if (email) {
      await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendReservationEmail, {
        email,
        name: reservation.userName,
        assetKind: "equipment",
        assetName: equipment?.name ?? "Équipement",
        label: reservation.title,
        start: reservation.start,
        end: reservation.end,
        state: "cancelled",
        photoUrl: (await photoForClerkId(ctx, recipientClerkId)) ?? undefined,
        assetImageUrl: (equipment ? await resolveEquipmentPhoto(ctx, equipment) : null) ?? undefined,
      });
    }
  },
});

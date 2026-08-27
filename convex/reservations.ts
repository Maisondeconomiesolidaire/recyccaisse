import { v } from "convex/values";
import { action, env, internalMutation, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import {
  accessAllows,
  clerkIdForEmail,
  emailForClerkId,
  fetchInternalClerkDirectory,
  formatUserName,
  hasCrmPermission,
  isReservationParticipant,
  isVehicleReturnOverdue,
  photoForClerkId,
  requireCrmPermission,
  requireUser,
  vehicleReservationBusyEnd,
} from "./lib";
import { vehicleBusyReason } from "./fleet";
import { createMesoutilsNotification } from "./mesoutilsNotifications";
import { awardEngagementPoints } from "./points";

/** Photo de profil de l'identité Clerk courante, si présente. */
function pictureUrl(identity: unknown): string | undefined {
  return (identity as { pictureUrl?: string | null }).pictureUrl ?? undefined;
}

/** Args d'image d'un actif (véhicule/salle) pour les emails : proxy si stocké. */
function assetImageArgs(asset: { photo?: unknown; photoUrl?: string }) {
  return asset.photo
    ? { assetImageStorageId: String(asset.photo) }
    : asset.photoUrl
      ? { assetImageUrl: asset.photoUrl }
      : {};
}

const PAGE_KEY = "mesoutils:reservations";

// Comptes prévenus dans l'app à chaque « nouvelle demande de réservation
// véhicule ». Doit rester aligné sur `VEHICLE_REQUEST_MANAGER_EMAILS`, qui
// gouverne l'email : un responsable retiré d'une liste et pas de l'autre
// continuerait d'être sollicité par un seul des deux canaux.
const VEHICLE_REQUEST_NOTIFY_EMAILS = ["f.henry@eco-solidaire.fr"];

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

/**
 * Réservation approuvée qui occupe le véhicule sur `[start, end[`, ou
 * `undefined`. L'occupation est calculée par `vehicleReservationBusyEnd` :
 * retour anticipé = libéré plus tôt, retour manquant = occupé sans limite.
 */
function conflictingVehicleReservation(
  reservations: Doc<"vehicleReservations">[],
  start: number,
  end: number,
  now: number,
  excludeId?: Id<"vehicleReservations">,
) {
  return reservations
    .filter((reservation) => reservation._id !== excludeId)
    .sort((a, b) => a.start - b.start)
    .find((reservation) =>
      overlaps(reservation.start, vehicleReservationBusyEnd(reservation, now), start, end),
    );
}

/** Message d'erreur d'un conflit : « déjà réservé » ou « pas encore rendu ». */
function vehicleConflictMessage(reservation: Doc<"vehicleReservations">, now: number) {
  return isVehicleReturnOverdue(reservation, now)
    ? `Ce véhicule n'a pas encore été rendu par ${reservation.userName} : le retour doit être enregistré avant toute nouvelle réservation.`
    : "Ce véhicule est déjà réservé sur ce créneau.";
}

async function ensureVehicleAvailable(
  ctx: QueryCtx | MutationCtx,
  vehicleId: Id<"vehicles">,
  start: number,
  end: number,
  excludeId?: Id<"vehicleReservations">,
) {
  const dayMs = 86_400_000;
  for (
    let cursor = Math.floor(start / dayMs) * dayMs;
    cursor < end;
    cursor += dayMs
  ) {
    // Collectes / tournées / maintenance occupent le véhicule toute la journée.
    // Les réservations, elles, sont vérifiées à l'heure près juste après.
    const reason = await vehicleBusyReason(ctx, vehicleId, cursor, { ignoreReservations: true });
    if (reason) throw new Error(reason);
  }
  const now = Date.now();
  const approved = await approvedReservationsForVehicle(ctx, vehicleId);
  const conflict = conflictingVehicleReservation(approved, start, end, now, excludeId);
  if (conflict) throw new Error(vehicleConflictMessage(conflict, now));
}

function displayName(identity: {
  name?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
}) {
  return formatUserName(identity);
}

function normalizeVehicleKind(kind: string) {
  return kind === "voiture" ? "voiture" : "utilitaire";
}

async function resolveVehiclePhotoUrls(
  ctx: QueryCtx | MutationCtx,
  vehicles: Doc<"vehicles">[],
) {
  return await Promise.all(
    vehicles.map(async (vehicle) => ({
      ...vehicle,
      kind: normalizeVehicleKind(vehicle.kind),
      photoUrl: vehicle.photo ? await ctx.storage.getUrl(vehicle.photo) : null,
    })),
  );
}

async function approvedReservationsForVehicle(
  ctx: QueryCtx | MutationCtx,
  vehicleId: Id<"vehicles">,
) {
  const reservations = await ctx.db
    .query("vehicleReservations")
    .withIndex("by_vehicleId", (q) => q.eq("vehicleId", vehicleId))
    .collect();
  // Les réservations rendues sont conservées ici : c'est
  // `vehicleReservationBusyEnd` qui les ramène à leur occupation réelle
  // (libérées à l'heure du retour). Une seule règle d'occupation, un seul
  // endroit où la lire.
  return reservations.filter((reservation) => reservation.status === "approved");
}

/**
 * Réservations de véhicule dont le retour est dû mais pas fait : approuvées,
 * créneau terminé, aucun retour enregistré.
 *
 * Le retour conditionne la libération du véhicule ; tant qu'il manque, la
 * flotte est fausse pour tout le monde. On bloque donc toute nouvelle
 * réservation de la personne concernée jusqu'à régularisation.
 *
 * On interroge les deux index (réservataire et bénéficiaire d'une réservation
 * faite pour quelqu'un d'autre) plutôt que de scanner la table.
 */
async function overdueVehicleReturnsFor(ctx: QueryCtx | MutationCtx, clerkId: string) {
  const [own, onBehalf] = await Promise.all([
    ctx.db
      .query("vehicleReservations")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .collect(),
    ctx.db
      .query("vehicleReservations")
      .withIndex("by_bookedForClerkId", (q) => q.eq("bookedForClerkId", clerkId))
      .collect(),
  ]);
  const byId = new Map([...own, ...onBehalf].map((reservation) => [String(reservation._id), reservation]));
  const now = Date.now();
  return [...byId.values()].filter(
    (reservation) =>
      reservation.status === "approved" && isVehicleReturnOverdue(reservation, now),
  );
}

/** Retours en retard de l'utilisateur courant — bannière et blocage côté UI. */
export const myOverdueVehicleReturns = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const overdue = await overdueVehicleReturnsFor(ctx, identity.subject);
    const vehicles = await ctx.db.query("vehicles").collect();
    const vehicleName = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.name]));
    return overdue
      .map((reservation) => ({
        _id: String(reservation._id),
        vehicleName: vehicleName.get(String(reservation.vehicleId)) ?? "Véhicule",
        purpose: reservation.purpose,
        start: reservation.start,
        end: reservation.end,
      }))
      .sort((a, b) => a.end - b.end);
  },
});

async function lastRecordedMileageForVehicle(
  ctx: QueryCtx | MutationCtx,
  vehicleId: Id<"vehicles">,
) {
  const [vehicle, reservations] = await Promise.all([
    ctx.db.get(vehicleId),
    ctx.db
      .query("vehicleReservations")
      .withIndex("by_vehicleId", (q) => q.eq("vehicleId", vehicleId))
      .collect(),
  ]);
  const reservationMileage = reservations.reduce<number | undefined>((max, reservation) => {
    const mileage = reservation.feedbackMileage;
    if (typeof mileage !== "number" || !Number.isFinite(mileage)) return max;
    return max === undefined ? mileage : Math.max(max, mileage);
  }, undefined);
  if (typeof vehicle?.odometerKm === "number" && Number.isFinite(vehicle.odometerKm)) {
    return reservationMileage === undefined
      ? vehicle.odometerKm
      : Math.max(vehicle.odometerKm, reservationMileage);
  }
  return reservationMileage;
}

function feedbackMileageRecordedAt(reservation: Doc<"vehicleReservations">) {
  return reservation.feedbackSubmittedAt ?? reservation.end ?? reservation.start ?? reservation._creationTime;
}

export const listRooms = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const rooms = await ctx.db.query("rooms").order("asc").collect();
    return await Promise.all(
      rooms.map(async (room) => ({
        ...room,
        photoUrl: room.photo ? await ctx.storage.getUrl(room.photo) : room.photoUrl,
      })),
    );
  },
});

export const createRoom = mutation({
  args: {
    name: v.string(),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    capacity: v.optional(v.number()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    return await ctx.db.insert("rooms", {
      ...args,
      active: true,
      createdAt: Date.now(),
    });
  },
});

export const updateRoom = mutation({
  args: {
    roomId: v.id("rooms"),
    name: v.string(),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    capacity: v.optional(v.number()),
    color: v.optional(v.string()),
    active: v.boolean(),
  },
  handler: async (ctx, { roomId, ...patch }) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    await ctx.db.patch(roomId, patch);
  },
});

export const listRoomReservations = query({
  args: {
    start: v.number(),
    end: v.number(),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    ensureRange(args.start, args.end);
    const reservations = await ctx.db.query("roomReservations").collect();
    return reservations.filter((reservation) =>
      reservation.status !== "cancelled" &&
      overlaps(reservation.start, reservation.end, args.start, args.end),
    );
  },
});

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
    return {
      onBehalf: false,
      clerkId: undefined,
      name: displayName(identity),
    };
  }

  const user = await userForClerkId(ctx, forClerkId);
  const name = forName?.trim() || userDisplayName(user);
  if (!name) throw new Error("Utilisateur introuvable.");
  return {
    onBehalf: true,
    clerkId: forClerkId,
    name,
  };
}

/**
 * Annuaire « Réserver pour » : uniquement les membres internes
 * (@eco-solidaire.fr) de l'instance Clerk PRODUCTION, lus via l'API Backend
 * (`CLERK_SECRET_KEY`), hors soi-même. On n'utilise pas la table `users` Convex :
 * elle ne contient que les comptes déjà connectés et peut garder d'anciens
 * comptes dev. Si Clerk est injoignable on remonte l'erreur plutôt que
 * d'afficher un annuaire faux ou vide.
 */
export const listReservationDirectory = action({
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

export const bookRoom = mutation({
  args: {
    roomId: v.id("rooms"),
    title: v.string(),
    usageType: v.optional(v.string()),
    attendees: v.optional(v.number()),
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
    const room = await ctx.db.get(args.roomId);
    if (!room || !room.active) throw new Error("Salle indisponible.");

    if (args.attendees !== undefined) {
      if (!Number.isFinite(args.attendees) || args.attendees < 1) {
        throw new Error("Nombre de personnes invalide.");
      }
      if (room.capacity && args.attendees > room.capacity) {
        throw new Error(`Cette salle accueille ${room.capacity} personnes maximum.`);
      }
    }

    const existing = await ctx.db
      .query("roomReservations")
      .withIndex("by_roomId", (q) => q.eq("roomId", args.roomId))
      .collect();
    const conflict = existing.find((reservation) =>
      reservation.status !== "cancelled" &&
      overlaps(reservation.start, reservation.end, args.start, args.end),
    );
    if (conflict) {
      throw new Error("Ce créneau est déjà réservé pour cette salle.");
    }

    const target = await resolveReservationTarget(ctx, identity, args.forClerkId, args.forName);
    const reservationId = await ctx.db.insert("roomReservations", {
      roomId: args.roomId,
      clerkId: identity.subject,
      userName: target.name,
      bookedByName: target.onBehalf ? displayName(identity) : undefined,
      bookedForClerkId: target.clerkId,
      title: args.title.trim(),
      usageType: args.usageType?.trim() || undefined,
      attendees: args.attendees,
      start: args.start,
      end: args.end,
      notes: args.notes?.trim() || undefined,
      status: "confirmed",
      createdAt: Date.now(),
    });
    await awardEngagementPoints(ctx, {
      clerkId: target.clerkId ?? identity.subject,
      displayName: target.name,
      eventKey: `room-reservation:${reservationId}`,
    });
    await createMesoutilsNotification(ctx, {
      recipientClerkId: target.clerkId ?? identity.subject,
      kind: "room_reservation_confirmed",
      title: "Votre réservation de salle est confirmée",
      body: `${room.name} · ${args.title.trim()}`,
      assetImageUrl: (room.photo ? await ctx.storage.getUrl(room.photo) : room.photoUrl) ?? undefined,
      href: "/reservations?v=mine",
    });
    const requesterName = target.name;
    const requesterPhotoUrl =
      (target.onBehalf ? await photoForClerkId(ctx, target.clerkId) : pictureUrl(identity)) ??
      undefined;
    const roomImageUrl =
      (room.photo ? await ctx.storage.getUrl(room.photo) : room.photoUrl) ?? undefined;

    const email = target.onBehalf
      ? await emailForClerkId(ctx, target.clerkId)
      : identity.email ?? await emailForClerkId(ctx, identity.subject);
    if (email) {
      await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendReservationEmail, {
        email,
        name: requesterName,
        assetKind: "room",
        assetName: room.name,
        label: args.title.trim(),
        start: args.start,
        end: args.end,
        state: "confirmed",
        photoUrl: requesterPhotoUrl,
        assetImageUrl: roomImageUrl,
      });
    }

    // Email aux responsables des réservations de salle.
    // Décalé pour ne pas dépasser la limite Resend (2 req/s) avec l'email au demandeur.
    await ctx.scheduler.runAfter(1200, internal.mesoutilsEmails.sendRoomReservationToManagers, {
      requesterName,
      requesterPhotoUrl,
      roomName: room.name,
      roomImageUrl,
      label: args.title.trim(),
      start: args.start,
      end: args.end,
      note: args.notes?.trim() || undefined,
    });

    return reservationId;
  },
});

export const cancelRoomReservation = mutation({
  args: {
    reservationId: v.id("roomReservations"),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation) return;
    const isManager = await hasCrmPermission(ctx, PAGE_KEY, "manage");
    if (!isReservationParticipant(reservation, identity.subject) && !isManager) {
      throw new Error("Annulation non autorisée.");
    }
    const room = await ctx.db.get(reservation.roomId);
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
        assetKind: "room",
        assetName: room?.name ?? "Salle",
        label: reservation.title,
        start: reservation.start,
        end: reservation.end,
        state: "cancelled",
        photoUrl: (await photoForClerkId(ctx, recipientClerkId)) ?? undefined,
        ...(room ? assetImageArgs(room) : {}),
      });
    }
  },
});

async function isVehicleFree(
  ctx: QueryCtx | MutationCtx,
  vehicleId: Id<"vehicles">,
  start: number,
  end: number,
) {
  const dayMs = 86_400_000;
  for (let cursor = Math.floor(start / dayMs) * dayMs; cursor < end; cursor += dayMs) {
    // Réservations exclues ici : elles se chevauchent à l'heure près (ci-dessous).
    if (await vehicleBusyReason(ctx, vehicleId, cursor, { ignoreReservations: true })) return false;
  }
  const approved = await approvedReservationsForVehicle(ctx, vehicleId);
  return conflictingVehicleReservation(approved, start, end, Date.now()) === undefined;
}

export const availableRooms = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    ensureRange(args.start, args.end);
    const rooms = (await ctx.db.query("rooms").collect()).filter((room) => room.active);
    const reservations = await ctx.db.query("roomReservations").collect();
    const available = rooms.filter(
      (room) =>
        !reservations.some(
          (reservation) =>
            reservation.status !== "cancelled" &&
            reservation.roomId === room._id &&
            overlaps(reservation.start, reservation.end, args.start, args.end),
        ),
    );
    return await Promise.all(
      available.map(async (room) => ({
        ...room,
        photoUrl: room.photo ? await ctx.storage.getUrl(room.photo) : room.photoUrl,
      })),
    );
  },
});

/**
 * Toutes les salles actives avec leur état sur le créneau : libres, ou
 * occupées avec « réservé par X » (affichage grisé côté UI, sans bouton).
 */
export const listRoomsForSlot = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    ensureRange(args.start, args.end);
    const rooms = (await ctx.db.query("rooms").collect()).filter((room) => room.active);
    const reservations = await ctx.db.query("roomReservations").collect();
    return await Promise.all(
      rooms.map(async (room) => {
        const conflict = reservations
          .filter(
            (reservation) =>
              reservation.roomId === room._id &&
              reservation.status !== "cancelled" &&
              overlaps(reservation.start, reservation.end, args.start, args.end),
          )
          .sort((a, b) => a.start - b.start)[0];
        return {
          ...room,
          photoUrl: room.photo ? await ctx.storage.getUrl(room.photo) : room.photoUrl,
          occupiedBy: conflict
            ? { userName: conflict.userName, start: conflict.start, end: conflict.end }
            : null,
        };
      }),
    );
  },
});

/** Tous les véhicules actifs avec leur état sur le créneau (voir listRoomsForSlot). */
export const listVehiclesForSlot = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    ensureRange(args.start, args.end);
    const vehicles = (await ctx.db.query("vehicles").collect()).filter(
      (vehicle) =>
        vehicle.active &&
        (vehicle.reservablePro !== false || vehicle.reservablePersonal === true),
    );
    const withPhotos = await resolveVehiclePhotoUrls(ctx, vehicles);
    return await Promise.all(
      withPhotos.map(async (vehicle) => {
        const approved = await approvedReservationsForVehicle(ctx, vehicle._id);
        const nowMs = Date.now();
        const conflict = conflictingVehicleReservation(approved, args.start, args.end, nowMs);
        let unavailableReason: string | null = null;
        if (!conflict && !(await isVehicleFree(ctx, vehicle._id, args.start, args.end))) {
          unavailableReason = "Indisponible sur ce créneau";
        }
        return {
          ...vehicle,
          occupiedBy: conflict
            ? {
                userName: conflict.userName,
                start: conflict.start,
                end: conflict.end,
                returnRequired: isVehicleReturnOverdue(conflict, nowMs),
              }
            : null,
          unavailableReason,
        };
      }),
    );
  },
});

export const availableVehicles = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    ensureRange(args.start, args.end);
    const vehicles = (await ctx.db.query("vehicles").collect()).filter(
      (vehicle) =>
        vehicle.active &&
        (vehicle.reservablePro !== false || vehicle.reservablePersonal === true),
    );
    const free: Doc<"vehicles">[] = [];
    for (const vehicle of vehicles) {
      if (await isVehicleFree(ctx, vehicle._id, args.start, args.end)) free.push(vehicle);
    }
    return await resolveVehiclePhotoUrls(ctx, free);
  },
});

/** Réservations véhicules (approuvées + en attente) sur une plage, pour l'agenda. */
export const listVehicleBookings = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const reservations = await ctx.db.query("vehicleReservations").collect();
    const vehicles = await ctx.db.query("vehicles").collect();
    const nameById = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.name]));
    return reservations
      .filter((reservation) =>
        reservation.status !== "rejected" &&
        reservation.status !== "cancelled" &&
        overlaps(reservation.start, reservation.end, args.start, args.end)
      )
      .map((reservation) => ({
        _id: reservation._id,
        vehicleName: nameById.get(String(reservation.vehicleId)) ?? "Véhicule",
        clerkId: reservation.clerkId,
        bookedForClerkId: reservation.bookedForClerkId,
        userName: reservation.userName,
        purpose: reservation.purpose,
        usageType: reservation.usageType,
        expectedKm: reservation.expectedKm,
        start: reservation.start,
        end: reservation.end,
        status: reservation.status,
      }))
      .sort((a, b) => a.start - b.start);
  },
});

/** Toutes les réservations de l'utilisateur courant (salles + véhicules). */
export const listMyReservations = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const me = identity.subject;

    const [roomRes, vehicleRes, equipmentRes, rooms, vehicles, equipments] = await Promise.all([
      ctx.db.query("roomReservations").collect(),
      ctx.db.query("vehicleReservations").collect(),
      ctx.db.query("equipmentReservations").collect(),
      ctx.db.query("rooms").collect(),
      ctx.db.query("vehicles").collect(),
      ctx.db.query("equipments").collect(),
    ]);
    const roomInfo = new Map(
      await Promise.all(
        rooms.map(
          async (room) =>
            [
              String(room._id),
              {
                name: room.name,
                photoUrl: (room.photo ? await ctx.storage.getUrl(room.photo) : room.photoUrl) ?? null,
              },
            ] as const,
        ),
      ),
    );
    const vehicleInfo = new Map(
      await Promise.all(
        vehicles.map(
          async (vehicle) =>
            [
              String(vehicle._id),
              {
                name: vehicle.name,
                photoUrl:
                  (vehicle.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle.photoUrl) ?? null,
              },
            ] as const,
        ),
      ),
    );
    const equipmentInfo = new Map(
      await Promise.all(
        equipments.map(
          async (equipment) =>
            [
              String(equipment._id),
              {
                name: equipment.name,
                photoUrl:
                  (equipment.photo ? await ctx.storage.getUrl(equipment.photo) : equipment.photoUrl) ??
                  null,
              },
            ] as const,
        ),
      ),
    );
    const lastMileageByVehicleId = new Map(
      vehicles.map((vehicle) => [String(vehicle._id), vehicle.odometerKm]),
    );
    for (const reservation of vehicleRes) {
      if (typeof reservation.feedbackMileage !== "number" || !Number.isFinite(reservation.feedbackMileage)) {
        continue;
      }
      const key = String(reservation.vehicleId);
      const current = lastMileageByVehicleId.get(key);
      lastMileageByVehicleId.set(
        key,
        typeof current === "number" ? Math.max(current, reservation.feedbackMileage) : reservation.feedbackMileage,
      );
    }

    const mine = [
      ...roomRes
        .filter((reservation) => reservation.clerkId === me || reservation.bookedForClerkId === me)
        .map((reservation) => ({
          _id: String(reservation._id),
          kind: "room" as const,
          assetName: roomInfo.get(String(reservation.roomId))?.name ?? "Salle",
          photoUrl: roomInfo.get(String(reservation.roomId))?.photoUrl ?? null,
          usageType: undefined as "pro" | "personal" | undefined,
          label: reservation.title,
          start: reservation.start,
          end: reservation.end,
          status: reservation.status ?? ("confirmed" as const),
          feedbackSubmittedAt: reservation.feedbackSubmittedAt,
        })),
      ...vehicleRes
        .filter((reservation) => reservation.clerkId === me || reservation.bookedForClerkId === me)
        .map((reservation) => ({
          _id: String(reservation._id),
          kind: "vehicle" as const,
          assetName: vehicleInfo.get(String(reservation.vehicleId))?.name ?? "Véhicule",
          photoUrl: vehicleInfo.get(String(reservation.vehicleId))?.photoUrl ?? null,
          usageType: reservation.usageType,
          label: reservation.purpose,
          start: reservation.start,
          end: reservation.end,
          status: reservation.status,
          feedbackSubmittedAt: reservation.feedbackSubmittedAt,
          lastRecordedMileage: lastMileageByVehicleId.get(String(reservation.vehicleId)),
        })),
      // Les équipements se réservent depuis la même page que salles et
      // véhicules : « Mes réservations » doit donc tout regrouper, sinon
      // l'utilisateur n'aurait aucun endroit où retrouver ou annuler une
      // réservation d'équipement.
      ...equipmentRes
        .filter((reservation) => reservation.clerkId === me || reservation.bookedForClerkId === me)
        .map((reservation) => ({
          _id: String(reservation._id),
          kind: "equipment" as const,
          assetName: equipmentInfo.get(String(reservation.equipmentId))?.name ?? "Équipement",
          photoUrl: equipmentInfo.get(String(reservation.equipmentId))?.photoUrl ?? null,
          usageType: undefined as "pro" | "personal" | undefined,
          label: reservation.title,
          start: reservation.start,
          end: reservation.end,
          status: reservation.status ?? ("confirmed" as const),
          feedbackSubmittedAt: undefined as number | undefined,
        })),
    ];
    return mine.sort((a, b) => b.start - a.start);
  },
});

export const submitVehicleFeedback = mutation({
  args: {
    reservationId: v.id("vehicleReservations"),
    mileage: v.number(),
    fuelRestored: v.optional(v.boolean()),
    vehicleEmpty: v.boolean(),
    vehicleClean: v.boolean(),
    /** L'utilisateur déclare-t-il un incident ? Détermine `issues`. */
    incident: v.optional(v.boolean()),
    issues: v.optional(v.string()),
    notes: v.optional(v.string()),
    /** Photos / vidéos déjà envoyées via `files.generateUploadUrl`. */
    media: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          contentType: v.optional(v.string()),
          name: v.optional(v.string()),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation) throw new Error("Réservation introuvable.");
    if (!isReservationParticipant(reservation, identity.subject)) {
      throw new Error("Retour non autorisé.");
    }
    if (reservation.status !== "approved") {
      throw new Error("Le retour est disponible uniquement pour une réservation validée.");
    }
    // Aucune contrainte de date : c'est le retour qui libère le véhicule, donc
    // il doit pouvoir être fait dès qu'on rapporte le véhicule — souvent avant
    // la fin prévue. On refuse seulement un retour avant même le départ.
    if (reservation.start > Date.now()) {
      throw new Error("Le retour sera disponible une fois la réservation commencée.");
    }
    if (!Number.isFinite(args.mileage) || args.mileage < 0) {
      throw new Error("Kilométrage invalide.");
    }
    const lastRecordedMileage = await lastRecordedMileageForVehicle(ctx, reservation.vehicleId);
    if (
      typeof lastRecordedMileage === "number" &&
      Number.isFinite(lastRecordedMileage) &&
      args.mileage < lastRecordedMileage
    ) {
      throw new Error(
        `Le kilométrage ne peut pas être inférieur à ${Math.round(lastRecordedMileage)} km.`,
      );
    }

    await ctx.db.patch(args.reservationId, {
      feedbackSubmittedAt: Date.now(),
      feedbackMileage: Math.round(args.mileage),
      feedbackFuelRestored:
        reservation.usageType === "personal" ? Boolean(args.fuelRestored) : undefined,
      feedbackVehicleEmpty: args.vehicleEmpty,
      feedbackVehicleClean: args.vehicleClean,
      // Sans incident déclaré, aucun texte d'incident n'est conservé : le retour
      // ne doit pas remonter dans les remarques.
      feedbackIncident: Boolean(args.incident),
      feedbackIssues: args.incident ? args.issues?.trim() || undefined : undefined,
      feedbackNotes: args.notes?.trim() || undefined,
      // Au plus 6 pièces jointes : de quoi illustrer un problème sans
      // transformer le retour en album photo.
      feedbackMedia: args.media?.length ? args.media.slice(0, 6) : undefined,
    });
    await awardEngagementPoints(ctx, {
      clerkId: identity.subject,
      displayName: displayName(identity),
      eventKey: `vehicle-return:${args.reservationId}`,
    });
    // Chaque nouveau retour relance une synthèse qui tient compte de tout
    // l'historique du véhicule et de ses éventuels problèmes récurrents.
    await ctx.scheduler.runAfter(0, internal.vehicleRemarkAnalysis.analyze, {
      vehicleId: reservation.vehicleId,
    });
  },
});

/**
 * Libère manuellement un véhicule lorsqu'un utilisateur ne peut pas faire son
 * retour. Réservé aux gestionnaires : l'opération est tracée sur la réservation.
 */
export const markVehicleReturned = mutation({
  args: { reservationId: v.id("vehicleReservations") },
  handler: async (ctx, { reservationId }) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    const identity = await requireUser(ctx);
    const reservation = await ctx.db.get(reservationId);
    if (!reservation) throw new Error("Réservation introuvable.");
    if (reservation.status !== "approved") {
      throw new Error("Seule une réservation approuvée peut être clôturée.");
    }
    if (reservation.feedbackSubmittedAt) return;
    const now = Date.now();
    await ctx.db.patch(reservationId, {
      feedbackSubmittedAt: now,
      feedbackManualReturnAt: now,
      feedbackManualReturnBy: displayName(identity),
      feedbackNotes: [reservation.feedbackNotes, "Retour confirmé manuellement par l'équipe."].filter(Boolean).join("\n"),
    });
  },
});

/** Relance le demandeur d'une réservation terminée dont le retour manque encore. */
export const remindVehicleReturn = mutation({
  args: { reservationId: v.id("vehicleReservations") },
  handler: async (ctx, { reservationId }) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    const reservation = await ctx.db.get(reservationId);
    if (!reservation) throw new Error("Réservation introuvable.");
    if (reservation.status !== "approved" || reservation.end >= Date.now()) {
      throw new Error("Seule une réservation approuvée et terminée peut être relancée.");
    }
    if (reservation.feedbackSubmittedAt) {
      throw new Error("Le retour de cette réservation a déjà été effectué.");
    }

    const recipientClerkId = reservation.bookedForClerkId ?? reservation.clerkId;
    const email = await emailForClerkId(ctx, recipientClerkId);
    if (!email) throw new Error("Adresse e-mail introuvable pour cet utilisateur.");

    const vehicle = await ctx.db.get(reservation.vehicleId);
    const now = Date.now();
    await ctx.db.patch(reservationId, { feedbackReminderSentAt: now });
    await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendVehicleFeedbackRequestEmail, {
      email,
      name: reservation.userName,
      vehicleName: vehicle?.name ?? "Véhicule",
      vehicleImageUrl:
        (vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle?.photoUrl) ??
        undefined,
      label: reservation.purpose,
      start: reservation.start,
      end: reservation.end,
    });
  },
});

export const requestVehicleFeedbackForPastReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const reservations = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_status", (q) => q.eq("status", "approved"))
      .order("desc")
      .take(200);
    let delay = 0;

    for (const reservation of reservations) {
      if (reservation.end > now) continue;
      if (reservation.feedbackRequestedAt || reservation.feedbackSubmittedAt) continue;

      const recipientClerkId = reservation.bookedForClerkId ?? reservation.clerkId;
      const email = await emailForClerkId(ctx, recipientClerkId);
      const vehicle = await ctx.db.get(reservation.vehicleId);
      await ctx.db.patch(reservation._id, { feedbackRequestedAt: now });

      if (!email) continue;
      await ctx.scheduler.runAfter(delay, internal.mesoutilsEmails.sendVehicleFeedbackRequestEmail, {
        email,
        name: reservation.userName,
        vehicleName: vehicle?.name ?? "Véhicule",
        vehicleImageUrl:
          (vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle?.photoUrl) ??
          undefined,
        label: reservation.purpose,
        start: reservation.start,
        end: reservation.end,
      });
      delay += 700;
    }
  },
});

// ─── Retour (remarques) sur les réservations de salle ────────────────────────

export const submitRoomFeedback = mutation({
  args: {
    reservationId: v.id("roomReservations"),
    clean: v.boolean(),
    tidy: v.boolean(),
    /** L'utilisateur déclare-t-il un incident ? Détermine `issues`. */
    incident: v.optional(v.boolean()),
    issues: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation) throw new Error("Réservation introuvable.");
    if (!isReservationParticipant(reservation, identity.subject)) {
      throw new Error("Retour non autorisé.");
    }
    if (reservation.start > Date.now()) {
      throw new Error("Le retour sera disponible une fois la réservation commencée.");
    }
    await ctx.db.patch(args.reservationId, {
      feedbackSubmittedAt: Date.now(),
      feedbackClean: args.clean,
      feedbackTidy: args.tidy,
      feedbackIncident: Boolean(args.incident),
      feedbackIssues: args.incident ? args.issues?.trim() || undefined : undefined,
      feedbackNotes: args.notes?.trim() || undefined,
    });
  },
});

/** Cron : demande un retour sur les réservations de salle terminées. */
export const requestRoomFeedbackForPastReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const reservations = await ctx.db
      .query("roomReservations")
      .withIndex("by_start")
      .order("desc")
      .take(200);
    let delay = 0;

    for (const reservation of reservations) {
      if (reservation.end > now) continue;
      if (reservation.feedbackRequestedAt || reservation.feedbackSubmittedAt) continue;

      const recipientClerkId = reservation.bookedForClerkId ?? reservation.clerkId;
      const email = await emailForClerkId(ctx, recipientClerkId);
      const room = await ctx.db.get(reservation.roomId);
      await ctx.db.patch(reservation._id, { feedbackRequestedAt: now });

      if (!email) continue;
      await ctx.scheduler.runAfter(delay, internal.mesoutilsEmails.sendRoomFeedbackRequestEmail, {
        email,
        name: reservation.userName,
        roomName: room?.name ?? "Salle",
        roomImageUrl:
          (room?.photo ? await ctx.storage.getUrl(room.photo) : room?.photoUrl) ?? undefined,
        label: reservation.title,
        start: reservation.start,
        end: reservation.end,
      });
      delay += 700;
    }
  },
});

// ─── Remarques (retours) pour les encadrants ─────────────────────────────────

/**
 * Retours de réservation d'un véhicule.
 *
 * `scope` sépare deux populations qui n'ont pas le même usage :
 *  - « incidents » (défaut) : les retours qui SIGNALENT quelque chose. C'est la
 *    liste de travail — ce qui appelle une réparation ou un suivi.
 *  - « returns » : les retours « tout est ok ». Ils ne demandent rien, mais ils
 *    prouvent que le véhicule a bien été rendu et portent le kilométrage, la
 *    propreté, le plein. Sans eux, on ne voit que ce qui va mal.
 */
export const listVehicleRemarks = query({
  args: {
    vehicleId: v.optional(v.id("vehicles")),
    scope: v.optional(v.union(v.literal("incidents"), v.literal("returns"))),
  },
  handler: async (ctx, { vehicleId, scope }) => {
    await requireCrmPermission(ctx, "mesoutils:gotravaux", "read");
    const raw = vehicleId
      ? await ctx.db
          .query("vehicleReservations")
          .withIndex("by_vehicleId", (q) => q.eq("vehicleId", vehicleId))
          .order("desc")
          .collect()
      : await ctx.db.query("vehicleReservations").order("desc").take(300);
    // Un retour « tout est ok » n'est pas une remarque. Les retours antérieurs
    // au drapeau `feedbackIncident` sont jugés sur la présence d'un texte
    // d'incident.
    const hasIncident = (r: Doc<"vehicleReservations">) =>
      r.feedbackIncident ?? Boolean(r.feedbackIssues?.trim());
    const reservations = raw.filter(
      (r) =>
        r.feedbackSubmittedAt &&
        (scope === "returns" ? !hasIncident(r) : hasIncident(r)),
    );
    const [vehicles, mileageSource] = await Promise.all([
      ctx.db.query("vehicles").collect(),
      vehicleId ? Promise.resolve(raw) : ctx.db.query("vehicleReservations").collect(),
    ]);
    const byId = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));
    const mileageHistoryByVehicleId = new Map<
      string,
      Array<{ id: string; recordedAt: number; mileage: number }>
    >();
    for (const reservation of mileageSource) {
      if (typeof reservation.feedbackMileage !== "number" || !Number.isFinite(reservation.feedbackMileage)) {
        continue;
      }
      const key = String(reservation.vehicleId);
      const history = mileageHistoryByVehicleId.get(key) ?? [];
      history.push({
        id: String(reservation._id),
        recordedAt: feedbackMileageRecordedAt(reservation),
        mileage: reservation.feedbackMileage,
      });
      mileageHistoryByVehicleId.set(key, history);
    }
    for (const history of mileageHistoryByVehicleId.values()) {
      history.sort((a, b) => a.recordedAt - b.recordedAt);
    }

    const previousMileageForReservation = (reservation: Doc<"vehicleReservations">) => {
      const history = mileageHistoryByVehicleId.get(String(reservation.vehicleId)) ?? [];
      const reservationId = String(reservation._id);
      const recordedAt = feedbackMileageRecordedAt(reservation);
      let previous: number | undefined;
      for (const entry of history) {
        if (entry.recordedAt > recordedAt) break;
        if (entry.id !== reservationId) previous = entry.mileage;
      }
      return previous;
    };

    return await Promise.all(
      reservations
        .sort((a, b) => (b.feedbackSubmittedAt ?? 0) - (a.feedbackSubmittedAt ?? 0))
        .map(async (r) => {
          const vehicle = byId.get(String(r.vehicleId)) ?? null;
          return {
            _id: r._id,
            vehicleId: r.vehicleId,
            assetName: vehicle?.name ?? "Véhicule",
            photoUrl:
              (vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle?.photoUrl) ?? null,
            userName: r.userName,
            label: r.purpose,
            usageType: r.usageType,
            start: r.start,
            end: r.end,
            submittedAt: r.feedbackSubmittedAt ?? 0,
            mileage: r.feedbackMileage,
            lastRecordedMileage: previousMileageForReservation(r),
            fuelRestored: r.feedbackFuelRestored,
            vehicleEmpty: r.feedbackVehicleEmpty,
            vehicleClean: r.feedbackVehicleClean,
            issues: r.feedbackIssues,
            notes: r.feedbackNotes,
            media: (
              await Promise.all(
                (r.feedbackMedia ?? []).map(async (item) => {
                  const url = await ctx.storage.getUrl(item.storageId);
                  return url ? { url, contentType: item.contentType, name: item.name } : null;
                }),
              )
            ).flatMap((item) => (item ? [item] : [])),
          };
        }),
    );
  },
});

export const listRoomRemarks = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "mesoutils:salles", "read");
    const reservations = (
      await ctx.db.query("roomReservations").order("desc").take(300)
    ).filter((r) => r.feedbackSubmittedAt && (r.feedbackIncident ?? Boolean(r.feedbackIssues?.trim())));
    const rooms = await ctx.db.query("rooms").collect();
    const byId = new Map(rooms.map((room) => [String(room._id), room]));

    return await Promise.all(
      reservations
        .sort((a, b) => (b.feedbackSubmittedAt ?? 0) - (a.feedbackSubmittedAt ?? 0))
        .map(async (r) => {
          const room = byId.get(String(r.roomId)) ?? null;
          return {
            _id: r._id,
            assetName: room?.name ?? "Salle",
            photoUrl:
              (room?.photo ? await ctx.storage.getUrl(room.photo) : room?.photoUrl) ?? null,
            userName: r.userName,
            label: r.title,
            start: r.start,
            end: r.end,
            submittedAt: r.feedbackSubmittedAt ?? 0,
            clean: r.feedbackClean,
            tidy: r.feedbackTidy,
            issues: r.feedbackIssues,
            notes: r.feedbackNotes,
          };
        }),
    );
  },
});

export const listVehicles = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const vehicles = (await ctx.db.query("vehicles").collect()).filter(
      (vehicle) => vehicle.active,
    );
    return await resolveVehiclePhotoUrls(ctx, vehicles);
  },
});

export const listVehicleReservations = query({
  args: {
    status: v.optional(
      v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected"), v.literal("cancelled")),
    ),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const canManage = await hasCrmPermission(ctx, PAGE_KEY, "manage");
    const reservations = await ctx.db
      .query("vehicleReservations")
      .order("desc")
      .take(200);
    const filtered = reservations.filter((reservation) => {
      if (args.status && reservation.status !== args.status) return false;
      if (canManage) return true;
      return reservation.clerkId === identity.subject;
    });
    const vehicles = await ctx.db.query("vehicles").collect();
    const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));

    return await Promise.all(
      filtered.map(async (reservation) => {
        const vehicle = vehicleById.get(String(reservation.vehicleId)) ?? null;
        return {
          ...reservation,
          vehicle,
          vehiclePhotoUrl:
            vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : null,
        };
      }),
    );
  },
});

export const pendingVehicleReservationsCount = query({
  args: {},
  handler: async (ctx) => {
    try {
      await requireCrmPermission(ctx, PAGE_KEY, "manage");
    } catch {
      return 0;
    }
    const pending = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    return pending.length;
  },
});

export const requestVehicle = mutation({
  args: {
    vehicleId: v.id("vehicles"),
    purpose: v.string(),
    usageType: v.optional(v.union(v.literal("pro"), v.literal("personal"))),
    expectedKm: v.optional(v.number()),
    willTransport: v.optional(v.boolean()),
    transportDetails: v.optional(v.string()),
    start: v.number(),
    end: v.number(),
    forClerkId: v.optional(v.string()),
    forName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    ensureRange(args.start, args.end);

    // Le retour est obligatoire : tant qu'il en manque un, plus aucune
    // réservation. Vérifié ici et pas seulement côté UI, sinon la règle se
    // contourne en rejouant la requête.
    const overdueReturns = await overdueVehicleReturnsFor(ctx, identity.subject);
    if (overdueReturns.length > 0) {
      throw new Error(
        overdueReturns.length === 1
          ? "Vous avez un retour de véhicule à faire avant de pouvoir réserver à nouveau."
          : `Vous avez ${overdueReturns.length} retours de véhicule à faire avant de pouvoir réserver à nouveau.`,
      );
    }

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || !vehicle.active) throw new Error("Véhicule indisponible.");

    if (args.usageType === "pro" && vehicle.reservablePro === false) {
      throw new Error("Ce véhicule n'est pas réservable pour un usage professionnel.");
    }
    if (args.usageType === "personal" && vehicle.reservablePersonal !== true) {
      throw new Error("Ce véhicule n'est pas réservable pour un usage personnel.");
    }
    if (args.expectedKm !== undefined && (!Number.isFinite(args.expectedKm) || args.expectedKm < 0)) {
      throw new Error("Kilométrage estimé invalide.");
    }

    await ensureVehicleAvailable(ctx, args.vehicleId, args.start, args.end);

    const target = await resolveReservationTarget(ctx, identity, args.forClerkId, args.forName);
    const willTransport = args.willTransport ?? false;
    const transportDetails = willTransport
      ? args.transportDetails?.trim() || undefined
      : undefined;
    const reservationId = await ctx.db.insert("vehicleReservations", {
      vehicleId: args.vehicleId,
      clerkId: identity.subject,
      userName: target.name,
      bookedByName: target.onBehalf ? displayName(identity) : undefined,
      bookedForClerkId: target.clerkId,
      purpose: args.purpose.trim(),
      usageType: args.usageType,
      expectedKm: args.expectedKm,
      willTransport,
      transportDetails,
      start: args.start,
      end: args.end,
      status: "pending",
      createdAt: Date.now(),
    });
    await awardEngagementPoints(ctx, {
      clerkId: target.clerkId ?? identity.subject,
      displayName: target.name,
      eventKey: `vehicle-reservation:${reservationId}`,
    });

    // Les responsables sont notifiés de chaque demande de réservation véhicule :
    // notification in-app (pour ceux qui ont un compte) + email systématique.
    const requesterName = target.name;
    const requesterPhotoUrl =
      (target.onBehalf ? await photoForClerkId(ctx, target.clerkId) : pictureUrl(identity)) ??
      undefined;
    const assetImageUrl =
      (vehicle.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle.photoUrl) ?? undefined;
    for (const managerEmail of VEHICLE_REQUEST_NOTIFY_EMAILS) {
      const notifyClerkId = await clerkIdForEmail(ctx, managerEmail);
      if (notifyClerkId && notifyClerkId !== identity.subject) {
        await createMesoutilsNotification(ctx, {
          recipientClerkId: notifyClerkId,
          kind: "vehicle_reservation_request",
          title: "Nouvelle demande de réservation de véhicule",
          body: [vehicle.name, requesterName, args.purpose.trim()]
            .filter(Boolean)
            .join(" · "),
          actorName: displayName(identity),
          assetImageUrl,
          href: "/gotravaux?v=reservations",
        });
      }
    }

    // Email aux responsables (adresses fixes), qu'ils aient un compte ou non.
    await ctx.scheduler.runAfter(1200, internal.mesoutilsEmails.sendVehicleRequestToManagers, {
      requesterName,
      requesterPhotoUrl,
      vehicleName: vehicle.name,
      vehicleImageUrl: assetImageUrl,
      label: args.purpose.trim(),
      start: args.start,
      end: args.end,
    });

    // Véhicule mis à disposition de la Recyclerie : on prévient son équipe.
    if (vehicle.recycappEnabled === true) {
      await ctx.scheduler.runAfter(2400, internal.mesoutilsEmails.sendRecyclerieVehicleNotice, {
        state: "submitted",
        requesterName,
        requesterPhotoUrl,
        vehicleName: vehicle.name,
        vehicleImageUrl: assetImageUrl,
        label: args.purpose.trim(),
        start: args.start,
        end: args.end,
      });
    }

    const email = target.onBehalf
      ? await emailForClerkId(ctx, target.clerkId)
      : identity.email ?? null;
    if (email) {
      await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendReservationEmail, {
        email,
        name: requesterName,
        assetKind: "vehicle",
        assetName: vehicle.name,
        label: args.purpose.trim(),
        start: args.start,
        end: args.end,
        state: "submitted",
        photoUrl: requesterPhotoUrl,
        assetImageUrl,
      });
    }
    return reservationId;
  },
});

/**
 * Applique une décision (accepter/refuser) sur une réservation véhicule :
 * contrôle de disponibilité, notification + emails au demandeur, et notice
 * Recyclerie le cas échéant. Partagé entre la décision Mes Outils (Gotravaux)
 * et la décision côté Recyclerie (recycapp).
 */
async function applyVehicleReservationDecision(
  ctx: MutationCtx,
  identity: Awaited<ReturnType<typeof requireUser>>,
  args: {
    reservationId: Id<"vehicleReservations">;
    decision: "approved" | "rejected";
    note?: string;
  },
  opts: { requireRecyclerie?: boolean } = {},
) {
  const reservation = await ctx.db.get(args.reservationId);
  if (!reservation) throw new Error("Réservation introuvable.");
  const vehicle = await ctx.db.get(reservation.vehicleId);
  if (opts.requireRecyclerie && vehicle?.recycappEnabled !== true) {
    throw new Error("Ce véhicule n'est pas rattaché à la Recyclerie.");
  }
  if (reservation.status === "cancelled") {
    throw new Error("Cette réservation a été annulée.");
  }

  if (args.decision === "approved") {
    // La réservation elle-même est exclue du contrôle : une demande déjà
    // approuvée puis re-décidée ne doit pas entrer en conflit avec elle-même.
    await ensureVehicleAvailable(
      ctx,
      reservation.vehicleId,
      reservation.start,
      reservation.end,
      reservation._id,
    );
  }

  await ctx.db.patch(args.reservationId, {
    status: args.decision,
    decisionNote: args.note?.trim() || undefined,
    decidedBy: displayName(identity),
    decidedAt: Date.now(),
  });

  await createMesoutilsNotification(ctx, {
    recipientClerkId: reservation.bookedForClerkId ?? reservation.clerkId,
    kind: "vehicle_reservation_decided",
    title:
      args.decision === "approved"
        ? "Votre réservation de véhicule est approuvée"
        : "Votre réservation de véhicule est refusée",
    body: [vehicle?.name ?? "Véhicule", reservation.purpose, args.note?.trim()]
      .filter(Boolean)
      .join(" · "),
    actorName: displayName(identity),
    assetImageUrl: (vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : undefined) ?? undefined,
    href: "/reservations?v=mine",
  });

  const recipientClerkId = reservation.bookedForClerkId ?? reservation.clerkId;
  const requesterPhotoUrl = (await photoForClerkId(ctx, recipientClerkId)) ?? undefined;
  const vehicleImageUrl =
    (vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle?.photoUrl) ?? undefined;
  const email = await emailForClerkId(ctx, recipientClerkId);
  if (email) {
    await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendReservationEmail, {
      email,
      name: reservation.userName,
      assetKind: "vehicle",
      assetName: vehicle?.name ?? "Véhicule",
      label: reservation.purpose,
      start: reservation.start,
      end: reservation.end,
      state: args.decision === "approved" ? "approved" : "rejected",
      note: args.note?.trim() || undefined,
      photoUrl: requesterPhotoUrl,
      assetImageUrl: vehicleImageUrl,
    });
  }

  await ctx.scheduler.runAfter(1200, internal.mesoutilsEmails.sendVehicleReservationManagerUpdate, {
    state: args.decision,
    requesterName: reservation.userName,
    requesterPhotoUrl,
    vehicleName: vehicle?.name ?? "Véhicule",
    vehicleImageUrl,
    label: reservation.purpose,
    start: reservation.start,
    end: reservation.end,
    note: args.note?.trim() || undefined,
  });

  // Véhicule Recyclerie accepté : on prévient l'équipe (sans lien Gotravaux).
  if (args.decision === "approved" && vehicle?.recycappEnabled === true) {
    await ctx.scheduler.runAfter(1200, internal.mesoutilsEmails.sendRecyclerieVehicleNotice, {
      state: "approved",
      requesterName: reservation.userName,
      requesterPhotoUrl,
      vehicleName: vehicle.name,
      vehicleImageUrl,
      label: reservation.purpose,
      start: reservation.start,
      end: reservation.end,
      note: args.note?.trim() || undefined,
    });
  }
}

export const decideVehicleReservation = mutation({
  args: {
    reservationId: v.id("vehicleReservations"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    const identity = await requireUser(ctx);
    await applyVehicleReservationDecision(ctx, identity, args);
  },
});

/**
 * Décision côté Recyclerie (recycapp) : réservée aux véhicules mis à disposition
 * de la Recyclerie, protégée par le droit `flotte` (manage).
 */
export const decideRecyclerieVehicleReservation = mutation({
  args: {
    reservationId: v.id("vehicleReservations"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "reservations", "manage");
    const identity = await requireUser(ctx);
    await applyVehicleReservationDecision(ctx, identity, args, { requireRecyclerie: true });
  },
});

/**
 * Réservations des véhicules mis à disposition de la Recyclerie, pour la page
 * « Réservations » de recycapp. Protégée par le droit `flotte` (lecture).
 */
export const listRecyclerieVehicleReservations = query({
  args: {
    status: v.optional(
      v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected"), v.literal("cancelled")),
    ),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "reservations", "read");
    const vehicles = await ctx.db.query("vehicles").collect();
    const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));

    const reservations = await ctx.db
      .query("vehicleReservations")
      .order("desc")
      .take(200);
    const filtered = reservations.filter((reservation) => {
      if (args.status && reservation.status !== args.status) return false;
      return vehicleById.get(String(reservation.vehicleId))?.recycappEnabled === true;
    });

    return await Promise.all(
      filtered.map(async (reservation) => {
        const vehicle = vehicleById.get(String(reservation.vehicleId)) ?? null;
        return {
          ...reservation,
          vehicle,
          vehiclePhotoUrl: vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : null,
        };
      }),
    );
  },
});

/** Annulation d'une réservation véhicule Recyclerie (droit `flotte` manage). */
export const cancelRecyclerieVehicleReservation = mutation({
  args: { reservationId: v.id("vehicleReservations") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "reservations", "manage");
    const identity = await requireUser(ctx);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation) return;
    const vehicle = await ctx.db.get(reservation.vehicleId);
    if (vehicle?.recycappEnabled !== true) {
      throw new Error("Ce véhicule n'est pas rattaché à la Recyclerie.");
    }
    if (canPermanentlyDelete(identity)) {
      await ctx.db.delete(args.reservationId);
      return;
    }
    await ctx.db.patch(args.reservationId, {
      status: "cancelled",
      decisionNote: "Demande annulée",
      decidedBy: displayName(identity),
      decidedAt: Date.now(),
    });
    const recipientClerkId = reservation.bookedForClerkId ?? reservation.clerkId;
    const email = await emailForClerkId(ctx, recipientClerkId);
    if (email) {
      await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendReservationEmail, {
        email,
        name: reservation.userName,
        assetKind: "vehicle",
        assetName: vehicle?.name ?? "Véhicule",
        label: reservation.purpose,
        start: reservation.start,
        end: reservation.end,
        state: "cancelled",
        photoUrl: (await photoForClerkId(ctx, recipientClerkId)) ?? undefined,
        assetImageUrl:
          (vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle?.photoUrl) ??
          undefined,
      });
    }
    await ctx.scheduler.runAfter(1200, internal.mesoutilsEmails.sendVehicleReservationManagerUpdate, {
      state: "cancelled",
      requesterName: reservation.userName,
      requesterPhotoUrl: (await photoForClerkId(ctx, recipientClerkId)) ?? undefined,
      vehicleName: vehicle?.name ?? "Véhicule",
      vehicleImageUrl:
        (vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle?.photoUrl) ??
        undefined,
      label: reservation.purpose,
      start: reservation.start,
      end: reservation.end,
      note: "Demande annulée",
    });
  },
});

export const cancelVehicleReservation = mutation({
  args: {
    reservationId: v.id("vehicleReservations"),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation) return;
    const canManage = await hasCrmPermission(ctx, PAGE_KEY, "manage");
    if (!isReservationParticipant(reservation, identity.subject) && !canManage) {
      throw new Error("Annulation non autorisée.");
    }
    const vehicle = await ctx.db.get(reservation.vehicleId);
    if (canPermanentlyDelete(identity)) {
      await ctx.db.delete(args.reservationId);
      return;
    }
    await ctx.db.patch(args.reservationId, {
      status: "cancelled",
      decisionNote: "Demande annulée",
      decidedBy: displayName(identity),
      decidedAt: Date.now(),
    });
    const recipientClerkId = reservation.bookedForClerkId ?? reservation.clerkId;
    const email = await emailForClerkId(ctx, recipientClerkId);
    if (email) {
      await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendReservationEmail, {
        email,
        name: reservation.userName,
        assetKind: "vehicle",
        assetName: vehicle?.name ?? "Véhicule",
        label: reservation.purpose,
        start: reservation.start,
        end: reservation.end,
        state: "cancelled",
        photoUrl: (await photoForClerkId(ctx, recipientClerkId)) ?? undefined,
        assetImageUrl:
          (vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle?.photoUrl) ??
          undefined,
      });
    }
    await ctx.scheduler.runAfter(1200, internal.mesoutilsEmails.sendVehicleReservationManagerUpdate, {
      state: "cancelled",
      requesterName: reservation.userName,
      requesterPhotoUrl: (await photoForClerkId(ctx, recipientClerkId)) ?? undefined,
      vehicleName: vehicle?.name ?? "Véhicule",
      vehicleImageUrl:
        (vehicle?.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle?.photoUrl) ??
        undefined,
      label: reservation.purpose,
      start: reservation.start,
      end: reservation.end,
      note: "Demande annulée",
    });
  },
});

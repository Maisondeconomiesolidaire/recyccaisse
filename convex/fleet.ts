import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import {
  isVehicleReturnOverdue,
  latestMileageReading,
  requireAnyCrmPermission,
  requireCrmPermission,
  vehicleReservationBusyEnd,
} from "./lib";

const vehicleKind = v.union(
  v.literal("utilitaire"),
  v.literal("voiture"),
);

/** Deux timestamps tombent-ils le même jour (UTC) ? */
function sameUtcDay(a: number, b: number): boolean {
  return Math.floor(a / 86_400_000) === Math.floor(b / 86_400_000);
}

function overlapsUtcDay(start: number, end: number, day: number) {
  const dayStart = Math.floor(day / 86_400_000) * 86_400_000;
  const dayEnd = dayStart + 86_400_000;
  return start < dayEnd && end > dayStart;
}

/**
 * Raison d'indisponibilité d'un véhicule à une date donnée, sinon `null`.
 * - Occupé s'il est affecté à une collecte/livraison planifiée ce jour-là.
 * - Occupé s'il est en tournée (en cours, ou planifiée ce jour-là) tant que
 *   la tournée n'est pas terminée ou annulée.
 */
export async function vehicleBusyReason(
  ctx: QueryCtx | MutationCtx,
  vehicleId: Id<"vehicles">,
  date: number,
  opts: {
    excludeRequestId?: Id<"requests">;
    excludeTourneeId?: Id<"tournees">;
    // Les réservations Mes Outils sont horodatées (créneau à l'heure près). Les
    // flux de réservation véhicule vérifient les chevauchements précisément et
    // passent cette option pour ne pas bloquer toute la journée.
    ignoreReservations?: boolean;
  } = {},
): Promise<string | null> {
  const requests = await ctx.db
    .query("requests")
    .withIndex("by_assignedVehicle", (q) => q.eq("assignedVehicle", vehicleId))
    .collect();
  for (const request of requests) {
    if (opts.excludeRequestId && request._id === opts.excludeRequestId) continue;
    if (
      request.outcome === "open" &&
      request.scheduledDate &&
      sameUtcDay(request.scheduledDate, date)
    ) {
      return `Affecté à une collecte planifiée ce jour (#${request.reference ?? "?"})`;
    }
  }

  const tournees = await ctx.db
    .query("tournees")
    .withIndex("by_fleetVehicle", (q) => q.eq("fleetVehicleId", vehicleId))
    .collect();
  for (const tournee of tournees) {
    if (opts.excludeTourneeId && tournee._id === opts.excludeTourneeId) continue;
    if (tournee.status === "terminee" || tournee.status === "annulee") continue;
    if (tournee.status === "en_cours" || sameUtcDay(tournee.date, date)) {
      return `En tournée (${tournee.label})`;
    }
  }

  if (!opts.ignoreReservations) {
    const reservations = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_vehicleId", (q) => q.eq("vehicleId", vehicleId))
      .collect();
    const now = Date.now();
    for (const reservation of reservations) {
      // Une réservation retournée reste visible dans l'historique mais libère
      // immédiatement le véhicule pour toutes les vues de disponibilité.
      if (reservation.status !== "approved" || reservation.feedbackSubmittedAt) continue;
      if (overlapsUtcDay(reservation.start, vehicleReservationBusyEnd(reservation, now), date)) {
        return isVehicleReturnOverdue(reservation, now)
          ? "Non rendu (retour non effectué)"
          : "Réservé via Mes Outils";
      }
    }
  }

  // Une tâche de maintenance non terminée planifiée ce jour-là bloque le véhicule.
  const tasks = await ctx.db
    .query("vehicleMaintenanceTasks")
    .withIndex("by_vehicleId", (q) => q.eq("vehicleId", vehicleId))
    .collect();
  for (const task of tasks) {
    if (task.status === "done" || !task.dueDate) continue;
    const taskEnd = Math.max(task.dueDate, task.endDate ?? task.dueDate);
    if (overlapsUtcDay(task.dueDate, taskEnd, date)) {
      return `En maintenance (${task.title})`;
    }
  }

  return null;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "flotte", "read");
    // La flotte n'affiche que les véhicules actifs : on exclut les immobilisés
    // (active === false) et les vendus (saleDate renseignée).
    const vehicles = (await ctx.db.query("vehicles").order("desc").collect()).filter(
      (vehicle) => vehicle.recycappEnabled === true && vehicle.active && !vehicle.saleDate,
    );
    const now = Date.now();
    return await Promise.all(
      vehicles.map(async (vehicle) => {
        const reason = vehicle.active
          ? await vehicleBusyReason(ctx, vehicle._id, now)
          : null;
        const status: "disponible" | "sur_collecte" | "en_tournee" | "inactif" =
          !vehicle.active
            ? "inactif"
            : reason?.startsWith("En tournée")
              ? "en_tournee"
              : reason
                ? "sur_collecte"
                : "disponible";
        const photoUrl = vehicle.photo
          ? await ctx.storage.getUrl(vehicle.photo)
          : null;
        return { ...vehicle, status, reason, photoUrl };
      }),
    );
  },
});

/** Véhicules actifs disponibles à une date (pour les sélecteurs d'affectation). */
export const availableOn = query({
  args: {
    date: v.number(),
    includeVehicleId: v.optional(v.id("vehicles")),
  },
  handler: async (ctx, { date, includeVehicleId }) => {
    await requireAnyCrmPermission(ctx, [
      ["flotte", "read"],
      ["tournees", "read"],
      ["demandes", "read"],
    ]);
    const vehicles = (await ctx.db.query("vehicles").collect()).filter(
      (vehicle) =>
        (vehicle.recycappEnabled === true && vehicle.active) ||
        vehicle._id === includeVehicleId,
    );
    const result = [];
    for (const vehicle of vehicles) {
      const isCurrent = vehicle._id === includeVehicleId;
      const reason = isCurrent
        ? null
        : await vehicleBusyReason(ctx, vehicle._id, date);
      if (reason && !isCurrent) continue;
      const photoUrl = vehicle.photo
        ? await ctx.storage.getUrl(vehicle.photo)
        : null;
      result.push({
        _id: vehicle._id,
        name: vehicle.name,
        plate: vehicle.plate ?? null,
        kind: vehicle.kind,
        photoUrl,
      });
    }
    return result;
  },
});

export const listRemarks = query({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, { vehicleId }) => {
    await requireCrmPermission(ctx, "flotte", "read");
    const vehicle = await ctx.db.get(vehicleId);
    if (!vehicle || vehicle.recycappEnabled !== true) {
      throw new Error("Véhicule introuvable.");
    }

    const raw = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_vehicleId", (q) => q.eq("vehicleId", vehicleId))
      .order("desc")
      .collect();
    const reservations = raw.filter((reservation) => reservation.feedbackSubmittedAt);
    // Le relevé de référence est le plus récent (fiche véhicule ou retour),
    // pas le plus élevé : une correction du compteur doit faire autorité.
    const lastMileage = latestMileageReading(vehicle, raw)?.mileage ?? null;

    return {
      vehicleId: vehicle._id,
      vehicleName: vehicle.name,
      remarks: reservations
        .sort((a, b) => (b.feedbackSubmittedAt ?? 0) - (a.feedbackSubmittedAt ?? 0))
        .map((reservation) => ({
          _id: reservation._id,
          userName: reservation.userName,
          purpose: reservation.purpose,
          usageType: reservation.usageType ?? null,
          start: reservation.start,
          end: reservation.end,
          submittedAt: reservation.feedbackSubmittedAt ?? 0,
          mileage: reservation.feedbackMileage ?? null,
          lastRecordedMileage: lastMileage,
          fuelRestored: reservation.feedbackFuelRestored ?? null,
          vehicleEmpty: reservation.feedbackVehicleEmpty ?? null,
          vehicleClean: reservation.feedbackVehicleClean ?? null,
          issues: reservation.feedbackIssues ?? null,
          notes: reservation.feedbackNotes ?? null,
        })),
    };
  },
});

/** Véhicules pris (demandes + tournées) sur une période, pour le calendrier. */
export const takenInRange = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    await requireAnyCrmPermission(ctx, [
      ["flotte", "read"],
      ["tournees", "read"],
      ["demandes", "read"],
      ["calendrier", "read"],
    ]);
    const vehicles = (await ctx.db.query("vehicles").collect()).filter(
      (vehicle) => vehicle.recycappEnabled === true,
    );
    const nameById = new Map(vehicles.map((v) => [String(v._id), v.name]));

    const entries: Array<{
      date: number;
      vehicleId: string;
      vehicleName: string;
      source: "demande" | "tournee";
      label: string;
    }> = [];

    const requests = await ctx.db
      .query("requests")
      .withIndex("by_scheduledDate", (q) =>
        q.gte("scheduledDate", from).lte("scheduledDate", to),
      )
      .collect();
    for (const r of requests) {
      if (!r.assignedVehicle || !r.scheduledDate || r.outcome !== "open") continue;
      const name = nameById.get(String(r.assignedVehicle));
      if (!name) continue;
      entries.push({
        date: r.scheduledDate,
        vehicleId: String(r.assignedVehicle),
        vehicleName: name,
        source: "demande",
        label: r.reference ? `#${r.reference}` : "Demande",
      });
    }

    const tournees = await ctx.db
      .query("tournees")
      .withIndex("by_date", (q) => q.gte("date", from).lte("date", to))
      .collect();
    for (const t of tournees) {
      if (!t.fleetVehicleId || t.status === "terminee" || t.status === "annulee")
        continue;
      const name = nameById.get(String(t.fleetVehicleId));
      if (!name) continue;
      entries.push({
        date: t.date,
        vehicleId: String(t.fleetVehicleId),
        vehicleName: name,
        source: "tournee",
        label: t.label,
      });
    }

    return entries;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    plate: v.optional(v.string()),
    kind: vehicleKind,
    photo: v.optional(v.id("_storage")),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "flotte", "create");
    return await ctx.db.insert("vehicles", {
      ...args,
      active: true,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("vehicles"),
    name: v.string(),
    plate: v.optional(v.string()),
    kind: vehicleKind,
    photo: v.optional(v.union(v.id("_storage"), v.null())),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    active: v.boolean(),
  },
  handler: async (ctx, { id, photo, ...rest }) => {
    await requireCrmPermission(ctx, "flotte", "update");
    await ctx.db.patch(id, {
      ...rest,
      ...(photo !== undefined ? { photo: photo ?? undefined } : {}),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("vehicles") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "flotte", "delete");
    await ctx.db.delete(id);
  },
});

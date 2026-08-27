import { v } from "convex/values";
import {
  action,
  env,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { accessAllows, customerFullName, requireCrmPermission } from "./lib";
import { vehicleBusyReason } from "./fleet";
import type { Doc, Id } from "./_generated/dataModel";

const TOURNEE_DEPOT_ADDRESS = "4 rue de la prairie 60650 Lachapelle-aux-Pots";
const MAX_STORED_ROUTE_COORDINATES = 8_000;

const tourneeStopValidator = v.object({
  requestId: v.optional(v.id("requests")),
  address: v.string(),
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  contactName: v.optional(v.string()),
  contactPhone: v.optional(v.string()),
  notes: v.optional(v.string()),
  status: v.union(v.literal("prevu"), v.literal("effectue"), v.literal("annule")),
  order: v.number(),
});

type TourneeStop = {
  requestId?: Id<"requests">;
  address: string;
  latitude?: number;
  longitude?: number;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
  status: "prevu" | "effectue" | "annule";
  order: number;
};

function buildStopTrackingKey(
  stop: Pick<TourneeStop, "requestId" | "address" | "contactName">,
) {
  return stop.requestId ?? `${normalizeTrackingText(stop.address)}::${normalizeTrackingText(stop.contactName)}`;
}

function normalizeTrackingText(value?: string) {
  return (value ?? "").trim().toLowerCase();
}

function findStopForTrackingLink(
  stops: TourneeStop[],
  link: Pick<TourneeStop, "requestId" | "address" | "contactName" | "order">,
) {
  return (
    (link.requestId
      ? stops.find((stop) => stop.requestId === link.requestId)
      : undefined) ??
    stops.find(
      (stop) =>
        normalizeTrackingText(stop.address) === normalizeTrackingText(link.address) &&
        normalizeTrackingText(stop.contactName) === normalizeTrackingText(link.contactName),
    ) ??
    stops.find((stop) => stop.order === link.order)
  );
}

function requestCollectAddressKey(request: Doc<"requests">) {
  return normalizeTrackingText(
    [
      request.collecte?.collectAddress?.address ?? request.customer.address,
      request.collecte?.collectAddress?.postalCode ?? request.customer.postalCode,
      request.collecte?.collectAddress?.city ?? request.customer.city,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function stopAddressKey(stop: Pick<TourneeStop, "address">) {
  return normalizeTrackingText(stop.address);
}

async function resolveRequestIdForStop(
  ctx: MutationCtx,
  stop: TourneeStop,
) {
  if (stop.requestId) return stop.requestId;
  const stopAddress = stopAddressKey(stop);
  const stopContact = normalizeTrackingText(stop.contactName);
  if (!stopAddress) return undefined;

  const candidates = (await ctx.db
    .query("requests")
    .withIndex("by_outcome", (q) => q.eq("outcome", "open"))
    .filter((q) => q.eq(q.field("type"), "collecte"))
    .collect()).filter((request) => {
      if (requestCollectAddressKey(request) !== stopAddress) return false;
      if (!stopContact) return true;
      return normalizeTrackingText(customerFullName(request.customer)) === stopContact;
    });

  return candidates.length === 1 ? candidates[0]._id : undefined;
}

async function syncTrackingLinks(
  ctx: MutationCtx,
  tourneeId: Id<"tournees">,
  stops: TourneeStop[],
) {
  const existingLinks = await ctx.db
    .query("tourneeTrackingLinks")
    .withIndex("by_tourneeId", (q) => q.eq("tourneeId", tourneeId))
    .collect();

  const linksByKey = new Map(existingLinks.map((link) => [buildStopTrackingKey(link), link]));
  const usedLinkIds = new Set<Id<"tourneeTrackingLinks">>();

  const resolvedStops: TourneeStop[] = [];

  for (const stop of stops) {
    const requestId = await resolveRequestIdForStop(ctx, stop);
    const stopWithRequest = requestId ? { ...stop, requestId } : stop;
    resolvedStops.push(stopWithRequest);
    const key = buildStopTrackingKey(stopWithRequest);
    const existing = linksByKey.get(key);
    if (existing) {
      usedLinkIds.add(existing._id);
      await ctx.db.patch(existing._id, {
        stopOrder: stopWithRequest.order,
        requestId: stopWithRequest.requestId,
        contactName: stopWithRequest.contactName,
        address: stopWithRequest.address,
        latitude: stopWithRequest.latitude,
        longitude: stopWithRequest.longitude,
      });
      continue;
    }

    const insertedId = await ctx.db.insert("tourneeTrackingLinks", {
      tourneeId,
      shareToken: crypto.randomUUID(),
      stopOrder: stopWithRequest.order,
      requestId: stopWithRequest.requestId,
      contactName: stopWithRequest.contactName,
      address: stopWithRequest.address,
      latitude: stopWithRequest.latitude,
      longitude: stopWithRequest.longitude,
      createdAt: Date.now(),
    });
    usedLinkIds.add(insertedId);
  }

  await Promise.all(
    existingLinks
      .filter((link) => !usedLinkIds.has(link._id))
      .map((link) => ctx.db.delete(link._id)),
  );

  return resolvedStops;
}

// ─── Sorties hors magasin ─────────────────────────────────────────────────────

export const createSortieHorsMagasin = mutation({
  args: {
    articleId: v.optional(v.id("articles")),
    articleTitle: v.string(),
    articleReference: v.optional(v.string()),
    price: v.number(),
    channel: v.union(
      v.literal("leboncoin"),
      v.literal("ebay"),
      v.literal("vinted"),
      v.literal("instagram"),
      v.literal("facebook"),
      v.literal("depot_vente"),
      v.literal("commande"),
      v.literal("autre"),
    ),
    buyerName: v.optional(v.string()),
    notes: v.optional(v.string()),
    date: v.number(),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "sorties", "create");
    if (args.articleId) {
      await ctx.db.patch(args.articleId, { status: "vendu" });
    }
    return await ctx.db.insert("sortiesHorsMagasin", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const listSortiesHorsMagasin = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    await requireCrmPermission(ctx, "sorties", "read");
    return await ctx.db
      .query("sortiesHorsMagasin")
      .withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate))
      .order("desc")
      .collect();
  },
});

// ─── Sorties matières ─────────────────────────────────────────────────────────

export const createSortieMatiere = mutation({
  args: {
    materialType: v.string(),
    weightKg: v.number(),
    destination: v.string(),
    documentNumber: v.optional(v.string()),
    notes: v.optional(v.string()),
    origin: v.optional(v.string()),
    date: v.number(),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "sorties", "create");
    return await ctx.db.insert("sortiesMatieres", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const listSortiesMatieres = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    await requireCrmPermission(ctx, "sorties", "read");
    return await ctx.db
      .query("sortiesMatieres")
      .withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate))
      .order("desc")
      .collect();
  },
});

export const sortiesStats = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    await requireCrmPermission(ctx, "sorties", "read");
    const [hm, mat] = await Promise.all([
      ctx.db.query("sortiesHorsMagasin").withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate)).collect(),
      ctx.db.query("sortiesMatieres").withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate)).collect(),
    ]);

    const hmRevenue = hm.reduce((s, v) => s + v.price, 0);
    const matWeight = mat.reduce((s, v) => s + v.weightKg, 0);
    const byChannel: Record<string, number> = {};
    for (const v of hm) byChannel[v.channel] = (byChannel[v.channel] ?? 0) + v.price;
    const byMaterial: Record<string, number> = {};
    for (const v of mat) byMaterial[v.materialType] = (byMaterial[v.materialType] ?? 0) + v.weightKg;

    return {
      hmCount: hm.length,
      hmRevenue: Math.round(hmRevenue * 100) / 100,
      matCount: mat.length,
      matWeight: Math.round(matWeight * 10) / 10,
      byChannel,
      byMaterial,
    };
  },
});

// ─── Tournées ─────────────────────────────────────────────────────────────────

export const createTournee = mutation({
  args: {
    label: v.string(),
    date: v.number(),
    driverId: v.optional(v.id("teamMembers")),
    driverWorkerId: v.optional(v.id("polyvalentWorkers")),
    fleetVehicleId: v.optional(v.id("vehicles")),
    stops: v.array(tourneeStopValidator),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "tournees", "create");
    if (args.fleetVehicleId) {
      const reason = await vehicleBusyReason(ctx, args.fleetVehicleId, args.date);
      if (reason) {
        throw new Error(`Véhicule indisponible pour cette tournée : ${reason}`);
      }
    }
    const tourneeId = await ctx.db.insert("tournees", {
      ...args,
      depotAddress: TOURNEE_DEPOT_ADDRESS,
      status: "planifiee",
      createdAt: Date.now(),
    });
    const resolvedStops = await syncTrackingLinks(ctx, tourneeId, args.stops);
    if (resolvedStops.some((stop, index) => stop.requestId !== args.stops[index]?.requestId)) {
      await ctx.db.patch(tourneeId, { stops: resolvedStops });
    }
    return tourneeId;
  },
});

export const getTourneeForOptimization = internalQuery({
  args: { tourneeId: v.id("tournees") },
  handler: async (ctx, { tourneeId }) => {
    return await ctx.db.get(tourneeId);
  },
});

export const applyTourneeOptimization = internalMutation({
  args: {
    tourneeId: v.id("tournees"),
    orderedStops: v.array(tourneeStopValidator),
    depotLatitude: v.number(),
    depotLongitude: v.number(),
    depotAddress: v.string(),
    optimizedAt: v.number(),
    estimatedDistanceMeters: v.number(),
    estimatedDurationSeconds: v.number(),
    routeCoordinates: v.array(v.array(v.number())),
  },
  handler: async (
    ctx,
    {
      tourneeId,
      orderedStops,
      depotLatitude,
      depotLongitude,
      depotAddress,
      optimizedAt,
      estimatedDistanceMeters,
      estimatedDurationSeconds,
      routeCoordinates,
    },
  ) => {
    await ctx.db.patch(tourneeId, {
      stops: orderedStops,
      depotLatitude,
      depotLongitude,
      depotAddress,
      optimizedAt,
      estimatedDistanceMeters,
      estimatedDurationSeconds,
      routeCoordinates,
    });
    const resolvedStops = await syncTrackingLinks(ctx, tourneeId, orderedStops);
    if (resolvedStops.some((stop, index) => stop.requestId !== orderedStops[index]?.requestId)) {
      await ctx.db.patch(tourneeId, { stops: resolvedStops });
    }
  },
});

async function geocodeStop(address: string, accessToken: string) {
  const url = new URL("https://api.mapbox.com/search/geocode/v6/forward");
  url.searchParams.set("q", address);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("limit", "1");
  url.searchParams.set("language", "fr");
  url.searchParams.set("country", "FR");
  url.searchParams.set("autocomplete", "false");

  const response = await fetch(url.toString());
  const payload = (await response.json()) as {
    features?: Array<{ geometry?: { coordinates?: [number, number] } }>;
    message?: string;
  };

  if (!response.ok) {
    throw new Error(payload.message || "Géocodage Mapbox impossible.");
  }

  const coordinates = payload.features?.[0]?.geometry?.coordinates;
  if (!coordinates || coordinates.length < 2) {
    throw new Error(`Adresse introuvable ou imprécise : ${address}`);
  }

  return { longitude: coordinates[0], latitude: coordinates[1] };
}

type OptimizableStop = {
  stop: TourneeStop;
  longitude: number;
  latitude: number;
};

function limitRouteCoordinates(
  coordinates: number[][],
  maxPoints = MAX_STORED_ROUTE_COORDINATES,
) {
  const validCoordinates = coordinates.filter(
    (coordinate) =>
      coordinate.length >= 2 &&
      Number.isFinite(coordinate[0]) &&
      Number.isFinite(coordinate[1]),
  );
  if (validCoordinates.length <= maxPoints) return validCoordinates;
  if (maxPoints <= 1) return validCoordinates.slice(0, maxPoints);

  const lastIndex = validCoordinates.length - 1;
  return Array.from({ length: maxPoints }, (_, index) => {
    const sourceIndex = Math.round((index * lastIndex) / (maxPoints - 1));
    const coordinate = validCoordinates[sourceIndex];
    return [coordinate[0], coordinate[1]];
  });
}

export const optimizeTournee = action({
  args: { tourneeId: v.id("tournees") },
  handler: async (ctx, { tourneeId }) => {
    // Action (sans db) : on vérifie la permission via la query d'accès.
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "tournees", "update")) {
      throw new Error("Accès CRM insuffisant.");
    }
    const accessToken = env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error("MAPBOX_ACCESS_TOKEN n'est pas configurée côté Convex.");
    }

    const tournee = await ctx.runQuery(internal.sorties.getTourneeForOptimization, {
      tourneeId,
    });

    if (!tournee) {
      throw new Error("Tournée introuvable.");
    }
    if (tournee.stops.length < 3) {
      throw new Error("Il faut au moins 3 arrêts pour optimiser une tournée.");
    }
    if (tournee.stops.length > 11) {
      throw new Error(
        "Avec le dépôt de départ fixe, Mapbox Optimization accepte au maximum 11 arrêts clients.",
      );
    }

    const depotCoordinates = await geocodeStop(TOURNEE_DEPOT_ADDRESS, accessToken);
    const geocodedStops: OptimizableStop[] = [];
    for (const stop of tournee.stops) {
      const address = stop.address.trim();
      if (!address) {
        throw new Error("Chaque arrêt doit avoir une adresse avant optimisation.");
      }
      const coordinates = await geocodeStop(address, accessToken);
      geocodedStops.push({ stop, ...coordinates });
    }

    const coordinatesPath = [
      `${depotCoordinates.longitude},${depotCoordinates.latitude}`,
      ...geocodedStops.map(({ longitude, latitude }) => `${longitude},${latitude}`),
    ].join(";");

    const optimizationUrl = new URL(
      `https://api.mapbox.com/optimized-trips/v1/mapbox/driving/${coordinatesPath}`,
    );
    optimizationUrl.searchParams.set("access_token", accessToken);
    optimizationUrl.searchParams.set("source", "first");
    optimizationUrl.searchParams.set("destination", "any");
    optimizationUrl.searchParams.set("roundtrip", "true");
    optimizationUrl.searchParams.set("overview", "simplified");
    optimizationUrl.searchParams.set("geometries", "geojson");

    const response = await fetch(optimizationUrl.toString());
    const payload = (await response.json()) as {
      code?: string;
      message?: string;
      waypoints?: Array<{ waypoint_index?: number }>;
      trips?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: number[][] };
      }>;
    };

    if (!response.ok || payload.code !== "Ok" || !payload.waypoints?.length) {
      throw new Error(
        payload.message || "Optimisation Mapbox impossible pour cette tournée.",
      );
    }

    const orderedStops = payload.waypoints
      .map((waypoint, inputIndex) => ({
        stop: inputIndex === 0 ? null : geocodedStops[inputIndex - 1].stop,
        waypointIndex: waypoint.waypoint_index ?? Number.MAX_SAFE_INTEGER,
        longitude: inputIndex === 0 ? depotCoordinates.longitude : geocodedStops[inputIndex - 1].longitude,
        latitude: inputIndex === 0 ? depotCoordinates.latitude : geocodedStops[inputIndex - 1].latitude,
      }))
      .filter((item) => item.stop !== null)
      .sort((a, b) => a.waypointIndex - b.waypointIndex)
      .map(({ stop, longitude, latitude }, index) => ({
        ...stop,
        longitude,
        latitude,
        order: index + 1,
      })) as TourneeStop[];

    const distanceMeters = Math.round(payload.trips?.[0]?.distance ?? 0);
    const durationSeconds = Math.round(payload.trips?.[0]?.duration ?? 0);
    const routeCoordinates = limitRouteCoordinates(
      payload.trips?.[0]?.geometry?.coordinates ?? [],
    );

    await ctx.runMutation(internal.sorties.applyTourneeOptimization, {
      tourneeId,
      orderedStops,
      depotLatitude: depotCoordinates.latitude,
      depotLongitude: depotCoordinates.longitude,
      depotAddress: TOURNEE_DEPOT_ADDRESS,
      optimizedAt: Date.now(),
      estimatedDistanceMeters: distanceMeters,
      estimatedDurationSeconds: durationSeconds,
      routeCoordinates,
    });

    return {
      stopCount: orderedStops.length,
      distanceMeters,
      durationSeconds,
    };
  },
});

export const updateTourneeStop = mutation({
  args: {
    tourneeId: v.id("tournees"),
    stopOrder: v.number(),
    status: v.union(v.literal("prevu"), v.literal("effectue"), v.literal("annule")),
  },
  handler: async (ctx, { tourneeId, stopOrder, status }) => {
    await requireCrmPermission(ctx, "tournees", "update");
    const tournee = await ctx.db.get(tourneeId);
    if (!tournee) throw new Error("Tournée introuvable");
    const stops = tournee.stops.map((s) =>
      s.order === stopOrder ? { ...s, status } : s,
    );
    await ctx.db.patch(tourneeId, { stops });
    const resolvedStops = await syncTrackingLinks(ctx, tourneeId, stops);
    if (resolvedStops.some((stop, index) => stop.requestId !== stops[index]?.requestId)) {
      await ctx.db.patch(tourneeId, { stops: resolvedStops });
    }
  },
});

export const updateTourneeStatus = mutation({
  args: {
    tourneeId: v.id("tournees"),
    status: v.union(v.literal("planifiee"), v.literal("en_cours"), v.literal("terminee"), v.literal("annulee")),
  },
  handler: async (ctx, { tourneeId, status }) => {
    await requireCrmPermission(ctx, "tournees", "update");
    const tournee = await ctx.db.get(tourneeId);
    if (!tournee) throw new Error("Tournée introuvable");
    const resolvedStops = await syncTrackingLinks(ctx, tourneeId, tournee.stops);
    await ctx.db.patch(tourneeId, { status, stops: resolvedStops });
  },
});

export const deleteTournee = mutation({
  args: { tourneeId: v.id("tournees") },
  handler: async (ctx, { tourneeId }) => {
    await requireCrmPermission(ctx, "tournees", "delete");
    const tournee = await ctx.db.get(tourneeId);
    if (!tournee) return;

    const links = await ctx.db
      .query("tourneeTrackingLinks")
      .withIndex("by_tourneeId", (q) => q.eq("tourneeId", tourneeId))
      .collect();
    const vehicleLocation = await ctx.db
      .query("tourneeVehicleLocations")
      .withIndex("by_tourneeId", (q) => q.eq("tourneeId", tourneeId))
      .unique();

    await Promise.all(links.map((link) => ctx.db.delete(link._id)));
    if (vehicleLocation) await ctx.db.delete(vehicleLocation._id);
    await ctx.db.delete(tourneeId);
  },
});

export const updateTourneeVehicleLocation = mutation({
  args: {
    tourneeId: v.id("tournees"),
    latitude: v.number(),
    longitude: v.number(),
    heading: v.optional(v.number()),
    accuracy: v.optional(v.number()),
    speedKmh: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "tournees", "start");
    const existing = await ctx.db
      .query("tourneeVehicleLocations")
      .withIndex("by_tourneeId", (q) => q.eq("tourneeId", args.tourneeId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("tourneeVehicleLocations", {
      ...args,
      updatedAt: Date.now(),
    });
  },
});

export const listTourneeTrackingLinks = query({
  args: { tourneeId: v.id("tournees") },
  handler: async (ctx, { tourneeId }) => {
    await requireCrmPermission(ctx, "tournees", "read");
    const links = await ctx.db
      .query("tourneeTrackingLinks")
      .withIndex("by_tourneeId", (q) => q.eq("tourneeId", tourneeId))
      .collect();
    return links.sort((a, b) => a.stopOrder - b.stopOrder);
  },
});

export const listTrackingLinksByTournees = query({
  args: { tourneeIds: v.array(v.id("tournees")) },
  handler: async (ctx, { tourneeIds }) => {
    await requireCrmPermission(ctx, "tournees", "read");
    return await Promise.all(
      tourneeIds.map(async (tourneeId) => {
        const links = await ctx.db
          .query("tourneeTrackingLinks")
          .withIndex("by_tourneeId", (q) => q.eq("tourneeId", tourneeId))
          .collect();
        return {
          tourneeId,
          links: links.sort((a, b) => a.stopOrder - b.stopOrder),
        };
      }),
    );
  },
});

export const getPublicTrackingByToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const link = await ctx.db
      .query("tourneeTrackingLinks")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", token))
      .unique();

    if (!link) return null;

    const tournee = await ctx.db.get(link.tourneeId);
    if (!tournee) return null;

    const vehicleLocation = await ctx.db
      .query("tourneeVehicleLocations")
      .withIndex("by_tourneeId", (q) => q.eq("tourneeId", link.tourneeId))
      .unique();

    const stops = (tournee.stops ?? []).slice().sort((a, b) => a.order - b.order);
    const recipientStop = findStopForTrackingLink(stops, {
      requestId: link.requestId,
      address: link.address,
      contactName: link.contactName,
      order: link.stopOrder,
    });
    const recipientOrder = recipientStop?.order ?? link.stopOrder;
    const totalStops = stops.length;
    const stopsAhead = stops.filter(
      (s) => s.order < recipientOrder && s.status !== "effectue",
    ).length;
    const thisStopStatus = recipientStop?.status ?? "prevu";

    // The recipient's own stop + every stop before it, numbered, so the public
    // map can show "stops ahead of you" like Amazon. Coordinates only — no
    // names/addresses of other people are exposed.
    const precedingStops = stops
      .filter((s) => s.order <= recipientOrder)
      .map((s) => ({
        order: s.order,
        latitude: s.latitude ?? null,
        longitude: s.longitude ?? null,
        done: s.status === "effectue",
        isRecipient: s.order === recipientOrder,
      }));

    return {
      token,
      tournee: {
        _id: tournee._id,
        label: tournee.label,
        date: tournee.date,
        status: tournee.status,
        depotAddress: tournee.depotAddress ?? TOURNEE_DEPOT_ADDRESS,
        depotLatitude: tournee.depotLatitude ?? null,
        depotLongitude: tournee.depotLongitude ?? null,
        routeCoordinates: tournee.routeCoordinates ?? [],
        estimatedDistanceMeters: tournee.estimatedDistanceMeters ?? null,
        estimatedDurationSeconds: tournee.estimatedDurationSeconds ?? null,
      },
      recipient: {
        stopOrder: recipientOrder,
        contactName: recipientStop?.contactName ?? link.contactName ?? null,
        address: recipientStop?.address ?? link.address,
        latitude: recipientStop?.latitude ?? link.latitude ?? null,
        longitude: recipientStop?.longitude ?? link.longitude ?? null,
        totalStops,
        stopsAhead,
        stopStatus: thisStopStatus,
      },
      stops: precedingStops,
      vehicleLocation: vehicleLocation
        ? {
            latitude: vehicleLocation.latitude,
            longitude: vehicleLocation.longitude,
            heading: vehicleLocation.heading ?? null,
            accuracy: vehicleLocation.accuracy ?? null,
            speedKmh: vehicleLocation.speedKmh ?? null,
            updatedAt: vehicleLocation.updatedAt,
          }
        : null,
    };
  },
});

/** Nom du chauffeur, quelle que soit l'équipe d'origine (nouvelle ou ancienne). */
async function tourneeDriverName(
  ctx: QueryCtx,
  tournee: Pick<Doc<"tournees">, "driverWorkerId" | "driverId">,
): Promise<string | null> {
  if (tournee.driverWorkerId) {
    const worker = await ctx.db.get(tournee.driverWorkerId);
    if (worker) return `${worker.firstName} ${worker.lastName}`.trim() || null;
  }
  if (tournee.driverId) {
    const member = await ctx.db.get(tournee.driverId);
    if (member) return member.name ?? null;
  }
  return null;
}

export const listTournees = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    await requireCrmPermission(ctx, "tournees", "read");
    const tournees = await ctx.db
      .query("tournees")
      .withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate))
      .order("desc")
      .collect();
    return await Promise.all(
      tournees.map(async (t) => {
        const driverName = await tourneeDriverName(ctx, t);
        const vehicle = t.fleetVehicleId ? await ctx.db.get(t.fleetVehicleId) : null;
        const stops = await Promise.all(
          t.stops.map(async (stop) => {
            const request = stop.requestId ? await ctx.db.get(stop.requestId) : null;
            return {
              ...stop,
              requestReference: request?.reference ?? null,
            };
          }),
        );
        // On n'inclut PAS la position GPS (live) ni la géométrie d'itinéraire :
        // la liste CRM ne les affiche pas, et lire la position ferait
        // re-exécuter cette requête à chaque mise à jour GPS (coût Convex).
        const { routeCoordinates, ...rest } = t;
        void routeCoordinates;
        return {
          ...rest,
          stops,
          driverName,
          vehicleName: vehicle?.name ?? null,
        };
      }),
    );
  },
});

export const getTournee = query({
  args: { tourneeId: v.id("tournees") },
  handler: async (ctx, { tourneeId }) => {
    await requireCrmPermission(ctx, "tournees", "read");
    const tournee = await ctx.db.get(tourneeId);
    if (!tournee) return null;
    const driverName = await tourneeDriverName(ctx, tournee);
    const fleetVehicle = tournee.fleetVehicleId
      ? await ctx.db.get(tournee.fleetVehicleId)
      : null;
    const vehicleLocation = await ctx.db
      .query("tourneeVehicleLocations")
      .withIndex("by_tourneeId", (q) => q.eq("tourneeId", tournee._id))
      .unique();
    const stops = await Promise.all(
      tournee.stops.map(async (stop) => {
        const request = stop.requestId ? await ctx.db.get(stop.requestId) : null;
        return {
          ...stop,
          requestReference: request?.reference ?? null,
        };
      }),
    );
    return {
      ...tournee,
      stops,
      driverName,
      vehicleName: fleetVehicle?.name ?? null,
      vehicleLocation: vehicleLocation
        ? {
            latitude: vehicleLocation.latitude,
            longitude: vehicleLocation.longitude,
            heading: vehicleLocation.heading ?? null,
            speedKmh: vehicleLocation.speedKmh ?? null,
            updatedAt: vehicleLocation.updatedAt,
          }
        : null,
    };
  },
});

export const listUpcomingCollectes = query({
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "tournees", "read");
    return await ctx.db
      .query("requests")
      .withIndex("by_outcome", (q) => q.eq("outcome", "open"))
      .filter((q) => q.eq(q.field("type"), "collecte"))
      .order("desc")
      .take(50);
  },
});

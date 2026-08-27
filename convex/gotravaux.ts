import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { accessAllows, customerFullName, formatUserName, requireCrmPermission, requireUser } from "./lib";
import { buildAddressString, drivingDistanceKm, geocode } from "./livraison";
import type { Id } from "./_generated/dataModel";

const FLEET_PAGE_KEY = "mesoutils:gotravaux";
const ROOMS_PAGE_KEY = "mesoutils:salles";

/** Dépôt de départ pour le calcul des distances (identique aux tournées / livraisons). */
const DEPOT_ADDRESS = "4 rue de la prairie 60650 Lachapelle-aux-Pots";

const vehicleKind = v.union(
  v.literal("utilitaire"),
  v.literal("voiture"),
);

function normalizeVehicleKind(kind: string) {
  return kind === "voiture" ? "voiture" : "utilitaire";
}

const site = v.union(v.literal("60"), v.literal("76"));
const taskPriority = v.union(v.literal("low"), v.literal("medium"), v.literal("high"));
const taskStatus = v.union(
  v.literal("todo"),
  v.literal("in_progress"),
  v.literal("done"),
);

function displayName(identity: {
  name?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
}) {
  return formatUserName(identity);
}

export const listVehicles = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "read");
    const [vehicles, tasks] = await Promise.all([
      ctx.db.query("vehicles").order("desc").collect(),
      ctx.db.query("vehicleMaintenanceTasks").collect(),
    ]);
    const openTasksByVehicle = new Map<string, number>();
    for (const task of tasks) {
      if (task.status === "done") continue;
      const key = String(task.vehicleId);
      openTasksByVehicle.set(key, (openTasksByVehicle.get(key) ?? 0) + 1);
    }

    return await Promise.all(
      vehicles.map(async (vehicle) => ({
        ...vehicle,
        kind: normalizeVehicleKind(vehicle.kind),
        photoUrl: vehicle.photo ? await ctx.storage.getUrl(vehicle.photo) : vehicle.photoUrl,
        openTasksCount: openTasksByVehicle.get(String(vehicle._id)) ?? 0,
      })),
    );
  },
});

export const createVehicle = mutation({
  args: {
    name: v.string(),
    plate: v.optional(v.string()),
    kind: vehicleKind,
    site: v.optional(site),
    brand: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    seats: v.optional(v.number()),
    assignedTo: v.optional(v.string()),
    photo: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    odometerKm: v.optional(v.number()),
    technicalControlDate: v.optional(v.string()),
    pollutionControlDate: v.optional(v.string()),
    recycappEnabled: v.optional(v.boolean()),
    reservablePro: v.optional(v.boolean()),
    reservablePersonal: v.optional(v.boolean()),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "create");
    return await ctx.db.insert("vehicles", {
      ...args,
      name: args.name.trim(),
      plate: args.plate?.trim() || undefined,
      brand: args.brand?.trim() || undefined,
      model: args.model?.trim() || undefined,
      assignedTo: args.assignedTo?.trim() || undefined,
      photoUrl: args.photoUrl?.trim() || undefined,
      odometerUpdatedAt: typeof args.odometerKm === "number" ? new Date().toISOString() : undefined,
      createdAt: Date.now(),
    });
  },
});

export const updateVehicle = mutation({
  args: {
    vehicleId: v.id("vehicles"),
    name: v.string(),
    plate: v.optional(v.string()),
    kind: vehicleKind,
    site: v.optional(site),
    brand: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    seats: v.optional(v.number()),
    assignedTo: v.optional(v.string()),
    photo: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    odometerKm: v.optional(v.number()),
    technicalControlDate: v.optional(v.string()),
    pollutionControlDate: v.optional(v.string()),
    insuranceCompany: v.optional(v.string()),
    insurancePolicy: v.optional(v.string()),
    saleDate: v.optional(v.string()),
    recycappEnabled: v.optional(v.boolean()),
    reservablePro: v.optional(v.boolean()),
    reservablePersonal: v.optional(v.boolean()),
    active: v.boolean(),
  },
  handler: async (ctx, { vehicleId, ...patch }) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "update");
    const existing = await ctx.db.get(vehicleId);
    const odometerChanged =
      typeof patch.odometerKm === "number" && patch.odometerKm !== existing?.odometerKm;
    await ctx.db.patch(vehicleId, {
      ...patch,
      name: patch.name.trim(),
      plate: patch.plate?.trim() || undefined,
      brand: patch.brand?.trim() || undefined,
      model: patch.model?.trim() || undefined,
      assignedTo: patch.assignedTo?.trim() || undefined,
      photoUrl: patch.photoUrl?.trim() || undefined,
      insuranceCompany: patch.insuranceCompany?.trim() || undefined,
      insurancePolicy: patch.insurancePolicy?.trim() || undefined,
      saleDate: patch.saleDate?.trim() || undefined,
      ...(odometerChanged ? { odometerUpdatedAt: new Date().toISOString() } : {}),
    });
  },
});

export const listVehicleTasks = query({
  args: {
    vehicleId: v.optional(v.id("vehicles")),
    status: v.optional(taskStatus),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "read");
    const tasks = await ctx.db.query("vehicleMaintenanceTasks").order("desc").take(300);
    const filtered = tasks.filter((task) => {
      if (args.vehicleId && task.vehicleId !== args.vehicleId) return false;
      if (args.status && task.status !== args.status) return false;
      return true;
    });
    const vehicles = await ctx.db.query("vehicles").collect();
    const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));
    return await Promise.all(
      filtered.map(async (task) => {
        const vehicle = vehicleById.get(String(task.vehicleId)) ?? null;
        return {
          ...task,
          // URLs signées des pièces jointes, résolues à la lecture : les
          // storageId seuls ne sont pas affichables.
          attachmentUrls: (
            await Promise.all(
              (task.attachments ?? []).map((id) => ctx.storage.getUrl(id)),
            )
          ).filter((url): url is string => Boolean(url)),
          beforePhotoUrls: (
            await Promise.all(
              (task.beforePhotos ?? []).map((id) => ctx.storage.getUrl(id)),
            )
          ).filter((url): url is string => Boolean(url)),
          afterPhotoUrls: (
            await Promise.all(
              (task.afterPhotos ?? []).map((id) => ctx.storage.getUrl(id)),
            )
          ).filter((url): url is string => Boolean(url)),
          vehicle: vehicle
            ? {
                ...vehicle,
                photoUrl: vehicle.photo
                  ? await ctx.storage.getUrl(vehicle.photo)
                  : vehicle.photoUrl,
              }
            : null,
        };
      }),
    );
  },
});

/**
 * Informations exigées pour clôturer une maintenance.
 *
 * Une intervention terminée a forcément coûté du temps, s'est déroulée à une
 * date et a laissé le véhicule à un kilométrage connu. Sans ces valeurs le
 * suivi de la flotte est faux : coût d'entretien incalculable, historique sans
 * date, et compteur véhicule qui dérive jusqu'au prochain relevé manuel.
 *
 * On accepte 0 € de pièces (rien à remplacer) mais pas un temps nul.
 */
function ensureClosingRequirements(fields: {
  laborMinutes: number | undefined;
  partsCost: number | undefined;
  dueDate: number | undefined;
  odometerKm: number | undefined;
}) {
  const { laborMinutes, partsCost, dueDate, odometerKm } = fields;
  if (typeof laborMinutes !== "number" || !Number.isFinite(laborMinutes) || laborMinutes <= 0) {
    throw new Error("Renseignez le temps passé pour terminer la maintenance.");
  }
  if (typeof dueDate !== "number" || !Number.isFinite(dueDate)) {
    throw new Error("Renseignez la date d'intervention pour terminer la maintenance.");
  }
  if (typeof odometerKm !== "number" || !Number.isFinite(odometerKm) || odometerKm < 0) {
    throw new Error("Renseignez le kilométrage du véhicule pour terminer la maintenance.");
  }
  if (typeof partsCost !== "number" || !Number.isFinite(partsCost) || partsCost < 0) {
    throw new Error("Renseignez le prix des pièces pour terminer la maintenance.");
  }
}

export const createVehicleTask = mutation({
  args: {
    vehicleId: v.id("vehicles"),
    title: v.string(),
    description: v.optional(v.string()),
    priority: taskPriority,
    dueDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
    odometerKm: v.optional(v.number()),
    laborMinutes: v.optional(v.number()),
    partsCost: v.optional(v.number()),
    attachments: v.optional(v.array(v.id("_storage"))),
    beforePhotos: v.optional(v.array(v.id("_storage"))),
    beforeNotes: v.optional(v.string()),
    afterPhotos: v.optional(v.array(v.id("_storage"))),
    afterNotes: v.optional(v.string()),
    /**
     * Statut à la création. Réservé à la reprise d'historique (import Excel),
     * qui enregistre des interventions déjà faites : les garde-fous de clôture
     * (temps passé, prix des pièces) ne s'appliquent pas, ces informations
     * n'existant pas dans les fichiers repris.
     */
    status: v.optional(taskStatus),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    const now = Date.now();
    const taskId = await ctx.db.insert("vehicleMaintenanceTasks", {
      vehicleId: args.vehicleId,
      title: args.title.trim(),
      description: args.description?.trim() || undefined,
      priority: args.priority,
      status: args.status ?? "todo",
      dueDate: args.dueDate,
      endDate: args.endDate,
      odometerKm: args.odometerKm,
      laborMinutes: args.laborMinutes,
      partsCost: args.partsCost,
      attachments: args.attachments?.length ? args.attachments : undefined,
      beforePhotos: args.beforePhotos?.length ? args.beforePhotos : undefined,
      beforeNotes: args.beforeNotes?.trim() || undefined,
      afterPhotos: args.afterPhotos?.length ? args.afterPhotos : undefined,
      afterNotes: args.afterNotes?.trim() || undefined,
      createdBy: displayName(identity),
      createdAt: now,
      updatedAt: now,
    });
    const vehicle = await ctx.db.get(args.vehicleId);
    if (typeof args.odometerKm === "number") {
      if (vehicle && (vehicle.odometerKm === undefined || args.odometerKm > vehicle.odometerKm)) {
        await ctx.db.patch(args.vehicleId, {
          odometerKm: args.odometerKm,
          odometerUpdatedAt: new Date(now).toISOString(),
        });
      }
    }

    await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendMaintenanceCreatedEmail, {
      vehicleName: vehicle?.name ?? "Véhicule",
      vehiclePlate: vehicle?.plate,
      title: args.title.trim(),
      description: args.description?.trim() || undefined,
      priority: args.priority,
      dueDate: args.dueDate,
      endDate: args.endDate,
      odometerKm: args.odometerKm,
      createdByName: displayName(identity),
      vehicleImageUrl: vehicle?.photoUrl,
      vehicleImageStorageId: vehicle?.photo ? String(vehicle.photo) : undefined,
    });

    return taskId;
  },
});

const documentCategory = v.union(
  v.literal("carte_grise"),
  v.literal("facture"),
  v.literal("devis"),
  v.literal("assurance"),
  v.literal("controle_technique"),
  v.literal("autre"),
);

export const listVehicleDocuments = query({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "read");
    const documents = await ctx.db
      .query("vehicleDocuments")
      .withIndex("by_vehicleId", (q) => q.eq("vehicleId", args.vehicleId))
      .order("desc")
      .collect();
    return await Promise.all(
      documents.map(async (document) => ({
        ...document,
        url: await ctx.storage.getUrl(document.storageId),
      })),
    );
  },
});

export const addVehicleDocument = mutation({
  args: {
    vehicleId: v.id("vehicles"),
    name: v.string(),
    category: documentCategory,
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "update");
    const identity = await requireUser(ctx);
    return await ctx.db.insert("vehicleDocuments", {
      vehicleId: args.vehicleId,
      name: args.name.trim() || "Document",
      category: args.category,
      storageId: args.storageId,
      uploadedBy: displayName(identity),
      createdAt: Date.now(),
    });
  },
});

/**
 * Renomme un document. Le nom repris à l'import est celui du fichier
 * (« IMG_4821.pdf », « scan0007.pdf ») : sans renommage, une carte grise ne se
 * distingue d'un devis qu'en l'ouvrant.
 */
export const renameVehicleDocument = mutation({
  args: { documentId: v.id("vehicleDocuments"), name: v.string() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "update");
    const name = args.name.trim();
    if (!name) throw new Error("Le nom du document ne peut pas être vide.");
    const document = await ctx.db.get(args.documentId);
    if (!document) throw new Error("Document introuvable.");
    await ctx.db.patch(args.documentId, { name: name.slice(0, 200) });
  },
});

export const removeVehicleDocument = mutation({
  args: { documentId: v.id("vehicleDocuments") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "update");
    await ctx.db.delete(args.documentId);
  },
});

export const updateVehicleTask = mutation({
  args: {
    taskId: v.id("vehicleMaintenanceTasks"),
    status: v.optional(taskStatus),
    priority: v.optional(taskPriority),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    dueDate: v.optional(v.union(v.number(), v.null())),
    endDate: v.optional(v.union(v.number(), v.null())),
    odometerKm: v.optional(v.union(v.number(), v.null())),
    laborMinutes: v.optional(v.union(v.number(), v.null())),
    partsCost: v.optional(v.union(v.number(), v.null())),
    attachments: v.optional(v.array(v.id("_storage"))),
    beforePhotos: v.optional(v.array(v.id("_storage"))),
    beforeNotes: v.optional(v.string()),
    afterPhotos: v.optional(v.array(v.id("_storage"))),
    afterNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "update");
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Maintenance introuvable.");
    const now = Date.now();

    // Valeurs résultantes (args si fournis, sinon celles déjà en base) pour le
    // garde-fou de clôture.
    const nextLaborMinutes =
      args.laborMinutes !== undefined ? args.laborMinutes ?? undefined : task.laborMinutes;
    const nextPartsCost =
      args.partsCost !== undefined ? args.partsCost ?? undefined : task.partsCost;
    const nextDueDate = args.dueDate !== undefined ? args.dueDate ?? undefined : task.dueDate;
    const nextOdometerKm =
      args.odometerKm !== undefined ? args.odometerKm ?? undefined : task.odometerKm;
    if (args.status === "done") {
      ensureClosingRequirements({
        laborMinutes: nextLaborMinutes,
        partsCost: nextPartsCost,
        dueDate: nextDueDate,
        odometerKm: nextOdometerKm,
      });
    }
    // Passer « en cours » exige au minimum la date d'intervention : une
    // maintenance qu'on démarre est planifiée à une date, et sans elle elle
    // n'apparaît pas dans l'agenda flotte (filtré sur `dueDate`).
    if (
      args.status === "in_progress" &&
      (typeof nextDueDate !== "number" || !Number.isFinite(nextDueDate))
    ) {
      throw new Error(
        "Renseignez la date d'intervention pour passer la maintenance en cours.",
      );
    }

    const patch: {
      status?: "todo" | "in_progress" | "done";
      priority?: "low" | "medium" | "high";
      title?: string;
      description?: string;
      dueDate?: number | undefined;
      endDate?: number | undefined;
      odometerKm?: number | undefined;
      laborMinutes?: number | undefined;
      partsCost?: number | undefined;
      attachments?: Id<"_storage">[] | undefined;
      beforePhotos?: Id<"_storage">[] | undefined;
      beforeNotes?: string | undefined;
      afterPhotos?: Id<"_storage">[] | undefined;
      afterNotes?: string | undefined;
      updatedAt: number;
    } = {
      updatedAt: now,
    };
    if (args.status !== undefined) patch.status = args.status;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.description !== undefined) patch.description = args.description.trim() || undefined;
    if (args.dueDate !== undefined) patch.dueDate = args.dueDate ?? undefined;
    if (args.endDate !== undefined) patch.endDate = args.endDate ?? undefined;
    if (args.odometerKm !== undefined) patch.odometerKm = args.odometerKm ?? undefined;
    if (args.laborMinutes !== undefined) patch.laborMinutes = args.laborMinutes ?? undefined;
    if (args.partsCost !== undefined) patch.partsCost = args.partsCost ?? undefined;
    if (args.attachments !== undefined) {
      patch.attachments = args.attachments.length ? args.attachments : undefined;
    }
    if (args.beforePhotos !== undefined) {
      patch.beforePhotos = args.beforePhotos.length ? args.beforePhotos : undefined;
    }
    if (args.beforeNotes !== undefined) {
      patch.beforeNotes = args.beforeNotes.trim() || undefined;
    }
    if (args.afterPhotos !== undefined) {
      patch.afterPhotos = args.afterPhotos.length ? args.afterPhotos : undefined;
    }
    if (args.afterNotes !== undefined) {
      patch.afterNotes = args.afterNotes.trim() || undefined;
    }
    await ctx.db.patch(args.taskId, patch);
    // On répercute la valeur résultante, pas seulement celle reçue : clôturer
    // une maintenance dont le kilométrage avait été saisi plus tôt doit quand
    // même mettre le compteur du véhicule à jour.
    if (typeof nextOdometerKm === "number") {
      const vehicle = await ctx.db.get(task.vehicleId);
      if (vehicle && (vehicle.odometerKm === undefined || nextOdometerKm > vehicle.odometerKm)) {
        await ctx.db.patch(task.vehicleId, {
          odometerKm: nextOdometerKm,
          odometerUpdatedAt: new Date(now).toISOString(),
        });
      }
    }
  },
});

/** Supprime définitivement une maintenance, après confirmation côté interface. */
export const removeVehicleTask = mutation({
  args: { taskId: v.id("vehicleMaintenanceTasks") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "delete");
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Maintenance introuvable.");
    await ctx.db.delete(args.taskId);
  },
});

/* ─── Services planifiés avec véhicule affecté (calendrier flotte) ─────────── */

/** Adresse pertinente où le véhicule se rend pour un service donné. */
function resolveServiceAddress(request: {
  collecte?: { collectAddress?: { address?: string; postalCode?: string; city?: string } };
  livraison?: { deliveryAddress?: { address?: string; postalCode?: string; city?: string } };
  aerogommageOptions?: {
    deliveryAddress?: { address?: string; postalCode?: string; city?: string };
    pickupAddress?: { address?: string; postalCode?: string; city?: string };
  };
  customer: { address?: string; postalCode?: string; city?: string };
}) {
  const candidates = [
    request.collecte?.collectAddress,
    request.livraison?.deliveryAddress,
    request.aerogommageOptions?.deliveryAddress,
    request.aerogommageOptions?.pickupAddress,
  ];
  for (const candidate of candidates) {
    if (candidate?.address) return candidate;
  }
  return {
    address: request.customer.address,
    postalCode: request.customer.postalCode,
    city: request.customer.city,
  };
}

/**
 * Demandes ouvertes (collecte, livraison, aérogommage…) ayant un véhicule de la
 * flotte affecté et une date planifiée — pour les afficher dans le calendrier
 * Gotravaux à côté des réservations et des maintenances.
 */
export const listScheduledServices = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, FLEET_PAGE_KEY, "read");
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_outcome", (q) => q.eq("outcome", "open"))
      .collect();
    const scheduled = requests.filter(
      (request) => request.assignedVehicle && request.scheduledDate,
    );
    if (scheduled.length === 0) return [];

    const vehicles = await ctx.db.query("vehicles").collect();
    const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));

    return await Promise.all(
      scheduled.map(async (request) => {
        const vehicle = vehicleById.get(String(request.assignedVehicle));
        const address = resolveServiceAddress(request);
        return {
          _id: request._id,
          type: request.type,
          collecteType: request.collecteType ?? null,
          reference: request.reference ?? null,
          scheduledDate: request.scheduledDate as number,
          vehicleId: request.assignedVehicle as Id<"vehicles">,
          vehicleName: vehicle?.name ?? null,
          vehiclePlate: vehicle?.plate ?? null,
          vehiclePhotoUrl: vehicle?.photo
            ? await ctx.storage.getUrl(vehicle.photo)
            : (vehicle?.photoUrl ?? null),
          customerName: customerFullName(request.customer),
          scheduledByName:
            request.fieldEdits?.scheduledDate?.by ??
            request.fieldEdits?.assignedVehicle?.by ??
            null,
          address: address.address ?? null,
          postalCode: address.postalCode ?? null,
          city: address.city ?? null,
          // Distance déjà calculée (livraison) : aller-retour, indicative.
          storedDistanceKm: request.livraison?.distanceKm ?? null,
        };
      }),
    );
  },
});

/**
 * Distance routière (km, aller simple) entre le dépôt et l'adresse d'un service,
 * via Mapbox. Calculée à la demande depuis la modale détail du calendrier.
 */
export const computeServiceDistance = action({
  args: {
    address: v.string(),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ distanceKm: number }> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, FLEET_PAGE_KEY, "read")) {
      throw new Error("Accès CRM insuffisant.");
    }
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error("MAPBOX_ACCESS_TOKEN n'est pas configurée côté Convex.");
    }
    const destination = buildAddressString(args);
    if (!destination) throw new Error("Adresse du service manquante.");

    const [depot, target] = await Promise.all([
      geocode(DEPOT_ADDRESS, accessToken),
      geocode(destination, accessToken),
    ]);
    const oneWayKm = await drivingDistanceKm(depot, target, accessToken);
    return { distanceKm: Math.round(oneWayKm * 10) / 10 };
  },
});

export const listRooms = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, ROOMS_PAGE_KEY, "read");
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
    site: v.optional(site),
    capacity: v.optional(v.number()),
    color: v.optional(v.string()),
    buildingLabel: v.optional(v.string()),
    photo: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    services: v.optional(v.array(v.string())),
    reservable: v.optional(v.boolean()),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, ROOMS_PAGE_KEY, "create");
    return await ctx.db.insert("rooms", {
      ...args,
      name: args.name.trim(),
      buildingLabel: args.buildingLabel?.trim() || undefined,
      photoUrl: args.photoUrl?.trim() || undefined,
      createdAt: Date.now(),
    });
  },
});

export const updateRoom = mutation({
  args: {
    roomId: v.id("rooms"),
    name: v.string(),
    site: v.optional(site),
    capacity: v.optional(v.number()),
    color: v.optional(v.string()),
    buildingLabel: v.optional(v.string()),
    photo: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    services: v.optional(v.array(v.string())),
    reservable: v.optional(v.boolean()),
    unavailabilityNotes: v.optional(v.string()),
    active: v.boolean(),
  },
  handler: async (ctx, { roomId, ...patch }) => {
    await requireCrmPermission(ctx, ROOMS_PAGE_KEY, "update");
    await ctx.db.patch(roomId, {
      ...patch,
      name: patch.name.trim(),
      buildingLabel: patch.buildingLabel?.trim() || undefined,
      photoUrl: patch.photoUrl?.trim() || undefined,
      unavailabilityNotes: patch.unavailabilityNotes?.trim() || undefined,
    });
  },
});

/* ─── Maintenance (CLI uniquement) ────────────────────────────────────────── */

/**
 * Liste les auteurs (`createdBy`) des tâches de maintenance véhicule et leur nombre.
 * `npx convex run gotravaux:adminListMaintenanceCreators --prod`
 */
export const adminListMaintenanceCreators = internalQuery({
  args: {},
  handler: async (ctx) => {
    const tasks = await ctx.db.query("vehicleMaintenanceTasks").collect();
    const counts = new Map<string, number>();
    for (const task of tasks) {
      counts.set(task.createdBy, (counts.get(task.createdBy) ?? 0) + 1);
    }
    return {
      total: tasks.length,
      byCreator: [...counts.entries()]
        .map(([createdBy, count]) => ({ createdBy, count }))
        .sort((a, b) => b.count - a.count),
    };
  },
});

/**
 * Supprime toutes les tâches de maintenance véhicule dont `createdBy` correspond
 * (comparaison insensible à la casse/accents, sur nom exact ou fragment).
 * Dry-run par défaut ; passer `{"createdBy":"Selim Lahmer","apply":true}` pour supprimer.
 * `npx convex run gotravaux:adminDeleteMaintenanceByCreator '{"createdBy":"Selim Lahmer"}' --prod`
 */
export const adminDeleteMaintenanceByCreator = internalMutation({
  args: { createdBy: v.string(), apply: v.optional(v.boolean()) },
  handler: async (ctx, { createdBy, apply }) => {
    const norm = (s: string) =>
      s.trim().toLocaleLowerCase("fr-FR").normalize("NFD").replace(/[̀-ͯ]/g, "");
    const needle = norm(createdBy);
    const tasks = await ctx.db.query("vehicleMaintenanceTasks").collect();
    const matches = tasks.filter((t) => norm(t.createdBy).includes(needle));
    if (apply) {
      for (const t of matches) await ctx.db.delete(t._id);
    }
    return {
      dryRun: !apply,
      matched: matches.length,
      deleted: apply ? matches.length : 0,
      samples: matches.slice(0, 10).map((t) => ({ id: t._id, createdBy: t.createdBy, title: t.title })),
    };
  },
});

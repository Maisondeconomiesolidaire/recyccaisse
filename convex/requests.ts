import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import {
  customerFullName,
  requireAdmin,
  requireCrmPermission,
  requireAnyCrmPermission,
  hasCrmPermission,
  isAerogommageComplete,
  isCollecteComplete,
  isArticleComplete,
  isVeloComplete,
  isLivraisonComplete,
  normalizeCustomer,
  normalizeEmail,
  requireUser,
  titleCaseName,
} from "./lib";
import {
  aerogommageItem,
  collecteType,
  requestLostReason,
  requestType,
} from "./schema";
import { PICKUP_DEADLINE_DAYS } from "./emails";
import { isAwaitingInvoicePayment, resolveProcess, STEP } from "./processes";
import { applyDiscount, assertUsableDiscount } from "./discountCodes";
import { scheduleStripeSync } from "./stripeCatalog";
import { vehicleBusyReason } from "./fleet";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

/**
 * Fusionne le dernier modificateur (`actorName`) pour chaque champ modifié,
 * afin d'afficher « Modifié par … » sous chaque champ du CRM.
 */
function withFieldEdits(
  existing: Record<string, { by: string; at: number }> | undefined,
  keys: string[],
  actorName: string | undefined,
): Record<string, { by: string; at: number }> | undefined {
  if (keys.length === 0) return existing;
  const by = actorName?.trim() || "Inconnu";
  const at = Date.now();
  const next = { ...(existing ?? {}) };
  for (const key of keys) next[key] = { by, at };
  return next;
}

function sameValue(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function setPatchIfChanged<T>(
  patch: Record<string, unknown>,
  changed: string[],
  key: string,
  currentValue: T,
  nextValue: T,
  trackFieldEdit = true,
) {
  if (sameValue(currentValue, nextValue)) return;
  patch[key] = nextValue;
  if (trackFieldEdit) changed.push(key);
}

const customerArg = v.object({
  firstName: v.string(),
  lastName: v.string(),
  email: v.string(),
  phone: v.string(),
  address: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  city: v.optional(v.string()),
});

const addressArg = v.object({
  address: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  city: v.optional(v.string()),
});

const aerogommageOptionsArg = v.object({
  pickupAtHome: v.optional(v.boolean()),
  deliveryAtHome: v.optional(v.boolean()),
  pickupAddress: v.optional(addressArg),
  deliveryAddress: v.optional(addressArg),
});

/** Aperçu article pour l'email (carte avec image, prix, lien boutique). */
async function emailArticlePreview(ctx: MutationCtx, request: Doc<"requests">) {
  if (request.type === "article") {
    const articleId =
      request.article?.articleId ?? request.articles?.[0]?.articleId;
    if (!articleId) return undefined;
    const article = await ctx.db.get(articleId);
    if (!article) return undefined;
    return {
      title: article.title,
      price: article.price,
      condition: article.condition,
      imageStorageId: article.images?.[0]
        ? String(article.images[0])
        : undefined,
      articleId: String(articleId),
    };
  }
  if (request.type === "livraison" && request.livraison) {
    const l = request.livraison;
    if (!l.articleTitle) return undefined;
    return {
      title: l.articleTitle,
      price: l.articlePrice,
      condition: l.condition,
      imageStorageId: l.articlePhoto ? String(l.articlePhoto) : undefined,
    };
  }
  return undefined;
}

async function createNewRequestNotification(
  ctx: MutationCtx,
  args: {
    requestId: Id<"requests">;
    requestType: "aerogommage" | "collecte" | "article" | "velo" | "livraison" | "depot";
    customerName: string;
  },
) {
  await ctx.db.insert("notifications", {
    kind: "new_request",
    title: "Nouvelle demande",
    requestId: args.requestId,
    requestType: args.requestType,
    customerName: args.customerName,
    read: false,
    createdAt: Date.now(),
  });

  // Email de confirmation au client (Resend). Une commande déjà réglée en ligne
  // reçoit un message d'achat, avec le délai de retrait de 5 jours.
  const request = await ctx.db.get(args.requestId);
  if (request?.customer.email) {
    const paid = request.payment?.status === "paid";
    await ctx.scheduler.runAfter(0, internal.emails.sendRequestConfirmation, {
      email: request.customer.email,
      name: customerFullName(request.customer),
      reference: request.reference ?? String(request._id).slice(-6),
      type: request.type,
      requestId: String(request._id),
      article: await emailArticlePreview(ctx, request),
      paid,
      pickupDeadline: paid
        ? (request.payment?.paidAt ?? request.createdAt) +
          PICKUP_DEADLINE_DAYS * 24 * 60 * 60 * 1000
        : undefined,
    });
  }

  // Email à l'équipe recyclerie — décalé pour rester sous la limite Resend
  // (2 req/s) avec l'email client. E. Carette est ajouté uniquement pour
  // les demandes d'aérogommage par l'action d'envoi.
  if (request) {
    await ctx.scheduler.runAfter(1200, internal.emails.sendNewRequestToStaff, {
      type: request.type,
      reference: request.reference ?? String(request._id).slice(-6),
      customerName: customerFullName(request.customer),
      article: await emailArticlePreview(ctx, request),
    });
  }
}

export async function generateReference(ctx: MutationCtx): Promise<string> {
  const all = await ctx.db.query("requests").collect();
  const n = all.length + 1;
  return n.toString().padStart(6, "0");
}

/**
 * Demande créée par une vente au comptoir (caisse).
 *
 * Le client est devant nous, il repart avec l'objet : la demande naît donc
 * ACHEVÉE — « Paiement validé » puis « Retrait effectué » cochés, issue
 * « gagnée ». Elle ne sert pas à piloter un travail restant mais à nourrir
 * l'historique du client, exactement comme une commande en ligne retirée.
 */
export async function createInShopSaleRequest(
  ctx: MutationCtx,
  args: {
    customer: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      address?: string;
      postalCode?: string;
      city?: string;
    };
    articles: Array<{ articleId: Id<"articles">; articleTitle: string }>;
    total: number;
    paymentMethod: "cb" | "especes";
    receiptNumber?: string;
    stripePaymentIntentId?: string;
  },
): Promise<Id<"requests">> {
  const customer = normalizeCustomer(args.customer);
  const steps = resolveProcess("article");
  const reference = await generateReference(ctx);
  const now = Date.now();

  const requestId = await ctx.db.insert("requests", {
    type: "article",
    stage: "nouveau",
    outcome: "gagnee",
    requestOrigin: "internal",
    complete: isArticleComplete(customer),
    processSteps: steps,
    // Vente en personne : les deux jalons sont franchis d'un coup.
    completedSteps: steps.length,
    processLog: steps.map((_, index) => ({
      step: index,
      by: "Caisse",
      at: now,
    })),
    customer,
    comment: args.receiptNumber
      ? `Vente en boutique — ticket ${args.receiptNumber}.`
      : "Vente en boutique.",
    photos: [],
    article: args.articles[0],
    articles: args.articles,
    quoteAmount: args.total,
    payment: {
      method: args.paymentMethod,
      status: "paid",
      validated: true,
      captured: true,
      ...(args.stripePaymentIntentId
        ? {
            provider: "stripe" as const,
            stripePaymentIntentId: args.stripePaymentIntentId,
          }
        : {}),
      paidAt: now,
    },
    createdAt: now,
    updatedAt: now,
    reference,
  });

  await upsertRequestCustomer(ctx, customer, "/crm/caisse");
  return requestId;
}

async function upsertRequestCustomer(
  ctx: MutationCtx,
  customerInput: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    address?: string;
    postalCode?: string;
    city?: string;
  },
  sourcePath: string,
) {
  const customer = normalizeCustomer(customerInput);
  const email = normalizeEmail(customer.email);
  const now = Date.now();

  const [existingUser, existingCrmCustomer, identity] = await Promise.all([
    email
      ? ctx.db
          .query("users")
          .withIndex("by_email", (q) => q.eq("email", email))
          .first()
      : null,
    email
      ? ctx.db
          .query("crmCustomers")
          .withIndex("by_email", (q) => q.eq("email", email))
          .first()
      : null,
    ctx.auth.getUserIdentity(),
  ]);

  if (existingUser) {
    await ctx.db.patch(existingUser._id, {
      firstName: titleCaseName(customer.firstName),
      lastName: titleCaseName(customer.lastName),
      phone: customer.phone,
      address: customer.address,
      postalCode: customer.postalCode,
      city: customer.city,
      updatedAt: now,
    });
  }

  if (existingCrmCustomer) {
    await ctx.db.patch(existingCrmCustomer._id, {
      firstName: titleCaseName(customer.firstName),
      lastName: titleCaseName(customer.lastName),
      phone: customer.phone,
      address: customer.address,
      postalCode: customer.postalCode,
      city: customer.city,
      updatedAt: now,
    });
  } else if (email) {
    await ctx.db.insert("crmCustomers", {
      source: "public:request",
      sourceId: `${sourcePath}:${email}`,
      firstName: titleCaseName(customer.firstName),
      lastName: titleCaseName(customer.lastName),
      email,
      phone: customer.phone,
      address: customer.address,
      postalCode: customer.postalCode,
      city: customer.city,
      raw: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  const signedInEmail = normalizeEmail(identity?.email);
  const signedInUserId =
    signedInEmail && signedInEmail === email ? identity?.subject : undefined;

  return {
    customer,
    userId: existingUser?.clerkId ?? signedInUserId,
  };
}

function requestArticleIds(request: {
  article?: { articleId: Id<"articles"> };
  articles?: Array<{ articleId: Id<"articles"> }>;
}) {
  return Array.from(
    new Set([
      ...(request.articles ?? []).map((article) => article.articleId),
      ...(request.article?.articleId ? [request.article.articleId] : []),
    ]),
  );
}

const PERMANENT_DELETE_EMAIL = "lahmerselim@gmail.com";

async function requirePermanentDeleteAccess(ctx: MutationCtx) {
  const identity = await requireUser(ctx);
  if (identity.email?.trim().toLowerCase() !== PERMANENT_DELETE_EMAIL) {
    throw new Error("Suppression définitive non autorisée.");
  }
  return identity;
}

function requestStorageIds(request: Doc<"requests">) {
  const ids = new Set<Id<"_storage">>();
  for (const id of request.photos ?? []) ids.add(id);
  for (const id of request.beforePhotos ?? []) ids.add(id);
  for (const id of request.afterPhotos ?? []) ids.add(id);
  for (const item of request.aerogommage ?? []) {
    for (const id of item.photos ?? []) ids.add(id);
    for (const id of item.beforePhotos ?? []) ids.add(id);
    for (const id of item.afterPhotos ?? []) ids.add(id);
  }
  for (const entry of request.collecte?.categoryPhotos ?? []) {
    for (const id of entry.photos ?? []) ids.add(id);
  }
  if (request.livraison?.articlePhoto) ids.add(request.livraison.articlePhoto);
  if (request.livraison?.referencePhoto) ids.add(request.livraison.referencePhoto);
  return [...ids];
}

async function deleteStorageBestEffort(ctx: MutationCtx, ids: Id<"_storage">[]) {
  let deleted = 0;
  for (const id of ids) {
    try {
      await ctx.storage.delete(id);
      deleted++;
    } catch {
      // Le fichier peut déjà avoir été retiré ou être partagé ailleurs.
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Envois publics (depuis les formulaires clients) — pas d'authentification.
// ---------------------------------------------------------------------------

export const submitAerogommage = mutation({
  args: {
    customer: customerArg,
    comment: v.optional(v.string()),
    photos: v.array(v.id("_storage")),
    items: v.array(aerogommageItem),
    options: v.optional(aerogommageOptionsArg),
  },
  handler: async (ctx, { customer, comment, photos, items, options }) => {
    await requireUser(ctx);
    // Sans photo, impossible de chiffrer un décapage : la règle est portée ici
    // et pas seulement dans le formulaire, sinon un envoi direct la contourne.
    if (items.some((item) => (item.photos?.length ?? 0) === 0) && photos.length === 0) {
      throw new Error(
        "Ajoutez au moins une photo pour chaque objet à décaper : sans photo, la demande ne peut pas être chiffrée.",
      );
    }
    const resolvedCustomer = await upsertRequestCustomer(
      ctx,
      customer,
      "/aerogommage",
    );
    customer = resolvedCustomer.customer;
    const now = Date.now();
    const reference = await generateReference(ctx);
    const requestId = await ctx.db.insert("requests", {
      type: "aerogommage",
      stage: "nouveau",
      outcome: "open",
      requestOrigin: "external",
      complete: isAerogommageComplete(customer, items),
      processSteps: resolveProcess("aerogommage"),
      completedSteps: 0,
      site: "60", // Recyclerie 60 par défaut pour l'aérogommage.
      customer,
      userId: resolvedCustomer.userId,
      comment,
      photos,
      aerogommage: items,
      aerogommageOptions: options,
      createdAt: now,
      updatedAt: now,
      reference,
    });
    await createNewRequestNotification(ctx, {
      requestId,
      requestType: "aerogommage",
      customerName: customerFullName(customer),
    });
    return requestId;
  },
});

export const submitCollecte = mutation({
  args: {
    customer: customerArg,
    comment: v.optional(v.string()),
    photos: v.array(v.id("_storage")),
    details: v.object({
      dismountable: v.optional(v.boolean()),
      reusableGoodCondition: v.optional(v.boolean()),
      sorted: v.optional(v.boolean()),
      noWaste: v.optional(v.boolean()),
      objectCategories: v.optional(v.array(v.string())),
      categoryPhotos: v.optional(
        v.array(
          v.object({
            category: v.string(),
            photos: v.array(v.id("_storage")),
          }),
        ),
      ),
      grosObjets: v.optional(v.array(v.string())),
      grosObjetsAutre: v.optional(v.string()),
      petitsObjets: v.optional(v.array(v.string())),
      petitsObjetsAutre: v.optional(v.string()),
      housingType: v.optional(v.string()),
      floors: v.optional(v.number()),
      dedicatedParking: v.optional(v.boolean()),
      parkingDistance: v.optional(v.number()),
      parkingUnknown: v.optional(v.boolean()),
      collectAddress: v.optional(
        v.object({
          address: v.optional(v.string()),
          postalCode: v.optional(v.string()),
          city: v.optional(v.string()),
        }),
      ),
    }),
  },
  handler: async (ctx, { customer, comment, photos, details }) => {
    await requireUser(ctx);
    // Idem collecte : la demande doit être illustrée, sinon on ne sait pas ce
    // qu'il y a à charger. Contrôle côté serveur, pas uniquement dans le
    // formulaire (une demande sans aucune photo est déjà passée).
    const collectePhotoCount =
      photos.length +
      (details.categoryPhotos ?? []).reduce(
        (total, entry) => total + entry.photos.length,
        0,
      );
    if (collectePhotoCount === 0) {
      throw new Error(
        "Ajoutez au moins une photo des objets à collecter : sans photo, la demande ne peut pas être traitée.",
      );
    }
    const resolvedCustomer = await upsertRequestCustomer(
      ctx,
      customer,
      "/collecte",
    );
    customer = resolvedCustomer.customer;
    const now = Date.now();
    const reference = await generateReference(ctx);
    const requestId = await ctx.db.insert("requests", {
      type: "collecte",
      stage: "nouveau",
      outcome: "open",
      requestOrigin: "external",
      complete: isCollecteComplete(customer, details),
      // Arrive en « Collecte à définir » : sous-type choisi ensuite dans le CRM.
      collecteType: "indefini",
      processSteps: resolveProcess("collecte", "indefini"),
      completedSteps: 0,
      customer,
      userId: resolvedCustomer.userId,
      comment,
      photos,
      collecte: details,
      createdAt: now,
      updatedAt: now,
      reference,
    });
    await createNewRequestNotification(ctx, {
      requestId,
      requestType: "collecte",
      customerName: customerFullName(customer),
    });
    return requestId;
  },
});

export const submitVelo = mutation({
  args: {
    customer: customerArg,
    comment: v.optional(v.string()),
    photos: v.array(v.id("_storage")),
    details: v.object({
      bikeType: v.optional(v.string()),
      service: v.optional(v.string()),
      brand: v.optional(v.string()),
      condition: v.optional(v.string()),
      description: v.optional(v.string()),
    }),
  },
  handler: async (ctx, { customer, comment, photos, details }) => {
    await requireUser(ctx);
    const resolvedCustomer = await upsertRequestCustomer(
      ctx,
      customer,
      "/velo",
    );
    customer = resolvedCustomer.customer;
    const now = Date.now();
    const reference = await generateReference(ctx);
    const requestId = await ctx.db.insert("requests", {
      type: "velo",
      stage: "nouveau",
      outcome: "open",
      requestOrigin: "external",
      complete: isVeloComplete(customer, details),
      processSteps: resolveProcess("velo"),
      completedSteps: 0,
      customer,
      userId: resolvedCustomer.userId,
      comment,
      photos,
      velo: details,
      createdAt: now,
      updatedAt: now,
      reference,
    });
    await createNewRequestNotification(ctx, {
      requestId,
      requestType: "velo",
      customerName: customerFullName(customer),
    });
    return requestId;
  },
});

/* ─── Dépôt en recyclerie ────────────────────────────────────────────────── */

/**
 * Créneaux de dépôt : uniquement le lundi, par tranches d'une heure.
 * Un seul rendez-vous par créneau et par recyclerie.
 */
/** Premier et dernier créneau (minutes depuis minuit, heure de Paris). */
const DEPOT_FIRST_SLOT_MINUTE = 13 * 60 + 30;
const DEPOT_LAST_SLOT_MINUTE = 16 * 60 + 40;
/** Un rendez-vous toutes les 10 minutes. */
const DEPOT_SLOT_MINUTES = 10;

/** Minutes depuis minuit de chaque créneau proposé, dans l'ordre. */
const DEPOT_SLOT_MINUTE_MARKS = (() => {
  const marks: number[] = [];
  for (
    let minute = DEPOT_FIRST_SLOT_MINUTE;
    minute <= DEPOT_LAST_SLOT_MINUTE;
    minute += DEPOT_SLOT_MINUTES
  ) {
    marks.push(minute);
  }
  return marks;
})();

/** « 13:30 » à partir des minutes depuis minuit. */
function depotSlotLabel(minuteOfDay: number) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
/** Nombre de lundis proposés à la réservation. */
const DEPOT_WEEKS_AHEAD = 8;

/** Décalage (ms) entre l'heure de Paris et UTC à un instant donné. */
function parisOffsetMs(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - timestamp;
}

/** Horodatage d'une heure locale de Paris (gère l'heure d'été). */
function parisTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Deux passes : la première corrige le décalage, la seconde absorbe un
  // éventuel changement d'heure entre l'estimation et l'instant corrigé.
  const first = guess - parisOffsetMs(guess);
  return guess - parisOffsetMs(first);
}

/** Champs calendaires d'un horodatage, exprimés à Paris. */
function parisParts(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** Les prochains lundis (dates Paris) proposés à la réservation. */
function upcomingMondays(from: number) {
  const days: Array<{ year: number; month: number; day: number }> = [];
  const start = parisParts(from);
  const cursor = Date.UTC(start.year, start.month - 1, start.day);
  for (let offset = 0; days.length < DEPOT_WEEKS_AHEAD; offset += 1) {
    const dayUtc = cursor + offset * 86_400_000;
    const date = new Date(dayUtc);
    // getUTCDay : 1 = lundi. La date est déjà exprimée en jours de Paris.
    if (date.getUTCDay() !== 1) continue;
    days.push({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    });
  }
  return days;
}

/** Rendez-vous déjà pris pour une recyclerie (créneaux à venir uniquement). */
async function bookedDepotSlots(ctx: QueryCtx | MutationCtx, site: "60" | "76", from: number) {
  const requests = await ctx.db
    .query("requests")
    .withIndex("by_type", (q) => q.eq("type", "depot"))
    .collect();
  return new Set(
    requests
      .filter(
        (request) =>
          request.depot?.site === site &&
          request.outcome !== "perdue" &&
          (request.depot?.slotStart ?? 0) >= from,
      )
      .map((request) => request.depot!.slotStart),
  );
}

/**
 * Créneaux de dépôt proposés au client : les prochains lundis, avec pour
 * chaque heure l'information « déjà réservé » calculée côté serveur — c'est la
 * même source que la validation de `submitDepot`, donc l'affichage ne peut pas
 * proposer un créneau que la mutation refusera.
 */
/** Fermetures saisies par l'équipe pour une recyclerie. */
async function depotBlocks(ctx: QueryCtx | MutationCtx, site: "60" | "76") {
  const blocks = await ctx.db
    .query("depotBlockedSlots")
    .withIndex("by_site", (q) => q.eq("site", site))
    .collect();
  return {
    days: new Set(blocks.filter((b) => b.slotStart === undefined).map((b) => b.date)),
    slots: new Set(
      blocks
        .filter((b) => b.slotStart !== undefined)
        .map((b) => b.slotStart as number),
    ),
  };
}

export const depotSlots = query({
  args: { site: v.union(v.literal("60"), v.literal("76")) },
  handler: async (ctx, { site }) => {
    const now = Date.now();
    const booked = await bookedDepotSlots(ctx, site, now);
    const blocked = await depotBlocks(ctx, site);
    return upcomingMondays(now).map((day) => {
      const date = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
      const dayBlocked = blocked.days.has(date);
      return {
        date,
        dayBlocked,
        slots: DEPOT_SLOT_MINUTE_MARKS.map((minuteOfDay) => {
          const start = parisTimestamp(
            day.year,
            day.month,
            day.day,
            Math.floor(minuteOfDay / 60),
            minuteOfDay % 60,
          );
          const isBooked = booked.has(start);
          const isBlocked = dayBlocked || blocked.slots.has(start);
          return {
            start,
            end: start + DEPOT_SLOT_MINUTES * 60_000,
            label: depotSlotLabel(minuteOfDay),
            booked: isBooked,
            blocked: isBlocked,
            available: start > now && !isBooked && !isBlocked,
          };
        }),
      };
    });
  },
});

/**
 * Ouvre ou ferme une journée / un créneau de dépôt.
 *
 * Fermer une journée masque tous ses créneaux d'un coup ; les rendez-vous déjà
 * pris ne sont pas annulés pour autant — l'équipe les voit toujours dans
 * l'onglet Dépôts et reste libre de les traiter.
 */
export const setDepotAvailability = mutation({
  args: {
    site: v.union(v.literal("60"), v.literal("76")),
    date: v.string(),
    /** Absent : c'est la journée entière qui est ouverte/fermée. */
    slotStart: v.optional(v.number()),
    blocked: v.boolean(),
  },
  handler: async (ctx, { site, date, slotStart, blocked }) => {
    await requireCrmPermission(ctx, "calendrier", "update");
    const identity = await requireUser(ctx);

    const existing = (
      await ctx.db
        .query("depotBlockedSlots")
        .withIndex("by_site_and_date", (q) => q.eq("site", site).eq("date", date))
        .collect()
    ).filter((block) => block.slotStart === slotStart);

    if (!blocked) {
      for (const block of existing) await ctx.db.delete(block._id);
      // Rouvrir un créneau précis n'a pas de sens si toute la journée est
      // fermée : on lève aussi la fermeture de la journée.
      if (slotStart !== undefined) {
        const dayBlocks = (
          await ctx.db
            .query("depotBlockedSlots")
            .withIndex("by_site_and_date", (q) => q.eq("site", site).eq("date", date))
            .collect()
        ).filter((block) => block.slotStart === undefined);
        for (const block of dayBlocks) await ctx.db.delete(block._id);
      }
      return { blocked: false };
    }

    if (existing.length > 0) return { blocked: true };
    await ctx.db.insert("depotBlockedSlots", {
      site,
      date,
      slotStart,
      createdAt: Date.now(),
      createdBy: identity.name ?? identity.email ?? identity.subject,
    });
    return { blocked: true };
  },
});

export const submitDepot = mutation({
  args: {
    customer: customerArg,
    comment: v.optional(v.string()),
    photos: v.array(v.id("_storage")),
    details: v.object({
      site: v.union(v.literal("60"), v.literal("76")),
      slotStart: v.number(),
      vehicleType: v.union(
        v.literal("voiture"),
        v.literal("camionnette"),
        v.literal("remorque"),
      ),
      description: v.optional(v.string()),
    }),
  },
  handler: async (ctx, { customer, comment, photos, details }) => {
    await requireUser(ctx);

    // Le créneau est revalidé ici : un client peut avoir gardé la page ouverte
    // pendant qu'un autre réservait le même lundi.
    const now = Date.now();
    const slot = parisParts(details.slotStart);
    if (slot.weekday !== "Mon") {
      throw new Error("Les dépôts se font uniquement le lundi.");
    }
    if (!DEPOT_SLOT_MINUTE_MARKS.includes(slot.hour * 60 + slot.minute)) {
      throw new Error("Ce créneau n'est pas proposé.");
    }
    if (details.slotStart <= now) {
      throw new Error("Ce créneau est déjà passé.");
    }
    const booked = await bookedDepotSlots(ctx, details.site, now);
    if (booked.has(details.slotStart)) {
      throw new Error("Ce créneau vient d'être réservé. Choisissez-en un autre.");
    }

    const resolvedCustomer = await upsertRequestCustomer(ctx, customer, "/depot");
    customer = resolvedCustomer.customer;
    const reference = await generateReference(ctx);
    const requestId = await ctx.db.insert("requests", {
      type: "depot",
      stage: "planifie",
      outcome: "open",
      requestOrigin: "external",
      // Un dépôt est complet dès l'envoi : créneau, site et véhicule sont requis.
      complete: true,
      processSteps: resolveProcess("depot"),
      completedSteps: 0,
      customer,
      userId: resolvedCustomer.userId,
      site: details.site,
      // Le créneau choisi pilote aussi le calendrier du CRM.
      scheduledDate: details.slotStart,
      comment,
      photos,
      depot: {
        site: details.site,
        slotStart: details.slotStart,
        slotEnd: details.slotStart + DEPOT_SLOT_MINUTES * 60_000,
        vehicleType: details.vehicleType,
        description: details.description || undefined,
      },
      createdAt: now,
      updatedAt: now,
      reference,
    });
    await createNewRequestNotification(ctx, {
      requestId,
      requestType: "depot",
      customerName: customerFullName(customer),
    });
    return requestId;
  },
});

/** Libellé public d'une recyclerie, pour les emails et l'espace client. */
const DEPOT_SITE_LABELS: Record<"60" | "76", string> = {
  "60": "Recyclerie du Pays de Bray 60",
  "76": "Recyclerie de Gournay en Bray 76",
};

/**
 * Annulation de son propre créneau de dépôt par le client.
 *
 * Le créneau est immédiatement rendu à la réservation : `bookedDepotSlots`
 * ignore les demandes perdues.
 */
export const cancelMyDepot = mutation({
  args: { id: v.id("requests") },
  handler: async (ctx, { id }) => {
    const identity = await requireUser(ctx);
    const request = await ctx.db.get(id);
    if (!request || request.type !== "depot") throw new Error("Dépôt introuvable.");

    const ownsByAccount = request.userId === identity.subject;
    const ownsByEmail =
      normalizeEmail(request.customer.email) === normalizeEmail(identity.email ?? "");
    if (!ownsByAccount && !ownsByEmail) throw new Error("Annulation non autorisée.");
    if (request.outcome === "perdue") return { cancelled: true };

    await ctx.db.patch(id, {
      outcome: "perdue",
      lostReason: "annulation_client",
      updatedAt: Date.now(),
    });
    return { cancelled: true };
  },
});

/**
 * Cron quotidien : rappel de dépôt la veille du rendez-vous.
 *
 * `reminderSentAt` est posé après l'envoi, donc un client n'est prévenu qu'une
 * fois même si le cron repasse ou si la fenêtre du lendemain est recalculée.
 */
export const sendDepotReminders = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ sent: number }> => {
    const now = Date.now();
    const tomorrow = parisParts(now + 86_400_000);
    const dayStart = parisTimestamp(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0);
    const dayEnd = dayStart + 86_400_000;

    const depots = await ctx.db
      .query("requests")
      .withIndex("by_type", (q) => q.eq("type", "depot"))
      .collect();

    let sent = 0;
    for (const request of depots) {
      const detail = request.depot;
      if (!detail || detail.reminderSentAt) continue;
      if (request.outcome === "perdue") continue;
      if (detail.slotStart < dayStart || detail.slotStart >= dayEnd) continue;
      const email = request.customer.email?.trim();
      if (!email) continue;

      await ctx.scheduler.runAfter(0, internal.emails.sendDepotReminder, {
        email,
        name: customerFullName(request.customer),
        requestId: String(request._id),
        siteLabel: DEPOT_SITE_LABELS[detail.site],
        slotStart: detail.slotStart,
      });
      await ctx.db.patch(request._id, {
        depot: { ...detail, reminderSentAt: now },
      });
      sent += 1;
    }
    return { sent };
  },
});

export const submitLivraison = mutation({
  args: {
    customer: customerArg,
    comment: v.optional(v.string()),
    articlePhoto: v.optional(v.id("_storage")),
    referencePhoto: v.optional(v.id("_storage")),
  },
  handler: async (ctx, { customer, comment, articlePhoto, referencePhoto }) => {
    await requireUser(ctx);
    const resolvedCustomer = await upsertRequestCustomer(
      ctx,
      customer,
      "/livraison",
    );
    customer = resolvedCustomer.customer;
    const now = Date.now();
    const reference = await generateReference(ctx);
    const details = {
      deliveryAddress: {
        address: customer.address,
        postalCode: customer.postalCode,
        city: customer.city,
      },
      sameAsBilling: true,
      articlePhoto,
      referencePhoto,
    };
    const photos = [articlePhoto, referencePhoto].filter(
      (p): p is Id<"_storage"> => Boolean(p),
    );
    const requestId = await ctx.db.insert("requests", {
      type: "livraison",
      stage: "nouveau",
      outcome: "open",
      requestOrigin: "external",
      complete: isLivraisonComplete(customer, details),
      processSteps: resolveProcess("livraison"),
      completedSteps: 0,
      customer,
      userId: resolvedCustomer.userId,
      comment,
      photos,
      livraison: details,
      createdAt: now,
      updatedAt: now,
      reference,
    });
    await createNewRequestNotification(ctx, {
      requestId,
      requestType: "livraison",
      customerName: customerFullName(customer),
    });
    return requestId;
  },
});

export const submitArticleReservation = mutation({
  args: {
    customer: customerArg,
    comment: v.optional(v.string()),
    articleId: v.id("articles"),
  },
  handler: async (ctx, { customer, comment, articleId }) => {
    const resolvedCustomer = await upsertRequestCustomer(
      ctx,
      customer,
      "/boutique",
    );
    customer = resolvedCustomer.customer;
    const article = await ctx.db.get(articleId);
    if (!article) throw new Error("Article introuvable.");
    if (article.status !== "disponible") {
      throw new Error("Cet article n'est plus disponible.");
    }
    const now = Date.now();
    const reference = await generateReference(ctx);
    // L'article passe en « réservé » dès la demande.
    await ctx.db.patch(articleId, { status: "reserve" });
    await scheduleStripeSync(ctx, articleId);
    const requestId = await ctx.db.insert("requests", {
      type: "article",
      stage: "nouveau",
      outcome: "open",
      requestOrigin: "external",
      complete: isArticleComplete(customer),
      processSteps: resolveProcess("article"),
      completedSteps: 0,
      customer,
      userId: resolvedCustomer.userId,
      comment,
      photos: [],
      article: { articleId, articleTitle: article.title },
      articles: [{ articleId, articleTitle: article.title }],
      payment: {
        method: "especes",
        status: "pending",
        validated: false,
        captured: false,
      },
      createdAt: now,
      updatedAt: now,
      reference,
    });
    await createNewRequestNotification(ctx, {
      requestId,
      requestType: "article",
      customerName: customerFullName(customer),
    });
    return requestId;
  },
});

export const submitArticleCartReservation = mutation({
  args: {
    customer: customerArg,
    comment: v.optional(v.string()),
    articleIds: v.array(v.id("articles")),
  },
  handler: async (ctx, { customer, comment, articleIds }) => {
    const resolvedCustomer = await upsertRequestCustomer(
      ctx,
      customer,
      "/boutique/panier",
    );
    customer = resolvedCustomer.customer;
    const uniqueArticleIds = Array.from(new Set(articleIds));
    if (uniqueArticleIds.length === 0) {
      throw new Error("Ajoutez au moins un article au panier.");
    }
    const articles = [];
    for (const articleId of uniqueArticleIds) {
      const article = await ctx.db.get(articleId);
      if (!article) throw new Error("Un article du panier est introuvable.");
      if (article.status !== "disponible") {
        throw new Error(`"${article.title}" n'est plus disponible.`);
      }
      articles.push({ articleId, articleTitle: article.title });
    }

    const now = Date.now();
    const reference = await generateReference(ctx);
    for (const articleId of uniqueArticleIds) {
      await ctx.db.patch(articleId, { status: "reserve" });
      await scheduleStripeSync(ctx, articleId);
    }

    const requestId = await ctx.db.insert("requests", {
      type: "article",
      stage: "nouveau",
      outcome: "open",
      requestOrigin: "external",
      complete: isArticleComplete(customer),
      processSteps: resolveProcess("article"),
      completedSteps: 0,
      customer,
      userId: resolvedCustomer.userId,
      comment,
      photos: [],
      article: articles[0],
      articles,
      payment: {
        method: "especes",
        status: "pending",
        validated: false,
        captured: false,
      },
      createdAt: now,
      updatedAt: now,
      reference,
    });
    await createNewRequestNotification(ctx, {
      requestId,
      requestType: "article",
      customerName: customerFullName(customer),
    });
    return requestId;
  },
});

export const createPublicStripeCheckoutDraft = internalMutation({
  args: {
    customer: customerArg,
    comment: v.optional(v.string()),
    articleIds: v.array(v.id("articles")),
    discountCode: v.optional(v.string()),
  },
  handler: async (ctx, { customer, comment, articleIds, discountCode }) => {
    customer = normalizeCustomer(customer);
    const uniqueArticleIds = Array.from(new Set(articleIds));
    if (uniqueArticleIds.length === 0) {
      throw new Error("Ajoutez au moins un article au panier.");
    }

    let total = 0;
    for (const articleId of uniqueArticleIds) {
      const article = await ctx.db.get(articleId);
      if (!article) throw new Error("Un article du panier est introuvable.");
      if (article.status !== "disponible") {
        throw new Error(`"${article.title}" n'est plus disponible.`);
      }
      total += article.price;
    }

    // La remise est relue depuis le bon lui-même : le navigateur n'envoie
    // qu'un code, jamais un pourcentage ni un montant.
    let discountCodeId: Id<"discountCodes"> | undefined;
    let discountPercent: number | undefined;
    let discountAmount: number | undefined;
    let payable = total;
    if (discountCode?.trim()) {
      const discount = await assertUsableDiscount(ctx, discountCode);
      const applied = applyDiscount(total, discount.percent);
      discountCodeId = discount._id;
      discountPercent = discount.percent;
      discountAmount = applied.discountAmount;
      payable = applied.total;
    }

    const draftId = await ctx.db.insert("publicStripeCheckoutDrafts", {
      articleIds: uniqueArticleIds,
      customer,
      comment,
      total: payable,
      subtotal: total,
      discountCodeId,
      discountPercent,
      discountAmount,
      status: "pending",
      createdAt: Date.now(),
    });
    return { draftId, total: payable, subtotal: total, discountPercent, discountAmount };
  },
});

export const attachStripeSessionToPublicDraft = internalMutation({
  args: {
    draftId: v.id("publicStripeCheckoutDrafts"),
    stripeSessionId: v.string(),
  },
  handler: async (ctx, { draftId, stripeSessionId }) => {
    await ctx.db.patch(draftId, { stripeSessionId });
    return null;
  },
});

/** Flux custom : mémorise le PaymentIntent dès sa création. */
export const attachStripePaymentIntentToPublicDraft = internalMutation({
  args: {
    draftId: v.id("publicStripeCheckoutDrafts"),
    stripePaymentIntentId: v.string(),
  },
  handler: async (ctx, { draftId, stripePaymentIntentId }) => {
    await ctx.db.patch(draftId, { stripePaymentIntentId });
  },
});

/**
 * Avancement d'une demande boutique qui vient d'être payée.
 *
 * Le paiement ne solde PAS la demande : il ne coche que « Paiement validé ».
 * La commande reste ouverte (colonne « Prestation planifiée » du CRM) tant que
 * l'équipe n'a pas constaté le retrait en boutique. Les demandes créées avant
 * l'introduction de ce process gardent leurs anciennes étapes : on les solde
 * comme avant pour ne pas les laisser bloquées.
 */
function paidBoutiqueProgress(steps: string[]): {
  completedSteps: number;
  outcome: "open" | "gagnee";
} {
  const paidIndex = steps.indexOf(STEP.paiementValide);
  if (paidIndex === -1) {
    return { completedSteps: steps.length, outcome: "gagnee" };
  }
  const completedSteps = paidIndex + 1;
  return {
    completedSteps,
    outcome: completedSteps >= steps.length ? "gagnee" : "open",
  };
}

/**
 * Encaissement d'un lien de paiement : marque les articles vendus et solde la
 * demande liée — ou en crée une quand le lien a été généré depuis un article,
 * sans demande préalable. Idempotent : rejouer l'appel ne crée rien de plus.
 */
export const finalizePaymentLink = internalMutation({
  args: {
    token: v.string(),
    stripePaymentIntentId: v.string(),
    customer: v.optional(customerArg),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, { token, stripePaymentIntentId, customer, comment }) => {
    const link = await ctx.db
      .query("paymentLinks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!link) throw new Error("Lien de paiement introuvable.");
    if (link.status === "paid") {
      return { requestId: link.requestId ?? null };
    }

    const now = Date.now();
    const payment = {
      method: "cb" as const,
      status: "paid" as const,
      validated: true,
      captured: true,
      provider: "stripe" as const,
      stripePaymentIntentId,
      paidAt: now,
    };

    const articles: Array<{ articleId: Id<"articles">; articleTitle: string }> = [];
    for (const articleId of link.articleIds) {
      const article = await ctx.db.get(articleId);
      if (!article) continue;
      articles.push({ articleId, articleTitle: article.title });
      if (article.status !== "vendu") {
        await ctx.db.patch(articleId, { status: "vendu" });
        await scheduleStripeSync(ctx, articleId);
      }
    }

    let requestId = link.requestId ?? null;
    if (requestId) {
      const request = await ctx.db.get(requestId);
      if (!request) throw new Error("Demande introuvable.");
      const progress = paidBoutiqueProgress(request.processSteps);
      await ctx.db.patch(requestId, {
        payment,
        outcome: progress.outcome,
        completedSteps: progress.completedSteps,
        updatedAt: now,
      });
      if (progress.outcome === "gagnee" && request.outcome !== "gagnee") {
        await scheduleReviewInvite(ctx, request);
      }
    } else {
      // Lien généré depuis un article : on crée la demande boutique payée.
      const linkCustomer = normalizeCustomer(
        customer ?? link.customer ?? {
          firstName: "Client",
          lastName: "boutique",
          email: "",
          phone: "",
        },
      );
      const steps = resolveProcess("article");
      const progress = paidBoutiqueProgress(steps);
      const reference = await generateReference(ctx);
      requestId = await ctx.db.insert("requests", {
        type: "article",
        stage: "nouveau",
        outcome: progress.outcome,
        requestOrigin: "external",
        complete: isArticleComplete(linkCustomer),
        processSteps: steps,
        completedSteps: progress.completedSteps,
        customer: linkCustomer,
        comment,
        photos: [],
        article: articles[0],
        articles,
        payment,
        createdAt: now,
        updatedAt: now,
        reference,
      });
      await createNewRequestNotification(ctx, {
        requestId,
        requestType: "article",
        customerName: customerFullName(linkCustomer),
      });
    }

    await ctx.db.patch(link._id, {
      status: "paid",
      stripePaymentIntentId,
      paidAt: now,
      ...(customer && !link.customer ? { customer: normalizeCustomer(customer) } : {}),
    });

    return { requestId };
  },
});

/* ─── Remboursement d'une commande boutique ──────────────────────────────── */

/** Lit le paiement d'une demande pour l'action de remboursement Stripe. */
export const paymentForRefund = internalQuery({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.get(requestId);
    if (!request) return null;
    return {
      payment: request.payment ?? null,
      quoteAmount: request.quoteAmount,
      reference: request.reference,
      articleIds: requestArticleIds(request),
    };
  },
});

/**
 * Enregistre le remboursement Stripe sur la demande.
 *
 * Le paiement reste marqué « payé » — il l'a bien été — mais porte désormais sa
 * trace de remboursement, et la demande est fermée en « perdue » : la commande
 * n'ira pas au bout. Les articles repartent en vente (« disponible ») puisque
 * plus personne ne les a achetés.
 */
export const markRefunded = internalMutation({
  args: {
    requestId: v.id("requests"),
    stripeRefundId: v.string(),
    refundedAmount: v.number(),
    refundedBy: v.optional(v.string()),
  },
  handler: async (ctx, { requestId, stripeRefundId, refundedAmount, refundedBy }) => {
    const request = await ctx.db.get(requestId);
    if (!request) throw new Error("Demande introuvable.");
    if (!request.payment) throw new Error("Cette demande n'a aucun paiement.");
    const now = Date.now();
    await ctx.db.patch(requestId, {
      payment: {
        ...request.payment,
        stripeRefundId,
        refundedAmount,
        refundedAt: now,
        refundedBy,
      },
      outcome: "perdue",
      lostReason: "annulation_client",
      updatedAt: now,
    });
    for (const articleId of requestArticleIds(request)) {
      const article = await ctx.db.get(articleId);
      if (article && article.status === "vendu") {
        await ctx.db.patch(articleId, { status: "disponible" });
        await scheduleStripeSync(ctx, articleId);
      }
    }
    return null;
  },
});

export const finalizePublicStripeCheckout = internalMutation({
  args: {
    draftId: v.id("publicStripeCheckoutDrafts"),
    /** Flux Checkout hébergé. Absent pour le flux custom (Payment Element). */
    stripeSessionId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, { draftId, stripeSessionId, stripePaymentIntentId }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) throw new Error("Paiement en ligne introuvable.");

    if (draft.status === "completed" && draft.requestId) {
      return { requestId: draft.requestId };
    }

    if (
      stripeSessionId &&
      draft.stripeSessionId &&
      draft.stripeSessionId !== stripeSessionId
    ) {
      throw new Error("Cette session Stripe ne correspond pas au panier en cours.");
    }
    if (
      stripePaymentIntentId &&
      draft.stripePaymentIntentId &&
      draft.stripePaymentIntentId !== stripePaymentIntentId
    ) {
      throw new Error("Ce paiement Stripe ne correspond pas au panier en cours.");
    }

    const articles = [];
    for (const articleId of draft.articleIds) {
      const article = await ctx.db.get(articleId);
      if (!article) throw new Error("Un article payé est introuvable.");
      if (article.status !== "disponible") {
        throw new Error(`"${article.title}" n'est plus disponible.`);
      }
      articles.push({ articleId, articleTitle: article.title });
    }

    const now = Date.now();
    const reference = await generateReference(ctx);
    for (const articleId of draft.articleIds) {
      await ctx.db.patch(articleId, { status: "vendu" });
      await scheduleStripeSync(ctx, articleId);
    }

    const discount = draft.discountCodeId
      ? await ctx.db.get(draft.discountCodeId)
      : null;
    const discountCodeValue = discount?.code;

    const steps = resolveProcess("article");
    const progress = paidBoutiqueProgress(steps);
    const requestId = await ctx.db.insert("requests", {
      type: "article",
      stage: "nouveau",
      outcome: progress.outcome,
      requestOrigin: "external",
      complete: isArticleComplete(draft.customer),
      processSteps: steps,
      completedSteps: progress.completedSteps,
      customer: draft.customer,
      comment: draft.comment || undefined,
      photos: [],
      article: articles[0],
      articles,
      payment: {
        method: "cb",
        status: "paid",
        validated: true,
        captured: true,
        provider: "stripe",
        stripeSessionId,
        stripePaymentIntentId,
        paidAt: now,
        ...(draft.discountPercent !== undefined
          ? {
              discountCode: discountCodeValue,
              discountPercent: draft.discountPercent,
              discountAmount: draft.discountAmount,
              subtotal: draft.subtotal,
            }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
      reference,
    });

    if (discount && discount.status !== "used") {
      await ctx.db.patch(discount._id, {
        status: "used",
        usedAt: now,
        usedByRequestId: requestId,
        discountAmount: draft.discountAmount,
      });
    }

    await createNewRequestNotification(ctx, {
      requestId,
      requestType: "article",
      customerName: customerFullName(draft.customer),
    });

    await ctx.db.patch(draftId, {
      ...(stripeSessionId ? { stripeSessionId } : {}),
      ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
      status: "completed",
      requestId,
      completedAt: Date.now(),
    });

    return { requestId };
  },
});

// ---------------------------------------------------------------------------
// CRM (protégé)
// ---------------------------------------------------------------------------

export const list = query({
  args: {
    type: v.optional(requestType),
  },
  handler: async (ctx, { type }) => {
    await requireCrmPermission(ctx, "demandes", "read");
    const all = type
      ? await ctx.db
          .query("requests")
          .withIndex("by_type", (q) => q.eq("type", type))
          .order("desc")
          .collect()
      : await ctx.db.query("requests").order("desc").collect();
    // Un dépôt n'est pas une demande à traiter : c'est un rendez-vous, il vit
    // dans l'onglet « Dépôts » du calendrier et pas sur le tableau des demandes.
    return all
      .filter((r) => r.type !== "depot")
      .map((r) => ({ ...r, customer: normalizeCustomer(r.customer) }));
  },
});

/** Liste légère des demandes pour le sélecteur « Assigner à une demande ». */
export const listForPicker = query({
  args: {},
  handler: async (ctx) => {
    await requireAnyCrmPermission(ctx, [
      ["documents", "share"],
      ["demandes", "read"],
    ]);
    const requests = await ctx.db.query("requests").order("desc").take(500);
    return requests.map((r) => {
      const c = normalizeCustomer(r.customer);
      return {
        _id: r._id,
        reference: r.reference ?? String(r._id).slice(-6),
        type: r.type,
        collecteType: r.collecteType ?? null,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        city: c.city ?? null,
        createdAt: r.createdAt,
      };
    });
  },
});

export const counts = query({
  args: {},
  handler: async (ctx) => {
    // Badge de navigation : renvoie 0 sans erreur si l'utilisateur n'a pas
    // accès aux demandes (la query est montée en permanence dans le layout).
    if (!(await hasCrmPermission(ctx, "demandes", "read"))) {
      return { complete: 0 };
    }
    const openRequests = await ctx.db
      .query("requests")
      .withIndex("by_outcome", (q) => q.eq("outcome", "open"))
      .collect();
    return {
      complete: openRequests.filter((request) => request.complete).length,
    };
  },
});

export const get = query({
  args: { id: v.id("requests") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "demandes", "read");
    const request = await ctx.db.get(id);
    if (!request) return null;
    const photoUrls = await Promise.all(
      request.photos.map((p) => ctx.storage.getUrl(p)),
    );
    const beforePhotoUrls = await Promise.all(
      (request.beforePhotos ?? []).map((p) => ctx.storage.getUrl(p)),
    );
    const afterPhotoUrls = await Promise.all(
      (request.afterPhotos ?? []).map((p) => ctx.storage.getUrl(p)),
    );
    // Résout les URLs des photos rattachées à chaque objet d'aérogommage.
    const aerogommagePhotos = await Promise.all(
      (request.aerogommage ?? []).map(async (item) =>
        (
          await Promise.all((item.photos ?? []).map((p) => ctx.storage.getUrl(p)))
        ).filter((u): u is string => u !== null),
      ),
    );
    const aerogommageBeforePhotos = await Promise.all(
      (request.aerogommage ?? []).map(async (item) =>
        (
          await Promise.all((item.beforePhotos ?? []).map((p) => ctx.storage.getUrl(p)))
        ).filter((u): u is string => u !== null),
      ),
    );
    const aerogommageAfterPhotos = await Promise.all(
      (request.aerogommage ?? []).map(async (item) =>
        (
          await Promise.all((item.afterPhotos ?? []).map((p) => ctx.storage.getUrl(p)))
        ).filter((u): u is string => u !== null),
      ),
    );
    // Résout les URLs des photos de collecte, groupées par catégorie.
    const collecteCategoryPhotos = await Promise.all(
      (request.collecte?.categoryPhotos ?? []).map(async (entry) => ({
        category: entry.category,
        urls: (
          await Promise.all(entry.photos.map((p) => ctx.storage.getUrl(p)))
        ).filter((u): u is string => u !== null),
      })),
    );
    // Photos de la demande de livraison (article + référence, séparées).
    const livraisonArticleUrl = request.livraison?.articlePhoto
      ? await ctx.storage.getUrl(request.livraison.articlePhoto)
      : null;
    const livraisonReferenceUrl = request.livraison?.referencePhoto
      ? await ctx.storage.getUrl(request.livraison.referencePhoto)
      : null;
    return {
      ...request,
      customer: normalizeCustomer(request.customer),
      photoUrls: photoUrls.filter((u): u is string => u !== null),
      beforePhotoUrls: beforePhotoUrls.filter((u): u is string => u !== null),
      afterPhotoUrls: afterPhotoUrls.filter((u): u is string => u !== null),
      aerogommagePhotos,
      aerogommageBeforePhotos,
      aerogommageAfterPhotos,
      collecteCategoryPhotos,
      livraisonArticleUrl,
      livraisonReferenceUrl,
    };
  },
});

/**
 * Invitation à noter la Recyclerie sur Google, à l'issue d'une demande gagnée.
 *
 * Envoyée une seule fois par demande (`reviewInviteSentAt`) : une demande
 * rouverte puis re-soldée ne relance pas le client. Sans email client, il n'y
 * a rien à envoyer. Le lien dépend du site de traitement, la Recyclerie 60
 * servant de défaut quand il n'est pas renseigné.
 */
async function scheduleReviewInvite(ctx: MutationCtx, request: Doc<"requests">) {
  if (request.reviewInviteSentAt) return;
  const email = request.customer.email?.trim();
  if (!email) return;
  await ctx.db.patch(request._id, { reviewInviteSentAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.emails.sendReviewInvite, {
    email,
    name: customerFullName(request.customer) || "à vous",
    reference: request.reference ?? String(request._id).slice(-6),
    type: request.type,
    site: request.site ?? "60",
  });
}

export const setOutcome = mutation({
  args: {
    id: v.id("requests"),
    outcome: v.union(
      v.literal("open"),
      v.literal("gagnee"),
      v.literal("perdue"),
    ),
    lostReason: v.optional(v.union(requestLostReason, v.null())),
    lostReasonDetails: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, outcome, lostReason, lostReasonDetails }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    const request = await ctx.db.get(id);
    if (!request) throw new Error("Demande introuvable.");
    await ctx.db.patch(id, {
      outcome,
      lostReason: outcome === "perdue" ? (lostReason ?? undefined) : undefined,
      lostReasonDetails:
        outcome === "perdue" ? (lostReasonDetails ?? undefined) : undefined,
      updatedAt: Date.now(),
    });
    if (outcome === "gagnee" && request.outcome !== "gagnee") {
      await scheduleReviewInvite(ctx, request);
    }
    if (request.type === "article") {
      const articleStatus =
        outcome === "gagnee"
          ? "vendu"
          : outcome === "perdue"
            ? "disponible"
            : "reserve";
      for (const articleId of requestArticleIds(request)) {
        await ctx.db.patch(articleId, { status: articleStatus });
        await scheduleStripeSync(ctx, articleId);
      }
    }
  },
});

export const deleteForever = mutation({
  args: { id: v.id("requests") },
  handler: async (ctx, { id }) => {
    await requirePermanentDeleteAccess(ctx);
    const request = await ctx.db.get(id);
    if (!request) return { deleted: false };

    let messagesDeleted = 0;
    let notificationsDeleted = 0;
    let documentsDeleted = 0;
    let trackingLinksDeleted = 0;
    let tourneeStopsRemoved = 0;
    let articleReservationsReleased = 0;

    const requestPhotoIds = requestStorageIds(request);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_requestId", (q) => q.eq("requestId", id))
      .collect();
    for (const message of messages) {
      await ctx.db.delete(message._id);
      messagesDeleted++;
    }

    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_requestId", (q) => q.eq("requestId", id))
      .collect();
    for (const notification of notifications) {
      await ctx.db.delete(notification._id);
      notificationsDeleted++;
    }

    const requestDocuments = await ctx.db
      .query("requestDocuments")
      .withIndex("by_requestId", (q) => q.eq("requestId", id))
      .collect();
    const documentStorageIds: Id<"_storage">[] = [];
    for (const document of requestDocuments) {
      if (!document.sourceDocumentId) documentStorageIds.push(document.storageId);
      await ctx.db.delete(document._id);
      documentsDeleted++;
    }

    const trackingLinks = await ctx.db
      .query("tourneeTrackingLinks")
      .withIndex("by_requestId", (q) => q.eq("requestId", id))
      .collect();
    for (const link of trackingLinks) {
      await ctx.db.delete(link._id);
      trackingLinksDeleted++;
    }

    const tournees = await ctx.db.query("tournees").take(500);
    for (const tournee of tournees) {
      const stops = tournee.stops.filter((stop) => {
        if (stop.requestId !== id) return true;
        tourneeStopsRemoved++;
        return false;
      });
      if (stops.length !== tournee.stops.length) {
        await ctx.db.patch(tournee._id, {
          stops: stops.map((stop, index) => ({ ...stop, order: index })),
        });
      }
    }

    const publicDrafts = await ctx.db.query("publicStripeCheckoutDrafts").take(500);
    for (const draft of publicDrafts) {
      if (draft.requestId === id) {
        await ctx.db.patch(draft._id, { requestId: undefined });
      }
    }

    if (request.type === "article") {
      for (const articleId of requestArticleIds(request)) {
        const article = await ctx.db.get(articleId);
        if (article?.status === "reserve") {
          await ctx.db.patch(articleId, { status: "disponible" });
          await scheduleStripeSync(ctx, articleId);
          articleReservationsReleased++;
        }
      }
    }

    const storageDeleted = await deleteStorageBestEffort(ctx, [
      ...requestPhotoIds,
      ...documentStorageIds,
    ]);

    await ctx.db.delete(id);

    return {
      deleted: true,
      messagesDeleted,
      notificationsDeleted,
      documentsDeleted,
      trackingLinksDeleted,
      tourneeStopsRemoved,
      articleReservationsReleased,
      storageDeleted,
    };
  },
});

export const setComplete = mutation({
  args: {
    id: v.id("requests"),
    complete: v.boolean(),
  },
  handler: async (ctx, { id, complete }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    await ctx.db.patch(id, { complete, updatedAt: Date.now() });
  },
});

export const backfillRequestOrigins = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const requests = await ctx.db.query("requests").collect();
    let updated = 0;

    for (const request of requests) {
      if (request.requestOrigin !== undefined) continue;
      await ctx.db.patch(request._id, { requestOrigin: "external" });
      updated += 1;
    }

    return { updated };
  },
});

/**
 * Harmonise les noms/prénoms historiques dans tout l'écosystème client/CRM.
 * Couvre : demandes, profils clients, notifications et noms d'expéditeur client.
 */
export const backfillCustomerNameFormatting = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    let requestsUpdated = 0;
    let usersUpdated = 0;
    let notificationsUpdated = 0;
    let messagesUpdated = 0;

    const requests = await ctx.db.query("requests").collect();
    for (const request of requests) {
      const customer = normalizeCustomer(request.customer);
      if (
        customer.firstName !== request.customer.firstName ||
        customer.lastName !== request.customer.lastName
      ) {
        await ctx.db.patch(request._id, {
          customer,
          updatedAt: Date.now(),
        });
        requestsUpdated += 1;
      }
    }

    const users = await ctx.db.query("users").collect();
    for (const user of users) {
      const firstName = user.firstName ? titleCaseName(user.firstName) : user.firstName;
      const lastName = user.lastName ? titleCaseName(user.lastName) : user.lastName;
      if (firstName !== user.firstName || lastName !== user.lastName) {
        await ctx.db.patch(user._id, {
          firstName,
          lastName,
          updatedAt: Date.now(),
        });
        usersUpdated += 1;
      }
    }

    const notifications = await ctx.db.query("notifications").collect();
    for (const notification of notifications) {
      const customerName = titleCaseName(notification.customerName);
      if (customerName !== notification.customerName) {
        await ctx.db.patch(notification._id, { customerName });
        notificationsUpdated += 1;
      }
    }

    const messages = await ctx.db.query("messages").collect();
    for (const message of messages) {
      if (message.senderRole !== "client") continue;
      const senderName = titleCaseName(message.senderName);
      if (senderName !== message.senderName) {
        await ctx.db.patch(message._id, { senderName });
        messagesUpdated += 1;
      }
    }

    return {
      requestsUpdated,
      usersUpdated,
      notificationsUpdated,
      messagesUpdated,
    };
  },
});

/**
 * Met à jour les champs de gestion interne (onglet Gestion).
 * Une valeur `null` efface le champ ; un champ absent est laissé inchangé.
 */
export const patchManagement = mutation({
  args: {
    id: v.id("requests"),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    assignedTo: v.optional(v.union(v.id("teamMembers"), v.null())),
    assignedWorkerId: v.optional(v.union(v.id("polyvalentWorkers"), v.null())),
    estimatedHours: v.optional(v.union(v.number(), v.null())),
    actualHours: v.optional(v.union(v.number(), v.null())),
    quoteAmount: v.optional(v.union(v.number(), v.null())),
    quoteDetails: v.optional(v.union(v.string(), v.null())),
    visitNeeded: v.optional(v.union(v.boolean(), v.null())),
    assignedVehicle: v.optional(v.union(v.id("vehicles"), v.null())),
    beforePhotos: v.optional(v.array(v.id("_storage"))),
    afterPhotos: v.optional(v.array(v.id("_storage"))),
    // Nom de l'auteur (persona sélectionné ou nom du compte).
    actorName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "demandes", "update");
    const request = await ctx.db.get(args.id);
    if (!request) throw new Error("Demande introuvable.");
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    if (args.site !== undefined) {
      setPatchIfChanged(patch, changed, "site", request.site, args.site);
    }
    if (args.assignedTo !== undefined) {
      setPatchIfChanged(
        patch,
        changed,
        "assignedTo",
        request.assignedTo,
        args.assignedTo ?? undefined,
      );
    }
    if (args.assignedWorkerId !== undefined) {
      setPatchIfChanged(patch, changed, "assignedWorkerId", request.assignedWorkerId, args.assignedWorkerId ?? undefined);
    }
    if (args.assignedVehicle !== undefined) {
      if (args.assignedVehicle) {
        const date = request.scheduledDate ?? Date.now();
        const reason = await vehicleBusyReason(ctx, args.assignedVehicle, date, {
          excludeRequestId: args.id,
        });
        if (reason) {
          throw new Error(`Véhicule indisponible à cette date : ${reason}`);
        }
      }
      setPatchIfChanged(
        patch,
        changed,
        "assignedVehicle",
        request.assignedVehicle,
        args.assignedVehicle ?? undefined,
      );
    }
    if (args.estimatedHours !== undefined) {
      setPatchIfChanged(
        patch,
        changed,
        "estimatedHours",
        request.estimatedHours,
        args.estimatedHours ?? undefined,
      );
    }
    if (args.actualHours !== undefined) {
      setPatchIfChanged(
        patch,
        changed,
        "actualHours",
        request.actualHours,
        args.actualHours ?? undefined,
      );
    }
    if (args.quoteAmount !== undefined) {
      setPatchIfChanged(
        patch,
        changed,
        "quoteAmount",
        request.quoteAmount,
        args.quoteAmount ?? undefined,
      );
    }
    if (args.quoteDetails !== undefined) {
      setPatchIfChanged(
        patch,
        changed,
        "quoteDetails",
        request.quoteDetails,
        args.quoteDetails ?? undefined,
      );
    }
    if (args.visitNeeded !== undefined) {
      setPatchIfChanged(
        patch,
        changed,
        "visitNeeded",
        request.visitNeeded,
        args.visitNeeded ?? undefined,
      );
    }
    if (args.beforePhotos !== undefined) {
      setPatchIfChanged(
        patch,
        changed,
        "beforePhotos",
        request.beforePhotos,
        args.beforePhotos,
        false,
      );
    }
    if (args.afterPhotos !== undefined) {
      setPatchIfChanged(
        patch,
        changed,
        "afterPhotos",
        request.afterPhotos,
        args.afterPhotos,
        false,
      );
    }
    if (Object.keys(patch).length === 0) return;
    patch.updatedAt = Date.now();
    const fieldEdits = withFieldEdits(request.fieldEdits, changed, args.actorName);
    if (fieldEdits) patch.fieldEdits = fieldEdits;
    await ctx.db.patch(args.id, patch);
  },
});

/** Planifie (ou déplanifie) la prestation pour le calendrier. */
export const schedule = mutation({
  args: {
    id: v.id("requests"),
    scheduledDate: v.optional(v.number()),
    assignedVehicle: v.optional(v.union(v.id("vehicles"), v.null())),
    actorName: v.optional(v.string()),
  },
  handler: async (ctx, { id, scheduledDate, assignedVehicle, actorName }) => {
    await requireAnyCrmPermission(ctx, [["demandes", "update"], ["calendrier", "update"]]);
    const previous = await ctx.db.get(id);
    const patch: Record<string, unknown> = {
      scheduledDate,
      updatedAt: Date.now(),
    };
    const changed = ["scheduledDate"];
    if (assignedVehicle !== undefined) {
      if (assignedVehicle && scheduledDate) {
        const reason = await vehicleBusyReason(
          ctx,
          assignedVehicle,
          scheduledDate,
          { excludeRequestId: id },
        );
        if (reason) {
          throw new Error(`Véhicule indisponible à cette date : ${reason}`);
        }
      }
      patch.assignedVehicle = assignedVehicle ?? undefined;
      changed.push("assignedVehicle");
    }
    const fieldEdits = withFieldEdits(previous?.fieldEdits, changed, actorName);
    if (fieldEdits) patch.fieldEdits = fieldEdits;
    await ctx.db.patch(id, patch);
    // Prévenir le client par email quand une date est (re)programmée.
    if (
      scheduledDate &&
      scheduledDate !== previous?.scheduledDate &&
      previous?.customer.email
    ) {
      await ctx.scheduler.runAfter(0, internal.emails.sendScheduled, {
        email: previous.customer.email,
        name: customerFullName(previous.customer),
        reference: previous.reference ?? String(previous._id).slice(-6),
        type: previous.type,
        requestId: String(previous._id),
        date: scheduledDate,
        article: await emailArticlePreview(ctx, previous),
      });
    }
  },
});

/** Envoie au client un email lui demandant d'importer des photos (Resend). */
export const requestPhotos = mutation({
  args: { id: v.id("requests"), note: v.optional(v.string()) },
  handler: async (ctx, { id, note }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    const request = await ctx.db.get(id);
    if (!request) throw new Error("Demande introuvable.");
    if (!request.customer.email) {
      throw new Error("Ce client n'a pas d'adresse email renseignée.");
    }
    await ctx.scheduler.runAfter(0, internal.emails.sendPhotoRequest, {
      email: request.customer.email,
      name: customerFullName(request.customer),
      reference: request.reference ?? String(request._id).slice(-6),
      type: request.type,
      requestId: String(request._id),
      note: note?.trim() || undefined,
    });
    return { ok: true };
  },
});

/**
 * Coche l'étape suivante du process (une seule à la fois, pas de saut).
 * Quand la dernière étape est cochée, la demande passe automatiquement en gagnée.
 */
export const advanceProcess = mutation({
  args: { id: v.id("requests"), by: v.optional(v.string()) },
  handler: async (ctx, { id, by }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    const r = await ctx.db.get(id);
    if (!r) throw new Error("Demande introuvable.");
    const steps = r.processSteps ?? [];
    const current = r.completedSteps ?? 0;
    if (current >= steps.length) return;
    const completedSteps = current + 1;
    const done = completedSteps >= steps.length && completedSteps > 0;
    const log = (r.processLog ?? []).filter((e) => e.step < current);
    log.push({ step: current, by: by?.trim() || "Inconnu", at: Date.now() });
    await ctx.db.patch(id, {
      completedSteps,
      processLog: log,
      outcome: done ? "gagnee" : "open",
      updatedAt: Date.now(),
    });
    if (done && r.outcome !== "gagnee") {
      await scheduleReviewInvite(ctx, r);
    }
    if (done && r.type === "article") {
      for (const articleId of requestArticleIds(r)) {
        await ctx.db.patch(articleId, { status: "vendu" });
        await scheduleStripeSync(ctx, articleId);
      }
    }
    // La facture vient d'être éditée et « Facture réglée » est l'étape
    // suivante : on prévient la compta qu'un règlement est à encaisser puis à
    // cocher dans le CRM.
    if (isAwaitingInvoicePayment(steps, completedSteps)) {
      await ctx.scheduler.runAfter(0, internal.emails.sendInvoicePendingPayment, {
        reference: r.reference ?? String(r._id).slice(-6),
        type: r.type,
        customerName: customerFullName(r.customer) || "Client inconnu",
        amount: r.quoteAmount,
        requestId: String(r._id),
      });
    }
  },
});

/** Décoche la dernière étape cochée (retour en arrière d'une étape). */
export const retreatProcess = mutation({
  args: { id: v.id("requests") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    const r = await ctx.db.get(id);
    if (!r) throw new Error("Demande introuvable.");
    const current = r.completedSteps ?? 0;
    if (current <= 0) return;
    const completedSteps = current - 1;
    const log = (r.processLog ?? []).filter((e) => e.step < completedSteps);
    await ctx.db.patch(id, {
      completedSteps,
      processLog: log,
      // Si la demande était gagnée par la dernière étape, on la rouvre.
      outcome: r.outcome === "gagnee" ? "open" : r.outcome,
      updatedAt: Date.now(),
    });
    if (r.outcome === "gagnee" && r.type === "article") {
      for (const articleId of requestArticleIds(r)) {
        await ctx.db.patch(articleId, { status: "reserve" });
        await scheduleStripeSync(ctx, articleId);
      }
    }
  },
});

export const addProcessNote = mutation({
  args: {
    id: v.id("requests"),
    step: v.number(),
    body: v.string(),
    by: v.optional(v.string()),
  },
  handler: async (ctx, { id, step, body, by }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    const request = await ctx.db.get(id);
    if (!request) throw new Error("Demande introuvable.");
    if (step < 0 || step >= request.processSteps.length) {
      throw new Error("Étape de process invalide.");
    }

    const trimmed = body.trim();
    if (!trimmed) {
      throw new Error("Le commentaire ne peut pas être vide.");
    }

    await ctx.db.patch(id, {
      processNotes: [
        ...(request.processNotes ?? []),
        {
          step,
          by: by?.trim() || "Inconnu",
          at: Date.now(),
          body: trimmed,
        },
      ],
      updatedAt: Date.now(),
    });
  },
});

/** Définit le sous-type d'une collecte (C1/C2/C3) → recalcule le process. */
export const setCollecteType = mutation({
  args: { id: v.id("requests"), collecteType, actorName: v.optional(v.string()) },
  handler: async (ctx, { id, collecteType: ct, actorName }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    const r = await ctx.db.get(id);
    if (!r) throw new Error("Demande introuvable.");
    if (r.type !== "collecte") throw new Error("Type de demande invalide.");
    await ctx.db.patch(id, {
      collecteType: ct,
      processSteps: resolveProcess("collecte", ct),
      completedSteps: 0,
      processLog: [],
      processNotes: [],
      outcome: "open",
      updatedAt: Date.now(),
      fieldEdits: withFieldEdits(r.fieldEdits, ["collecteType"], actorName),
    });
  },
});

/**
 * Ajoute des photos (uploadées par l'équipe) à une catégorie d'objets d'une
 * collecte. Fusionne avec les photos déjà présentes pour cette catégorie et
 * s'assure que la catégorie apparaît dans `objectCategories`.
 */
export const addCollecteCategoryPhotos = mutation({
  args: {
    id: v.id("requests"),
    category: v.string(),
    photos: v.array(v.id("_storage")),
  },
  handler: async (ctx, { id, category, photos }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    if (photos.length === 0) return;
    const r = await ctx.db.get(id);
    if (!r) throw new Error("Demande introuvable.");
    if (r.type !== "collecte") throw new Error("Type de demande invalide.");

    const collecte = r.collecte ?? {};
    const categoryPhotos = [...(collecte.categoryPhotos ?? [])];
    const existing = categoryPhotos.find((e) => e.category === category);
    if (existing) {
      existing.photos = [...existing.photos, ...photos];
    } else {
      categoryPhotos.push({ category, photos });
    }
    const objectCategories = collecte.objectCategories ?? [];
    const nextCategories = objectCategories.includes(category)
      ? objectCategories
      : [...objectCategories, category];

    await ctx.db.patch(id, {
      collecte: { ...collecte, categoryPhotos, objectCategories: nextCategories },
      updatedAt: Date.now(),
    });
  },
});

/** Retire une photo d'une catégorie d'objets d'une collecte (index dans la catégorie). */
export const removeCollecteCategoryPhoto = mutation({
  args: {
    id: v.id("requests"),
    category: v.string(),
    index: v.number(),
  },
  handler: async (ctx, { id, category, index }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    const r = await ctx.db.get(id);
    if (!r) throw new Error("Demande introuvable.");
    if (r.type !== "collecte" || !r.collecte) return;

    const categoryPhotos = (r.collecte.categoryPhotos ?? [])
      .map((entry) => {
        if (entry.category !== category) return entry;
        const photos = entry.photos.filter((_, i) => i !== index);
        return { ...entry, photos };
      })
      .filter((entry) => entry.photos.length > 0);

    await ctx.db.patch(id, {
      collecte: { ...r.collecte, categoryPhotos },
      updatedAt: Date.now(),
    });
  },
});

/** Met à jour les coordonnées du client d'une demande (onglet Client). */
export const updateCustomer = mutation({
  args: { id: v.id("requests"), customer: customerArg, actorName: v.optional(v.string()) },
  handler: async (ctx, { id, customer, actorName }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    const request = await ctx.db.get(id);
    if (!request) throw new Error("Demande introuvable.");
    const nextCustomer = normalizeCustomer(customer);
    if (sameValue(normalizeCustomer(request.customer), nextCustomer)) return;
    await ctx.db.patch(id, {
      customer: nextCustomer,
      updatedAt: Date.now(),
      fieldEdits: withFieldEdits(request.fieldEdits, ["customer"], actorName),
    });
  },
});

/** Met à jour les champs renseignés par le client pour une demande d'aérogommage. */
export const updateAerogommageDetails = mutation({
  args: {
    id: v.id("requests"),
    comment: v.optional(v.string()),
    items: v.array(aerogommageItem),
    aerogommageOptions: v.optional(aerogommageOptionsArg),
    actorName: v.optional(v.string()),
  },
  handler: async (ctx, { id, comment, items, aerogommageOptions, actorName }) => {
    await requireCrmPermission(ctx, "demandes", "update");
    const request = await ctx.db.get(id);
    if (!request) throw new Error("Demande introuvable.");
    if (request.type !== "aerogommage") {
      throw new Error("Type de demande invalide.");
    }

    const nextComment = comment?.trim() || undefined;
    const nextComplete = isAerogommageComplete(request.customer, items);
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    setPatchIfChanged(patch, changed, "comment", request.comment, nextComment);
    setPatchIfChanged(patch, changed, "aerogommage", request.aerogommage, items);
    setPatchIfChanged(
      patch,
      changed,
      "aerogommageOptions",
      request.aerogommageOptions,
      aerogommageOptions,
    );
    setPatchIfChanged(patch, changed, "complete", request.complete, nextComplete, false);
    if (Object.keys(patch).length === 0) return;
    patch.updatedAt = Date.now();
    const fieldEdits = withFieldEdits(request.fieldEdits, changed, actorName);
    if (fieldEdits) patch.fieldEdits = fieldEdits;
    await ctx.db.patch(id, patch);
  },
});

/**
 * Crée une demande directement depuis le CRM (par un membre de l'équipe).
 * Même logique que les mutations publiques, avec requestOrigin: "internal".
 */
export const createInternal = mutation({
  args: {
    type: requestType,
    customer: customerArg,
    comment: v.optional(v.string()),
    // Aérogommage
    items: v.optional(v.array(aerogommageItem)),
    aerogommageOptions: v.optional(aerogommageOptionsArg),
    // Collecte
    collecteDetails: v.optional(
      v.object({
        dismountable: v.optional(v.boolean()),
        reusableGoodCondition: v.optional(v.boolean()),
        sorted: v.optional(v.boolean()),
        noWaste: v.optional(v.boolean()),
        objectCategories: v.optional(v.array(v.string())),
        categoryPhotos: v.optional(
          v.array(
            v.object({
              category: v.string(),
              photos: v.array(v.id("_storage")),
            }),
          ),
        ),
        grosObjets: v.optional(v.array(v.string())),
        grosObjetsAutre: v.optional(v.string()),
        petitsObjets: v.optional(v.array(v.string())),
        petitsObjetsAutre: v.optional(v.string()),
        housingType: v.optional(v.string()),
        floors: v.optional(v.number()),
        dedicatedParking: v.optional(v.boolean()),
        parkingDistance: v.optional(v.number()),
        parkingUnknown: v.optional(v.boolean()),
        collectAddress: v.optional(
          v.object({
            address: v.optional(v.string()),
            postalCode: v.optional(v.string()),
            city: v.optional(v.string()),
          }),
        ),
      }),
    ),
    // Article
    articleId: v.optional(v.id("articles")),
    // Livraison
    livraisonDetails: v.optional(
      v.object({
        deliveryAddress: v.optional(addressArg),
        sameAsBilling: v.optional(v.boolean()),
        articlePhoto: v.optional(v.id("_storage")),
        referencePhoto: v.optional(v.id("_storage")),
        articleTitle: v.optional(v.string()),
        category: v.optional(v.string()),
        subcategory: v.optional(v.string()),
        condition: v.optional(v.string()),
        reference: v.optional(v.string()),
        referenceFromBarcode: v.optional(v.boolean()),
        articlePrice: v.optional(v.number()),
        acompte: v.optional(v.number()),
        distanceKm: v.optional(v.number()),
        deliveryFee: v.optional(v.number()),
        suggestedSlot: v.optional(
          v.object({
            requestReference: v.optional(v.string()),
            scheduledDate: v.optional(v.number()),
            distanceKm: v.optional(v.number()),
            city: v.optional(v.string()),
            discount: v.optional(v.number()),
            reducedDeliveryFee: v.optional(v.number()),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "demandes", "create");
    args = { ...args, customer: normalizeCustomer(args.customer) };
    const now = Date.now();
    const reference = await generateReference(ctx);
    const name = customerFullName(args.customer);

    if (args.type === "aerogommage") {
      const items = args.items ?? [];
      const id = await ctx.db.insert("requests", {
        type: "aerogommage",
        stage: "nouveau",
        outcome: "open",
        requestOrigin: "internal",
        complete: isAerogommageComplete(args.customer, items),
        processSteps: resolveProcess("aerogommage"),
        completedSteps: 0,
        site: "60",
        customer: args.customer,
        comment: args.comment,
        photos: [],
        aerogommage: items,
        aerogommageOptions: args.aerogommageOptions,
        createdAt: now,
        updatedAt: now,
        reference,
      });
      await createNewRequestNotification(ctx, { requestId: id, requestType: "aerogommage", customerName: name });
      return id;
    }

    if (args.type === "collecte") {
      const details = args.collecteDetails ?? {};
      const id = await ctx.db.insert("requests", {
        type: "collecte",
        stage: "nouveau",
        outcome: "open",
        requestOrigin: "internal",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        complete: isCollecteComplete(args.customer, details as any),
        collecteType: "indefini",
        processSteps: resolveProcess("collecte", "indefini"),
        completedSteps: 0,
        customer: args.customer,
        comment: args.comment,
        photos: [],
        collecte: details,
        createdAt: now,
        updatedAt: now,
        reference,
      });
      await createNewRequestNotification(ctx, { requestId: id, requestType: "collecte", customerName: name });
      return id;
    }

    if (args.type === "article") {
      const articleId = args.articleId;
      if (!articleId) throw new Error("articleId requis pour une demande boutique.");
      const article = await ctx.db.get(articleId);
      if (!article) throw new Error("Article introuvable.");
      if (article.status !== "disponible") throw new Error("Cet article n'est plus disponible.");
      await ctx.db.patch(articleId, { status: "reserve" });
      await scheduleStripeSync(ctx, articleId);
      const id = await ctx.db.insert("requests", {
        type: "article",
        stage: "nouveau",
        outcome: "open",
        requestOrigin: "internal",
        complete: isArticleComplete(args.customer),
        processSteps: resolveProcess("article"),
        completedSteps: 0,
        customer: args.customer,
        comment: args.comment,
        photos: [],
        article: { articleId, articleTitle: article.title },
        articles: [{ articleId, articleTitle: article.title }],
        createdAt: now,
        updatedAt: now,
        reference,
      });
      await createNewRequestNotification(ctx, { requestId: id, requestType: "article", customerName: name });
      return id;
    }

    if (args.type === "livraison") {
      const details = args.livraisonDetails ?? {};
      const photos = [details.articlePhoto, details.referencePhoto].filter(
        (p): p is Id<"_storage"> => Boolean(p),
      );
      const id = await ctx.db.insert("requests", {
        type: "livraison",
        stage: "nouveau",
        outcome: "open",
        requestOrigin: "internal",
        complete: isLivraisonComplete(args.customer, details),
        processSteps: resolveProcess("livraison"),
        completedSteps: 0,
        customer: args.customer,
        comment: args.comment,
        photos,
        livraison: details,
        createdAt: now,
        updatedAt: now,
        reference,
      });
      await createNewRequestNotification(ctx, { requestId: id, requestType: "livraison", customerName: name });
      return id;
    }

    throw new Error("Type de demande non pris en charge.");
  },
});

/** Demandes planifiées sur une période (pour le calendrier). */
export const scheduled = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    await requireCrmPermission(ctx, "calendrier", "read");
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_scheduledDate", (q) =>
        q.gte("scheduledDate", from).lte("scheduledDate", to),
      )
      .collect();
    return requests
      .filter((request) => request.type !== "depot")
      .map((request) => ({
        ...request,
        customer: normalizeCustomer(request.customer),
      }));
  },
});

/**
 * Rendez-vous de dépôt d'une période, pour l'onglet « Dépôts » du calendrier.
 *
 * Requête séparée de `scheduled` : les dépôts sont volontairement absents du
 * tableau et du calendrier des demandes, et ont leur propre vue.
 */
export const scheduledDepots = query({
  args: {
    from: v.number(),
    to: v.number(),
    /** Restreint à une recyclerie ; absent = les deux. */
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
  },
  handler: async (ctx, { from, to, site }) => {
    await requireCrmPermission(ctx, "calendrier", "read");
    const depots = await ctx.db
      .query("requests")
      .withIndex("by_type", (q) => q.eq("type", "depot"))
      .collect();
    return depots
      .filter((request) => {
        if (site && request.depot?.site !== site) return false;
        const slotStart = request.depot?.slotStart ?? 0;
        return slotStart >= from && slotStart <= to;
      })
      .sort((a, b) => (a.depot?.slotStart ?? 0) - (b.depot?.slotStart ?? 0))
      .map((request) => ({
        ...request,
        customer: normalizeCustomer(request.customer),
      }));
  },
});

/**
 * Demandes dont la facture est éditée et dont l'étape suivante est
 * « Facture réglée » — c.-à-d. les factures en attente de règlement.
 */
type PendingInvoice = {
  reference: string;
  type: string;
  customerName: string;
  amount?: number;
  requestId: string;
};

export const pendingInvoices = internalQuery({
  args: {},
  handler: async (ctx): Promise<PendingInvoice[]> => {
    const all = await ctx.db.query("requests").collect();
    return all
      .filter(
        (r) =>
          r.outcome === "open" &&
          isAwaitingInvoicePayment(r.processSteps ?? [], r.completedSteps ?? 0),
      )
      .map((r) => ({
        reference: r.reference ?? String(r._id).slice(-6),
        type: r.type,
        customerName:
          customerFullName(normalizeCustomer(r.customer)) || "Client inconnu",
        amount: r.quoteAmount,
        requestId: String(r._id),
      }));
  },
});

/**
 * Envoie à la compta le récapitulatif des factures en attente de règlement.
 * Déclenchable à la main (`npx convex run requests:sendPendingInvoicesDigest`)
 * pour remettre la liste à jour sur les demandes déjà en cours.
 */
export const sendPendingInvoicesDigest = internalAction({
  args: {},
  handler: async (ctx): Promise<{ count: number }> => {
    const requests: PendingInvoice[] = await ctx.runQuery(
      internal.requests.pendingInvoices,
      {},
    );
    await ctx.runAction(internal.emails.sendInvoicePendingDigest, { requests });
    return { count: requests.length };
  },
});

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireAnyCrmPermission } from "./lib";

const bikeStatus = v.union(
  v.literal("inactive"),
  v.literal("available"),
  v.literal("purchase_pending"),
  v.literal("sold"),
  // Anciennes valeurs conservées pour lecture/migration douce.
  v.literal("waiting"),
  v.literal("online"),
  v.literal("draft"),
  v.literal("atelier"),
  v.literal("ready"),
  v.literal("reserved"),
  v.literal("archived"),
);

const publicBikeStatus = v.union(
  v.literal("inactive"),
  v.literal("available"),
  v.literal("purchase_pending"),
  v.literal("sold"),
);

const pipelineStatus = v.union(
  v.literal("nouveau"),
  v.literal("validation"),
  v.literal("en_cours"),
  v.literal("gagnee"),
  v.literal("perdue"),
);

const site = v.union(v.literal("60"), v.literal("76"));

const bikePayload = {
  photos: v.array(v.id("_storage")),
  description: v.string(),
  site,
  gdrReference: v.optional(v.string()),
  category: v.string(),
  condition: v.string(),
  status: publicBikeStatus,
  price: v.optional(v.number()),
  profile: v.optional(v.string()),
  useMode: v.optional(v.union(v.literal("purchase"), v.literal("rental"))),
};

type Bike = Doc<"bikes">;
type BikePayload = {
  photos: Id<"_storage">[];
  description: string;
  site: "60" | "76";
  gdrReference?: string;
  category: string;
  condition: string;
  status: "inactive" | "available" | "purchase_pending" | "sold";
  price?: number;
  profile?: string;
  useMode?: "purchase" | "rental";
};

function cleanText(value?: string) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function normalizePrice(value?: number) {
  if (value === undefined || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.round(value * 100) / 100);
}

function titleFor(args: Pick<BikePayload, "category" | "profile" | "gdrReference">) {
  return [args.category, args.profile]
    .filter(Boolean)
    .join(" · ");
}

function normalizeBike(args: BikePayload) {
  const gdrReference = cleanText(args.gdrReference);
  if (gdrReference && !/^\d{15}$/.test(gdrReference)) {
    throw new Error("La REF GDR doit contenir exactement 15 chiffres.");
  }

  return {
    photos: args.photos,
    title: titleFor({ ...args, gdrReference }),
    description: args.description.trim(),
    site: args.site,
    gdrReference,
    category: args.category.trim(),
    condition: args.condition.trim(),
    useMode: args.useMode ?? "purchase",
    status: args.status,
    price: args.useMode === "rental" ? undefined : normalizePrice(args.price),
    sizeLabel: cleanText(args.profile),
    updatedAt: Date.now(),
  };
}

async function withPhotoUrls(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  bike: Bike,
) {
  const photoUrls = await Promise.all(bike.photos.map((id) => ctx.storage.getUrl(id)));
  return { ...bike, photoUrls: photoUrls.filter((url): url is string => Boolean(url)) };
}

function matchesSearch(bike: Bike, search?: string) {
  const needle = search?.trim().toLowerCase();
  if (!needle) return true;
  return [
    bike.title,
    bike.description,
    bike.category,
    bike.condition,
    bike.gdrReference,
    bike.sizeLabel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function visibleInShop(bike: Bike) {
  return bike.status === "available" || bike.status === "purchase_pending" || bike.status === "online";
}

export const list = query({
  args: {
    searchText: v.optional(v.string()),
    status: v.optional(bikeStatus),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
  },
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [["cycle:stock", "read"], ["recycapp:articles", "read"], ["articles", "read"]]);
    const bikes = args.status
      ? await ctx.db.query("bikes").withIndex("by_status", (q) => q.eq("status", args.status!)).order("desc").collect()
      : await ctx.db.query("bikes").order("desc").collect();
    const filtered = bikes
      .filter((bike) => !args.site || bike.site === args.site)
      .filter((bike) => matchesSearch(bike, args.searchText));
    return Promise.all(filtered.map((bike) => withPhotoUrls(ctx, bike)));
  },
});

export const listPublic = query({
  args: {
    searchText: v.optional(v.string()),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    category: v.optional(v.string()),
    profile: v.optional(v.string()),
    useMode: v.optional(v.union(v.literal("purchase"), v.literal("rental"))),
    maxPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const bikes = await ctx.db.query("bikes").order("desc").collect();
    const filtered = bikes
      .filter(visibleInShop)
      .filter((bike) => !args.site || bike.site === args.site)
      .filter((bike) => !args.category || bike.category === args.category)
      .filter((bike) => !args.profile || bike.sizeLabel === args.profile)
      .filter((bike) => !args.useMode || (bike.useMode ?? "purchase") === args.useMode)
      .filter((bike) => args.maxPrice === undefined || (bike.price ?? 0) <= args.maxPrice!)
      .filter((bike) => matchesSearch(bike, args.searchText));
    return Promise.all(filtered.map((bike) => withPhotoUrls(ctx, bike)));
  },
});

export const getPublic = query({
  args: { id: v.id("bikes") },
  handler: async (ctx, args) => {
    const bike = await ctx.db.get(args.id);
    if (!bike || !visibleInShop(bike)) return null;
    return withPhotoUrls(ctx, bike);
  },
});

export const create = mutation({
  args: bikePayload,
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [["cycle:stock", "create"], ["recycapp:articles", "create"], ["articles", "create"]]);
    const now = Date.now();
    return await ctx.db.insert("bikes", { ...normalizeBike(args), createdAt: now, updatedAt: now });
  },
});

export const update = mutation({
  args: { id: v.id("bikes"), ...bikePayload },
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [["cycle:stock", "update"], ["recycapp:articles", "update"], ["articles", "update"]]);
    const { id, ...payload } = args;
    await ctx.db.patch(id, normalizeBike(payload));
  },
});

export const updateStatus = mutation({
  args: { id: v.id("bikes"), status: publicBikeStatus },
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [["cycle:stock", "update"], ["recycapp:articles", "update"], ["articles", "update"]]);
    await ctx.db.patch(args.id, { status: args.status, updatedAt: Date.now() });
  },
});

export const photoUrls = query({
  args: { ids: v.array(v.id("_storage")) },
  handler: async (ctx, args) => {
    const urls = await Promise.all(args.ids.map((id) => ctx.storage.getUrl(id)));
    return urls;
  },
});

const customerPayload = {
  firstName: v.string(),
  lastName: v.string(),
  email: v.string(),
  phone: v.string(),
  message: v.optional(v.string()),
};

const reebikePayload = {
  desiredAt: v.string(),
  duration: v.optional(v.string()),
  formula: v.string(),
  frontBrake: v.string(),
  bikeType: v.string(),
  wheelSize: v.string(),
  compatibilityPhotos: v.optional(v.array(v.id("_storage"))),
};

async function upsertCycleCustomer(
  ctx: MutationCtx,
  args: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  },
) {
  const email = args.email.trim().toLowerCase();
  const now = Date.now();
  let customer = await ctx.db
    .query("cycleCustomers")
    .withIndex("by_email", (q) => q.eq("email", email))
    .unique();

  if (!customer) {
    const customerId = await ctx.db.insert("cycleCustomers", {
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      email,
      phone: args.phone.trim(),
      createdAt: now,
      updatedAt: now,
    });
    customer = await ctx.db.get(customerId);
  } else {
    await ctx.db.patch(customer._id, {
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      phone: args.phone.trim(),
      updatedAt: now,
    });
  }

  if (!customer) throw new Error("Client introuvable.");
  return { customer, email, now };
}

export const remove = mutation({
  args: { id: v.id("bikes") },
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [["cycle:stock", "delete"], ["recycapp:articles", "delete"], ["articles", "delete"]]);
    await ctx.db.delete(args.id);
  },
});

export const reserveBike = mutation({
  args: {
    bikeId: v.id("bikes"),
    ...customerPayload,
    rentalStart: v.optional(v.string()),
    rentalEnd: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const bike = await ctx.db.get(args.bikeId);
    if (!bike || !visibleInShop(bike)) throw new Error("Ce vélo n'est plus disponible.");
    if (bike.status === "purchase_pending" || bike.status === "waiting" || bike.status === "reserved") {
      throw new Error("Ce vélo est déjà réservé.");
    }

    const { customer, email, now } = await upsertCycleCustomer(ctx, args);

    const requestId = await ctx.db.insert("cycleRequests", {
      requestKind: "reservation",
      bikeId: bike._id,
      bikeTitle: bike.title,
      bikeGdrReference: bike.gdrReference,
      customerId: customer._id,
      customer: {
        firstName: args.firstName.trim(),
        lastName: args.lastName.trim(),
        email,
        phone: args.phone.trim(),
        message: cleanText(args.message),
      },
      reservation: {
        rentalStart: cleanText(args.rentalStart),
        rentalEnd: cleanText(args.rentalEnd),
      },
      rental:
        cleanText(args.rentalStart) && cleanText(args.rentalEnd)
          ? { startDate: cleanText(args.rentalStart)!, endDate: cleanText(args.rentalEnd)! }
          : undefined,
      pipelineStatus: "nouveau",
      processStep: 0,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(bike._id, { status: "purchase_pending", updatedAt: now });
    return requestId;
  },
});

export const submitReebike = mutation({
  args: {
    customer: v.object(customerPayload),
    reebike: v.object(reebikePayload),
  },
  handler: async (ctx, args) => {
    const { customer, email, now } = await upsertCycleCustomer(ctx, args.customer);
    return await ctx.db.insert("cycleRequests", {
      requestKind: "reebike",
      bikeTitle: "Demande Reebike",
      customerId: customer._id,
      customer: {
        firstName: args.customer.firstName.trim(),
        lastName: args.customer.lastName.trim(),
        email,
        phone: args.customer.phone.trim(),
        message: cleanText(args.customer.message),
      },
      reebike: {
        desiredAt: args.reebike.desiredAt,
        duration: cleanText(args.reebike.duration),
        formula: args.reebike.formula,
        frontBrake: args.reebike.frontBrake,
        bikeType: args.reebike.bikeType,
        wheelSize: args.reebike.wheelSize,
        compatibilityPhotos: args.reebike.compatibilityPhotos ?? [],
      },
      pipelineStatus: "nouveau",
      processStep: 0,
      management: {},
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const submitRepair = mutation({
  args: {
    customer: v.object(customerPayload),
  },
  handler: async (ctx, args) => {
    const { customer, email, now } = await upsertCycleCustomer(ctx, args.customer);
    return await ctx.db.insert("cycleRequests", {
      requestKind: "repair",
      bikeTitle: "Demande de réparation",
      customerId: customer._id,
      customer: {
        firstName: args.customer.firstName.trim(),
        lastName: args.customer.lastName.trim(),
        email,
        phone: args.customer.phone.trim(),
        message: cleanText(args.customer.message),
      },
      pipelineStatus: "nouveau",
      processStep: 0,
      management: {},
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listRequests = query({
  args: {},
  handler: async (ctx) => {
    await requireAnyCrmPermission(ctx, [["cycle:stock", "read"], ["recycapp:articles", "read"], ["articles", "read"]]);
    const requests = await ctx.db.query("cycleRequests").order("desc").collect();
    return Promise.all(
      requests.map(async (request) => {
        const bike = request.bikeId ? await ctx.db.get(request.bikeId) : null;
        return {
          ...request,
          bike: bike ? await withPhotoUrls(ctx, bike) : null,
        };
      }),
    );
  },
});

export const updateRequest = mutation({
  args: {
    id: v.id("cycleRequests"),
    actorName: v.optional(v.string()),
    customer: v.optional(v.object(customerPayload)),
    reebike: v.optional(v.object(reebikePayload)),
    management: v.optional(v.object({
      site: v.optional(site),
      assignedTo: v.optional(v.string()),
      notes: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [["cycle:stock", "update"], ["recycapp:articles", "update"], ["articles", "update"]]);
    const request = await ctx.db.get(args.id);
    if (!request) throw new Error("Demande introuvable.");
    const patch: Partial<Doc<"cycleRequests">> = { updatedAt: Date.now() };

    if (args.customer) {
      const email = args.customer.email.trim().toLowerCase();
      patch.customer = {
        firstName: args.customer.firstName.trim(),
        lastName: args.customer.lastName.trim(),
        email,
        phone: args.customer.phone.trim(),
        message: cleanText(args.customer.message),
      };
      await ctx.db.patch(request.customerId, {
        firstName: args.customer.firstName.trim(),
        lastName: args.customer.lastName.trim(),
        email,
        phone: args.customer.phone.trim(),
        updatedAt: Date.now(),
      });
      patch.fieldEdits = {
        ...(request.fieldEdits ?? {}),
        customer: args.actorName
          ? { by: args.actorName.trim(), at: Date.now() }
          : request.fieldEdits?.customer,
      };
    }

    if (args.reebike) {
      patch.reebike = {
        desiredAt: args.reebike.desiredAt,
        duration: cleanText(args.reebike.duration),
        formula: args.reebike.formula,
        frontBrake: args.reebike.frontBrake,
        bikeType: args.reebike.bikeType,
        wheelSize: args.reebike.wheelSize,
        compatibilityPhotos: args.reebike.compatibilityPhotos ?? [],
      };
      patch.fieldEdits = {
        ...(patch.fieldEdits ?? request.fieldEdits ?? {}),
        reebike: args.actorName
          ? { by: args.actorName.trim(), at: Date.now() }
          : request.fieldEdits?.reebike,
      };
    }

    if (args.management) {
      patch.management = {
        site: args.management.site,
        assignedTo: cleanText(args.management.assignedTo),
        notes: cleanText(args.management.notes),
      };
      patch.fieldEdits = {
        ...(patch.fieldEdits ?? request.fieldEdits ?? {}),
        management: args.actorName
          ? { by: args.actorName.trim(), at: Date.now() }
          : request.fieldEdits?.management,
      };
    }

    await ctx.db.patch(args.id, patch);
  },
});

export const updateRequestPipeline = mutation({
  args: {
    id: v.id("cycleRequests"),
    pipelineStatus,
    processStep: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [["cycle:stock", "update"], ["recycapp:articles", "update"], ["articles", "update"]]);
    const identity = await ctx.auth.getUserIdentity();
    const request = await ctx.db.get(args.id);
    if (!request) throw new Error("Demande introuvable.");
    const processStep =
      args.processStep === undefined ? request.processStep : Math.max(0, Math.min(5, Math.floor(args.processStep)));
    await ctx.db.patch(args.id, {
      pipelineStatus: args.pipelineStatus,
      processStep,
      processLog:
        args.processStep === undefined
          ? request.processLog
          : [
              ...(request.processLog ?? []),
              {
                step: processStep,
                by: identity?.email ?? identity?.name ?? "Equipe",
                at: Date.now(),
              },
            ],
      updatedAt: Date.now(),
    });
  },
});

type LegacyBike = {
  Categorie?: string;
  Description?: string;
  Etat?: string;
  Prix?: string;
  Profil?: string;
  REF_GDR?: string;
  Site_traitement?: string;
  "Sous-categorie"?: string;
  Statut?: string;
};

function statusFromLegacy(value?: string): BikePayload["status"] {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "vendu") return "sold";
  if (normalized === "disponible") return "available";
  if (normalized === "achat en cours" || normalized === "achat_en_cours" || normalized === "reserve") {
    return "purchase_pending";
  }
  return "inactive";
}

function siteFromLegacy(value?: string): "60" | "76" {
  // Bubble ids fournis : le premier lot correspond au site 60, le second au site 76.
  return value === "1774275714764x355210632634661800" ? "76" : "60";
}

function normalizeGdr(value?: string) {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  if (raw.includes("e+")) {
    const parsed = Number(raw.replace(",", "."));
    if (Number.isFinite(parsed)) {
      const digits = String(Math.round(parsed));
      return digits.length === 16 && digits.endsWith("0") ? digits.slice(0, 15) : digits;
    }
  }
  const digits = raw.replace(/\D/g, "");
  return digits.length === 16 && digits.endsWith("0") ? digits.slice(0, 15) : digits;
}

export const importLegacy = mutation({
  args: { rows: v.array(v.any()) },
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [["cycle:stock", "create"], ["recycapp:articles", "create"], ["articles", "create"]]);
    const now = Date.now();
    let created = 0;
    let updated = 0;

    for (const rawRow of args.rows) {
      const row = rawRow as LegacyBike;
      const gdrReference = normalizeGdr(row.REF_GDR);
      const payload = normalizeBike({
        photos: [],
        description: row.Description?.trim() || "Vélo Cycle en Bray",
        site: siteFromLegacy(row.Site_traitement),
        gdrReference,
        category: row["Sous-categorie"]?.trim() || row.Categorie?.trim() || "Vélo",
        condition: row.Etat?.trim() || "Bon état",
        status: statusFromLegacy(row.Statut),
        price: row.Prix ? Number(row.Prix.replace(",", ".")) : undefined,
        profile: row.Profil?.trim() || undefined,
      });

      const existing = gdrReference
        ? await ctx.db
            .query("bikes")
            .withIndex("by_gdrReference", (q) => q.eq("gdrReference", gdrReference))
            .unique()
        : null;

      if (existing) {
        await ctx.db.patch(existing._id, payload);
        updated += 1;
      } else {
        await ctx.db.insert("bikes", { ...payload, createdAt: now, updatedAt: now });
        created += 1;
      }
    }

    return { created, updated };
  },
});

import {
  action,
  env,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { accessAllows, livePhotosByClerkId, requireCrmPermission, requireUser } from "./lib";
import { bytesToBase64, resendSend, storageImageUrl, type EmailAttachment } from "./emails";
import { bpBilling, bpCompanyType, bpMaterial, bpUnit } from "./schema";
import { resolveActingProfile } from "./bennesproProfiles";

/* ─── Entreprises ─────────────────────────────────────────────────────────── */

export type ComplianceStatus = "validated" | "pending" | "missing";

/**
 * Statut des documents obligatoires : « validated » si le staff a coché
 * « Signé » (flag sur l'entreprise), sinon « pending » si un document du type
 * a été déposé (client ou staff), sinon « missing ».
 */
async function companyCompliance(
  ctx: QueryCtx | MutationCtx,
  company: Doc<"bpCompanies">,
): Promise<{ convention: ComplianceStatus; protocole: ComplianceStatus }> {
  const docs = await ctx.db
    .query("bpCompanyDocuments")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .collect();
  const statusFor = (
    type: "convention" | "protocole",
    signedAt: number | undefined,
  ): ComplianceStatus => {
    if (signedAt !== undefined) return "validated";
    if (docs.some((d) => d.docType === type)) return "pending";
    return "missing";
  };
  return {
    convention: statusFor("convention", company.conventionSignedAt),
    protocole: statusFor("protocole", company.protocoleSignedAt),
  };
}

export const listCompanies = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "read");
    const companies = await ctx.db.query("bpCompanies").order("desc").collect();
    const sorted = companies.sort((a, b) => a.name.localeCompare(b.name, "fr"));
    return Promise.all(
      sorted.map(async (c) => ({ ...c, compliance: await companyCompliance(ctx, c) })),
    );
  },
});

export const getCompany = query({
  args: { companyId: v.id("bpCompanies") },
  handler: async (ctx, { companyId }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "read");
    const company = await ctx.db.get(companyId);
    if (!company) return null;
    const vehicles = await ctx.db
      .query("bpVehicles")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const vehicleLabels = new Map(vehicles.map((vehicle) => [vehicle._id, vehicle.label]));
    const depots = await ctx.db
      .query("bpDepots")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .order("desc")
      .collect();
    return {
      ...company,
      compliance: await companyCompliance(ctx, company),
      vehicles,
      depots: depots.map((depot) => ({
        ...depot,
        vehicleLabel: vehicleLabels.get(depot.vehicleId) ?? "—",
      })),
    };
  },
});

export const createCompany = mutation({
  args: {
    name: v.string(),
    siret: v.optional(v.string()),
    address: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    billingEmail: v.optional(v.string()),
    companyType: v.optional(bpCompanyType),
    companyTypeOther: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "create");
    return await ctx.db.insert("bpCompanies", {
      ...args,
      name: args.name.trim(),
      createdAt: Date.now(),
    });
  },
});

export const updateCompany = mutation({
  args: {
    companyId: v.id("bpCompanies"),
    name: v.string(),
    siret: v.optional(v.string()),
    address: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    billingEmail: v.optional(v.string()),
    companyType: v.optional(bpCompanyType),
    companyTypeOther: v.optional(v.string()),
  },
  handler: async (ctx, { companyId, ...patch }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "update");
    await ctx.db.patch(companyId, { ...patch, name: patch.name.trim() });
  },
});

/* ─── Documents & messagerie : validateurs & sérialisation ────────────────── */

const bpDocType = v.union(
  v.literal("kbis"),
  v.literal("rib"),
  v.literal("assurance"),
  v.literal("convention"),
  v.literal("protocole"),
  v.literal("autre"),
);

/**
 * Cherche une entreprise « adoptable » (sans compte client) dont l'email de
 * contact ou de facturation correspond à l'un des emails fournis. Sert à
 * rattacher automatiquement les dépôts existants au nouveau compte client.
 */
async function findAdoptableCompanyByEmail(
  ctx: QueryCtx | MutationCtx,
  emails: Array<string | undefined | null>,
): Promise<Doc<"bpCompanies"> | null> {
  const set = new Set(
    emails.map((e) => e?.trim().toLowerCase()).filter((e): e is string => !!e),
  );
  if (set.size === 0) return null;
  const companies = await ctx.db.query("bpCompanies").collect();
  return (
    companies.find(
      (c) =>
        !c.ownerUserId &&
        [c.contactEmail, c.billingEmail].some((e) => e && set.has(e.trim().toLowerCase())),
    ) ?? null
  );
}

function serializeBpMessage(
  m: Doc<"bpCompanyMessages">,
  senderImageUrl: string | null = null,
) {
  return {
    _id: m._id,
    senderRole: m.senderRole,
    senderName: m.senderName,
    senderImageUrl,
    body: m.body,
    createdAt: m.createdAt,
    readByClientAt: m.readByClientAt ?? null,
    readByStaffAt: m.readByStaffAt ?? null,
  };
}

/** Sérialise une liste de messages en résolvant les photos de profil (par lot). */
async function serializeBpMessages(
  ctx: QueryCtx | MutationCtx,
  messages: Doc<"bpCompanyMessages">[],
) {
  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  const photos = await livePhotosByClerkId(ctx, sorted.map((m) => m.senderClerkId));
  return sorted.map((m) =>
    serializeBpMessage(m, m.senderClerkId ? photos.get(m.senderClerkId) ?? null : null),
  );
}

/* ─── Espace client (portail public) ──────────────────────────────────────── */

/** Entreprise rattachée au compte client courant (ou null). */
export const getMyCompany = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    return await ctx.db
      .query("bpCompanies")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", identity.subject))
      .first();
  },
});

/**
 * Rattache automatiquement une entreprise existante (créée par le staff, sans
 * compte) au client courant si son email correspond — récupère ainsi ses dépôts.
 * Idempotent : sans correspondance, ne fait rien.
 */
export const claimMyCompanyByEmail = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const owned = await ctx.db
      .query("bpCompanies")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", identity.subject))
      .first();
    if (owned) return owned._id;
    const match = await findAdoptableCompanyByEmail(ctx, [identity.email]);
    if (!match) return null;
    await ctx.db.patch(match._id, { ownerUserId: identity.subject });
    return match._id;
  },
});

/** Résout l'entreprise du client courant (ou lève une erreur). */
async function requireMyCompany(ctx: QueryCtx | MutationCtx) {
  const identity = await requireUser(ctx);
  const company = await ctx.db
    .query("bpCompanies")
    .withIndex("by_owner", (q) => q.eq("ownerUserId", identity.subject))
    .first();
  if (!company) throw new Error("Aucune entreprise associée à ce compte.");
  return { identity, company };
}

/** Crée (1re fois) ou met à jour l'entreprise du client courant. */
export const saveMyCompany = mutation({
  args: {
    name: v.string(),
    siret: v.optional(v.string()),
    address: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    billingEmail: v.optional(v.string()),
    companyType: v.optional(bpCompanyType),
    companyTypeOther: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireUser(ctx);
    const patch = { ...args, name: args.name.trim() };
    const existing = await ctx.db
      .query("bpCompanies")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", identity.subject))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    // Pas encore de compte : on tente de rattacher une entreprise existante
    // (créée par le staff) via l'email, pour récupérer ses dépôts.
    const adoptable = await findAdoptableCompanyByEmail(ctx, [
      args.contactEmail,
      args.billingEmail,
      identity.email,
    ]);
    if (adoptable) {
      await ctx.db.patch(adoptable._id, { ...patch, ownerUserId: identity.subject });
      return adoptable._id;
    }
    return await ctx.db.insert("bpCompanies", {
      ...patch,
      ownerUserId: identity.subject,
      contactEmail: args.contactEmail ?? identity.email ?? undefined,
      createdAt: Date.now(),
    });
  },
});

/** Dépôts de l'entreprise cliente (avec de quoi générer le bon de dépôt + facture). */
export const listMyDepots = query({
  args: {},
  handler: async (ctx) => {
    const { company } = await requireMyCompany(ctx);
    const depots = await ctx.db
      .query("bpDepots")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .order("desc")
      .collect();
    return Promise.all(
      depots.map(async (depot) => {
        const vehicle = await ctx.db.get(depot.vehicleId);
        const signatureUrl = depot.signature
          ? await ctx.storage.getUrl(depot.signature)
          : null;
        return { ...depot, company, vehicle, signatureUrl };
      }),
    );
  },
});

/** Documents visibles côté client (ses uploads + docs partagés par le staff). */
export const listMyDocuments = query({
  args: {},
  handler: async (ctx) => {
    const { company } = await requireMyCompany(ctx);
    const docs = await ctx.db
      .query("bpCompanyDocuments")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .collect();
    return Promise.all(
      docs
        .filter((d) => d.uploadedByRole === "client" || d.sharedWithClientAt !== undefined)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (d) => ({
          _id: d._id,
          name: d.name,
          docType: d.docType,
          mimeType: d.mimeType ?? null,
          uploadedByRole: d.uploadedByRole,
          validated: d.validatedAt !== undefined,
          validatedAt: d.validatedAt ?? null,
          createdAt: d.createdAt,
          url: await ctx.storage.getUrl(d.storageId),
        })),
    );
  },
});

/** Le client dépose un document (KBIS, RIB…). */
export const addMyDocument = mutation({
  args: {
    storageId: v.id("_storage"),
    name: v.string(),
    docType: bpDocType,
    mimeType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { company } = await requireMyCompany(ctx);
    return await ctx.db.insert("bpCompanyDocuments", {
      companyId: company._id,
      storageId: args.storageId,
      name: args.name.trim(),
      docType: args.docType,
      mimeType: args.mimeType,
      uploadedByRole: "client",
      createdAt: Date.now(),
    });
  },
});

export const listMyMessages = query({
  args: {},
  handler: async (ctx) => {
    const { company } = await requireMyCompany(ctx);
    const msgs = await ctx.db
      .query("bpCompanyMessages")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .collect();
    return serializeBpMessages(ctx, msgs);
  },
});

export const sendMyMessage = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const trimmed = body.trim();
    if (!trimmed) throw new Error("Message vide.");
    const { identity, company } = await requireMyCompany(ctx);
    await ctx.db.insert("bpCompanyMessages", {
      companyId: company._id,
      senderRole: "client",
      senderName: identity.name ?? company.contactName ?? company.name,
      senderClerkId: identity.subject,
      body: trimmed,
      createdAt: Date.now(),
    });
  },
});

export const markMyMessagesRead = mutation({
  args: {},
  handler: async (ctx) => {
    const { company } = await requireMyCompany(ctx);
    const msgs = await ctx.db
      .query("bpCompanyMessages")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .collect();
    const now = Date.now();
    await Promise.all(
      msgs
        .filter((m) => m.senderRole === "staff" && m.readByClientAt === undefined)
        .map((m) => ctx.db.patch(m._id, { readByClientAt: now })),
    );
  },
});

/* ─── Documents & messagerie côté CRM (staff) ─────────────────────────────── */

export const listCompanyDocuments = query({
  args: { companyId: v.id("bpCompanies") },
  handler: async (ctx, { companyId }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "read");
    const docs = await ctx.db
      .query("bpCompanyDocuments")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    return Promise.all(
      docs
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (d) => ({
          _id: d._id,
          name: d.name,
          docType: d.docType,
          note: d.note ?? null,
          mimeType: d.mimeType ?? null,
          uploadedByRole: d.uploadedByRole,
          sharedWithClientAt: d.sharedWithClientAt ?? null,
          validated: d.validatedAt !== undefined,
          validatedAt: d.validatedAt ?? null,
          createdAt: d.createdAt,
          url: await ctx.storage.getUrl(d.storageId),
        })),
    );
  },
});

/** État de conformité (statuts + flags « Signé ») pour l'onglet Documents CRM. */
export const companyComplianceState = query({
  args: { companyId: v.id("bpCompanies") },
  handler: async (ctx, { companyId }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "read");
    const company = await ctx.db.get(companyId);
    if (!company) return null;
    const compliance = await companyCompliance(ctx, company);
    return {
      convention: compliance.convention,
      protocole: compliance.protocole,
      conventionSigned: company.conventionSignedAt !== undefined,
      protocoleSigned: company.protocoleSignedAt !== undefined,
    };
  },
});

/** Le staff marque un document obligatoire comme « Signé » (ou l'annule). */
export const setComplianceSigned = mutation({
  args: {
    companyId: v.id("bpCompanies"),
    type: v.union(v.literal("convention"), v.literal("protocole")),
    signed: v.boolean(),
  },
  handler: async (ctx, { companyId, type, signed }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "update");
    const field = type === "convention" ? "conventionSignedAt" : "protocoleSignedAt";
    await ctx.db.patch(companyId, { [field]: signed ? Date.now() : undefined });
  },
});

/** Le staff valide un document signé (convention, protocole…). */
export const validateCompanyDocument = mutation({
  args: { documentId: v.id("bpCompanyDocuments"), validated: v.boolean() },
  handler: async (ctx, { documentId, validated }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "update");
    const identity = await requireUser(ctx);
    await ctx.db.patch(documentId, {
      validatedAt: validated ? Date.now() : undefined,
      validatedBy: validated ? identity.email ?? undefined : undefined,
    });
  },
});

/** Le staff dépose un document destiné au client (partagé immédiatement). */
export const addCompanyDocument = mutation({
  args: {
    companyId: v.id("bpCompanies"),
    storageId: v.id("_storage"),
    name: v.string(),
    docType: v.optional(bpDocType),
    note: v.optional(v.string()),
    mimeType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "update");
    const identity = await requireUser(ctx);
    return await ctx.db.insert("bpCompanyDocuments", {
      companyId: args.companyId,
      storageId: args.storageId,
      name: args.name.trim(),
      docType: args.docType ?? "autre",
      note: args.note?.trim() || undefined,
      mimeType: args.mimeType,
      uploadedByRole: "staff",
      // Non partagé par défaut : le staff décide explicitement via shareCompanyDocument.
      sharedWithClientAt: undefined,
      createdBy: identity.email ?? undefined,
      createdAt: Date.now(),
    });
  },
});

/** Le staff partage (rend visible côté client) un document ajouté. */
export const shareCompanyDocument = mutation({
  args: { documentId: v.id("bpCompanyDocuments"), shared: v.boolean() },
  handler: async (ctx, { documentId, shared }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "update");
    await ctx.db.patch(documentId, { sharedWithClientAt: shared ? Date.now() : undefined });
  },
});

export const removeCompanyDocument = mutation({
  args: { documentId: v.id("bpCompanyDocuments") },
  handler: async (ctx, { documentId }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "delete");
    const doc = await ctx.db.get(documentId);
    if (!doc) return;
    await ctx.storage.delete(doc.storageId);
    await ctx.db.delete(documentId);
  },
});

export const listCompanyMessages = query({
  args: { companyId: v.id("bpCompanies") },
  handler: async (ctx, { companyId }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "read");
    const msgs = await ctx.db
      .query("bpCompanyMessages")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    return serializeBpMessages(ctx, msgs);
  },
});

export const sendCompanyMessage = mutation({
  args: { companyId: v.id("bpCompanies"), body: v.string() },
  handler: async (ctx, { companyId, body }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "update");
    const trimmed = body.trim();
    if (!trimmed) throw new Error("Message vide.");
    const identity = await requireUser(ctx);
    await ctx.db.insert("bpCompanyMessages", {
      companyId,
      senderRole: "staff",
      senderName: identity.name ?? "Déchet'Lab",
      senderClerkId: identity.subject,
      body: trimmed,
      createdAt: Date.now(),
    });
  },
});

export const markCompanyMessagesRead = mutation({
  args: { companyId: v.id("bpCompanies") },
  handler: async (ctx, { companyId }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "read");
    const msgs = await ctx.db
      .query("bpCompanyMessages")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const now = Date.now();
    await Promise.all(
      msgs
        .filter((m) => m.senderRole === "client" && m.readByStaffAt === undefined)
        .map((m) => ctx.db.patch(m._id, { readByStaffAt: now })),
    );
  },
});

/** Toutes les conversations clients (boîte de réception CRM), plus récentes d'abord. */
export const listAllConversations = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "read");
    const msgs = await ctx.db.query("bpCompanyMessages").collect();
    const byCompany = new Map<
      Id<"bpCompanies">,
      { last: Doc<"bpCompanyMessages">; unread: number }
    >();
    for (const m of msgs) {
      const agg = byCompany.get(m.companyId);
      const unread = m.senderRole === "client" && m.readByStaffAt === undefined ? 1 : 0;
      if (!agg) {
        byCompany.set(m.companyId, { last: m, unread });
      } else {
        if (m.createdAt > agg.last.createdAt) agg.last = m;
        agg.unread += unread;
      }
    }
    const result = await Promise.all(
      [...byCompany.entries()].map(async ([companyId, agg]) => {
        const company = await ctx.db.get(companyId);
        if (!company) return null;
        return {
          companyId,
          companyName: company.name,
          lastBody: agg.last.body,
          lastAt: agg.last.createdAt,
          lastRole: agg.last.senderRole,
          unread: agg.unread,
        };
      }),
    );
    return result
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.lastAt - a.lastAt);
  },
});

/* ─── Véhicules ───────────────────────────────────────────────────────────── */

export const listVehicles = query({
  args: { companyId: v.id("bpCompanies") },
  handler: async (ctx, { companyId }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "read");
    return await ctx.db
      .query("bpVehicles")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
  },
});

export const addVehicle = mutation({
  args: {
    companyId: v.id("bpCompanies"),
    label: v.string(),
    plate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "update");
    return await ctx.db.insert("bpVehicles", {
      ...args,
      label: args.label.trim(),
      createdAt: Date.now(),
    });
  },
});

export const updateVehicle = mutation({
  args: {
    vehicleId: v.id("bpVehicles"),
    label: v.string(),
    plate: v.optional(v.string()),
  },
  handler: async (ctx, { vehicleId, ...patch }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "update");
    await ctx.db.patch(vehicleId, { ...patch, label: patch.label.trim() });
  },
});

export const removeVehicle = mutation({
  args: { vehicleId: v.id("bpVehicles") },
  handler: async (ctx, { vehicleId }) => {
    await requireCrmPermission(ctx, "bennespro:entreprises", "delete");
    await ctx.db.delete(vehicleId);
  },
});

/* ─── Dépôts ──────────────────────────────────────────────────────────────── */

const depotItem = v.object({
  material: bpMaterial,
  unit: bpUnit,
  quantity: v.number(),
  siteRef: v.string(),
});

async function resolveStorageUrls(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  ids: Array<Id<"_storage"> | undefined>,
) {
  return Promise.all(ids.map((id) => (id ? ctx.storage.getUrl(id) : Promise.resolve(null))));
}

export const listDepots = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "bennespro:depots", "read");
    const depots = await ctx.db.query("bpDepots").order("desc").collect();
    return Promise.all(
      depots.map(async (depot) => {
        const company = await ctx.db.get(depot.companyId);
        const vehicle = await ctx.db.get(depot.vehicleId);
        return {
          ...depot,
          companyName: company?.name ?? "—",
          vehicleLabel: vehicle?.label ?? "—",
        };
      }),
    );
  },
});

export const getDepot = query({
  args: { depotId: v.id("bpDepots") },
  handler: async (ctx, { depotId }) => {
    await requireCrmPermission(ctx, "bennespro:depots", "read");
    const depot = await ctx.db.get(depotId);
    if (!depot) return null;
    const company = await ctx.db.get(depot.companyId);
    const vehicle = await ctx.db.get(depot.vehicleId);
    const [ticketUrl, truckExteriorUrl, truckInteriorUrl, signatureUrl] =
      await resolveStorageUrls(ctx, [
        depot.ticketPhoto,
        depot.truckExteriorPhoto,
        depot.truckInteriorPhoto,
        depot.signature,
      ]);
    const attachmentUrls = await Promise.all(
      depot.attachments.map((id) => ctx.storage.getUrl(id)),
    );
    return {
      ...depot,
      company,
      vehicle,
      ticketUrl,
      truckExteriorUrl,
      truckInteriorUrl,
      signatureUrl,
      attachmentUrls,
    };
  },
});

export const createDepot = mutation({
  args: {
    companyId: v.id("bpCompanies"),
    vehicleId: v.id("bpVehicles"),
    depositorName: v.string(),
    siteRef: v.string(),
    items: v.array(depotItem),
    ticketPhoto: v.optional(v.id("_storage")),
    truckExteriorPhoto: v.optional(v.id("_storage")),
    truckInteriorPhoto: v.optional(v.id("_storage")),
    attachments: v.array(v.id("_storage")),
    comment: v.optional(v.string()),
    signature: v.id("_storage"),
    /** Profil choisi à l'ouverture, sur un compte partagé par plusieurs personnes. */
    profileId: v.optional(v.id("bpProfiles")),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "bennespro:depots", "create");
    const identity = await requireUser(ctx);
    const { profileId, ...depotArgs } = args;
    const actingProfile = await resolveActingProfile(ctx, profileId);
    // Dernier numéro via l'index (évite de charger toute la table).
    const last = await ctx.db
      .query("bpDepots")
      .withIndex("by_number")
      .order("desc")
      .first();
    const depotNumber = (last?.depotNumber ?? 0) + 1;

    const billing = await buildBilling(ctx, args.items);

    const depotId = await ctx.db.insert("bpDepots", {
      ...depotArgs,
      depotNumber,
      billing,
      createdBy: identity.email ?? undefined,
      ...actingProfile,
      createdAt: Date.now(),
    });
    if (billing) {
      await ctx.scheduler.runAfter(0, internal.bennespro.invoiceDepotDib, { depotId });
    }
    return { depotId, depotNumber };
  },
});

/* ─── Matières payantes : réglages & facturation Stripe ───────────────────── */

/** Matières facturées au poids. */
const DIB_MATERIAL = "Tout venant/DIB non triés";
const WOOD_MATERIAL = "Bois";

/** Prix par défaut : 32 centimes d'euro le kilo. */
const DEFAULT_DIB_PRICE_CENTS_PER_KG = 32;
/** Prix du bois : 17 centimes d'euro le kilo. */
const WOOD_PRICE_CENTS_PER_KG = 17;
const DIB_VAT_RATE = 20;

const SETTINGS_KEY = "bennespro";

type DepotItems = Array<{ material: string; unit: string; quantity: number }>;

/** Poids facturable d'une matière en kg (m³ et unités exclus). */
function materialWeightKg(items: DepotItems, material: string): number {
  let kg = 0;
  for (const item of items) {
    if (item.material !== material) continue;
    if (item.unit === "kg") kg += item.quantity;
    else if (item.unit === "tonne") kg += item.quantity * 1000;
  }
  return Math.round(kg * 100) / 100;
}

async function buildBilling(ctx: QueryCtx | MutationCtx, items: DepotItems) {
  const dibPriceCentsPerKg = await readDibPrice(ctx);
  const billableItems = ([
    { material: DIB_MATERIAL, weightKg: materialWeightKg(items, DIB_MATERIAL), priceCentsPerKg: dibPriceCentsPerKg },
    { material: WOOD_MATERIAL, weightKg: materialWeightKg(items, WOOD_MATERIAL), priceCentsPerKg: WOOD_PRICE_CENTS_PER_KG },
  ] satisfies Array<{
    material: Infer<typeof bpMaterial>;
    weightKg: number;
    priceCentsPerKg: number;
  }>)
    .filter((item) => item.weightKg > 0)
    .map((item) => ({ ...item, amountCents: Math.round(item.weightKg * item.priceCentsPerKg) }));
  const amountCents = billableItems.reduce((sum, item) => sum + item.amountCents, 0);
  if (amountCents <= 0) return undefined;
  const weightKg = billableItems.reduce((sum, item) => sum + item.weightKg, 0);
  return {
    weightKg,
    // Compatibilité avec les dépôts historiques et les affichages existants.
    priceCentsPerKg: billableItems.length === 1 ? billableItems[0].priceCentsPerKg : amountCents / weightKg,
    amountCents,
    items: billableItems,
    vatRate: DIB_VAT_RATE,
    status: "pending" as const,
  };
}

async function readDibPrice(ctx: QueryCtx | MutationCtx): Promise<number> {
  const settings = await ctx.db
    .query("bpSettings")
    .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
    .unique();
  return settings?.dibPriceCentsPerKg ?? DEFAULT_DIB_PRICE_CENTS_PER_KG;
}

export const getDibSettings = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "bennespro:depots", "read");
    return {
      priceCentsPerKg: await readDibPrice(ctx),
      woodPriceCentsPerKg: WOOD_PRICE_CENTS_PER_KG,
      stripeConfigured: Boolean(env.BENNESPRO_STRIPE_SECRET_KEY),
    };
  },
});

export const setDibPrice = mutation({
  args: { priceCentsPerKg: v.number() },
  handler: async (ctx, { priceCentsPerKg }) => {
    await requireCrmPermission(ctx, "bennespro:depots", "update");
    const identity = await requireUser(ctx);
    if (!Number.isFinite(priceCentsPerKg) || priceCentsPerKg <= 0 || priceCentsPerKg > 100000) {
      throw new Error("Prix DIB invalide.");
    }
    const rounded = Math.round(priceCentsPerKg * 100) / 100;
    const settings = await ctx.db
      .query("bpSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
    if (settings) {
      await ctx.db.patch(settings._id, {
        dibPriceCentsPerKg: rounded,
        updatedAt: Date.now(),
        updatedBy: identity.email ?? undefined,
      });
    } else {
      await ctx.db.insert("bpSettings", {
        key: SETTINGS_KEY,
        dibPriceCentsPerKg: rounded,
        updatedAt: Date.now(),
        updatedBy: identity.email ?? undefined,
      });
    }
  },
});

/** (Re)facture les matières payantes d'un dépôt — utilisé pour les dépôts anciens ou en erreur. */
export const billDepot = mutation({
  args: { depotId: v.id("bpDepots") },
  handler: async (ctx, { depotId }) => {
    await requireCrmPermission(ctx, "bennespro:depots", "update");
    const depot = await ctx.db.get(depotId);
    if (!depot) throw new Error("Dépôt introuvable.");
    if (depot.billing?.status === "invoiced") {
      throw new Error("Ce dépôt est déjà facturé.");
    }
    const billing = await buildBilling(ctx, depot.items);
    if (!billing) {
      throw new Error("Aucun poids de DIB ou de bois facturable (kg ou tonne) sur ce dépôt.");
    }
    await ctx.db.patch(depotId, {
      billing,
    });
    await ctx.scheduler.runAfter(0, internal.bennespro.invoiceDepotDib, { depotId });
  },
});

export const depotForBilling = internalQuery({
  args: { depotId: v.id("bpDepots") },
  handler: async (ctx, { depotId }) => {
    const depot = await ctx.db.get(depotId);
    if (!depot) return null;
    const company = await ctx.db.get(depot.companyId);
    return { depot, company };
  },
});

export const saveCompanyStripeCustomer = internalMutation({
  args: { companyId: v.id("bpCompanies"), stripeCustomerId: v.string() },
  handler: async (ctx, { companyId, stripeCustomerId }) => {
    await ctx.db.patch(companyId, { stripeCustomerId });
  },
});

export const saveDepotBilling = internalMutation({
  args: { depotId: v.id("bpDepots"), billing: bpBilling },
  handler: async (ctx, { depotId, billing }) => {
    await ctx.db.patch(depotId, { billing });
  },
});

export const saveInvoicePaymentStatus = internalMutation({
  args: {
    depotId: v.id("bpDepots"),
    paymentStatus: v.union(
      v.literal("draft"),
      v.literal("open"),
      v.literal("paid"),
      v.literal("void"),
      v.literal("uncollectible"),
    ),
    stripeInvoiceUrl: v.optional(v.string()),
    paidAt: v.optional(v.number()),
  },
  handler: async (ctx, { depotId, paymentStatus, stripeInvoiceUrl, paidAt }) => {
    const depot = await ctx.db.get(depotId);
    if (!depot?.billing) return;
    await ctx.db.patch(depotId, {
      billing: {
        ...depot.billing,
        paymentStatus,
        ...(stripeInvoiceUrl ? { stripeInvoiceUrl } : {}),
        ...(paidAt ? { paidAt } : {}),
      },
    });
  },
});

/** Enregistre l'horodatage de la dernière relance envoyée. */
export const recordReminderSent = internalMutation({
  args: { depotId: v.id("bpDepots"), at: v.number() },
  handler: async (ctx, { depotId, at }) => {
    const depot = await ctx.db.get(depotId);
    if (!depot?.billing) return;
    await ctx.db.patch(depotId, {
      billing: { ...depot.billing, lastReminderAt: at },
    });
  },
});

async function stripeRequest(
  secretKey: string,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const json = (await res.json()) as {
    error?: { message?: string };
    [key: string]: unknown;
  };
  if (!res.ok) {
    throw new Error(json.error?.message ?? `Stripe ${path} a échoué (${res.status}).`);
  }
  return json;
}

type StripeInvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

function stripeStatus(value: unknown): StripeInvoiceStatus | undefined {
  return value === "draft" ||
    value === "open" ||
    value === "paid" ||
    value === "void" ||
    value === "uncollectible"
    ? value
    : undefined;
}

function stripePaidAt(invoice: Record<string, unknown>): number | undefined {
  const transitions = invoice.status_transitions;
  if (!transitions || typeof transitions !== "object") return undefined;
  const paidAt = (transitions as { paid_at?: unknown }).paid_at;
  return typeof paidAt === "number" ? paidAt * 1000 : undefined;
}

async function stripeVatTaxRateId(secretKey: string): Promise<string> {
  if (env.BENNESPRO_STRIPE_TVA_TAX_RATE_ID) return env.BENNESPRO_STRIPE_TVA_TAX_RATE_ID;

  const existing = await stripeGet(secretKey, "tax_rates?active=true&limit=100");
  const rates = Array.isArray(existing.data) ? existing.data : [];
  for (const rate of rates) {
    if (!rate || typeof rate !== "object") continue;
    const taxRate = rate as Record<string, unknown>;
    if (
      taxRate.id &&
      taxRate.percentage === DIB_VAT_RATE &&
      taxRate.inclusive === false &&
      taxRate.country === "FR"
    ) {
      return String(taxRate.id);
    }
  }

  const created = await stripeRequest(secretKey, "tax_rates", {
    display_name: "TVA",
    inclusive: "false",
    percentage: String(DIB_VAT_RATE),
    country: "FR",
    description: "TVA française 20%",
  });
  return String(created.id);
}

async function refreshStripeInvoiceBilling(
  ctx: Pick<ActionCtx, "runMutation">,
  secretKey: string,
  depotId: Id<"bpDepots">,
  invoiceId: string,
): Promise<{ paymentStatus?: StripeInvoiceStatus; invoice: Record<string, unknown> }> {
  const invoice = await stripeGet(secretKey, `invoices/${invoiceId}`);
  const paymentStatus = stripeStatus(invoice.status);
  if (paymentStatus) {
    const args: {
      depotId: Id<"bpDepots">;
      paymentStatus: StripeInvoiceStatus;
      stripeInvoiceUrl?: string;
      paidAt?: number;
    } = { depotId, paymentStatus };
    const hostedUrl = invoice.hosted_invoice_url;
    if (typeof hostedUrl === "string") args.stripeInvoiceUrl = hostedUrl;
    const paidAt = stripePaidAt(invoice);
    if (paidAt) args.paidAt = paidAt;
    await ctx.runMutation(internal.bennespro.saveInvoicePaymentStatus, args);
  }
  return { paymentStatus, invoice };
}

/**
 * Facture les matières payantes d'un dépôt via Stripe : client (créé au besoin et mémorisé
 * sur l'entreprise), facture `send_invoice` à 30 jours, envoi par email si
 * l'entreprise a un email de contact.
 */
export const invoiceDepotDib = internalAction({
  args: { depotId: v.id("bpDepots") },
  handler: async (ctx, { depotId }) => {
    const data: { depot: Doc<"bpDepots">; company: Doc<"bpCompanies"> | null } | null =
      await ctx.runQuery(internal.bennespro.depotForBilling, { depotId });
    if (!data?.depot.billing || data.depot.billing.status === "invoiced") return;
    const { depot, company } = data;
    const billing: Infer<typeof bpBilling> = { ...depot.billing! };

    async function fail(message: string) {
      await ctx.runMutation(internal.bennespro.saveDepotBilling, {
        depotId,
        billing: { ...billing, status: "error", error: message },
      });
    }

    const secretKey = env.BENNESPRO_STRIPE_SECRET_KEY;
    if (!secretKey) {
      await fail("Clé Stripe non configurée (BENNESPRO_STRIPE_SECRET_KEY).");
      return;
    }
    if (!company) {
      await fail("Entreprise introuvable.");
      return;
    }

    try {
      // 1. Client Stripe de l'entreprise (réutilisé, jamais dupliqué).
      let customerId = company.stripeCustomerId;
      // Pas encore mémorisé : on cherche d'abord un client Stripe existant avec
      // la même adresse email avant d'en créer un — évite qu'un nouveau client
      // Stripe soit créé à chaque facture.
      if (!customerId && company.contactEmail) {
        const search = await stripeGet(
          secretKey,
          `customers?email=${encodeURIComponent(company.contactEmail)}&limit=1`,
        );
        const existing = Array.isArray(search.data) ? search.data[0] : undefined;
        const existingId = (existing as { id?: unknown } | undefined)?.id;
        if (typeof existingId === "string") customerId = existingId;
      }
      if (!customerId) {
        const customer = await stripeRequest(secretKey, "customers", {
          name: company.name,
          ...(company.contactEmail ? { email: company.contactEmail } : {}),
          ...(company.contactPhone ? { phone: company.contactPhone } : {}),
          "metadata[bpCompanyId]": company._id,
          ...(company.siret ? { "metadata[siret]": company.siret } : {}),
        });
        customerId = customer.id as string;
      }
      // Mémorise l'id (retrouvé ou créé) sur l'entreprise pour les prochaines fois.
      if (customerId && customerId !== company.stripeCustomerId) {
        await ctx.runMutation(internal.bennespro.saveCompanyStripeCustomer, {
          companyId: company._id,
          stripeCustomerId: customerId,
        });
      }

      const depotRef = `Bon de dépôt n° ${String(depot.depotNumber).padStart(4, "0")}`;
      const taxRateId = await stripeVatTaxRateId(secretKey);

      // 2. Facture vide (paiement à réception, 30 jours).
      const invoice = await stripeRequest(secretKey, "invoices", {
        customer: customerId,
        collection_method: "send_invoice",
        days_until_due: "30",
        currency: "eur",
        description: depotRef,
        pending_invoice_items_behavior: "exclude",
        "metadata[bpDepotId]": depot._id,
        "metadata[bpDepotNumber]": String(depot.depotNumber),
      });
      const invoiceId = invoice.id as string;

      // 3. Une ligne Stripe par matière payante. Les anciennes factures sans
      // détail restent compatibles et sont interprétées comme du DIB.
      const billableItems = billing.items ?? [{
        material: DIB_MATERIAL,
        weightKg: billing.weightKg,
        priceCentsPerKg: billing.priceCentsPerKg,
        amountCents: billing.amountCents,
      }];
      for (const item of billableItems) {
        const priceEuros = (item.priceCentsPerKg / 100).toFixed(2).replace(".", ",");
        const label = item.material === DIB_MATERIAL ? "DIB (tout-venant non trié)" : "Bois";
        await stripeRequest(secretKey, "invoiceitems", {
          customer: customerId,
          invoice: invoiceId,
          amount: String(item.amountCents),
          currency: "eur",
          "tax_rates[0]": taxRateId,
          description: `${label} — ${item.weightKg} kg × ${priceEuros} €/kg HT — ${depotRef}`,
        });
      }

      // 4. Finalisation (+ envoi par email si possible).
      const finalized = await stripeRequest(secretKey, `invoices/${invoiceId}/finalize`, {
        auto_advance: "false",
      });
      if (company.contactEmail) {
        await stripeRequest(secretKey, `invoices/${invoiceId}/send`, {});
      }

      const savedBilling: Infer<typeof bpBilling> = {
        ...billing,
        vatRate: DIB_VAT_RATE,
        status: "invoiced",
        stripeInvoiceId: invoiceId,
        paymentStatus: stripeStatus(finalized.status) ?? "open",
        invoicedAt: Date.now(),
      };
      const hostedUrl = finalized.hosted_invoice_url;
      if (typeof hostedUrl === "string") savedBilling.stripeInvoiceUrl = hostedUrl;
      const paidAt = stripePaidAt(finalized);
      if (paidAt) savedBilling.paidAt = paidAt;
      await ctx.runMutation(internal.bennespro.saveDepotBilling, {
        depotId,
        billing: savedBilling,
      });
    } catch (err) {
      await fail(err instanceof Error ? err.message : "Erreur Stripe inconnue.");
    }
  },
});

/* ─── Email de facture ────────────────────────────────────────────────────── */

const BP_TEAL = "#2aa79b";
const BP_DARK = "#14332f";

async function stripeGet(secretKey: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const json = (await res.json()) as { error?: { message?: string }; [key: string]: unknown };
  if (!res.ok) {
    throw new Error(json.error?.message ?? `Stripe ${path} a échoué (${res.status}).`);
  }
  return json;
}

export const refreshInvoiceStatus = action({
  args: { depotId: v.id("bpDepots") },
  handler: async (ctx, { depotId }) => {
    const access: {
      isAdmin?: boolean;
      bootstrapMode?: boolean;
      grants: Array<{ pageKey: string; actions: string[] }>;
    } = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "bennespro:depots", "read")) {
      throw new Error("Accès insuffisant.");
    }
    const data: { depot: Doc<"bpDepots">; company: Doc<"bpCompanies"> | null } | null =
      await ctx.runQuery(internal.bennespro.depotForBilling, { depotId });
    if (!data?.depot.billing?.stripeInvoiceId) {
      throw new Error("Aucune facture Stripe pour ce dépôt.");
    }
    const secretKey = env.BENNESPRO_STRIPE_SECRET_KEY;
    if (!secretKey) throw new Error("Clé Stripe non configurée (BENNESPRO_STRIPE_SECRET_KEY).");
    const { paymentStatus } = await refreshStripeInvoiceBilling(
      ctx,
      secretKey,
      depotId,
      data.depot.billing.stripeInvoiceId,
    );
    return { paymentStatus: paymentStatus ?? null };
  },
});

/* ─── Suppression définitive (permission « delete ») ──────────────────────── */

async function requireAccess(
  ctx: Pick<ActionCtx, "runQuery">,
  pageKey: string,
  action: "delete",
) {
  const access: {
    isAdmin?: boolean;
    bootstrapMode?: boolean;
    grants: Array<{ pageKey: string; actions: string[] }>;
  } = await ctx.runQuery(api.permissions.myAccess, {});
  if (!accessAllows(access, pageKey, action)) {
    throw new Error("Vous n'avez pas le droit de supprimer cet élément.");
  }
}

/** Annule (void) une facture Stripe si elle existe et n'est pas déjà payée. */
async function voidInvoiceIfPossible(
  secretKey: string | undefined,
  stripeInvoiceId: string | undefined,
  paymentStatus: string | undefined,
) {
  if (!secretKey || !stripeInvoiceId) return;
  if (paymentStatus === "paid" || paymentStatus === "void") return;
  try {
    await stripeRequest(secretKey, `invoices/${stripeInvoiceId}/void`, {});
  } catch (err) {
    console.warn("Annulation de la facture Stripe impossible :", err);
  }
}

/** Supprime définitivement un dépôt (fichiers + annulation de sa facture Stripe). */
export const deleteDepot = action({
  args: { depotId: v.id("bpDepots") },
  handler: async (ctx, { depotId }): Promise<null> => {
    await requireAccess(ctx, "bennespro:depots", "delete");
    const data: { depot: Doc<"bpDepots">; company: Doc<"bpCompanies"> | null } | null =
      await ctx.runQuery(internal.bennespro.depotForBilling, { depotId });
    if (!data) return null;
    await voidInvoiceIfPossible(
      env.BENNESPRO_STRIPE_SECRET_KEY,
      data.depot.billing?.stripeInvoiceId,
      data.depot.billing?.paymentStatus,
    );
    await ctx.runMutation(internal.bennespro.adminWipeDepot, { depotId, alsoCompany: false });
    return null;
  },
});

export const companyDepotsForDeletion = internalQuery({
  args: { companyId: v.id("bpCompanies") },
  handler: async (ctx, { companyId }) => {
    const depots = await ctx.db
      .query("bpDepots")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    return depots.map((d) => ({
      stripeInvoiceId: d.billing?.stripeInvoiceId,
      paymentStatus: d.billing?.paymentStatus,
    }));
  },
});

/** Supprime une entreprise et tout ce qui lui est rattaché (dépôts + fichiers + véhicules). */
export const wipeCompanyCascade = internalMutation({
  args: { companyId: v.id("bpCompanies") },
  handler: async (ctx, { companyId }) => {
    const depots = await ctx.db
      .query("bpDepots")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    for (const depot of depots) {
      const files = [
        depot.ticketPhoto,
        depot.truckExteriorPhoto,
        depot.truckInteriorPhoto,
        depot.signature,
        ...depot.attachments,
      ].filter((id): id is Id<"_storage"> => Boolean(id));
      for (const fileId of files) {
        try {
          await ctx.storage.delete(fileId);
        } catch {
          // Fichier déjà absent.
        }
      }
      await ctx.db.delete(depot._id);
    }
    const vehicles = await ctx.db
      .query("bpVehicles")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    for (const vehicle of vehicles) await ctx.db.delete(vehicle._id);
    const company = await ctx.db.get(companyId);
    if (company) await ctx.db.delete(companyId);
  },
});

/**
 * Supprime définitivement une entreprise : annule les factures Stripe non
 * payées de ses dépôts, puis efface l'entreprise, ses véhicules et ses dépôts.
 */
export const deleteCompany = action({
  args: { companyId: v.id("bpCompanies") },
  handler: async (ctx, { companyId }): Promise<null> => {
    await requireAccess(ctx, "bennespro:entreprises", "delete");
    const secretKey = env.BENNESPRO_STRIPE_SECRET_KEY;
    if (secretKey) {
      const depots: Array<{ stripeInvoiceId?: string; paymentStatus?: string }> =
        await ctx.runQuery(internal.bennespro.companyDepotsForDeletion, { companyId });
      for (const depot of depots) {
        await voidInvoiceIfPossible(secretKey, depot.stripeInvoiceId, depot.paymentStatus);
      }
    }
    await ctx.runMutation(internal.bennespro.wipeCompanyCascade, { companyId });
    return null;
  },
});

/**
 * Envoie la facture par email à l'entreprise du dépôt : lien de paiement dans
 * le corps + facture PDF et bon de dépôt PDF en pièces jointes.
 * `bonPdfBase64` est généré côté client (jsPDF) et transmis tel quel.
 */
export const sendInvoiceEmail = action({
  args: {
    depotId: v.id("bpDepots"),
    bonPdfBase64: v.optional(v.string()),
    reminder: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { depotId, bonPdfBase64, reminder },
  ): Promise<{ sentTo: string; reminder: boolean; sentAt: number }> => {
    // Annotations explicites : évite la circularité de types (fonction du même module).
    const access: {
      isAdmin?: boolean;
      bootstrapMode?: boolean;
      grants: Array<{ pageKey: string; actions: string[] }>;
    } = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "bennespro:depots", "read")) {
      throw new Error("Accès insuffisant.");
    }
    const data: { depot: Doc<"bpDepots">; company: Doc<"bpCompanies"> | null } | null =
      await ctx.runQuery(internal.bennespro.depotForBilling, { depotId });
    if (!data) throw new Error("Dépôt introuvable.");
    const { depot, company } = data;
    if (!depot.billing?.stripeInvoiceUrl || !depot.billing.stripeInvoiceId) {
      throw new Error("Aucune facture Stripe pour ce dépôt.");
    }
    const email = company?.contactEmail?.trim();
    if (!email) {
      throw new Error("Cette entreprise n'a pas d'email de contact. Ajoutez-le dans sa fiche.");
    }

    const number = String(depot.depotNumber).padStart(4, "0");
    const ref = `Bon de dépôt n° ${number}`;
    const amountHt = (depot.billing.amountCents / 100).toFixed(2).replace(".", ",");
    const vatRate = depot.billing.vatRate ?? DIB_VAT_RATE;
    const amountTtc = (Math.round(depot.billing.amountCents * (1 + vatRate / 100)) / 100)
      .toFixed(2)
      .replace(".", ",");
    const date = new Date(depot.createdAt).toLocaleDateString("fr-FR");
    const secretKey = env.BENNESPRO_STRIPE_SECRET_KEY;
    let stripeInvoice: Record<string, unknown> | null = null;
    if (secretKey) {
      const { paymentStatus, invoice } = await refreshStripeInvoiceBilling(
        ctx,
        secretKey,
        depotId,
        depot.billing.stripeInvoiceId,
      );
      stripeInvoice = invoice;
      if (paymentStatus === "paid") {
        throw new Error("Cette facture est déjà payée.");
      }
    }

    // Pièces jointes : facture PDF (téléchargée chez Stripe) + bon de dépôt PDF.
    const attachments: EmailAttachment[] = [];
    if (secretKey) {
      try {
        const invoice = stripeInvoice ?? (await stripeGet(secretKey, `invoices/${depot.billing.stripeInvoiceId}`));
        const pdfUrl = invoice.invoice_pdf as string | undefined;
        if (pdfUrl) {
          const res = await fetch(pdfUrl);
          if (res.ok) {
            attachments.push({
              filename: `facture-depot-${number}.pdf`,
              content: bytesToBase64(new Uint8Array(await res.arrayBuffer())),
            });
          }
        }
      } catch (err) {
        console.warn("Facture PDF Stripe indisponible :", err);
      }
    }
    if (bonPdfBase64) {
      attachments.push({ filename: `bon-depot-${number}.pdf`, content: bonPdfBase64 });
    }

    const logoId = env.BENNESPRO_EMAIL_LOGO_ID;
    const logoHtml = logoId
      ? `<img src="${storageImageUrl(logoId)}" alt="Déchet'Lab" height="72" style="display:block;height:72px;width:auto;margin:0 auto;" />`
      : `<p style="margin:0;text-align:center;color:${BP_DARK};font-size:20px;font-weight:bold;">Déchet'Lab</p>`;

    const html = `<!doctype html>
<html lang="fr"><body style="margin:0;background:#f0faf9;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #d9f2f0;">
      <tr><td style="padding:26px 28px 18px;background:#ffffff;">
        ${logoHtml}
      </td></tr>
      <tr><td style="height:4px;background:${BP_TEAL};font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:28px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${BP_TEAL};">${reminder ? "Relance facture" : "Facture"} — dépôt de déchets</p>
        <p style="margin:0 0 14px;font-size:19px;font-weight:bold;color:${BP_DARK};">${ref}</p>
        <p style="margin:0 0 12px;font-size:14px;line-height:22px;color:#3d4a46;">Bonjour${company?.contactName ? ` ${company.contactName}` : ""},</p>
        <p style="margin:0 0 18px;font-size:14px;line-height:22px;color:#3d4a46;">
          ${reminder ? "Nous nous permettons de vous relancer concernant votre facture pour le dépôt du" : "Veuillez trouver votre facture pour le dépôt du"} ${date}
          (matières facturées&nbsp;: ${depot.billing.weightKg}&nbsp;kg — <strong style="color:${BP_DARK};">${amountHt}&nbsp;€ HT / ${amountTtc}&nbsp;€ TTC</strong>, TVA ${vatRate}%).
          La facture et le bon de dépôt sont joints à cet email au format PDF.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr><td style="border-radius:10px;background:${BP_TEAL};">
          <a href="${depot.billing.stripeInvoiceUrl}" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">
            Voir et régler la facture en ligne
          </a>
        </td></tr></table>
        <p style="margin:0;font-size:12px;line-height:18px;color:#8a9691;">
          Le paiement s'effectue en ligne de façon sécurisée via Stripe.
          Message automatique — merci de ne pas répondre à cet email.
        </p>
      </td></tr>
      <tr><td style="padding:16px 28px;background:${BP_DARK};">
        <p style="margin:0;font-size:12px;color:#b4e5e1;">Déchet'Lab — Bennes &amp; Pro · Maison de l'Économie Solidaire</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

    await resendSend(
      email,
      `${reminder ? "Relance facture" : "Votre facture"} — ${ref} (${amountTtc} € TTC)`,
      html,
      "Déchet'Lab <no-reply@mesoutils.eco-solidaire.fr>",
      attachments,
    );
    const sentAt = Date.now();
    if (reminder) {
      await ctx.runMutation(internal.bennespro.recordReminderSent, { depotId, at: sentAt });
    }
    return { sentTo: email, reminder: reminder ?? false, sentAt };
  },
});

/** Stocke le logo email Déchet'Lab (base64 PNG) — retourne l'id à mettre dans BENNESPRO_EMAIL_LOGO_ID. */
export const adminStoreEmailLogo = internalAction({
  args: { base64: v.string() },
  handler: async (ctx, { base64 }): Promise<string> => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const storageId = await ctx.storage.store(new Blob([bytes], { type: "image/png" }));
    return storageId;
  },
});

/* ─── Maintenance (CLI uniquement) ────────────────────────────────────────── */

/** Force le prix DIB (centimes/kg) — `npx convex run bennespro:adminSetDibPrice '{"priceCentsPerKg":32}'`. */
export const adminSetDibPrice = internalMutation({
  args: { priceCentsPerKg: v.number() },
  handler: async (ctx, { priceCentsPerKg }) => {
    const settings = await ctx.db
      .query("bpSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
    if (settings) {
      await ctx.db.patch(settings._id, { dibPriceCentsPerKg: priceCentsPerKg, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("bpSettings", {
        key: SETTINGS_KEY,
        dibPriceCentsPerKg: priceCentsPerKg,
        updatedAt: Date.now(),
      });
    }
  },
});

const legacyCompany = v.object({
  key: v.string(),
  name: v.string(),
  siret: v.optional(v.string()),
  address: v.optional(v.string()),
  contactName: v.optional(v.string()),
  contactPhone: v.optional(v.string()),
  contactEmail: v.optional(v.string()),
  stripeCustomerId: v.optional(v.string()),
  createdAt: v.number(),
});

const legacyVehicle = v.object({
  key: v.string(),
  companyKey: v.string(),
  label: v.string(),
  plate: v.optional(v.string()),
  createdAt: v.number(),
});

const legacyDepot = v.object({
  depotNumber: v.number(),
  companyKey: v.string(),
  vehicleKey: v.optional(v.string()),
  vehicleLabel: v.optional(v.string()),
  depositorName: v.string(),
  siteRef: v.string(),
  materials: v.array(bpMaterial),
  items: v.optional(v.array(depotItem)),
  createdAt: v.number(),
  comment: v.optional(v.string()),
  invoiceId: v.optional(v.string()),
  invoiceUrl: v.optional(v.string()),
});

const legacyInvoice = v.object({
  invoiceId: v.string(),
  invoiceUrl: v.optional(v.string()),
  amountCents: v.number(),
  vatRate: v.number(),
  paymentStatus: v.optional(
    v.union(
      v.literal("draft"),
      v.literal("open"),
      v.literal("paid"),
      v.literal("void"),
      v.literal("uncollectible"),
    ),
  ),
  paidAt: v.optional(v.number()),
  invoicedAt: v.optional(v.number()),
});

function normalizedKey(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function sameOptional(a: string | undefined, b: string | undefined) {
  return (a ?? "") === (b ?? "");
}

function billingWeightKg(items: Array<Infer<typeof depotItem>>): number {
  let kg = 0;
  for (const item of items) {
    if (item.material !== DIB_MATERIAL) continue;
    if (item.unit === "kg") kg += item.quantity;
    else if (item.unit === "tonne") kg += item.quantity * 1000;
  }
  return Math.round(kg * 100) / 100;
}

async function findCompanyByLegacy(
  ctx: MutationCtx,
  company: Infer<typeof legacyCompany>,
  byKey: Map<string, Id<"bpCompanies">>,
) {
  if (byKey.has(company.key)) return byKey.get(company.key)!;
  const normalizedName = normalizedKey(company.name);
  const companies = await ctx.db.query("bpCompanies").collect();
  const existing = companies.find((row) =>
    (company.siret && row.siret === company.siret) || normalizedKey(row.name) === normalizedName,
  );
  if (existing) {
    byKey.set(company.key, existing._id);
    return existing._id;
  }
  const companyId = await ctx.db.insert("bpCompanies", {
    name: company.name,
    ...(company.siret ? { siret: company.siret } : {}),
    ...(company.address ? { address: company.address } : {}),
    ...(company.contactName ? { contactName: company.contactName } : {}),
    ...(company.contactPhone ? { contactPhone: company.contactPhone } : {}),
    ...(company.contactEmail ? { contactEmail: company.contactEmail } : {}),
    ...(company.stripeCustomerId ? { stripeCustomerId: company.stripeCustomerId } : {}),
    createdAt: company.createdAt,
  });
  byKey.set(company.key, companyId);
  return companyId;
}

export const adminImportLegacyBennesProData = internalMutation({
  args: {
    companies: v.array(legacyCompany),
    vehicles: v.array(legacyVehicle),
    depots: v.array(legacyDepot),
    invoices: v.array(legacyInvoice),
  },
  handler: async (ctx, { companies, vehicles, depots, invoices }) => {
    const companyByKey = new Map<string, Id<"bpCompanies">>();
    let companiesCreated = 0;
    let companiesUpdated = 0;
    for (const company of companies) {
      const before = await ctx.db.query("bpCompanies").collect();
      const companyId = await findCompanyByLegacy(ctx, company, companyByKey);
      const after = await ctx.db.get(companyId);
      if (before.some((row) => row._id === companyId)) {
        const patch: Partial<Doc<"bpCompanies">> = {};
        if (after && after.name !== company.name) patch.name = company.name;
        if (after && company.siret && after.siret !== company.siret) patch.siret = company.siret;
        if (after && company.address && after.address !== company.address) patch.address = company.address;
        if (after && company.contactName && after.contactName !== company.contactName) patch.contactName = company.contactName;
        if (after && company.contactPhone && after.contactPhone !== company.contactPhone) patch.contactPhone = company.contactPhone;
        if (after && company.contactEmail && after.contactEmail !== company.contactEmail) patch.contactEmail = company.contactEmail;
        if (after && company.stripeCustomerId && after.stripeCustomerId !== company.stripeCustomerId) {
          patch.stripeCustomerId = company.stripeCustomerId;
        }
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(companyId, patch);
          companiesUpdated += 1;
        }
      } else {
        companiesCreated += 1;
      }
    }

    const vehicleByKey = new Map<string, Id<"bpVehicles">>();
    let vehiclesCreated = 0;
    let vehiclesUpdated = 0;
    for (const vehicle of vehicles) {
      const companyId = companyByKey.get(vehicle.companyKey);
      if (!companyId) continue;
      const existingVehicles = await ctx.db
        .query("bpVehicles")
        .withIndex("by_company", (q) => q.eq("companyId", companyId))
        .collect();
      const normalizedLabel = normalizedKey(vehicle.label);
      const existing = existingVehicles.find(
        (row) =>
          (vehicle.plate && row.plate === vehicle.plate) ||
          (normalizedKey(row.label) === normalizedLabel && sameOptional(row.plate, vehicle.plate)),
      );
      if (existing) {
        vehicleByKey.set(vehicle.key, existing._id);
        const patch: Partial<Doc<"bpVehicles">> = {};
        if (existing.label !== vehicle.label) patch.label = vehicle.label;
        if (vehicle.plate && existing.plate !== vehicle.plate) patch.plate = vehicle.plate;
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, patch);
          vehiclesUpdated += 1;
        }
      } else {
        const vehicleId = await ctx.db.insert("bpVehicles", {
          companyId,
          label: vehicle.label,
          ...(vehicle.plate ? { plate: vehicle.plate } : {}),
          createdAt: vehicle.createdAt,
        });
        vehicleByKey.set(vehicle.key, vehicleId);
        vehiclesCreated += 1;
      }
    }

    const invoicesById = new Map(invoices.map((invoice) => [invoice.invoiceId, invoice]));
    let depotsCreated = 0;
    let depotsUpdated = 0;
    let fallbackVehiclesCreated = 0;
    for (const depot of depots) {
      const companyId = companyByKey.get(depot.companyKey);
      if (!companyId) continue;
      let vehicleId = depot.vehicleKey ? vehicleByKey.get(depot.vehicleKey) : undefined;
      const fallbackLabel = depot.vehicleLabel?.trim() || "Véhicule non renseigné";
      if (!vehicleId) {
        const existingVehicles = await ctx.db
          .query("bpVehicles")
          .withIndex("by_company", (q) => q.eq("companyId", companyId))
          .collect();
        const existing = existingVehicles.find((row) => normalizedKey(row.label) === normalizedKey(fallbackLabel));
        vehicleId = existing?._id;
        if (!vehicleId) {
          vehicleId = await ctx.db.insert("bpVehicles", {
            companyId,
            label: fallbackLabel,
            createdAt: depot.createdAt,
          });
          fallbackVehiclesCreated += 1;
        }
      }
      const invoice = depot.invoiceId ? invoicesById.get(depot.invoiceId) : undefined;
      const items =
        depot.items && depot.items.length > 0
          ? depot.items
          : depot.materials.map((material) => ({
              material,
              unit: "unite" as const,
              quantity: 1,
              siteRef: depot.siteRef,
            }));
      const weightKg = billingWeightKg(items);
      const billing: Infer<typeof bpBilling> | undefined = invoice
        ? {
            weightKg,
            priceCentsPerKg: weightKg > 0 ? Math.round((invoice.amountCents / weightKg) * 100) / 100 : 0,
            amountCents: invoice.amountCents,
            vatRate: invoice.vatRate,
            status: "invoiced",
            stripeInvoiceId: invoice.invoiceId,
            ...(invoice.invoiceUrl ? { stripeInvoiceUrl: invoice.invoiceUrl } : {}),
            ...(invoice.paymentStatus ? { paymentStatus: invoice.paymentStatus } : {}),
            ...(invoice.paidAt ? { paidAt: invoice.paidAt } : {}),
            ...(invoice.invoicedAt ? { invoicedAt: invoice.invoicedAt } : {}),
          }
        : undefined;
      const existing = await ctx.db
        .query("bpDepots")
        .withIndex("by_number", (q) => q.eq("depotNumber", depot.depotNumber))
        .unique();
      const payload = {
        depotNumber: depot.depotNumber,
        companyId,
        vehicleId,
        depositorName: depot.depositorName,
        siteRef: depot.siteRef,
        items,
        attachments: [],
        ...(depot.comment ? { comment: depot.comment } : {}),
        ...(billing ? { billing } : {}),
        createdBy: "import historique",
        createdAt: depot.createdAt,
      };
      if (existing) {
        await ctx.db.patch(existing._id, payload);
        depotsUpdated += 1;
      } else {
        await ctx.db.insert("bpDepots", payload);
        depotsCreated += 1;
      }
    }

    return {
      companiesCreated,
      companiesUpdated,
      vehiclesCreated,
      vehiclesUpdated,
      fallbackVehiclesCreated,
      depotsCreated,
      depotsUpdated,
      invoicesLinked: invoices.length,
    };
  },
});

type LegacyImportResult = {
  companiesCreated: number;
  companiesUpdated: number;
  vehiclesCreated: number;
  vehiclesUpdated: number;
  fallbackVehiclesCreated: number;
  depotsCreated: number;
  depotsUpdated: number;
  invoicesLinked: number;
};

export const adminImportLegacyBennesPro = internalAction({
  args: {
    companies: v.array(legacyCompany),
    vehicles: v.array(legacyVehicle),
    depots: v.array(legacyDepot),
  },
  handler: async (ctx, args): Promise<LegacyImportResult> => {
    const invoiceIds = args.depots
      .map((depot) => depot.invoiceId)
      .filter((invoiceId): invoiceId is string => Boolean(invoiceId));
    const secretKey = env.BENNESPRO_STRIPE_SECRET_KEY;
    if (invoiceIds.length > 0 && !secretKey) {
      throw new Error("Clé Stripe non configurée (BENNESPRO_STRIPE_SECRET_KEY).");
    }

    const invoices: Array<Infer<typeof legacyInvoice>> = [];
    if (secretKey) {
      for (const invoiceId of invoiceIds) {
        const invoice = await stripeGet(secretKey, `invoices/${invoiceId}`);
        const subtotal =
          typeof invoice.subtotal_excluding_tax === "number"
            ? invoice.subtotal_excluding_tax
            : typeof invoice.subtotal === "number"
              ? invoice.subtotal
              : 0;
        const total = typeof invoice.total === "number" ? invoice.total : subtotal;
        const rawVatRate = subtotal > 0 ? Math.round(((total - subtotal) / subtotal) * 10000) / 100 : 0;
        const vatRate = Math.abs(rawVatRate - DIB_VAT_RATE) < 0.25 ? DIB_VAT_RATE : rawVatRate;
        const importedInvoice: Infer<typeof legacyInvoice> = {
          invoiceId,
          amountCents: subtotal,
          vatRate,
        };
        const invoiceUrl =
          typeof invoice.hosted_invoice_url === "string"
            ? invoice.hosted_invoice_url
            : args.depots.find((depot) => depot.invoiceId === invoiceId)?.invoiceUrl;
        if (invoiceUrl) importedInvoice.invoiceUrl = invoiceUrl;
        const paymentStatus = stripeStatus(invoice.status);
        if (paymentStatus) importedInvoice.paymentStatus = paymentStatus;
        const paidAt = stripePaidAt(invoice);
        if (paidAt) importedInvoice.paidAt = paidAt;
        if (typeof invoice.created === "number") importedInvoice.invoicedAt = invoice.created * 1000;
        invoices.push(importedInvoice);
      }
    }

    return await ctx.runMutation(internal.bennespro.adminImportLegacyBennesProData, {
      ...args,
      invoices,
    });
  },
});

/** Supprime un dépôt (fichiers inclus) et, au besoin, son entreprise + véhicules. */
export const adminWipeDepot = internalMutation({
  args: { depotId: v.id("bpDepots"), alsoCompany: v.optional(v.boolean()) },
  handler: async (ctx, { depotId, alsoCompany }) => {
    const depot = await ctx.db.get(depotId);
    if (!depot) return;
    const files = [
      depot.ticketPhoto,
      depot.truckExteriorPhoto,
      depot.truckInteriorPhoto,
      depot.signature,
      ...depot.attachments,
    ].filter((id): id is Id<"_storage"> => Boolean(id));
    for (const fileId of files) {
      try {
        await ctx.storage.delete(fileId);
      } catch {
        // Fichier déjà absent.
      }
    }
    await ctx.db.delete(depotId);
    if (alsoCompany) {
      const vehicles = await ctx.db
        .query("bpVehicles")
        .withIndex("by_company", (q) => q.eq("companyId", depot.companyId))
        .collect();
      for (const vehicle of vehicles) await ctx.db.delete(vehicle._id);
      const company = await ctx.db.get(depot.companyId);
      if (company) await ctx.db.delete(company._id);
    }
  },
});

/** Supprime les entreprises de test/import inconnu, avec leurs dépôts et véhicules. */
export const adminDeleteTestAndUnknownCompanies = internalMutation({
  args: {},
  handler: async (ctx) => {
    const companies = await ctx.db.query("bpCompanies").collect();
    const targets = companies.filter((company) => {
      const name = normalizedKey(company.name);
      return name.includes("test") || name.includes("inconnu");
    });

    let depotsDeleted = 0;
    let vehiclesDeleted = 0;
    const deletedCompanies: string[] = [];

    for (const company of targets) {
      const depots = await ctx.db
        .query("bpDepots")
        .withIndex("by_company", (q) => q.eq("companyId", company._id))
        .collect();
      for (const depot of depots) {
        await ctx.db.delete(depot._id);
        depotsDeleted += 1;
      }

      const vehicles = await ctx.db
        .query("bpVehicles")
        .withIndex("by_company", (q) => q.eq("companyId", company._id))
        .collect();
      for (const vehicle of vehicles) {
        await ctx.db.delete(vehicle._id);
        vehiclesDeleted += 1;
      }

      await ctx.db.delete(company._id);
      deletedCompanies.push(company.name);
    }

    return {
      companiesDeleted: deletedCompanies.length,
      deletedCompanies,
      depotsDeleted,
      vehiclesDeleted,
    };
  },
});

/**
 * Supprime un dépôt de test : annule (void) la facture Stripe si elle existe,
 * puis efface le dépôt (et l'entreprise si demandé).
 * `npx convex run bennespro:adminDeleteTestDepot '{"depotId":"…","alsoCompany":true}'`
 */
export const adminDeleteTestDepot = internalAction({
  args: { depotId: v.id("bpDepots"), alsoCompany: v.optional(v.boolean()) },
  handler: async (ctx, { depotId, alsoCompany }): Promise<{ voided: boolean; deleted: boolean }> => {
    const data: { depot: Doc<"bpDepots">; company: Doc<"bpCompanies"> | null } | null =
      await ctx.runQuery(internal.bennespro.depotForBilling, { depotId });
    if (!data) return { voided: false, deleted: false };

    let voided = false;
    const invoiceId = data.depot.billing?.stripeInvoiceId;
    const secretKey = env.BENNESPRO_STRIPE_SECRET_KEY;
    if (invoiceId && secretKey) {
      try {
        await stripeRequest(secretKey, `invoices/${invoiceId}/void`, {});
        voided = true;
      } catch (err) {
        console.warn("Impossible d'annuler la facture Stripe :", err);
      }
    }
    await ctx.runMutation(internal.bennespro.adminWipeDepot, { depotId, alsoCompany });
    return { voided, deleted: true };
  },
});

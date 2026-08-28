/**
 * Bâtire — matériaux du bâtiment de seconde main.
 *
 * Même trio que la Recyclerie : une boutique en ligne, une vitrine kiosque et
 * un CRM. La différence tient à la marchandise. Un objet de brocante se compte
 * à l'unité ; un matériau se vend au mètre cube, à la tonne ou à la palette,
 * porte des dimensions, une matière, des normes, et se range à un emplacement
 * précis dans un dépôt. Ces champs ne sont pas décoratifs : sans unité de
 * vente, ni le prix ni le stock ne veulent dire quoi que ce soit.
 */
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { accessAllows, requireCrmPermission, requireUser, formatUserName } from "./lib";
import { recycappSecretKey, stripeRequest } from "./stripe";
import { btCondition, btMaterialStatus, btUnit } from "./schema";

const PAGE_MATERIAUX = "batire:materiaux";
const PAGE_DEMANDES = "batire:demandes";

/** Photos signées : un identifiant de stockage seul ne s'affiche pas. */
async function withPhotoUrls(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  material: Doc<"btMaterials">,
) {
  const photoUrls = await Promise.all(material.photos.map((id) => ctx.storage.getUrl(id)));
  return { ...material, photoUrls: photoUrls.filter((url): url is string => Boolean(url)) };
}

/* ─── Catalogue, côté équipe ───────────────────────────────────────────────── */

export const listMaterials = query({
  args: { search: v.optional(v.string()), status: v.optional(btMaterialStatus) },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_MATERIAUX, "read");
    const materials = args.status
      ? await ctx.db
          .query("btMaterials")
          .withIndex("by_status", (q) => q.eq("status", args.status!))
          .order("desc")
          .collect()
      : await ctx.db.query("btMaterials").order("desc").collect();

    const search = args.search?.trim().toLowerCase();
    const filtered = search
      ? materials.filter((material) =>
          [
            material.title,
            material.description,
            material.category,
            material.family,
            material.subcategory,
            material.brand,
            material.modelReference,
            material.material,
            material.qrReference,
            material.location,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(search),
        )
      : materials;

    return await Promise.all(filtered.map((material) => withPhotoUrls(ctx, material)));
  },
});

export const getMaterial = query({
  args: { id: v.id("btMaterials") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, PAGE_MATERIAUX, "read");
    const material = await ctx.db.get(id);
    return material ? await withPhotoUrls(ctx, material) : null;
  },
});

const materialFields = {
  title: v.string(),
  description: v.string(),
  category: v.string(),
  family: v.optional(v.string()),
  subcategory: v.optional(v.string()),
  condition: btCondition,
  unit: btUnit,
  quantity: v.number(),
  price: v.number(),
  packaging: v.optional(v.string()),
  lengthCm: v.optional(v.number()),
  widthCm: v.optional(v.number()),
  heightCm: v.optional(v.number()),
  thicknessMm: v.optional(v.number()),
  weightKg: v.optional(v.number()),
  brand: v.optional(v.string()),
  modelReference: v.optional(v.string()),
  material: v.optional(v.string()),
  color: v.optional(v.string()),
  standards: v.optional(v.string()),
  technicalNotes: v.optional(v.string()),
  depot: v.optional(v.string()),
  location: v.optional(v.string()),
  photos: v.array(v.id("_storage")),
  qrReference: v.optional(v.string()),
  aiConfidence: v.optional(v.number()),
  aiNotes: v.optional(v.string()),
};

/** Champs normalisés : un prix ou un stock négatif n'a pas de sens. */
function normalizeMaterial(args: Record<string, unknown>) {
  const price = Math.max(0, Number(args.price) || 0);
  const quantity = Math.max(0, Number(args.quantity) || 0);
  return { ...args, price, quantity };
}

export const createMaterial = mutation({
  args: { ...materialFields, status: v.optional(btMaterialStatus), published: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_MATERIAUX, "create");
    const identity = await requireUser(ctx);
    const title = args.title.trim();
    if (!title) throw new ConvexError("Le titre du matériau est requis.");
    const now = Date.now();
    const { status, published, ...rest } = args;

    const materialId = await ctx.db.insert("btMaterials", {
      ...(normalizeMaterial(rest) as typeof rest),
      title,
      status: status ?? "disponible",
      published: published ?? false,
      publishedAt: published ? now : undefined,
      createdBy: formatUserName(identity),
      createdAt: now,
      updatedAt: now,
    });
    if (args.qrReference) await claimQr(ctx, args.qrReference, materialId);
    return materialId;
  },
});

export const updateMaterial = mutation({
  args: {
    id: v.id("btMaterials"),
    ...materialFields,
    status: btMaterialStatus,
    published: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, ...args }) => {
    await requireCrmPermission(ctx, PAGE_MATERIAUX, "update");
    const existing = await ctx.db.get(id);
    if (!existing) throw new ConvexError("Matériau introuvable.");
    const title = args.title.trim();
    if (!title) throw new ConvexError("Le titre du matériau est requis.");
    const published = args.published ?? existing.published ?? false;
    await ctx.db.patch(id, {
      ...(normalizeMaterial(args) as typeof args),
      title,
      published,
      // La date de mise en ligne marque la PREMIÈRE publication : la modifier à
      // chaque enregistrement ferait remonter un vieux matériau en nouveauté.
      publishedAt: published ? existing.publishedAt ?? Date.now() : undefined,
      updatedAt: Date.now(),
    });
    if (args.qrReference && args.qrReference !== existing.qrReference) {
      await claimQr(ctx, args.qrReference, id);
    }
  },
});

export const setMaterialStatus = mutation({
  args: { id: v.id("btMaterials"), status: btMaterialStatus },
  handler: async (ctx, { id, status }) => {
    await requireCrmPermission(ctx, PAGE_MATERIAUX, "update");
    await ctx.db.patch(id, { status, updatedAt: Date.now() });
  },
});

export const setMaterialPublished = mutation({
  args: { id: v.id("btMaterials"), published: v.boolean() },
  handler: async (ctx, { id, published }) => {
    await requireCrmPermission(ctx, PAGE_MATERIAUX, "update");
    const material = await ctx.db.get(id);
    if (!material) throw new ConvexError("Matériau introuvable.");
    await ctx.db.patch(id, {
      published,
      publishedAt: published ? material.publishedAt ?? Date.now() : undefined,
      updatedAt: Date.now(),
    });
  },
});

export const removeMaterial = mutation({
  args: { id: v.id("btMaterials") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, PAGE_MATERIAUX, "delete");
    // Le QR code collé sur le matériau redevient libre pour un autre lot.
    const codes = await ctx.db
      .query("btQrCodes")
      .withIndex("by_material", (q) => q.eq("materialId", id))
      .collect();
    for (const code of codes) await ctx.db.patch(code._id, { materialId: undefined });
    await ctx.db.delete(id);
  },
});

/* ─── Boutique publique et kiosque ─────────────────────────────────────────── */

/**
 * Catalogue public : ce qui est publié, disponible et chiffré.
 *
 * Aucune authentification — c'est la vitrine. Un matériau réservé ou vendu en
 * disparaît, pour ne pas faire venir quelqu'un devant un lot déjà parti.
 */
export const listPublicMaterials = query({
  args: {
    search: v.optional(v.string()),
    category: v.optional(v.string()),
    family: v.optional(v.string()),
    subcategory: v.optional(v.string()),
    unit: v.optional(btUnit),
    condition: v.optional(btCondition),
    depot: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const published = await ctx.db
      .query("btMaterials")
      .withIndex("by_published", (q) => q.eq("published", true))
      .order("desc")
      .collect();

    const search = args.search?.trim().toLowerCase();
    const filtered = published.filter((material) => {
      if (material.status !== "disponible" || material.price <= 0) return false;
      if (args.category && material.category !== args.category) return false;
      if (args.family && material.family !== args.family) return false;
      if (args.subcategory && material.subcategory !== args.subcategory) return false;
      if (args.unit && material.unit !== args.unit) return false;
      if (args.condition && material.condition !== args.condition) return false;
      if (args.depot && material.depot !== args.depot) return false;
      if (!search) return true;
      return [
        material.title,
        material.description,
        material.category,
        material.family,
        material.subcategory,
        material.brand,
        material.material,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search);
    });

    return await Promise.all(filtered.map((material) => withPhotoUrls(ctx, material)));
  },
});

export const getPublicMaterial = query({
  args: { id: v.id("btMaterials") },
  handler: async (ctx, { id }) => {
    const material = await ctx.db.get(id);
    if (!material || !material.published || material.price <= 0) return null;
    return await withPhotoUrls(ctx, material);
  },
});

/** Filtres de la boutique, calculés sur le catalogue réellement en ligne. */
export const shopFacets = query({
  args: {},
  handler: async (ctx) => {
    const published = await ctx.db
      .query("btMaterials")
      .withIndex("by_published", (q) => q.eq("published", true))
      .collect();
    const available = published.filter((material) => material.status === "disponible");
    const unique = (values: Array<string | undefined>) =>
      [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) =>
        a.localeCompare(b, "fr"),
      );
    return {
      categories: unique(available.map((material) => material.category)),
      depots: unique(available.map((material) => material.depot)),
      units: unique(available.map((material) => material.unit)),
      total: available.length,
    };
  },
});

/* ─── Ventes ───────────────────────────────────────────────────────────────
 *
 * Deux chemins, un seul compte Stripe (celui de la Recyclerie pour l'instant) :
 * en boutique, le client paie en ligne par Stripe Checkout ; au dépôt, il scanne
 * le QR code de l'étiquette et l'équipe encaisse au terminal.
 *
 * Le montant n'est jamais calculé par le navigateur : il est recalculé ici, à
 * partir du prix du catalogue et de la quantité demandée.
 */

const customerValidator = v.object({
  firstName: v.string(),
  lastName: v.string(),
  email: v.string(),
  phone: v.optional(v.string()),
  company: v.optional(v.string()),
});

async function nextOrderReference(ctx: { db: { query: (t: "btOrders") => any } }) {
  const all = await ctx.db.query("btOrders").collect();
  return `BT${String(all.length + 1).padStart(5, "0")}`;
}

/** Commande en attente de paiement : c'est elle qui fige prix et quantité. */
export const createOrder = internalMutation({
  args: {
    materialId: v.id("btMaterials"),
    quantity: v.number(),
    customer: customerValidator,
    channel: v.union(v.literal("boutique"), v.literal("terminal")),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const material = await ctx.db.get(args.materialId);
    if (!material) throw new ConvexError("Matériau introuvable.");
    if (material.status !== "disponible") {
      throw new ConvexError(`« ${material.title} » n'est plus disponible.`);
    }
    if (material.price <= 0) throw new ConvexError("Ce matériau n'a pas de prix.");
    const quantity = Math.max(0, Number(args.quantity) || 0);
    if (quantity <= 0) throw new ConvexError("Indiquez une quantité.");
    if (quantity > material.quantity) {
      throw new ConvexError(
        `Stock insuffisant : ${material.quantity} ${material.unit} disponible.`,
      );
    }

    const amountCents = Math.round(material.price * quantity * 100);
    if (amountCents <= 0) throw new ConvexError("Le montant doit être supérieur à 0 €.");

    const orderId = await ctx.db.insert("btOrders", {
      reference: await nextOrderReference(ctx),
      materialId: args.materialId,
      materialTitle: material.title,
      quantity,
      unit: material.unit,
      unitPrice: material.price,
      amountCents,
      customer: { ...args.customer, email: args.customer.email.trim().toLowerCase() },
      channel: args.channel,
      status: "en_attente",
      userId: args.userId,
      createdAt: Date.now(),
    });
    return { orderId, amountCents, title: material.title, unit: material.unit };
  },
});

export const attachStripeSession = internalMutation({
  args: { orderId: v.id("btOrders"), stripeSessionId: v.string() },
  handler: async (ctx, { orderId, stripeSessionId }) => {
    await ctx.db.patch(orderId, { stripeSessionId });
  },
});

/**
 * Encaissement d'une commande : la vente est enregistrée et le stock diminue.
 *
 * Idempotent — Stripe peut rejouer un retour, et le client peut recharger la
 * page de confirmation : une commande déjà payée ne décrémente pas deux fois.
 */
export const markOrderPaid = internalMutation({
  args: { orderId: v.id("btOrders"), stripePaymentIntentId: v.optional(v.string()) },
  handler: async (ctx, { orderId, stripePaymentIntentId }) => {
    const order = await ctx.db.get(orderId);
    if (!order) throw new ConvexError("Commande introuvable.");
    if (order.status === "payee") return { alreadyPaid: true };

    await ctx.db.patch(orderId, {
      status: "payee",
      stripePaymentIntentId,
      paidAt: Date.now(),
    });

    const material = await ctx.db.get(order.materialId);
    if (material) {
      const remaining = Math.max(0, material.quantity - order.quantity);
      await ctx.db.patch(order.materialId, {
        quantity: remaining,
        // Plus de stock : le matériau sort de la boutique de lui-même, sinon
        // il continuerait d'attirer des acheteurs vers un lot déjà parti.
        status: remaining === 0 ? "vendu" : material.status,
        updatedAt: Date.now(),
      });
    }
    return { alreadyPaid: false };
  },
});

export const orderById = internalQuery({
  args: { orderId: v.id("btOrders") },
  handler: async (ctx, { orderId }) => await ctx.db.get(orderId),
});

/** Ouvre le paiement en ligne d'un matériau (boutique). */
export const startCheckout = action({
  args: {
    materialId: v.id("btMaterials"),
    quantity: v.number(),
    customer: customerValidator,
    returnUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{ checkoutUrl: string; orderId: Id<"btOrders"> }> => {
    const secretKey = recycappSecretKey();
    const email = args.customer.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new ConvexError("Adresse email invalide.");
    if (!args.customer.firstName.trim() || !args.customer.lastName.trim()) {
      throw new ConvexError("Indiquez votre prénom et votre nom.");
    }

    const identity = await ctx.auth.getUserIdentity();
    const order: {
      orderId: Id<"btOrders">;
      amountCents: number;
      title: string;
      unit: string;
    } = await ctx.runMutation(internal.batire.createOrder, {
      materialId: args.materialId,
      quantity: args.quantity,
      customer: { ...args.customer, email },
      channel: "boutique",
      userId: identity?.subject,
    });

    const returnUrl = new URL(args.returnUrl);
    returnUrl.searchParams.set("order_id", order.orderId);
    const session = await stripeRequest<{ id: string; url: string }>(
      "checkout/sessions",
      secretKey,
      {
        mode: "payment",
        success_url: `${returnUrl.toString()}&status=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${returnUrl.toString()}&status=cancelled`,
        locale: "fr",
        customer_email: email,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "eur",
        "line_items[0][price_data][unit_amount]": String(order.amountCents),
        "line_items[0][price_data][product_data][name]": order.title,
        "line_items[0][price_data][product_data][description]": `${args.quantity} ${order.unit}`,
        "metadata[orderId]": order.orderId,
        "metadata[source]": "batire-boutique",
        "payment_intent_data[metadata][orderId]": order.orderId,
        "payment_intent_data[metadata][source]": "batire-boutique",
      },
    );

    await ctx.runMutation(internal.batire.attachStripeSession, {
      orderId: order.orderId,
      stripeSessionId: session.id,
    });
    return { checkoutUrl: session.url, orderId: order.orderId };
  },
});

/** Confirme la commande au retour de Stripe, statut relu chez eux. */
export const confirmCheckout = action({
  args: { orderId: v.id("btOrders"), sessionId: v.string() },
  handler: async (ctx, args): Promise<{ reference: string }> => {
    const secretKey = recycappSecretKey();
    const session = await stripeRequest<{
      payment_status?: string;
      payment_intent?: string;
      metadata?: { orderId?: string };
    }>(`checkout/sessions/${args.sessionId}`, secretKey);

    if (session.metadata?.orderId !== args.orderId) {
      throw new ConvexError("Ce paiement ne correspond pas à la commande.");
    }
    if (session.payment_status !== "paid") {
      throw new ConvexError("Paiement non confirmé par Stripe.");
    }

    await ctx.runMutation(internal.batire.markOrderPaid, {
      orderId: args.orderId,
      stripePaymentIntentId:
        typeof session.payment_intent === "string" ? session.payment_intent : undefined,
    });
    const order = await ctx.runQuery(internal.batire.orderById, { orderId: args.orderId });
    return { reference: order?.reference ?? "" };
  },
});

export const listOrders = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_DEMANDES, "read");
    return await ctx.db.query("btOrders").order("desc").take(300);
  },
});

/* ─── QR codes ─────────────────────────────────────────────────────────────── */

async function claimQr(
  ctx: { db: any },
  reference: string,
  materialId: Id<"btMaterials">,
) {
  const normalized = reference.trim().toUpperCase();
  const code = await ctx.db
    .query("btQrCodes")
    .withIndex("by_reference", (q: any) => q.eq("reference", normalized))
    .unique();
  if (!code) return;
  if (code.materialId && String(code.materialId) !== String(materialId)) {
    throw new ConvexError(`Le QR code ${normalized} est déjà utilisé par un autre matériau.`);
  }
  await ctx.db.patch(code._id, { materialId });
}

export const listQrCodes = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_MATERIAUX, "read");
    const codes = await ctx.db.query("btQrCodes").order("desc").collect();
    return await Promise.all(
      codes.map(async (code) => ({
        ...code,
        materialTitle: code.materialId
          ? (await ctx.db.get(code.materialId))?.title ?? null
          : null,
      })),
    );
  },
});

export const generateQrCodes = mutation({
  args: { count: v.number() },
  handler: async (ctx, { count }) => {
    await requireCrmPermission(ctx, PAGE_MATERIAUX, "create");
    const identity = await requireUser(ctx);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      throw new ConvexError("Générez entre 1 et 200 QR codes à la fois.");
    }
    const existing = await ctx.db.query("btQrCodes").collect();
    let next = existing.length + 1;
    const created: string[] = [];
    for (let index = 0; index < count; index++) {
      // Référence courte et lisible à l'œil : elle est imprimée sous le code.
      const reference = `BT-${String(next++).padStart(5, "0")}`;
      await ctx.db.insert("btQrCodes", {
        reference,
        createdBy: formatUserName(identity),
        createdAt: Date.now(),
      });
      created.push(reference);
    }
    return created;
  },
});

/** Matériau derrière un QR code scanné, pour la vitrine comme pour l'équipe. */
export const materialByQr = query({
  args: { reference: v.string() },
  handler: async (ctx, { reference }) => {
    const code = await ctx.db
      .query("btQrCodes")
      .withIndex("by_reference", (q) => q.eq("reference", reference.trim().toUpperCase()))
      .unique();
    if (!code?.materialId) return null;
    const material = await ctx.db.get(code.materialId);
    if (!material) return null;
    return await withPhotoUrls(ctx, material);
  },
});

/* ─── Génération de l'annonce par l'IA ─────────────────────────────────────── */

export const assertCanAnalyze = internalQuery({
  args: {},
  handler: async (ctx) => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, PAGE_MATERIAUX, "create")) {
      throw new ConvexError("Accès CRM insuffisant.");
    }
    return null;
  },
});

type MaterialAnalysis = {
  title: string;
  description: string;
  category: string;
  family?: string | null;
  subcategory?: string | null;
  productLabel?: string | null;
  productKeywords?: string[] | null;
  condition: string;
  unit: string;
  quantity?: number | null;
  price?: number | null;
  packaging?: string | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  thicknessMm?: number | null;
  weightKg?: number | null;
  brand?: string | null;
  modelReference?: string | null;
  material?: string | null;
  color?: string | null;
  standards?: string | null;
  technicalNotes?: string | null;
  aiConfidence?: number | null;
  aiNotes?: string | null;
};


/**
 * Arborescence du catalogue sur trois niveaux : catégorie → famille →
 * sous-famille. Référentiel métier, identique côté application.
 * 15 catégories · 114 familles · 578 sous-familles.
 */
export const BT_TAXONOMY: Record<string, Record<string, string[]>> = {
  "Équipement de protection, sécurité": {
    "Vêtements & pantalon de travail": [
      "Pantalons",
      "Sweat",
      "Gilets",
      "Veste Softshell",
      "Polaires",
      "Manteaux",
      "Vêtements de pluie",
      "Vêtements à usage unique",
      "Ceintures",
      "Bonnet",
      "Genouillères"
    ],
    "Harnais & kit antichute": [
      "Harnais",
      "Kits anti-chute",
      "Anti-chute",
      "Lignes de vie",
      "Longes",
      "Connecteurs"
    ],
    "Chaussures de sécurité, chaussettes": [
      "Chaussures de sécurité pour homme",
      "Lacets",
      "Chaussettes"
    ],
    "Gants de protection": [
      "Gants de manutention générale",
      "Gants de manutention de précision"
    ]
  },
  "Matériel de chantier": {
    "Bétonnières & accessoires": [
      "Bétonnière",
      "Accessoires pour bétonnières",
      "Accessoires pour bétonnière"
    ],
    "Protection de chantier": [
      "Adhésif de signalisation",
      "Panneaux de signalisation",
      "Traceurs chantier",
      "Equipement chantier",
      "Equipement Parking",
      "Equipement de voirie",
      "Mobilier Urbain",
      "Equipement pour collectivités",
      "Balisage, Piquets",
      "Bâches, films"
    ],
    "Accès, travail en hauteur": [
      "Marchepieds, escabeaux",
      "Plates-formes",
      "Echelles",
      "Echafaudage & accessoires",
      "Echafaudage",
      "Accessoires echafaudage"
    ],
    "Téléphones, tablettes de chantier & accessoires": [
      "Accessoires smartphone",
      "Smartphones et tablettes"
    ],
    "Diables, transpalettes": [
      "Diables, tranpalettes"
    ],
    "Compresseurs & accessoires": [
      "Compresseurs & accessoires"
    ],
    "Aménagement et équipement d'atelier": [],
    "Vibration, décapage & compactage béton": [],
    "Chauffage & traitement de l'air": [
      "Canon à air chaud, radiant gaz",
      "Ventilateur, extracteur air"
    ],
    "Nettoyage de chantier": [],
    "Alimentation et éclairage de chantier": [
      "Groupes électrogènes & accessoires",
      "Alimentation électrique",
      "Eclairage de chantier"
    ],
    "Confort du chantier": [
      "Sac de charbon",
      "Jerricans",
      "Sel de déneigement",
      "Granulés bois, allume feux, sac bûches",
      "Bûche de ramonage",
      "Graisse",
      "Gaz pour camping"
    ]
  },
  "Bois et panneaux": {
    "Panneau et dalle bois brut": [
      "Panneau contreplaqué",
      "Panneau et dalle OSB (plaque)",
      "Panneau et dalle particules (aggloméré)",
      "Panneau MDF",
      "Panneau lamellé-collé et panneau 3 plis",
      "Panneau technique Construction ossature bois",
      "Panneau PVC expansé"
    ],
    "Panneau décoratif, menuiserie et agencement": [
      "Panneau mélaminé",
      "Panneaux stratifiés",
      "Panneau PVC expansé",
      "Tablette mélaminé",
      "Bande de chant",
      "Essences fines",
      "Plan de travail bois",
      "Placage"
    ],
    "Bois de construction": [
      "Bois de charpente",
      "Bois de couverture",
      "Montant d'ossature bois",
      "Bois massif reconstitué",
      "Bois de chauffage"
    ],
    "Bois de coffrage": [
      "Bastaing de coffrage",
      "Chevron de coffrage",
      "Madrier de coffrage",
      "Piquet",
      "Planche de coffrage",
      "Planche rouge",
      "Plateau maçon"
    ],
    "Bois de menuiserie": [
      "Plot de bois",
      "Bois de menuiserie brute",
      "Carrelets menuiserie",
      "Lames à volet, barres, écharpes"
    ]
  },
  "Portes, fenêtres, menuiserie": {
    "Portes d'intérieur, bloc-portes": [
      "Portes d'intérieur, bloc-portes Déco",
      "Portes d'intérieur, bloc-portes planes",
      "Portes d'intérieur, bloc-portes techniques"
    ],
    "Huisseries": [
      "Huisseries/batis bois",
      "Autres produits - Huisseries C/CC",
      "Huisseries fin de chantier et C/CC"
    ],
    "Placards, dressing": [
      "Aménagement de placard",
      "Portes de placard",
      "Séparation de pièces"
    ],
    "Grilles, stores, marquises": [
      "Balconnet",
      "Grilles de défense et gardes corps",
      "Marquises",
      "Stores et occultations"
    ],
    "Portes d'entrée et de service": [
      "Portes d'entrée",
      "Portes de service"
    ],
    "Portes coulissantes, systèmes coulissants": [
      "Systèmes coulissants en applique",
      "Systèmes coulissants à galandage",
      "Accessoires pour systèmes coulissants"
    ],
    "Escaliers et échelles": [
      "Accessoires escaliers",
      "Echelles",
      "Escaliers"
    ],
    "Fenêtres de toit (Velux et et autres marques)": [
      "Fenêtres de toit (Velux et autres marques) dimensions standard",
      "Fenêtres de toit (Velux et autres marques) hors dimensions standard",
      "Fenêtres pour toit plat",
      "Fenêtres pour verrières",
      "Fenêtres zinc",
      "Meneaux pour fenêtres patrimoine",
      "Rénovation de fenêtres de toit",
      "Châssis",
      "Commandes électriques fenêtres de toit",
      "Pièces détachées fenêtres de toit",
      "Accessoires communs fenêtres de toit",
      "Isolation pour fenêtres de toit"
    ],
    "Tertiaire": [
      "Porte grand passage"
    ],
    "Volets": [
      "Volets roulants",
      "Volets battants",
      "Volets coulissants",
      "Persiennes",
      "Coffres de volets roulants"
    ],
    "Portes de garage": [
      "Portes de garage basculantes",
      "Portes de garage sectionnelles",
      "Portes de garage à enroulement",
      "Motorisation de portes de garage",
      "Accessoires portes de garage",
      "Abris et carport"
    ],
    "Fenêtres et portes-fenêtres sur mesure": [
      "Fenêtres et porte-fenêtres PVC",
      "Fenêtres et porte-fenêtres aluminium",
      "Fenêtres et porte-fenêtres bois",
      "Fenêtres et porte-fenêtres mixtes aluminium bois",
      "Formes particulières (demi-lune, oeil de boeuf)",
      "Accessoires pour fenêtres et portes-fenêtres"
    ],
    "Portails": [
      "Portails en aluminium",
      "Portails en PVC",
      "Portails composites",
      "Automatismes de portails",
      "Portillons"
    ]
  },
  "Terrasses et extérieurs": {
    "Terrasse bois, carrelage, sol extérieur": [
      "Terrasse bois",
      "Carrelage extérieur (terrasse, piscine)",
      "Dalles pierre reconstituée, béton ou terre cuite",
      "Dalles pierre naturelle",
      "Dalles gazon et graviers",
      "Pavés béton et pierre naturelle",
      "Agrégats décoratifs"
    ],
    "Clôtures": [
      "Clôtures bois, béton, métal",
      "Grillage et occultation",
      "Chaperons, chapeaux et piliers béton, pierre reconstituée et aluminium",
      "Garde-corps et balustrades"
    ],
    "Produits de mise en oeuvre extérieur": [
      "Produits de mise en oeuvre aménagement extérieur",
      "Produits de mise en oeuvre terrasses bois",
      "Accessoires dalles et pavés",
      "Accessoires clôtures",
      "Accessoires grillage",
      "Accessoires garde-corps",
      "Accessoires parements",
      "Produits d'entretien et de traitement"
    ],
    "Entretien de piscine": [
      "Produits de traitement et accessoires piscine",
      "Pompes et matériel électrique",
      "Liner et pvc armé",
      "Peinture et enduit piscine"
    ],
    "Murs extérieurs": [
      "Plaquettes de parement",
      "Gabion",
      "Murs et blocs végétalisables"
    ],
    "Décoration du jardin": [
      "Mobilier de jardin",
      "Bordures",
      "Pas japonais",
      "Galets et gravillons pour le jardin",
      "Traverses",
      "Eclairage de jardin",
      "Palis et piquets"
    ],
    "Portails": [
      "Portails en aluminium",
      "Portails en PVC",
      "Portails composites",
      "Automatismes de portails",
      "Portillons"
    ]
  },
  "Salle de bain, WC, sanitaires": {
    "Meubles salle de bain": [
      "Meuble vasque salle de bain",
      "Meuble rangement salle de bain",
      "Meuble lave-main",
      "Miroir et armoire de toilette",
      "Accessoires salle de bain",
      "Meubles Salle de bain"
    ],
    "Robinetterie": [
      "Kit de douche encastrable",
      "Robinets pour douche",
      "Robinets pour baignoire",
      "Robinets pour lavabo",
      "Robinets techniques",
      "Vidage et siphon"
    ],
    "Douche": [
      "Cabine de douche",
      "Colonne de douche",
      "Paroi de douche",
      "Receveur de douche",
      "Barre et pommeau de douche",
      "Accessoires de douche"
    ],
    "Cuisine": [
      "Meuble sous évier",
      "Evier",
      "Robinets évier de cuisine"
    ],
    "Lavabo et vasque": [
      "Lavabo",
      "Vasque",
      "Lave-main"
    ],
    "WC": [
      "Packs WC",
      "WC suspendus",
      "Bidet, urinoir",
      "Accessoires WC",
      "Robinetterie WC",
      "Chasse d'eau",
      "Réservoir",
      "Broyeurs"
    ],
    "Collectivité": [
      "WC collectivité",
      "Robinetterie de collectivité"
    ]
  },
  "Autres revêtements sol et mur": {
    "Parquet": [
      "Parquet massif",
      "Parquet contrecollé"
    ],
    "Vinyles (PVC, lino)": [
      "Sol PVC imitation parquet ou bois en lame",
      "Sol PVC imitation carrelage ou béton",
      "Sol PVC autres décors",
      "Sols Vinyles à la coupe",
      "Revêtement minéral composite"
    ],
    "Plinthes et accessoires autres revêtements": [
      "Plinthes et accessoires sol stratifié",
      "Plinthes et accessoires sol PVC",
      "Plinthes et accessoires parquet contrecollé",
      "Plinthes bois",
      "Plinthes blanches",
      "Plinthes alu",
      "Accessoires de pose parquet massif"
    ],
    "Sol stratifié": [
      "Sol stratifié bois foncé",
      "Sol stratifié bois naturel",
      "Sol stratifié bois gris",
      "Sol stratifié bois blanchi",
      "Sol stratifié pierre"
    ],
    "Moquette et fibres naturelles": [
      "Jonc de mer",
      "Moquette",
      "Sisal"
    ],
    "Lambris": [
      "Lambris bois",
      "Lambris PVC",
      "Accessoires lambris PVC"
    ],
    "Produits de mise en œuvre intérieur": [
      "Préparation des sols",
      "Isolation phonique sol",
      "Colle (parquet, sol souple)",
      "Nez de marche, profilés, barres de seuil",
      "Tasseaux et moulures",
      "Produits d'entretien et de traitement",
      "Trappes, couvercles, divers",
      "Confort et accessibilité"
    ]
  },
  "Carrelage intérieur": {
    "Carrelage sol intérieur": [
      "Carrelage imitation pierre",
      "Carrelage imitation béton",
      "Carrelage imitation parquet ou bois",
      "Carrelage imitation marbre",
      "Carrelage hexagonal",
      "Carrelage uni",
      "Carrelage décor",
      "Carrelage sol grand format",
      "Carrelage technique"
    ],
    "Carrelage mur salle de bain, crédence cuisine, faïence": [
      "Carrelage mur uni",
      "Carrelage mur imitation pierre",
      "Carrelage mur imitation béton",
      "Carrelage mur motifs",
      "Carrelage métro",
      "Carrelage mur imitation bois",
      "Carrelage mur imitation marbre",
      "Carrelage mur hexagonal"
    ],
    "Carrelage grand format et XXL": [
      "Carrelage grand format et XXL imitation pierre",
      "Carrelage grand format et XXL imitation béton",
      "Carrelage grand format et XXL imitation bois",
      "Carrelage grand format et XXL imitation marbre",
      "Carrelage grand format et XXL uni et décor"
    ],
    "Plinthes et accessoires carrelage": [
      "Plinthes et accessoires sol effet béton",
      "Plinthes et accessoires sol effet pierre",
      "Plinthes et accessoires sol effet uni",
      "Plinthes et accessoires sol effet bois",
      "Plinthes et accessoires carrelage technique",
      "Plinthes et accessoires sol effet marbre"
    ],
    "Mosaïque, galet, listel": [
      "Mosaïque",
      "Listel",
      "Galet"
    ],
    "Carreaux ciment": [
      "Carreaux de ciment",
      "Imitation carreaux de ciment"
    ],
    "Produits de mise en oeuvre carrelage": [
      "Colles à carrelage",
      "Etanchéité sous carrelage",
      "Croisillons",
      "Joint carrelage"
    ]
  },
  "Toiture": {
    "Tuiles": [
      "Tuiles terre cuite",
      "Tuiles béton",
      "Tuiles de verre",
      "Fixations des tuiles",
      "Accessoires tuiles"
    ],
    "Etanchéité, traitement de toiture": [
      "Etanchéité bitume",
      "Etanchéité synthétique",
      "Etanchéité liquide",
      "Etanchéité toits plats",
      "Accessoires communs d'étanchéité",
      "Traitement de toiture"
    ],
    "Fenêtres de toit (Velux et autres marques)": [
      "Fenêtres de toit (Velux et autres marques) dimensions standard",
      "Fenêtres de toit (Velux et autres marques) hors dimensions standard",
      "Fenêtres pour toit plat",
      "Fenêtres pour verrières",
      "Fenêtres zinc",
      "Meneaux pour fenêtres patrimoine",
      "Rénovation de fenêtres de toit",
      "Châssis",
      "Commandes électriques fenêtres de toit",
      "Pièces détachées fenêtres de toit",
      "Accessoires communs fenêtres de toit",
      "Isolation pour fenêtres de toit"
    ],
    "Conduits de fumée et tubage": [
      "Aération & désenfumage",
      "Fumisterie"
    ],
    "Ardoises, bardeaux": [
      "Ardoises naturelles",
      "Ardoises manufacturées",
      "Fixations ardoises",
      "Bardeaux",
      "Accessoires pour ardoises et bardeaux"
    ],
    "Gouttières, zinguerie": [
      "Gouttières et descentes zinc",
      "Gouttières et descentes PVC",
      "Gouttières galvanisées",
      "Gouttières et descentes cuivre",
      "Gouttières et descentes inox",
      "Evacuation d'eau de pluie pour toit plat (boîtes à eaux)",
      "Accessoires communs gouttières et descentes"
    ],
    "Photovoltaïque": [],
    "ITE, isolation des toitures": [
      "Sarking",
      "Caissons chevronnés",
      "Panneaux sandwich",
      "Accessoires ITE toiture"
    ],
    "Toitures métalliques": [
      "Bacs acier",
      "Toitures en cuivre",
      "Toitures en inox",
      "Toitures en zinc",
      "Toitures en plomb",
      "Toitures aluminium",
      "Fixations toitures métalliques",
      "Joints d'étanchéité toitures métalliques"
    ],
    "Composants de toiture": [
      "Abergement",
      "Accessoires d'égoût",
      "Bandes d'étanchéité",
      "Closoirs de faîtage",
      "Ecrans sous toiture",
      "Noues",
      "Pare-pluie",
      "Ornements",
      "Solins d'abergement",
      "Dispositifs arrêt neige",
      "Anti oiseaux"
    ],
    "Bardage, clins, panneaux": [
      "Bardage bois",
      "Bardage fibre-ciment",
      "Bardage PVC",
      "Bardage fibre de bois",
      "Bardage bois composite",
      "Bardage compact HPL"
    ],
    "Plaques de toiture": [
      "Plaques support de tuile",
      "Plaques ondulées grandes ondes",
      "Plaques ondulées petites ondes",
      "Plaques planes"
    ],
    "Bandeau de rive et sous-face": [
      "Planche de rive Bois",
      "Bandeaux de rive PVC - Accessoires",
      "Lambris Sous-face Bois",
      "Lambris Sous-face PVC",
      "Autres produis planches/bandeaux de rives",
      "Protège panne"
    ]
  },
  "Plâtre, isolation, plafonds": {
    "Plaques de plâtre et cloisons": [
      "Plaques de plâtre standard (BA13, BA15...)",
      "Plaques hydrofuges & environnement très humide",
      "Plaques acoustiques",
      "Plaques plafond",
      "Plaques pré-peintes",
      "Plaques feu",
      "Plaques haute dureté, sol et renforcées",
      "Plaques air pur",
      "Plaques multifonctions",
      "Carreaux de plâtre,terre cuite, béton cellulaire, autres cloisons"
    ],
    "ITI ( Isolation Thermique par l'Intérieur)": [
      "Doublage collé PSE",
      "Doublage collé laine minérale",
      "Doublage collé polyuréthane",
      "Laine de verre mur",
      "Laine de roche mur",
      "Panneaux polystyrène",
      "Polyuréthane mur",
      "Isolants alvéolaires",
      "Laine minérale ossature bois",
      "Isolant sous vide",
      "Accessoires ITI"
    ],
    "Plafonds": [
      "Dalles plafonds",
      "Ossatures plafonds",
      "Plaques pour plafond",
      "Accessoires plafonds",
      "Trappes plafonds",
      "Isolation plafonds",
      "Autres dalles de plafond"
    ],
    "Isolation phonique des murs": [
      "Laine de verre acoustique standard largeur 600mm",
      "Laine de verre acoustique technique largeur 900mm",
      "Laine de roche acoustique",
      "Isolants biosourcés pour cloisons",
      "Autres produits - Pour cloison",
      "Laine minérale acoustique",
      "Doublage mince acoustique"
    ],
    "Plâtres, enduits, mortiers": [
      "Plâtres (manuel, à projeter) et accessoires",
      "Enduits et mortiers",
      "Accessoires plâtres, enduits et mortiers"
    ],
    "Isolants biosourcés et naturels": [
      "Fibre de bois",
      "Ouate de cellulose",
      "Chanvre",
      "Ouate de polyester",
      "Laine de coton",
      "Liège",
      "Autres isolants biosourcés",
      "Accessoires isolants biosourcés"
    ],
    "Isolation des toitures": [
      "Isolation des combles",
      "Isolants minces",
      "Isolation des toits terrasses",
      "Toiture - sarking"
    ],
    "Ossatures métalliques et accessoires": [
      "Ossatures métalliques",
      "Accessoires plaques de plâtre"
    ],
    "ITE (Isolation Thermique par l'Extérieur)": [
      "ITE finition enduit",
      "ITE finition bardage - panneaux",
      "ITE sous bardage ventilé",
      "ITE : enduits de façade"
    ],
    "Isolation des sols": [
      "Polystyrène expansés sols",
      "Polystyrène extrudés sols",
      "Polyurethane sols",
      "Laine minérale sols",
      "Accessoires isolation des sols"
    ],
    "Isolation hottes et équipement thermiques industriels": [
      "Laine de verre - Lambda 40",
      "Laine de verre - Lambda 35",
      "Laine de roche - Lambda 34",
      "Polyuréthane",
      "Équipements thermiques industriels"
    ]
  },
  "Matériaux, gros oeuvre": {
    "Matériaux de construction": [
      "Blocs béton cellulaire",
      "Parpaings",
      "Briques",
      "Ciment chaux",
      "Mortiers, bétons secs, BPE",
      "Plâtres & enduits",
      "Agrégats (sable, gravier, gravillons)",
      "Aciers (treillis soudé, rond à béton, armature)",
      "Linteaux et prélinteaux",
      "Appuis de fenêtre, seuils, produits béton préfabriqués",
      "Boisseaux de cheminée",
      "Coffrage (Panneaux et carton de coffrage)",
      "Parements",
      "Etanchéité et protection",
      "Chimie du bâtiment (ragréage, mortier de réparation)"
    ],
    "Voirie, TP": [
      "Fonte de voirie",
      "Bordures et caniveaux",
      "Regards et boîtes",
      "Tuyaux, raccords et drains",
      "Géotextiles voirie TP",
      "Réseaux secs",
      "Adduction d'eau",
      "Mobilier urbain",
      "Soutènement et tallutage",
      "Produits de mise en oeuvre VRD"
    ],
    "Assainissement": [
      "Caniveaux bâtiment",
      "Drainage, épandage et filtration",
      "Equipement des sols PVC",
      "Fosses, microstations et filtres compacts",
      "Géotextiles assainissement",
      "Récupération des eaux pluviales",
      "Regards et buses d'assainissement",
      "Traitement des eaux",
      "Tubes et raccords PVC pour l'assainissement",
      "Assainissement non collectif (ANC)"
    ],
    "Planchers, dallages, chapes": [
      "Poutrelles précontraintes",
      "Entrevous (hourdis)",
      "Planelles",
      "Poutres béton",
      "Planchers collaborants",
      "Accessoires pour poutrelles",
      "Chapes allégées"
    ]
  },
  "Quincaillerie générale de bâtiment": {
    "Connecteurs metalliques": [
      "Connecteur métallique assemblage bois"
    ]
  },
  "Peinture, mastic, droguerie": {
    "Peinture": [
      "Peinture intérieure",
      "Peinture extérieure",
      "Bombe, peinture aérosol",
      "Peinture et traitement bois",
      "Peinture et traitement métal",
      "Enduis, mortier, plâtre",
      "Toile de verre"
    ],
    "Mastics, colles, mousses": [
      "Mastics, joints",
      "Colles",
      "Mousses expansives",
      "Adhésifs, rubans",
      "Pistolets mastic, calfeutrage & acccessoires"
    ],
    "Droguerie et entretien": [
      "Solvants, lessivage",
      "Eponges, chiffons, serpillères",
      "Balais, brosses, raclettes"
    ]
  },
  "Plomberie": {
    "Raccords laiton": [
      "Raccord laiton à visser",
      "Raccords automatiques"
    ],
    "Tubes et raccords PE": [
      "Tubes PE",
      "Raccords PE"
    ],
    "Accessoires plomberie": [
      "Joints plomberie",
      "Flexible",
      "Robinet d'arrêt",
      "Nourrice plomberie",
      "Manomètre, régulation de pression d'eau",
      "Collier de serrage, rosace, patte à vis",
      "Accessoires Salle de bain"
    ],
    "Accessoires chauffe-eaux": [
      "Accessoires Chauffe-eau",
      "Accessoires chaudière",
      "Accessoires radiateurs"
    ],
    "Tubes et raccords PER": [
      "Tubes PER",
      "Raccords PER"
    ],
    "Tubes et raccords PVC Evacuation d'eau": [
      "Tubes PVC",
      "Raccords PVC",
      "Colle PVC"
    ],
    "Raccordement gaz": [
      "Gaz naturel",
      "Gaz Butane",
      "Gaz Propane",
      "Accessoires gaz"
    ],
    "Tubes et raccords multicouches": [
      "Tubes multicouches",
      "Raccords multicouches"
    ],
    "Tubes et raccords cuivre": [
      "Tubes cuivre",
      "Raccords cuivre"
    ],
    "Plomberie sanitaires": [
      "Abattants WC",
      "Accessoires WC",
      "Accessoires salle de bain",
      "Accessoires robinetterie",
      "Accessoires machine à laver",
      "Accessoires de cuisine"
    ],
    "Outils du plombier": [
      "Déboucheur de canalisation",
      "Etancheité plomberie",
      "Pince à sertir, clé lavabo",
      "Coupe tube pour plombier"
    ]
  },
  "Électricité, ventilation": {
    "Radiateur électrique": [
      "Radiateur à inertie",
      "Radiateur rayonnant",
      "Thermostat",
      "Sèche-serviette"
    ],
    "Matériel électrique": [
      "Tableau électrique",
      "Coffret électrique",
      "Disjoncteur",
      "Delesteur électrique",
      "Coffret de communication",
      "Coupe circuit",
      "Interrupteur sectionneur",
      "Fusible",
      "Parafoudre",
      "Télérupteur",
      "Contacteur",
      "Répartiteur",
      "Interrupteur différentiel",
      "Déclencheur",
      "Commandes",
      "Bloc différentiel",
      "Protection modulaire - autres produits"
    ],
    "Gaines et câbles électriques": [
      "Fils et câbles électriques",
      "Goulotte électrique",
      "Gaine électrique",
      "Fixation cable électrique",
      "Borne et domino électrique",
      "Boite de dérivation",
      "Enrouleur, rallonge et multiprise",
      "Boite d'encastrement",
      "Mise à la terre",
      "Gaines et câbles électriques - autres produits"
    ],
    "Outils électricien, multimètre": [
      "Multimètre",
      "Couteau, pince, tournevis électricien",
      "Outillage de l'électricien - autres produits"
    ],
    "Eclairage": [
      "Eclairage extérieur",
      "Ampoule, lampe",
      "Starter néon et ballast",
      "Connecteur, douille et accessoires",
      "Eclairage intérieur",
      "Lampe frontale",
      "Lampe torche - baladeuse",
      "Piles",
      "Accessoires éclairage",
      "Eclairage - autres produits"
    ],
    "Domotique, connectique": [
      "Pilotage de l'éclairage",
      "Visiophone et sonnette",
      "Alarme, sécurité",
      "Sécurité et domotique - autres produits"
    ],
    "Traitement et transmission du signal": [
      "Traitement du signal"
    ],
    "Appareillage électrique": [
      "Prises électriques et interrupteurs",
      "Autres produits - Appareillage électrique",
      "Boitier électrique"
    ],
    "Ventilation": [
      "VMC",
      "Extracteurs",
      "Ventilation - autres produits"
    ]
  }
};

export const BT_CATEGORIES = Object.keys(BT_TAXONOMY);

export function btFamilies(category: string) {
  return Object.keys(BT_TAXONOMY[category] ?? {});
}

export function btSubFamilies(category: string, family: string) {
  return BT_TAXONOMY[category]?.[family] ?? [];
}

const UNITS = ["unité", "m²", "m³", "ml", "kg", "tonne", "palette", "sac", "lot"];
const CONDITIONS = ["Neuf", "Déstockage", "Très bon état", "Bon état", "À rénover"];


/** Appel OpenAI en JSON strict, partagé par les deux passes du classement. */
async function callChat<T>(apiKey: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new ConvexError(payload.error?.message ?? "Erreur OpenAI.");
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new ConvexError("Réponse vide du modèle.");
  return JSON.parse(content) as T;
}

/* ─── Classement dans l'arborescence ───────────────────────────────────────
 *
 * Demander à un modèle de choisir parmi 578 sous-familles en une passe donne
 * des résultats inégaux : il invente des libellés voisins, ou renonce et rend
 * null. On procède donc en trois temps, du plus fiable au plus incertain :
 *
 * 1. la vision décrit le matériau (elle est bonne à ça) ;
 * 2. un score lexical local retient les vingt-cinq feuilles les plus proches ;
 * 3. le modèle n'a plus qu'à désigner un NUMÉRO dans cette courte liste.
 *
 * Comme la feuille détermine sa famille et sa catégorie, le chemin est
 * cohérent par construction. Et si le modèle échoue, la meilleure
 * correspondance locale sert de filet : les trois champs restent remplis.
 */

/** Feuille de l'arborescence, avec son chemin complet. */
type Leaf = { category: string; family: string; subFamily: string };

let leafIndex: Array<Leaf & { tokens: Set<string> }> | null = null;
/** Fréquence de chaque mot dans l'arborescence, pour pondérer les rares. */
let tokenFrequency: Map<string, number> | null = null;

const STOPWORDS = new Set([
  "de", "des", "du", "la", "le", "les", "et", "en", "pour", "aux", "au", "a",
  "sur", "sous", "par", "avec", "autres", "autre", "produits", "produit",
  "accessoires", "divers",
]);

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: string) {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

function buildLeafIndex() {
  if (leafIndex && tokenFrequency) return leafIndex;
  const leaves: Array<Leaf & { tokens: Set<string> }> = [];
  for (const [category, families] of Object.entries(BT_TAXONOMY)) {
    for (const [family, subFamilies] of Object.entries(families)) {
      if (subFamilies.length === 0) {
        // Une famille sans sous-famille reste une destination valable.
        leaves.push({
          category,
          family,
          subFamily: "",
          tokens: tokenize(`${category} ${family}`),
        });
        continue;
      }
      for (const subFamily of subFamilies) {
        leaves.push({
          category,
          family,
          subFamily,
          // Le chemin entier nourrit le score : « tuiles » seul est ambigu,
          // « toiture tuiles terre cuite » ne l'est plus.
          tokens: tokenize(`${category} ${family} ${subFamily}`),
        });
      }
    }
  }
  const frequency = new Map<string, number>();
  for (const leaf of leaves) {
    for (const token of leaf.tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  leafIndex = leaves;
  tokenFrequency = frequency;
  return leaves;
}

/**
 * Poids d'un mot : les rares décident, les banals départagent.
 *
 * Sans cela, « béton » — présent dans des dizaines de branches — pèserait
 * autant que « parpaing », qui n'en désigne qu'une.
 */
function tokenWeight(token: string) {
  const total = leafIndex?.length ?? 1;
  return Math.log(total / (1 + (tokenFrequency?.get(token) ?? 0))) + 0.5;
}

/** Feuilles les plus proches d'une description, par recouvrement pondéré. */
function candidateLeaves(query: string, limit = 25) {
  const leaves = buildLeafIndex();
  const queryTokens = [...tokenize(query)];
  if (queryTokens.length === 0) return [];
  const normalizedQuery = normalize(query);

  return leaves
    .map((leaf) => {
      let score = 0;
      for (const token of queryTokens) {
        const weight = tokenWeight(token);
        if (leaf.tokens.has(token)) {
          score += 3 * weight;
          continue;
        }
        // Pluriels et variantes proches : « parpaing » doit rejoindre
        // « parpaings », sans pour autant rapprocher « bloc » de « blocage ».
        const nearMatch = [...leaf.tokens].some(
          (leafToken) =>
            Math.abs(leafToken.length - token.length) <= 3 &&
            Math.min(leafToken.length, token.length) >= 5 &&
            (leafToken.startsWith(token) || token.startsWith(leafToken)),
        );
        if (nearMatch) score += 2.2 * weight;
      }
      // Le libellé de la feuille cité tel quel dans la description l'emporte.
      const leafLabel = normalize(leaf.subFamily || leaf.family);
      if (leafLabel.length > 4 && normalizedQuery.includes(leafLabel)) score += 8;
      return { leaf, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Remplit la fiche d'un matériau à partir de ses photos.
 *
 * L'unité de vente est la décision la plus lourde : elle commande le prix et le
 * stock. Le modèle doit la déduire de la nature du matériau — un isolant au m²,
 * du gravat à la tonne, une porte à l'unité — et non la choisir au hasard.
 */
export const analyzeMaterialPhotos = action({
  args: { storageIds: v.array(v.id("_storage")), extraDetails: v.optional(v.string()) },
  handler: async (ctx, { storageIds, extraDetails }): Promise<MaterialAnalysis> => {
    await ctx.runQuery(internal.batire.assertCanAnalyze, {});
    if (storageIds.length === 0) throw new ConvexError("Aucune photo à analyser.");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ConvexError("Clé OpenAI absente du déploiement Convex.");

    const urls = await Promise.all(storageIds.slice(0, 6).map((id) => ctx.storage.getUrl(id)));
    const imageUrls = urls.filter((url): url is string => Boolean(url));
    if (imageUrls.length === 0) throw new ConvexError("Photos introuvables en stockage.");

    const prompt = `Tu es responsable du dépôt de matériaux de construction de seconde main « Bâtire ».
Analyse toutes les photos ensemble : étiquettes, marquages, sections, état, quantité visible, palettes.
Rédige la fiche d'un professionnel du bâtiment qui vend à d'autres professionnels et à des particuliers avertis : précis, concret, sans emphase commerciale.

RÈGLES ABSOLUES
- N'invente JAMAIS une dimension, une norme, une marque, une matière ou une performance : si ce n'est pas lisible sur la photo ou fourni, mets null.
- L'unité de vente découle de la nature du matériau : isolant, carrelage, parquet, bardage → m² ; sable, gravats, terre → tonne ; bois de charpente, corniche, tube → ml ; béton, remblai → m³ ; porte, fenêtre, radiateur, sanitaire → unité ; ciment, enduit → sac ; lot hétérogène → lot ; conditionnement complet → palette.
- La quantité s'exprime dans cette unité, d'après ce que montrent les photos (nombre de plaques, de palettes, longueur du tas). Dans le doute, null.
- Le prix est un prix POUR UNE UNITÉ de vente, en euros, cohérent avec le marché du réemploi : nettement sous le neuf, ajusté à l'état.
- La description fait 3 à 6 phrases : ce que c'est, ses dimensions et sa matière, son état réel avec ses défauts, ses usages possibles.

Réponds UNIQUEMENT en JSON valide :
{
  "title": "titre court et cherchable : matériau, dimension marquante, matière",
  "description": "3 à 6 phrases",
  "productLabel": "ce qu'est l'objet, en 2 à 6 mots du vocabulaire du bâtiment : « plaque de plâtre BA13 hydrofuge », « tuile terre cuite mécanique », « radiateur électrique à inertie »",
  "productKeywords": ["4 à 8 mots-clés métier décrivant la nature, la matière et l'usage"],
  "condition": "une valeur EXACTE parmi ${JSON.stringify(CONDITIONS)}",
  "unit": "une valeur EXACTE parmi ${JSON.stringify(UNITS)}",
  "quantity": nombre dans cette unité ou null,
  "price": prix pour une unité en euros ou null,
  "packaging": "conditionnement (palette de 60 sacs…) ou null",
  "lengthCm": nombre ou null,
  "widthCm": nombre ou null,
  "heightCm": nombre ou null,
  "thicknessMm": nombre ou null,
  "weightKg": nombre ou null,
  "brand": "marque lue sur l'étiquette ou null",
  "modelReference": "référence fabricant lue ou null",
  "material": "bois, béton, acier, PVC, aluminium, plâtre, terre cuite… ou null",
  "color": "couleur dominante ou null",
  "standards": "normes visibles (CE, NF, classe d'emploi…) ou null",
  "technicalNotes": "caractéristiques techniques lues (lambda, section, résistance…) ou null",
  "aiConfidence": nombre entre 0 et 1,
  "aiNotes": "ce qu'un humain doit vérifier avant publication"
}
${extraDetails?.trim() ? `\nPrécisions de l'équipe, fiables et prioritaires sur la photo : ${extraDetails.trim()}` : ""}`;

    const result = await callChat<MaterialAnalysis>(apiKey, {
      model: "gpt-4o",
      temperature: 0.2,
      max_tokens: 1400,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            ...imageUrls.map((url) => ({
              type: "image_url",
              image_url: { url, detail: "high" },
            })),
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    // Le modèle reste un assistant : on ne laisse entrer que des valeurs du
    // référentiel, sans quoi la fiche serait invalide à l'enregistrement.
    // ── Classement dans l'arborescence ────────────────────────────────
    const description = [
      result.productLabel,
      (result.productKeywords ?? []).join(" "),
      result.title,
      result.material,
      result.brand,
    ]
      .filter(Boolean)
      .join(" ");

    const candidates = candidateLeaves(description);
    let chosen: Leaf | null = null;

    if (candidates.length > 0) {
      const list = candidates
        .map(
          (entry, index) =>
            `${index + 1}. ${entry.leaf.category} › ${entry.leaf.family}${entry.leaf.subFamily ? ` › ${entry.leaf.subFamily}` : ""}`,
        )
        .join("\n");

      // Seconde passe, sans image et sans texte libre : le modèle ne peut plus
      // qu'indiquer un numéro, donc plus rien à mal orthographier.
      const pick = await callChat<{ choice?: number }>(apiKey, {
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 60,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: `Matériau de construction à classer : « ${description} ».

Voici les rangements possibles, du plus au moins probable :
${list}

Réponds {"choice": N} avec le numéro du rangement le plus juste. Si vraiment aucun ne convient, réponds {"choice": 0}.`,
          },
        ],
      }).catch(() => ({ choice: 0 }));

      const index = Number(pick?.choice ?? 0);
      if (Number.isInteger(index) && index >= 1 && index <= candidates.length) {
        chosen = candidates[index - 1].leaf;
      } else {
        // Filet : la meilleure correspondance lexicale plutôt qu'un champ vide.
        chosen = candidates[0].leaf;
      }
    }

    if (chosen) {
      result.category = chosen.category;
      result.family = chosen.family;
      result.subcategory = chosen.subFamily || null;
    } else {
      // Aucune piste : on retombe sur ce que la vision avait proposé, à
      // condition qu'il existe vraiment dans le référentiel.
      if (!BT_CATEGORIES.includes(result.category)) result.category = BT_CATEGORIES[0];
      if (result.family && !btFamilies(result.category).includes(result.family)) {
        result.family = null;
      }
      if (
        result.subcategory &&
        (!result.family ||
          !btSubFamilies(result.category, result.family).includes(result.subcategory))
      ) {
        result.subcategory = null;
      }
    }
    if (!CONDITIONS.includes(result.condition)) result.condition = "Bon état";
    if (!UNITS.includes(result.unit)) result.unit = "unité";
    const positive = (value: unknown) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    result.quantity = positive(result.quantity);
    result.price = positive(result.price);
    result.lengthCm = positive(result.lengthCm);
    result.widthCm = positive(result.widthCm);
    result.heightCm = positive(result.heightCm);
    result.thicknessMm = positive(result.thicknessMm);
    result.weightKg = positive(result.weightKg);
    return result;
  },
});

/* ─── Messagerie ───────────────────────────────────────────────────────────── */

/** Un fil de discussion par client et par matériau. */
function threadKey(clientId: string, materialId: string | undefined) {
  return `${clientId}::${materialId ?? "general"}`;
}

export const sendMessage = mutation({
  args: {
    materialId: v.optional(v.id("btMaterials")),
    body: v.string(),
    /** Fil visé quand l'équipe répond : sans lui, on écrirait à soi-même. */
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireUser(ctx);
    const body = args.body.trim();
    if (!body) throw new ConvexError("Le message est vide.");

    const material = args.materialId ? await ctx.db.get(args.materialId) : null;
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    const fromStaff = accessAllows(access, PAGE_DEMANDES, "read");

    if (fromStaff && !args.clientId) {
      throw new ConvexError("Indiquez le fil auquel répondre.");
    }

    // Le fil appartient au client : quand l'équipe répond, on reprend ses
    // coordonnées du fil existant plutôt que celles du salarié.
    let clientId = args.clientId ?? identity.subject;
    let clientName = formatUserName(identity);
    let clientEmail = identity.email ?? "";
    if (fromStaff && args.clientId) {
      const previous = await ctx.db
        .query("btMessages")
        .withIndex("by_client", (q) => q.eq("clientId", args.clientId!))
        .first();
      clientId = args.clientId;
      clientName = previous?.clientName ?? clientName;
      clientEmail = previous?.clientEmail ?? "";
    }

    return await ctx.db.insert("btMessages", {
      materialId: args.materialId,
      materialTitle: material?.title ?? "Discussion générale",
      clientId,
      clientName,
      clientEmail,
      body,
      fromStaff,
      authorName: formatUserName(identity),
      readByStaff: fromStaff,
      readByClient: !fromStaff,
      createdAt: Date.now(),
    });
  },
});

/** Messages du client connecté, groupés par fil. */
export const myMessages = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db
      .query("btMessages")
      .withIndex("by_client", (q) => q.eq("clientId", identity.subject))
      .order("asc")
      .collect();
  },
});

/** Fils vus par l'équipe, le plus récemment actif en tête. */
export const listThreads = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_DEMANDES, "read");
    const messages = await ctx.db.query("btMessages").order("desc").take(1000);
    const threads = new Map<
      string,
      {
        key: string;
        clientId: string;
        clientName: string;
        clientEmail: string;
        materialId: Id<"btMaterials"> | undefined;
        materialTitle: string;
        lastMessage: string;
        lastAt: number;
        unread: number;
        messages: typeof messages;
      }
    >();
    for (const message of messages) {
      const key = threadKey(message.clientId, message.materialId);
      const thread = threads.get(key);
      if (!thread) {
        threads.set(key, {
          key,
          clientId: message.clientId,
          clientName: message.clientName,
          clientEmail: message.clientEmail,
          materialId: message.materialId,
          materialTitle: message.materialTitle,
          lastMessage: message.body,
          lastAt: message.createdAt,
          unread: message.fromStaff || message.readByStaff ? 0 : 1,
          messages: [message],
        });
      } else {
        thread.messages.push(message);
        if (!message.fromStaff && !message.readByStaff) thread.unread++;
      }
    }
    return [...threads.values()].map((thread) => ({
      ...thread,
      messages: [...thread.messages].sort((a, b) => a.createdAt - b.createdAt),
    }));
  },
});

export const markThreadRead = mutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    await requireCrmPermission(ctx, PAGE_DEMANDES, "read");
    const messages = await ctx.db
      .query("btMessages")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    for (const message of messages) {
      if (!message.fromStaff && !message.readByStaff) {
        await ctx.db.patch(message._id, { readByStaff: true });
      }
    }
  },
});

/* ─── Import de masse ──────────────────────────────────────────────────────── */

/**
 * Création en lot depuis un tableur.
 *
 * Chaque ligne est validée séparément : un fichier de cent lignes dont trois
 * sont mauvaises doit en importer quatre-vingt-dix-sept, et dire lesquelles
 * ont été écartées — pas échouer en bloc.
 */
export const importMaterials = mutation({
  args: {
    rows: v.array(
      v.object({
        title: v.string(),
        description: v.optional(v.string()),
        category: v.optional(v.string()),
        family: v.optional(v.string()),
        subcategory: v.optional(v.string()),
        condition: v.optional(v.string()),
        unit: v.optional(v.string()),
        quantity: v.optional(v.number()),
        price: v.optional(v.number()),
        brand: v.optional(v.string()),
        material: v.optional(v.string()),
        depot: v.optional(v.string()),
        location: v.optional(v.string()),
        qrReference: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    await requireCrmPermission(ctx, PAGE_MATERIAUX, "create");
    const identity = await requireUser(ctx);
    if (rows.length > 500) throw new ConvexError("500 lignes au maximum par import.");

    const units = ["unité", "m²", "m³", "ml", "kg", "tonne", "palette", "sac", "lot"];
    const conditions = ["Neuf", "Déstockage", "Très bon état", "Bon état", "À rénover"];
    const now = Date.now();
    const errors: Array<{ line: number; reason: string }> = [];
    let imported = 0;

    for (const [index, row] of rows.entries()) {
      const title = row.title?.trim();
      if (!title) {
        errors.push({ line: index + 2, reason: "Titre manquant" });
        continue;
      }
      const category = BT_CATEGORIES.includes(row.category ?? "")
        ? row.category!
        : BT_CATEGORIES[0];
      const family =
        row.family && btFamilies(category).includes(row.family) ? row.family : undefined;
      const subcategory =
        family && row.subcategory && btSubFamilies(category, family).includes(row.subcategory)
          ? row.subcategory
          : undefined;
      const unit = units.includes(row.unit ?? "") ? row.unit! : "unité";
      const condition = conditions.includes(row.condition ?? "") ? row.condition! : "Bon état";

      await ctx.db.insert("btMaterials", {
        title,
        description: row.description?.trim() || title,
        category,
        family,
        subcategory,
        condition: condition as never,
        unit: unit as never,
        quantity: Math.max(0, Number(row.quantity) || 0),
        price: Math.max(0, Number(row.price) || 0),
        brand: row.brand?.trim() || undefined,
        material: row.material?.trim() || undefined,
        depot: row.depot?.trim() || undefined,
        location: row.location?.trim() || undefined,
        qrReference: row.qrReference?.trim().toUpperCase() || undefined,
        photos: [],
        // Un import arrive en brouillon : personne n'a encore vu ces fiches,
        // les publier d'office mettrait en ligne des lignes non relues.
        status: "brouillon",
        published: false,
        createdBy: formatUserName(identity),
        createdAt: now,
        updatedAt: now,
      });
      imported++;
    }
    return { imported, errors };
  },
});

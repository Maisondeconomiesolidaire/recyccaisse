import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAnyCrmPermission, requireCrmPermission } from "./lib";
import { esc, resendSend } from "./emails";
import { KLYDE_GENDERS, KLYDE_TAXONOMY, isKlydeTaxonomyChoice, klydeAverageWeightKg, klydeCategories, klydeSubcategories, klydeSubsubcategories } from "./klydeTaxonomy";

const CONDITIONS = [
  "Neuf avec étiquette",
  "Neuf sans étiquette",
  "Très bon état",
  "Bon état",
  "Satisfaisant",
] as const;

const PARCEL_SIZES = ["Petit", "Moyen", "Grand"] as const;

const itemStatus = v.union(
  v.literal("stock"),
  v.literal("stock_b"),
  v.literal("en_ligne"),
  v.literal("en_cours_envoi"),
  v.literal("envoye"),
  v.literal("gagne"),
  v.literal("magasin"),
  v.literal("archive"),
);

type KlydeAIResult = {
  title: string;
  description: string;
  category: string;
  subcategory?: string | null;
  subsubcategory?: string | null;
  weightKg?: number | null;
  brand?: string | null;
  size?: string | null;
  condition: string;
  color?: string | null;
  material?: string | null;
  price?: number | null;
  parcelSize?: string | null;
  gender?: string | null;
  style?: string | null;
  keywords?: string[] | null;
  hashtags?: string[] | null;
  aiConfidence?: number | null;
  aiNotes?: string | null;
};

async function requireSignedIn(ctx: {
  auth: {
    getUserIdentity: () => Promise<{
      subject: string;
      email?: string;
      name?: string;
      givenName?: string;
      familyName?: string;
    } | null>;
  };
}) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Connexion requise.");
  return identity;
}

async function withPhotoUrls(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  item: Doc<"klydeItems">,
) {
  const photoUrls = await Promise.all(item.photos.map((id) => ctx.storage.getUrl(id)));
  return { ...item, photoUrls: photoUrls.filter((url): url is string => Boolean(url)) };
}

function cleanOptional(value?: string | null) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function normalizePrice(value?: number | null) {
  if (value == null || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.round(value * 100) / 100);
}

function normalizeQuantity(value?: number) {
  if (!value || Number.isNaN(value) || value < 1) return 1;
  return Math.floor(value);
}

function slugifyHashtag(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 32);
}

/** Une annonce complète — texte, mots-clés et hashtags — tient sous 2 000 caractères. */
const MAX_DESCRIPTION = 2000;
const MAX_HASHTAGS = 18;
const MAX_KEYWORDS = 34;
const KEYWORDS_BUDGET = 520;

function saleHashtags(
  suggestions: string[] | null | undefined,
  gender: string,
  category: string,
  subcategory: string | null | undefined,
  style: string | null | undefined,
) {
  const tags = new Set<string>();
  const add = (value?: string | null) => {
    if (!value) return;
    const tag = slugifyHashtag(value);
    // #vinted n'est jamais ajouté aux annonces ; les autres hashtags doivent
    // rester liés à l'article et ne jamais servir de bourrage de mots-clés.
    if (tag && !tag.startsWith("vinted")) tags.add(`#${tag}`);
  };

  // Le hashtag de genre passe en tête : c'est le seul que l'application
  // garantit, et les suggestions du modèle rempliraient sinon tout le quota.
  add(gender === "Femme" ? "femme" : gender === "Homme" ? "homme" : gender === "Enfant" ? "enfant" : "unisexe");
  for (const tag of suggestions ?? []) add(tag);
  add(category);
  add(subcategory);
  add(style);
  add("secondemain");
  add("mode");

  return [...tags].slice(0, MAX_HASHTAGS);
}

/**
 * Ligne de mots-clés de recherche, français et anglais mêlés.
 *
 * Elle vit sous l'annonce, avant les hashtags : ce sont les requêtes que tape
 * réellement l'acheteur (« robe portefeuille », « wrap dress », « cottagecore »)
 * et non des tendances plaquées. Doublons et bourrage sont écartés.
 */
function saleKeywords(suggestions: string[] | null | undefined) {
  const seen = new Set<string>();
  const keywords: string[] = [];
  let length = 0;
  for (const raw of suggestions ?? []) {
    const keyword = String(raw ?? "")
      .replace(/[#\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!keyword || keyword.length > 40) continue;
    if (seen.has(keyword)) continue;
    // On s'arrête sur un mot-clé entier : une expression coupée en deux ne
    // ramène personne et donne une annonce bâclée.
    const added = keywords.length === 0 ? keyword.length : keyword.length + 2;
    if (length + added > KEYWORDS_BUDGET) break;
    seen.add(keyword);
    keywords.push(keyword);
    length += added;
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  return keywords;
}

/** Coupe un texte sans casser un mot en deux. */
function truncateOnWord(text: string, limit: number) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return (lastBreak > limit * 0.6 ? cut.slice(0, lastBreak) : cut).trim();
}

function workflowRank(status: string) {
  return {
    stock: 0,
    en_stock: 0,
    reserve: 0,
    en_ligne: 1,
    en_cours_envoi: 2,
    envoye: 3,
    gagne: 4,
    vendu: 4,
    // « Magasin » n'est pas une étape du parcours en ligne mais une sortie de
    // ce parcours : elle se choisit, elle ne se « valide » pas dans l'ordre.
    magasin: -1,
  }[status] ?? -1;
}

/**
 * Génère une référence interne unique (6 chiffres) pour un article Klyd.
 * Même principe que la réf. interne de la boutique recyclerie : on tire au
 * hasard jusqu'à tomber sur une référence libre (vérifiée via l'index by_sku).
 */
async function generateKlydeReference(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    const existing = await ctx.db
      .query("klydeItems")
      .withIndex("by_sku", (q) => q.eq("sku", candidate))
      .first();
    if (!existing) return candidate;
  }
  throw new Error("Impossible de générer une référence unique.");
}

function sanitizeAnalysis(result: KlydeAIResult): KlydeAIResult {
  const condition = CONDITIONS.includes(result.condition as (typeof CONDITIONS)[number])
    ? result.condition
    : "Bon état";
  const parcelSize = PARCEL_SIZES.includes(result.parcelSize as (typeof PARCEL_SIZES)[number])
    ? result.parcelSize
    : undefined;
  const gender = KLYDE_GENDERS.includes(result.gender as (typeof KLYDE_GENDERS)[number])
    ? result.gender ?? "Unisexe"
    : "Unisexe";
  const category = isKlydeTaxonomyChoice(gender, result.category)
    ? result.category
    : klydeCategories(gender)[0] ?? "Vêtements";
  const subcategory = klydeSubcategories(gender, category).includes(result.subcategory ?? "")
    ? result.subcategory
    : undefined;
  const subsubcategory = subcategory && klydeSubsubcategories(gender, category, subcategory).includes(result.subsubcategory ?? "")
    ? result.subsubcategory
    : undefined;
  const rawDescription =
    cleanOptional(result.description)?.slice(0, 2400) ||
    "Article textile d'occasion. Détails à vérifier avant publication.";
  // Le modèle ne gère pas directement la ligne finale : on retire toute
  // tentative de hashtag dans son texte et on ajoute une liste contrôlée.
  const descriptionWithoutHashtags = rawDescription
    .replace(/(?:^|\s)#[\p{L}\p{N}_]+/gu, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  const hashtags = saleHashtags(result.hashtags, gender, category, subcategory, result.style);
  const keywords = saleKeywords(result.keywords);
  // L'annonce complète — texte, mots-clés puis hashtags — tient sous 2 000
  // caractères. On réserve d'abord la place du bas de page, qui porte le
  // référencement, et la prose occupe ce qui reste.
  const footer = [
    keywords.length > 0 ? keywords.join(", ") : "",
    hashtags.length > 0 ? hashtags.join(" ") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const proseBudget = footer ? MAX_DESCRIPTION - footer.length - 2 : MAX_DESCRIPTION;
  const prose = truncateOnWord(descriptionWithoutHashtags, Math.max(proseBudget, 0));
  const description = footer ? `${prose}\n\n${footer}` : prose;

  return {
    title: cleanOptional(result.title)?.slice(0, 80) || "Article textile",
    description,
    category,
    subcategory,
    subsubcategory,
    brand: cleanOptional(result.brand),
    size: cleanOptional(result.size),
    condition,
    color: cleanOptional(result.color),
    material: cleanOptional(result.material),
    price: normalizePrice(result.price),
    parcelSize,
    gender,
    style: cleanOptional(result.style),
    aiConfidence:
      result.aiConfidence == null ? undefined : Math.max(0, Math.min(1, result.aiConfidence)),
    aiNotes: cleanOptional(result.aiNotes),
    weightKg: klydeAverageWeightKg(category, subcategory, subsubcategory),
  };
}

async function callOpenAI<T>(apiKey: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erreur OpenAI (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  let cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
  if (!cleaned.startsWith("{")) {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) cleaned = cleaned.slice(first, last + 1);
  }
  return JSON.parse(cleaned) as T;
}

export const list = query({
  args: {
    searchText: v.optional(v.string()),
    status: v.optional(itemStatus),
    /** `true` = uniquement les archives ; par défaut elles sont exclues. */
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "klyde:stock", "read");
    const all = args.status
      ? await ctx.db
          .query("klydeItems")
          .withIndex("by_status", (q) => q.eq("status", args.status!))
          .order("desc")
          .collect()
      : await ctx.db.query("klydeItems").order("desc").collect();
    const items = all.filter((item) =>
      args.archived ? item.archivedAt !== undefined : item.archivedAt === undefined,
    );

    const search = args.searchText?.trim().toLowerCase();
    const filtered = search
      ? items.filter((item) =>
          [
            item.title,
            item.description,
            item.category,
            item.subcategory,
            item.subsubcategory,
            item.brand,
            item.size,
            item.color,
            item.material,
            item.sku,
            item.location,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(search),
        )
      : items;

    return Promise.all(filtered.map((item) => withPhotoUrls(ctx, item)));
  },
});

export const listPublic = query({
  args: {
    searchText: v.optional(v.string()),
    category: v.optional(v.string()),
    subcategory: v.optional(v.string()),
    gender: v.optional(v.string()),
    size: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query("klydeItems")
      .withIndex("by_boutiquePublished", (q) => q.eq("publishedOnBoutique", true))
      .order("desc")
      .collect();

    const search = args.searchText?.trim().toLowerCase();
    const nfc = (value?: string | null) => value?.normalize("NFC").trim() ?? "";
    const filtered = items.filter((item) => {
      if (args.category && nfc(item.category) !== nfc(args.category)) return false;
      if (args.subcategory && nfc(item.subcategory) !== nfc(args.subcategory)) return false;
      if (args.gender && item.gender !== args.gender) return false;
      if (args.size && item.size !== args.size) return false;
      if (!item.publishedOnBoutique || item.price == null || item.archivedAt) return false;
      if (!search) return true;
      return [
        item.title,
        item.description,
        item.category,
        item.subcategory,
        item.brand,
        item.size,
        item.color,
        item.material,
        item.gender,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search);
    });

    return Promise.all(filtered.map((item) => withPhotoUrls(ctx, item)));
  },
});

/** Visuels du header public de la boutique. */
export const getStorefront = query({
  args: {},
  handler: async (ctx) => {
    const storefront = await ctx.db
      .query("klydeStorefront")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .unique();
    if (!storefront) return { hommeUrl: null, femmeUrl: null };
    const [hommeUrl, femmeUrl] = await Promise.all([
      storefront.hommeCover ? ctx.storage.getUrl(storefront.hommeCover) : null,
      storefront.femmeCover ? ctx.storage.getUrl(storefront.femmeCover) : null,
    ]);
    return { hommeUrl, femmeUrl };
  },
});

/** Met à jour un visuel éditorial ; réservé aux gestionnaires de la boutique. */
export const updateStorefront = mutation({
  args: {
    hommeCover: v.optional(v.id("_storage")),
    femmeCover: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [
      ["klyde:boutique", "manage"],
      ["klyde:stock", "update"],
    ]);
    const existing = await ctx.db
      .query("klydeStorefront")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .unique();
    const patch = { ...args, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("klydeStorefront", { key: "default", ...patch });
    }
  },
});

export const getFeatured = query({
  args: {},
  handler: async (ctx) => {
    const featured = await ctx.db
      .query("klydeItems")
      .withIndex("by_featured", (q) => q.eq("featured", true))
      .collect();
    const online = featured.find(
      (item) => item.publishedOnBoutique && item.price != null && !item.archivedAt,
    );
    if (!online) return null;
    return await withPhotoUrls(ctx, online);
  },
});

export const getPublic = query({
  args: { id: v.id("klydeItems") },
  handler: async (ctx, { id }) => {
    const item = await ctx.db.get(id);
    if (!item || !item.publishedOnBoutique || item.price == null || item.archivedAt) return null;
    return await withPhotoUrls(ctx, item);
  },
});

export const getManyPublic = query({
  args: { ids: v.array(v.id("klydeItems")) },
  handler: async (ctx, { ids }) => {
    const uniqueIds = Array.from(new Set(ids)).slice(0, 40);
    const items = await Promise.all(uniqueIds.map((id) => ctx.db.get(id)));
    return Promise.all(
      items
        .filter((item): item is Doc<"klydeItems"> => Boolean(item?.publishedOnBoutique && item.price != null && !item.archivedAt))
        .map((item) => withPhotoUrls(ctx, item)),
    );
  },
});

export const latestByCategory = query({
  args: { category: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { category, limit }) => {
    const items = await ctx.db
      .query("klydeItems")
      .withIndex("by_boutiquePublished", (q) => q.eq("publishedOnBoutique", true))
      .order("desc")
      .take(80);
    const filtered = items
      .filter((item) => item.publishedOnBoutique && item.category === category && item.price != null && !item.archivedAt)
      .slice(0, Math.min(limit ?? 4, 8));
    return Promise.all(filtered.map((item) => withPhotoUrls(ctx, item)));
  },
});

export const myWishlistIds = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireSignedIn(ctx);
    const rows = await ctx.db
      .query("klydeWishlists")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .collect();
    return rows.map((row) => row.itemId);
  },
});

export const toggleWishlist = mutation({
  args: { itemId: v.id("klydeItems") },
  handler: async (ctx, { itemId }) => {
    const identity = await requireSignedIn(ctx);
    const item = await ctx.db.get(itemId);
    if (!item || item.status !== "en_ligne") throw new Error("Article indisponible.");

    const existing = await ctx.db
      .query("klydeWishlists")
      .withIndex("by_clerkId_itemId", (q) =>
        q.eq("clerkId", identity.subject).eq("itemId", itemId),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
      return { saved: false };
    }

    await ctx.db.insert("klydeWishlists", {
      clerkId: identity.subject,
      itemId,
      createdAt: Date.now(),
    });
    return { saved: true };
  },
});

export const submitCartOrder = mutation({
  args: {
    itemIds: v.array(v.id("klydeItems")),
    customer: v.object({
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      phone: v.string(),
    }),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireSignedIn(ctx);
    const uniqueIds = Array.from(new Set(args.itemIds));
    if (uniqueIds.length === 0) throw new Error("Ajoutez au moins un article au panier.");

    const items = await Promise.all(uniqueIds.map((id) => ctx.db.get(id)));
    const available = items.filter(
      (item): item is Doc<"klydeItems"> =>
        item !== null && item.status === "en_ligne" && item.price != null,
    );
    if (available.length !== uniqueIds.length) {
      throw new Error("Un article du panier n'est plus disponible.");
    }

    const total = available.reduce((sum, item) => sum + (item.price ?? 0), 0);
    const now = Date.now();
    const orderId = await ctx.db.insert("klydeOrders", {
      itemIds: available.map((item) => item._id),
      clerkId: identity.subject,
      customer: {
        firstName: args.customer.firstName.trim(),
        lastName: args.customer.lastName.trim(),
        email: args.customer.email.trim().toLowerCase(),
        phone: args.customer.phone.trim(),
      },
      total: Math.round(total * 100) / 100,
      status: "en_attente_paiement",
      paymentMethod: "card",
      note: cleanOptional(args.note),
      createdAt: now,
    });

    await Promise.all(
      available.map((item) =>
        ctx.db.patch(item._id, {
          status: "en_cours_envoi",
          trackingNotes: [
            item.trackingNotes,
            `Commande boutique ${orderId} créée. Paiement carte en attente.`,
          ]
            .filter(Boolean)
            .join("\n"),
          updatedAt: now,
        }),
      ),
    );

    return { orderId, total };
  },
});

export const create = mutation({
  args: {
    photos: v.array(v.id("_storage")),
    title: v.string(),
    description: v.string(),
    category: v.string(),
    subcategory: v.optional(v.string()),
    subsubcategory: v.optional(v.string()),
    weightKg: v.optional(v.number()),
    brand: v.optional(v.string()),
    size: v.optional(v.string()),
    condition: v.string(),
    color: v.optional(v.string()),
    material: v.optional(v.string()),
    price: v.optional(v.number()),
    actualSalePrice: v.optional(v.number()),
    parcelSize: v.optional(v.string()),
    gender: v.optional(v.string()),
    style: v.optional(v.string()),
    location: v.optional(v.string()),
    sku: v.optional(v.string()),
    vinted: v.optional(v.boolean()),
    outlet: v.optional(v.union(v.literal("klyd"), v.literal("mobifrip"))),
    quantity: v.optional(v.number()),
    aiConfidence: v.optional(v.number()),
    aiNotes: v.optional(v.string()),
    // Publier directement l'annonce sur la boutique à la création.
    publishOnBoutique: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "klyde:stock", "create");
    if (args.photos.length === 0) throw new Error("Ajoutez au moins une photo.");
    // Mise en ligne immédiate : mêmes droits que updateStatus("en_ligne").
    if (args.publishOnBoutique) {
      await requireAnyCrmPermission(ctx, [
        ["klyde:boutique", "manage"],
        ["klyde:stock", "update"],
      ]);
      if (normalizePrice(args.price) == null) {
        throw new Error("Renseignez un prix pour mettre l'article en ligne.");
      }
    }
    const now = Date.now();
    // Référence auto si l'utilisateur n'en a pas saisi.
    const sku = cleanOptional(args.sku) ?? (await generateKlydeReference(ctx));
    return await ctx.db.insert("klydeItems", {
      photos: args.photos,
      title: args.title.trim() || "Article textile",
      description: args.description.trim(),
      category: (args.category.trim() || "Vêtements").normalize("NFC"),
      subcategory: cleanOptional(args.subcategory)?.normalize("NFC"),
      subsubcategory: cleanOptional(args.subsubcategory)?.normalize("NFC"),
      weightKg: typeof args.weightKg === "number" && args.weightKg > 0
        ? Math.round(args.weightKg * 1000) / 1000
        : klydeAverageWeightKg(args.category, args.subcategory, args.subsubcategory),
      brand: cleanOptional(args.brand),
      size: cleanOptional(args.size),
      condition: args.condition.trim() || "Bon état",
      color: cleanOptional(args.color),
      material: cleanOptional(args.material),
      price: normalizePrice(args.price),
      actualSalePrice: normalizePrice(args.actualSalePrice),
      parcelSize: cleanOptional(args.parcelSize),
      gender: cleanOptional(args.gender),
      style: cleanOptional(args.style),
      location: cleanOptional(args.location),
      sku,
      publishedOnBoutique: args.publishOnBoutique || undefined,
      boutiquePublishedAt: args.publishOnBoutique ? now : undefined,
      outlet: args.outlet,
      quantity: normalizeQuantity(args.quantity),
      status: "stock",
      aiConfidence: args.aiConfidence,
      aiNotes: cleanOptional(args.aiNotes),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("klydeItems"),
    status: itemStatus,
  },
  handler: async (ctx, { id, status }) => {
    // Cette mutation générique est aussi utilisée par les vues de suivi : elle
    // doit toujours permettre de décocher/revenir à un état antérieur.
    if (status === "en_ligne") {
      await requireAnyCrmPermission(ctx, [
        ["klyde:boutique", "manage"],
        ["klyde:stock", "update"],
      ]);
    } else {
      await requireCrmPermission(ctx, "klyde:stock", "update");
    }
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Article introuvable.");
    const now = Date.now();
    await ctx.db.patch(id, {
      status,
      vinted: status === "stock" || status === "stock_b" ? undefined : status === "en_ligne" ? true : item.vinted,
      vintedAt: status === "en_ligne" ? item.vintedAt ?? now : status === "stock" || status === "stock_b" ? undefined : item.vintedAt,
      // Date d'encaissement : posée une fois, conservée si l'article repasse
      // par « gagné », effacée s'il quitte cet état (vente annulée).
      soldAt: status === "gagne" ? item.soldAt ?? now : undefined,
      updatedAt: now,
    });
  },
});

/** Avance d'une étape dans la carte de vente et applique ses champs requis. */
export const advanceWorkflow = mutation({
  args: { id: v.id("klydeItems"), status: itemStatus },
  handler: async (ctx, { id, status }) => {
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Article introuvable.");
    if (workflowRank(status) <= workflowRank(item.status)) {
      throw new Error("Utilisez le décochage pour revenir en arrière.");
    }
    if (status === "en_ligne") {
      await requireAnyCrmPermission(ctx, [
        ["klyde:boutique", "manage"],
        ["klyde:stock", "update"],
      ]);
    } else {
      await requireCrmPermission(ctx, "klyde:stock", "update");
    }

    if (status === "en_ligne" && item.price == null) {
      throw new Error("Renseignez le prix affiché avant la mise en ligne.");
    }
    if (status === "en_cours_envoi" && item.actualSalePrice == null) {
      throw new Error("Renseignez le prix de vente réel avant de marquer l'article comme vendu.");
    }
    if (status === "envoye" && !cleanOptional(item.trackingNotes)) {
      throw new Error("Ajoutez le numéro de suivi ou une note d'expédition avant cette étape.");
    }
    if (status === "gagne" && item.status !== "envoye") {
      throw new Error("Marquez d'abord l'article comme expédié avant de confirmer qu'il est gagné.");
    }
    const now = Date.now();
    await ctx.db.patch(id, {
      status,
      vinted: status === "en_ligne" ? true : item.vinted,
      vintedAt: status === "en_ligne" ? item.vintedAt ?? now : item.vintedAt,
      soldAt: status === "gagne" ? item.soldAt ?? now : undefined,
      updatedAt: now,
    });
  },
});

/** Prix effectivement encaissé : distinct du prix catalogue de l'article. */
export const setActualSalePrice = mutation({
  args: { id: v.id("klydeItems"), actualSalePrice: v.optional(v.number()) },
  handler: async (ctx, { id, actualSalePrice }) => {
    await requireCrmPermission(ctx, "klyde:stock", "update");
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Article introuvable.");
    await ctx.db.patch(id, {
      actualSalePrice: normalizePrice(actualSalePrice),
      updatedAt: Date.now(),
    });
  },
});

/** Décision après trois semaines sur Vinted : retrait vers Stock B. */
/**
 * Remise en vente à la boutique physique.
 *
 * Sortie du parcours Vinted pour un invendu : l'annonce en ligne est retirée
 * (`vinted` remis à zéro) et la décision est tracée dans `stockBDisposition`,
 * qui alimente déjà le suivi des sorties de Stock B.
 */
export const moveToShop = mutation({
  args: { id: v.id("klydeItems") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "klyde:stock", "update");
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Article introuvable.");
    await ctx.db.patch(id, {
      status: "magasin",
      stockBDisposition: "magasin",
      vinted: undefined,
      vintedAt: undefined,
      vintedAlertSentAt: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const moveToStockB = mutation({
  args: { id: v.id("klydeItems") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "klyde:stock", "update");
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Article introuvable.");
    await ctx.db.patch(id, {
      status: "stock_b",
      vinted: undefined,
      vintedAt: undefined,
      vintedAlertSentAt: undefined,
      updatedAt: Date.now(),
    });
  },
});

/** Prolonge une annonce Vinted et redémarre son délai de trois semaines. */
export const extendVintedListing = mutation({
  args: { id: v.id("klydeItems") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "klyde:stock", "update");
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Article introuvable.");
    if (!item.vinted) throw new Error("Cet article n'est pas en vente sur Vinted.");
    const now = Date.now();
    await ctx.db.patch(id, {
      vintedAt: now,
      vintedAlertSentAt: undefined,
      vintedExtensionCount: (item.vintedExtensionCount ?? 0) + 1,
      vintedLastExtendedAt: now,
      updatedAt: now,
    });
  },
});

/** Oriente un article de Stock B vers une vente exceptionnelle ou le magasin. */
export const setStockBDisposition = mutation({
  args: {
    id: v.id("klydeItems"),
    disposition: v.union(v.literal("vente_exceptionnelle"), v.literal("magasin")),
  },
  handler: async (ctx, { id, disposition }) => {
    await requireCrmPermission(ctx, "klyde:stock", "update");
    const item = await ctx.db.get(id);
    if (!item || item.status !== "stock_b") throw new Error("Article Stock B introuvable.");
    await ctx.db.patch(id, { stockBDisposition: disposition, updatedAt: Date.now() });
  },
});

export const updateTrackingNotes = mutation({
  args: {
    id: v.id("klydeItems"),
    trackingNotes: v.optional(v.string()),
  },
  handler: async (ctx, { id, trackingNotes }) => {
    await requireCrmPermission(ctx, "klyde:stock", "update");
    await ctx.db.patch(id, {
      trackingNotes: cleanOptional(trackingNotes),
      updatedAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("klydeItems"),
    photos: v.array(v.id("_storage")),
    title: v.string(),
    description: v.string(),
    category: v.string(),
    subcategory: v.optional(v.string()),
    subsubcategory: v.optional(v.string()),
    weightKg: v.optional(v.number()),
    brand: v.optional(v.string()),
    size: v.optional(v.string()),
    condition: v.string(),
    color: v.optional(v.string()),
    material: v.optional(v.string()),
    price: v.optional(v.number()),
    actualSalePrice: v.optional(v.number()),
    parcelSize: v.optional(v.string()),
    gender: v.optional(v.string()),
    style: v.optional(v.string()),
    location: v.optional(v.string()),
    sku: v.optional(v.string()),
    vinted: v.optional(v.boolean()),
    outlet: v.optional(v.union(v.literal("klyd"), v.literal("mobifrip"))),
    quantity: v.optional(v.number()),
    aiConfidence: v.optional(v.number()),
    aiNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "klyde:stock", "update");
    if (args.photos.length === 0) throw new Error("Ajoutez au moins une photo.");
    const existing = await ctx.db.get(args.id);
    const now = Date.now();
    // On complète la référence si elle manque encore (articles antérieurs).
    const sku = cleanOptional(args.sku) ?? (await generateKlydeReference(ctx));
    // Date Vinted : conservée si déjà en vente, initialisée à la 1re mise en
    // vente, effacée (avec l'alerte) si l'article est retiré de Vinted.
    const vintedAt = args.vinted ? existing?.vintedAt ?? now : undefined;
    const vintedAlertSentAt = args.vinted ? existing?.vintedAlertSentAt : undefined;
    await ctx.db.patch(args.id, {
      photos: args.photos,
      title: args.title.trim() || "Article textile",
      description: args.description.trim(),
      category: (args.category.trim() || "Vêtements").normalize("NFC"),
      subcategory: cleanOptional(args.subcategory)?.normalize("NFC"),
      subsubcategory: cleanOptional(args.subsubcategory)?.normalize("NFC"),
      weightKg: typeof args.weightKg === "number" && args.weightKg > 0
        ? Math.round(args.weightKg * 1000) / 1000
        : klydeAverageWeightKg(args.category, args.subcategory, args.subsubcategory),
      brand: cleanOptional(args.brand),
      size: cleanOptional(args.size),
      condition: args.condition.trim() || "Bon état",
      color: cleanOptional(args.color),
      material: cleanOptional(args.material),
      price: normalizePrice(args.price),
      actualSalePrice: normalizePrice(args.actualSalePrice),
      parcelSize: cleanOptional(args.parcelSize),
      gender: cleanOptional(args.gender),
      style: cleanOptional(args.style),
      location: cleanOptional(args.location),
      sku,
      vinted: args.vinted ? true : undefined,
      vintedAt,
      vintedAlertSentAt,
      outlet: args.outlet,
      quantity: normalizeQuantity(args.quantity),
      aiConfidence: args.aiConfidence,
      aiNotes: cleanOptional(args.aiNotes),
      updatedAt: now,
    });
  },
});

/**
 * Mise aux archives, et retour.
 *
 * L'article garde son statut : archiver n'est pas une étape du workflow de
 * vente mais une mise de côté, réversible depuis la page Archives. Un article
 * archivé quitte la boutique et le stock — le laisser publié le maintiendrait
 * en vente. Les rapports de ventes, eux, gardent l'historique : archiver un
 * article vendu ne doit pas réécrire un chiffre d'affaires déjà encaissé.
 */
export const setArchived = mutation({
  args: { id: v.id("klydeItems"), archived: v.boolean() },
  handler: async (ctx, { id, archived }) => {
    await requireCrmPermission(ctx, "klyde:stock", "update");
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Article introuvable.");
    await ctx.db.patch(id, {
      archivedAt: archived ? Date.now() : undefined,
      publishedOnBoutique: archived ? false : item.publishedOnBoutique,
      featured: archived ? undefined : item.featured,
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("klydeItems") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "klyde:stock", "delete");
    await ctx.db.delete(id);
  },
});

export const setFeatured = mutation({
  args: { id: v.id("klydeItems") },
  handler: async (ctx, { id }) => {
    await requireAnyCrmPermission(ctx, [
      ["klyde:boutique", "manage"],
      ["klyde:stock", "update"],
    ]);
    const target = await ctx.db.get(id);
    if (!target) throw new Error("Article introuvable.");
    if (!target.publishedOnBoutique) throw new Error("Publiez d'abord cet article sur la boutique.");

    const currentlyFeatured = await ctx.db
      .query("klydeItems")
      .withIndex("by_featured", (q) => q.eq("featured", true))
      .collect();

    const now = Date.now();
    // Un seul article peut être mis en avant : on retire les autres.
    for (const item of currentlyFeatured) {
      if (item._id !== id) await ctx.db.patch(item._id, { featured: false, updatedAt: now });
    }
    await ctx.db.patch(id, { featured: !target.featured, updatedAt: now });
    return { featured: !target.featured };
  },
});

/** Publication Boutique indépendante du statut Vinted. */
export const setBoutiquePublished = mutation({
  args: { id: v.id("klydeItems"), published: v.boolean() },
  handler: async (ctx, { id, published }) => {
    await requireAnyCrmPermission(ctx, [["klyde:boutique", "manage"], ["klyde:stock", "update"]]);
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Article introuvable.");
    if (published && normalizePrice(item.price) == null) throw new Error("Renseignez un prix avant de publier sur la boutique.");
    await ctx.db.patch(id, {
      publishedOnBoutique: published || undefined,
      boutiquePublishedAt: published ? item.boutiquePublishedAt ?? Date.now() : undefined,
      featured: published ? item.featured : false,
      updatedAt: Date.now(),
    });
  },
});

export const assertCanAnalyze = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "klyde:stock", "analyze");
    return true;
  },
});

/**
 * Consigne de style/persona en tête du prompt d'analyse, selon l'enseigne.
 * Les deux enseignes produisent une annonce Vinted riche et structurée.
 * La sortie reste le MÊME JSON structuré : seul le positionnement de marque
 * et le ton éditorial changent.
 */
const MOBIFRIP_ANALYSIS_PERSONA = `Tu es le responsable e-commerce de MOBIFRIP, boutique française de mode seconde main tendance. Tu es expert Vinted, merchandising, copywriting et stylisme.
Analyse toutes les photos ensemble, y compris étiquettes, défauts, matières, coupe, public cible et type d'article. Rédige comme un vrai vendeur passionné de mode, jamais comme une fiche automatique.

TITRE (champ "title") — règle absolue de l'ordre des mots, max 80 caractères.
Un titre se lit comme la requête que l'acheteur tape vraiment, JAMAIS comme une liste de tendances.
1) D'abord la recherche réelle, dans cet ordre : type de produit → genre → taille → couleur → coupe ou matière → marque UNIQUEMENT si elle est réellement recherchée (Ralph Lauren, Levi's, Guess, Tommy Hilfiger, Lacoste, Nike, Adidas, Carhartt...).
2) Ensuite seulement, après un tiret, les termes qui élargissent le référencement : vintage, 90s, Y2K, rétro, workwear, coquette, preppy, bohème...
Exemples du niveau attendu :
« Jean droit unisexe T38 100% coton denim - vintage 90s »
« Blazer femme T38 jaune fleuri jacquard - vintage 90s couture »
« Chemise homme XL coton rayée multicolore - vintage 90s »
« Jupe longue femme T40 beige coton à volants - bohème vintage »
« Veste femme T38 beige brodée strass - Y2K coquette »
Une marque inconnue ne gaspille jamais les premiers mots : elle reste dans la description et dans le champ « brand ». On cherche « jean droit taille 38 » ou « jean 100% coton », pas « jean vintage WMK ».
ÉPOQUE — c'est un argument de vente majeur sur le vintage.
Quand les photos, l'étiquette, la coupe ou les finitions permettent de dater la pièce, le titre COMMENCE par l'époque : « Vintage 90's », « Vintage 70's », « Vintage Y2K », « Vintage Rare 70's » pour une pièce réellement rare. Le reste du titre suit l'ordre de recherche : produit, genre, taille, couleur, matière ou coupe, puis les esthétiques.
Exemples du niveau attendu :
« Vintage 90's Veste Blazer en tweed officier tartan rétro chic »
« Vintage Rare 70's Ensemble Cacharel Blazer Harem pant sarouel »
Quand la pièce n'est PAS datable, on n'invente aucune décennie : le titre commence alors par le produit, comme ci-dessus.
Rappelle aussi l'époque dans la description (ligne « Année : 90's ») et décline-la dans les mots-clés (« années 90 », « 90s », « 80 90 »).

DESCRIPTION (champ "description") : ne rédige JAMAIS une seule phrase. Produis une vraie annonce prête à publier, riche, chaleureuse et précise, composée de 3 paragraphes distincts :
1. Une accroche qui présente clairement la pièce, sa marque si visible, sa coupe et ses éléments remarquables.
2. Un paragraphe détaillé sur le tombé, les couleurs, motifs, finitions et le style, puis une ou deux idées de look et d'occasions réalistes.
3. Un paragraphe de positionnement mode, uniquement avec les esthétiques réellement cohérentes avec la pièce (bohème, Y2K, vintage, preppy, workwear, etc.).
Ajoute ensuite un bloc factuel avec une information par ligne, seulement lorsqu'elle est visible ou fournie : « Marque : … », « Année : … », « Composition : … », « Fabrication : … », « Taille : … », « État : … ». N'ajoute pas toi-même de hashtags au texte : renvoie-les dans le champ JSON dédié. Ils doivent être modernes, jeunes, désirables et vraiment pertinents pour l'article (Y2K, fairycore, oldmoney, streetwear, vintage, coquette, gorpcore, etc. seulement lorsque justifiés), sans jamais inclure #vinted. Intègre plutôt les termes de recherche et les esthétiques pertinentes naturellement dans les phrases. Quand le genre est connu, indique clairement « pour femme » ou « pour homme » dans le texte.
La qualité attendue est celle d'une annonce éditoriale du type : « Magnifique jupe longue bohème… coupe longue et fluide… look bohème chic, romantique ou festival… statement piece… Marque / Fabrication / Taille / État ». Adapte toujours cette structure à l'article réel : ne reprends jamais la jupe, la marque, la taille ou les tendances de cet exemple si elles ne sont pas visibles.
Évite les banalités creuses comme « idéale pour un look casual », « matière légère et confortable » ou « parfaite pour les journées chaudes » sauf si elles sont démontrables à partir des photos ou du contexte. N'invente jamais matière, provenance, marque, taille, époque, défaut, état, prix neuf, rareté ou édition limitée. Si une donnée est inconnue, omets-la.
MOTS-CLÉS (champ "keywords") : 24 à 34 expressions de recherche, en minuscules, sans #, chacune de 1 à 4 mots. C'est le référencement de l'annonce, la partie qui la fait trouver. Mélange :
- les requêtes produit déclinées (« robe portefeuille », « robe rayée », « robe rose », « robe coton », « robe midi », « robe femme ») ;
- la matière et la coupe (« robe 100 coton », « robe mi-longue ») ;
- les époques, sous toutes leurs formes, dès que la pièce est datable (« années 90 », « 90s », « 90's », « années 80 », « 60 70 80 90 », « robe années 70 ») et les esthétiques justifiées (« bohème », « cottagecore », « grunge », « coquette ») ;
- les usages (« robe plage », « robe vacances », « robe casual chic ») ;
- puis une série en anglais pour les acheteurs européens (« cotton dress », « wrap dress », « vintage dress », « summer dress », « second hand fashion », « timeless style »).
Décline systématiquement le type de produit avec ses attributs, comme dans cet exemple. Aucune marque non visible, aucun mot-clé faux.

HASHTAGS (champ "hashtags") : 15 à 17 hashtags sans #, en CamelCase, modernes et désirables, du même esprit que : VintageDress, RetroStyle, WrapDress, StripedDress, CottonDress, SummerStyle, FrenchRiviera, Cottagecore, TimelessFashion, SlowFashion, SecondHandFashion, VintedEurope, VintageStyle, EverydayElegance. Ils doivent coller à l'article. #vinted est strictement interdit.
L'annonce complète — texte, mots-clés et hashtags — ne doit JAMAIS dépasser 2 000 caractères. Vise 900 à 1 200 caractères de texte rédigé pour laisser la place au référencement.`;

const KLYD_ANALYSIS_PERSONA = `Tu es le responsable e-commerce de MOBIFRIP, boutique de mode seconde main tendance : à la fois expert Vinted, merchandising, copywriting, tendances mode, psychologie d'achat et styliste.
Analyse toutes les photos ensemble (étiquettes, défauts, matières, coupe, public cible, type d'article) avant de rédiger.
Ton objectif : une annonce qui maximise clics, favoris, messages et ventes, sans jamais paraître artificielle — on doit croire à un vrai vendeur passionné de mode.
Positionnement Mobifrip : marques tendance accessibles (Ralph Lauren, Tommy Hilfiger, Levi's, Nike, Adidas, Sergio Tacchini, Lee, Carhartt, Burton, Kenzo, DDP, Zara, Mango, Naf Naf, Maje, Sandro, Motel...), prix 15 à 40 €. Le client cherche une bonne affaire, une pièce tendance, une marque connue, une belle qualité, facile à porter.
N'invente JAMAIS composition, matière, provenance, année, prix neuf, rareté, taille, dimensions, collaboration ou édition limitée : utilise uniquement ce qui est visible sur les photos ou fourni.

TITRE (champ "title") — règle absolue de l'ordre des mots, max 80 caractères.
Un titre se lit comme la requête que l'acheteur tape vraiment, JAMAIS comme une liste de tendances.
1) D'abord la recherche réelle, dans cet ordre : type de produit → genre → taille → couleur → coupe ou matière → marque UNIQUEMENT si elle est réellement recherchée (Ralph Lauren, Levi's, Guess, Tommy Hilfiger, Lacoste, Nike, Adidas, Carhartt...).
2) Ensuite seulement, après un tiret, les termes qui élargissent le référencement : vintage, 90s, Y2K, rétro, workwear, coquette, preppy, bohème...
Exemples du niveau attendu :
« Jean droit unisexe T38 100% coton denim - vintage 90s »
« Blazer femme T38 jaune fleuri jacquard - vintage 90s couture »
« Chemise homme XL coton rayée multicolore - vintage 90s »
« Jupe longue femme T40 beige coton à volants - bohème vintage »
« Veste femme T38 beige brodée strass - Y2K coquette »
Une marque inconnue ne gaspille jamais les premiers mots : elle reste dans la description et dans le champ « brand ». On cherche « jean droit taille 38 » ou « jean 100% coton », pas « jean vintage WMK ».
ÉPOQUE — c'est un argument de vente majeur sur le vintage.
Quand les photos, l'étiquette, la coupe ou les finitions permettent de dater la pièce, le titre COMMENCE par l'époque : « Vintage 90's », « Vintage 70's », « Vintage Y2K », « Vintage Rare 70's » pour une pièce réellement rare. Le reste du titre suit l'ordre de recherche : produit, genre, taille, couleur, matière ou coupe, puis les esthétiques.
Exemples du niveau attendu :
« Vintage 90's Veste Blazer en tweed officier tartan rétro chic »
« Vintage Rare 70's Ensemble Cacharel Blazer Harem pant sarouel »
Quand la pièce n'est PAS datable, on n'invente aucune décennie : le titre commence alors par le produit, comme ci-dessus.
Rappelle aussi l'époque dans la description (ligne « Année : 90's ») et décline-la dans les mots-clés (« années 90 », « 90s », « 80 90 »).

DESCRIPTION (champ "description") : écris une vraie annonce prête à publier, fluide et immersive, comme cet exemple de niveau attendu : accroche valorisante ; un paragraphe qui décrit précisément la coupe, les couleurs, l'imprimé, les détails et le mouvement ; un paragraphe qui propose des associations et des occasions ; un dernier paragraphe qui positionne la pièce dans les tendances pertinentes. Ensuite ajoute un bloc factuel, une information par ligne, uniquement avec ce qui est connu : « Marque : … », « Année : … », « Composition : … », « Fabrication : … », « Taille : … », « État : … ». N'ajoute pas toi-même de hashtags au texte : renvoie-les dans le champ JSON dédié. Ils doivent être modernes, jeunes, désirables et pertinents pour l'article ; #vinted est strictement interdit. Intègre naturellement les termes de recherche jeunes, actuels et vendeurs dans les phrases. Quand le genre est connu, indique clairement « pour femme » ou « pour homme » dans le texte.
La structure, le ton et la richesse doivent se rapprocher d'une annonce telle que : « Magnifique jupe longue bohème… coupe longue et fluide… look bohème chic, romantique ou festival… statement piece… Marque / Fabrication / Taille / État ». Adapte-la toujours à l'article photographié : n'imite ni la jupe, ni la marque, ni la taille de cet exemple.
Mentionne l'état et les défauts visibles. Si une donnée est inconnue, omets simplement sa ligne : ne mets ni « inconnu », ni une supposition.
L'annonce complète — texte, mots-clés et hashtags — ne doit JAMAIS dépasser 2 000 caractères. Vise 900 à 1 200 caractères de texte rédigé pour laisser la place au référencement.
MOTS-CLÉS (champ "keywords") : 24 à 34 expressions de recherche, en minuscules, sans #, chacune de 1 à 4 mots. C'est le référencement de l'annonce, la partie qui la fait trouver. Mélange :
- les requêtes produit déclinées (« robe portefeuille », « robe rayée », « robe rose », « robe coton », « robe midi », « robe femme ») ;
- la matière et la coupe (« robe 100 coton », « robe mi-longue ») ;
- les époques, sous toutes leurs formes, dès que la pièce est datable (« années 90 », « 90s », « 90's », « années 80 », « 60 70 80 90 », « robe années 70 ») et les esthétiques justifiées (« bohème », « cottagecore », « grunge », « coquette ») ;
- les usages (« robe plage », « robe vacances », « robe casual chic ») ;
- puis une série en anglais pour les acheteurs européens (« cotton dress », « wrap dress », « vintage dress », « summer dress », « second hand fashion », « timeless style »).
Décline systématiquement le type de produit avec ses attributs, comme dans cet exemple. Aucune marque non visible, aucun mot-clé faux.

HASHTAGS (champ "hashtags") : 15 à 17 hashtags sans #, en CamelCase, modernes et désirables, du même esprit que : VintageDress, RetroStyle, WrapDress, StripedDress, CottonDress, SummerStyle, FrenchRiviera, Cottagecore, TimelessFashion, SlowFashion, SecondHandFashion, VintedEurope, VintageStyle, EverydayElegance. Ils doivent coller à l'article. #vinted est strictement interdit.
Intègre naturellement une tendance seulement si pertinent (Y2K, Old Money, Preppy, Tenniscore, Workwear, Streetwear, Quiet Luxury, French Riviera, Vintage, 90s, 2000s...) sans jamais en faire une liste. Inspire-toi de l'univers de la marque quand c'est cohérent : Ralph Lauren → Hamptons, voile, polo, coucher de soleil, élégance décontractée ; Levi's → Copenhague, café de quartier, denim intemporel ; Tommy Hilfiger → université américaine, Cape Cod, preppy ; Carhartt → atelier, workwear, créatifs ; Nike vintage → années 90, playground, street culture ; Sergio Tacchini → tennis vintage, Riviera italienne ; Maje → Paris, dîner en terrasse, féminité moderne ; Desigual → voyage, couleurs, Méditerranée.
Style : naturel, fluide, premium, accessible, élégant, jamais prétentieux ni robotique ni répétitif. Aucun emoji. Pas de « idéal pour » répété. Chaque annonce doit être unique.`;

export const analyzePhotos = action({
  args: {
    storageIds: v.array(v.id("_storage")),
    extraDetails: v.optional(v.string()),
    outlet: v.optional(v.union(v.literal("klyd"), v.literal("mobifrip"))),
  },
  handler: async (ctx, { storageIds, extraDetails, outlet }) => {
    await ctx.runQuery(internal.klyde.assertCanAnalyze, {});
    if (storageIds.length === 0) throw new Error("Aucune photo à analyser.");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("Clé OpenAI absente du déploiement Convex partagé.");
    }

    const urls = await Promise.all(storageIds.slice(0, 8).map((id) => ctx.storage.getUrl(id)));
    const imageUrls = urls.filter((url): url is string => Boolean(url));
    if (imageUrls.length === 0) throw new Error("Photos introuvables dans le stockage Convex.");

    const persona = outlet === "klyd" ? KLYD_ANALYSIS_PERSONA : MOBIFRIP_ANALYSIS_PERSONA;
    const prompt = `${persona}
Retourne uniquement un JSON valide avec ces champs:
{
  "title": "titre dans l'ordre de recherche imposé, max 80 caractères",
  "description": "annonce structurée, prête à publier, avec état/défauts visibles et bloc factuel, sans hashtags",
  "gender": "Femme | Homme | Enfant | Unisexe",
  "category": "une catégorie exacte de la taxonomie fournie",
  "subcategory": "une sous-catégorie exacte de la catégorie choisie",
  "subsubcategory": "une sous-sous-catégorie exacte, ou null si aucun niveau plus précis n'existe",
  "brand": "marque si visible ou null",
  "size": "taille si visible ou estimée prudemment, sinon null",
  "condition": "une de: Neuf avec étiquette | Neuf sans étiquette | Très bon état | Bon état | Satisfaisant",
  "color": "couleur principale, sinon null",
  "material": "matière si visible/probable, sinon null",
  "price": prix conseillé en euros pour la boutique, nombre ou null,
  "parcelSize": "Petit | Moyen | Grand",
  "style": "style/mots utiles: vintage, casual, sport, chic... ou null",
  "keywords": ["24 à 34 expressions de recherche en minuscules, sans #, français puis anglais"],
  "hashtags": ["15 à 17 hashtags en CamelCase, sans # ni #vinted, ni marque non visible ; inclure la décennie si datable (Vintage90s, 90sFashion)"],
  "aiConfidence": nombre entre 0 et 1,
  "aiNotes": "points à vérifier humainement"
}
Taxonomie autorisée (genre → catégorie → sous-catégorie → sous-sous-catégorie):
${JSON.stringify(KLYDE_TAXONOMY)}
Sois prudent: si marque, taille ou matière ne sont pas visibles, mets null.
Optimise la recherche avec des termes modernes, jeunes et vendeurs, mais emploie-les seulement s'ils sont justifiés par l'article. N'ajoute jamais de marque absente ni d'information inventée. Pour le genre, écris toujours « pour femme » ou « pour homme » lorsque la photo permet de le déterminer. Les tableaux \`keywords\` et \`hashtags\` ne contiennent jamais de # : l'application compose la fin de l'annonce, filtre #vinted, ajoute le hashtag de genre et garantit la limite de 2 000 caractères.
${extraDetails?.trim() ? `Contexte fourni par l'utilisateur: ${extraDetails.trim()}` : ""}`;

    const result = await callOpenAI<KlydeAIResult>(apiKey, {
      model: "gpt-4o",
      temperature: 0.35,
      max_tokens: 1600,
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

    return sanitizeAnalysis(result);
  },
});

/**
 * Lance une prédiction FASHN et attend son résultat (polling), en renvoyant
 * l'URL de l'image générée. Chaque étape « quality » prend ~1 min.
 */
async function runFashnPrediction(
  apiKey: string,
  modelName: string,
  inputs: Record<string, unknown>,
): Promise<string> {
  const runResponse = await fetch("https://api.fashn.ai/v1/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model_name: modelName, inputs }),
  });
  if (!runResponse.ok) {
    const errorText = await runResponse.text();
    throw new Error(`Erreur FASHN (${runResponse.status}): ${errorText.slice(0, 300)}`);
  }
  const runData = (await runResponse.json()) as { id?: string; error?: unknown };
  if (runData.error || !runData.id) {
    throw new Error(`FASHN: ${JSON.stringify(runData.error ?? "réponse invalide").slice(0, 300)}`);
  }

  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const statusResponse = await fetch(`https://api.fashn.ai/v1/status/${runData.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!statusResponse.ok) continue;
    const statusData = (await statusResponse.json()) as {
      status?: string;
      output?: string[];
      error?: unknown;
    };
    if (statusData.status === "completed") {
      const output = statusData.output?.[0];
      if (!output) throw new Error("FASHN n'a renvoyé aucune image.");
      return output;
    }
    if (statusData.status === "failed" || statusData.error) {
      throw new Error(
        `Génération FASHN échouée: ${JSON.stringify(statusData.error ?? "inconnue").slice(0, 300)}`,
      );
    }
  }
  throw new Error("Génération FASHN expirée, réessayez.");
}

/**
 * Prompt de « mise en scène » : garde le mannequin et le vêtement principal
 * intacts, puis ajoute des accessoires/pièces complémentaires assortis et un
 * environnement/contexte sur mesure correspondant à l'univers du vêtement.
 */
function buildStylingPrompt(garment?: {
  category?: string;
  subcategory?: string;
  gender?: string;
  style?: string;
  color?: string;
  brand?: string;
}): string {
  const descriptors = [
    cleanOptional(garment?.subcategory) ?? cleanOptional(garment?.category),
    cleanOptional(garment?.style),
    cleanOptional(garment?.color),
    cleanOptional(garment?.brand),
  ].filter(Boolean);
  const garmentDesc = descriptors.length ? ` (${descriptors.join(", ")})` : "";

  return (
    `Keep the same person, face, body, pose and the main worn garment${garmentDesc} exactly the same. ` +
    `Style the look by adding tasteful, complementary fashion accessories and additional clothing pieces ` +
    `(such as shoes, bag, jewelry, layers) that match the garment's style and colours. ` +
    `Replace the background with a bespoke environment and context that fits the garment's universe: ` +
    `choose the setting, location, season, lighting, colours and mood that best tell its story. ` +
    `Be creative and vary the scene (studio, outdoor, urban, nature, stylish interior), ` +
    `keeping it coherent with the style. High-end editorial lookbook / brand e-commerce rendering, photorealistic.`
  );
}

/**
 * Essayage FASHN en deux temps : (1) Try-On Max place l'article sur le
 * mannequin (image) choisi par l'utilisateur — le mannequin est conservé ;
 * (2) un passage `edit` ajoute des accessoires/pièces complémentaires assortis
 * et génère un environnement/contexte sur mesure. Un seed aléatoire varie la
 * mise en scène à chaque fois. L'image finale est stockée dans Convex.
 */
export const generateTryOn = action({
  args: {
    storageId: v.id("_storage"),
    // Image du mannequin choisi (asset public de l'app Klyd), URL absolue.
    modelImageUrl: v.string(),
    // Qualité/résolution de sortie FASHN (défaut: 2k).
    resolution: v.optional(v.union(v.literal("1k"), v.literal("2k"), v.literal("4k"))),
    // Attributs de l'article pour orienter accessoires et contexte générés.
    garment: v.optional(
      v.object({
        category: v.optional(v.string()),
        subcategory: v.optional(v.string()),
        gender: v.optional(v.string()),
        style: v.optional(v.string()),
        color: v.optional(v.string()),
        brand: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { storageId, modelImageUrl, resolution, garment }) => {
    await ctx.runQuery(internal.klyde.assertCanAnalyze, {});

    const apiKey = process.env.FASHN_API_KEY;
    if (!apiKey) {
      throw new Error("Clé FASHN absente du déploiement Convex partagé.");
    }
    if (!/^https?:\/\//i.test(modelImageUrl)) {
      throw new Error("Image du mannequin invalide.");
    }
    const outputResolution = resolution ?? "2k";

    const productUrl = await ctx.storage.getUrl(storageId);
    if (!productUrl) throw new Error("Photo introuvable dans le stockage Convex.");

    // 1) Try-On Max : l'article porté par le mannequin choisi (mannequin conservé).
    const tryOnUrl = await runFashnPrediction(apiKey, "tryon-max", {
      product_image: productUrl,
      model_image: modelImageUrl,
      resolution: outputResolution,
      generation_mode: "quality",
      output_format: "png",
      num_images: 1,
    });

    // 2) Mise en scène : accessoires/pièces complémentaires + contexte sur mesure.
    const resultUrl = await runFashnPrediction(apiKey, "edit", {
      image: tryOnUrl,
      prompt: buildStylingPrompt(garment),
      resolution: outputResolution,
      generation_mode: "quality",
      output_format: "png",
      num_images: 1,
      // Seed aléatoire : une mise en scène différente à chaque génération.
      seed: Math.floor(Math.random() * 2_147_483_647),
    });

    // 3) Téléchargement et stockage de l'image générée dans Convex.
    const imageResponse = await fetch(resultUrl);
    if (!imageResponse.ok) throw new Error("Image générée par FASHN inaccessible.");
    const blob = await imageResponse.blob();
    const newStorageId = await ctx.storage.store(blob);
    const url = await ctx.storage.getUrl(newStorageId);
    return { storageId: newStorageId, url };
  },
});

/* ─── Alerte email « 3 semaines sur Vinted sans être gagné » ──────────────── */

const VINTED_ALERT_RECIPIENT = "s.maccioni@eco-solidaire.fr";
const VINTED_ALERT_AFTER_MS = 21 * 24 * 60 * 60 * 1000; // 3 semaines
const KLYD_FROM = "Klyd <no-reply@mesoutils.eco-solidaire.fr>";

/** Articles en vente sur Vinted depuis 3 semaines, non gagnés, sans alerte encore envoyée. */
export const listVintedAlertCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - VINTED_ALERT_AFTER_MS;
    const items = await ctx.db
      .query("klydeItems")
      .withIndex("by_status")
      .collect();
    return items
      .filter(
        (item) =>
          item.vinted === true &&
          item.vintedAt != null &&
          item.vintedAt <= cutoff &&
          item.status !== "gagne" &&
          item.status !== "archive" &&
          item.archivedAt === undefined &&
          item.vintedAlertSentAt == null,
      )
      .map((item) => ({
        _id: item._id,
        title: item.title,
        sku: item.sku ?? null,
        price: item.price ?? null,
        brand: item.brand ?? null,
        size: item.size ?? null,
        status: item.status,
        vintedAt: item.vintedAt ?? null,
      }));
  },
});

export const markVintedAlertSent = internalMutation({
  args: { id: v.id("klydeItems") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { vintedAlertSentAt: Date.now() });
  },
});

function buildVintedAlertEmail(item: {
  title: string;
  sku: string | null;
  price: number | null;
  brand: string | null;
  size: string | null;
  vintedAt: number | null;
}): { subject: string; html: string } {
  const ref = item.sku ? ` (réf. ${item.sku})` : "";
  const since = item.vintedAt
    ? new Date(item.vintedAt).toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";
  const details = [
    item.brand ? `Marque : ${item.brand}` : null,
    item.size ? `Taille : ${item.size}` : null,
    item.price != null ? `Prix : ${item.price.toFixed(2)} €` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const subject = `⏰ Vinted : « ${item.title} » en vente depuis 3 semaines`;
  const html = `<!doctype html>
<html lang="fr"><body style="margin:0;background:#f6eee5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e7d8ca;">
      <tr><td style="background:#e8306a;padding:18px 26px;">
        <p style="margin:0;color:#ffffff;font-size:16px;font-weight:bold;">Klyd — Alerte Vinted</p>
      </td></tr>
      <tr><td style="padding:26px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:#e8306a;">
          En vente depuis 3 semaines
        </p>
        <p style="margin:0 0 14px;font-size:19px;font-weight:bold;color:#111111;">
          ${esc(item.title)}${esc(ref)}
        </p>
        <p style="margin:0 0 12px;font-size:14px;line-height:22px;color:#3d3d3d;">
          Cet article est mis en vente sur <strong>Vinted</strong> depuis le
          <strong>${esc(since)}</strong> et n'est toujours pas gagné.
          Pensez à vérifier l'annonce (prix, visibilité) ou à le réorienter.
        </p>
        ${details ? `<p style="margin:0;font-size:13px;line-height:20px;color:#6b6b6b;">${esc(details)}</p>` : ""}
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject, html };
}

/**
 * Cron quotidien : alerte à s.maccioni pour chaque article en vente sur Vinted
 * depuis 3 semaines et toujours non gagné (une seule alerte par article).
 */
export const sendVintedAlerts = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sent: number }> => {
    const candidates = await ctx.runQuery(internal.klyde.listVintedAlertCandidates, {});
    let sent = 0;
    for (const item of candidates) {
      const { subject, html } = buildVintedAlertEmail(item);
      await resendSend(VINTED_ALERT_RECIPIENT, subject, html, KLYD_FROM);
      await ctx.runMutation(internal.klyde.markVintedAlertSent, { id: item._id });
      sent += 1;
      if (sent < candidates.length) {
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
    return { sent };
  },
});

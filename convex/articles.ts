import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { scheduleStripeSync } from "./stripeCatalog";
import { requireCrmPermission } from "./lib";
import {
  claimQrCode,
  normalizeReference,
  releaseQrCodes,
} from "./articleQrCodes";
import { Doc, Id } from "./_generated/dataModel";

async function withImageUrls(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  article: Doc<"articles">,
) {
  const imageUrls = await Promise.all(
    article.images.map((id) => ctx.storage.getUrl(id)),
  );
  return { ...article, imageUrls: imageUrls.filter((u): u is string => u !== null) };
}

/**
 * Variante allégée pour les listes : ne résout que l'image de couverture
 * (les cartes n'affichent que la première), ce qui accélère fortement la
 * requête boutique sur les gros catalogues.
 */
async function withCoverImageUrl(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  article: Doc<"articles">,
) {
  const cover = article.images[0] ? await ctx.storage.getUrl(article.images[0]) : null;
  return { ...article, imageUrls: cover ? [cover] : [] };
}

/**
 * Codes des caisses, indexés par identifiant.
 *
 * Le code (« CA-12 ») est annoncé au client : c'est le bac où l'objet
 * l'attend en boutique. La table des caisses est petite — on la lit une fois
 * pour toute une liste plutôt qu'une caisse par article.
 */
async function caisseCodesById(ctx: QueryCtx) {
  const caisses = await ctx.db.query("caisses").collect();
  return new Map(caisses.map((caisse) => [String(caisse._id), caisse.code]));
}

/** Code de la caisse d'un article, ou `undefined` s'il n'est pas rangé. */
function caisseCodeOf(
  article: Doc<"articles">,
  codes: Map<string, string>,
): string | undefined {
  return article.caisseId ? codes.get(String(article.caisseId)) : undefined;
}

async function withBundleDetails(ctx: QueryCtx, article: Doc<"articles">) {
  const enriched = await withImageUrls(ctx, article);
  if (!article.isLot || !article.bundledArticleIds?.length) {
    return enriched;
  }

  const bundledArticles = [];
  for (const articleId of article.bundledArticleIds.slice(0, 24)) {
    const bundled = await ctx.db.get(articleId);
    if (bundled) {
      bundledArticles.push(await withImageUrls(ctx, bundled));
    }
  }

  return { ...enriched, bundledArticles };
}

function normalizeWeightKg(weightKg?: number) {
  if (weightKg === undefined || Number.isNaN(weightKg) || weightKg < 0) {
    throw new Error("Le poids doit être un nombre positif ou nul.");
  }
  return Math.round(weightKg * 1000) / 1000;
}

async function similarArticlesFor(ctx: QueryCtx, article: Doc<"articles">) {
  const allArticles = await ctx.db.query("articles").order("desc").take(80);
  const currentKeywords = deriveKeywords(article);
  const currentTheme = deriveThemeKey(article);

  const scored = allArticles
    .filter(
      (candidate) =>
        candidate._id !== article._id &&
        !candidate.isLot &&
        candidate.status !== "vendu" &&
        candidate.status !== "attente" &&
        candidate.status !== "lot",
    )
    .map((candidate) => {
      const candidateKeywords = deriveKeywords(candidate);
      const sameTheme =
        currentTheme && deriveThemeKey(candidate) === currentTheme ? 8 : 0;
      const overlap = keywordOverlap(currentKeywords, candidateKeywords).length;
      const sameSubcategory = candidate.subcategory === article.subcategory ? 2 : 0;
      return { candidate, score: sameTheme + overlap + sameSubcategory };
    })
    .filter(({ score }) => score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return Promise.all(scored.map(({ candidate }) => withImageUrls(ctx, candidate)));
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function normalizeKeyword(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const GENERIC_KEYWORDS = new Set([
  "article",
  "articles",
  "avec",
  "bleu",
  "bon",
  "couleur",
  "couleurs",
  "etat",
  "figurine",
  "figurines",
  "jaune",
  "jeux",
  "jouet",
  "jouets",
  "loisirs",
  "plastique",
  "plusieurs",
  "usage",
]);

const THEME_ALIASES: Array<{ key: string; words: string[] }> = [
  { key: "mario", words: ["mario", "kart", "nintendo", "luigi", "toad", "todd", "champignon", "bowser", "peach"] },
  { key: "playmobil-pirates", words: ["playmobil", "pirate", "pirates", "bateau", "voile", "corsaire"] },
  { key: "lego", words: ["lego", "brique", "briques", "duplo"] },
  { key: "pokemon", words: ["pokemon", "pokémon", "pikachu", "pokeball"] },
  { key: "disney", words: ["disney", "mickey", "minnie", "pixar"] },
];

function uniqueKeywords(values: string[]) {
  return Array.from(
    new Set(
      values
        .map(normalizeKeyword)
        .flatMap((value) => value.split(/\s+/))
        .filter((word) => word.length >= 3 && !GENERIC_KEYWORDS.has(word)),
    ),
  ).slice(0, 16);
}

function deriveKeywords(
  article: Pick<
    Doc<"articles">,
    "title" | "description" | "category" | "subcategory" | "keywords"
  >,
) {
  if (article.keywords?.length) return uniqueKeywords(article.keywords);
  return uniqueKeywords([
    article.title,
    article.description,
    article.category,
    article.subcategory ?? "",
  ]);
}

function deriveThemeKey(
  article: Pick<
    Doc<"articles">,
    "title" | "description" | "subcategory" | "keywords" | "themeKey"
  >,
) {
  if (article.themeKey) return normalizeKeyword(article.themeKey).replace(/\s+/g, "-");
  const text = normalizeKeyword(
    `${article.title} ${article.description} ${article.subcategory ?? ""} ${(article.keywords ?? []).join(" ")}`,
  );
  const words = new Set(text.split(/\s+/).filter(Boolean));
  const matched = THEME_ALIASES.find((theme) =>
    theme.words.some((word) => words.has(normalizeKeyword(word))),
  );
  return matched?.key ?? "";
}

function keywordOverlap(a: string[], b: string[]) {
  const bSet = new Set(b);
  return a.filter((word) => bSet.has(word));
}

function areLotCompatible(a: Doc<"articles">, b: Doc<"articles">) {
  const aTheme = deriveThemeKey(a);
  const bTheme = deriveThemeKey(b);
  if (aTheme && bTheme) return aTheme === bTheme;
  if (a.subcategory !== b.subcategory) return false;
  return keywordOverlap(deriveKeywords(a), deriveKeywords(b)).length >= 2;
}

/** Valeurs par défaut d'un article créé à partir d'une simple photo. */
const DRAFT_CATEGORY = "Maison et Jardin";
const DRAFT_CONDITION = "Bon état";

function normalizeDigits(value: string) {
  return value.replace(/\D/g, "");
}

function assertArticleReferences(args: { internalReference: string }) {
  if (!/^\d{6}$/.test(args.internalReference)) {
    throw new Error("La référence interne doit contenir exactement 6 chiffres.");
  }
}

async function generateInternalReference(ctx: {
  db: {
    query: (table: "articles") => {
      collect: () => Promise<Doc<"articles">[]>;
    };
  };
}) {
  const articles = await ctx.db.query("articles").collect();
  const existingReferences = new Set(
    articles
      .map((article) => article.internalReference)
      .filter((value): value is string => Boolean(value)),
  );

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = String(Math.floor(Math.random() * 1_000_000)).padStart(
      6,
      "0",
    );
    if (!existingReferences.has(candidate)) {
      return candidate;
    }
  }

  throw new Error("Impossible de générer une référence interne unique.");
}

function matchesArticleFilters(
  article: Doc<"articles">,
  filters: { searchText?: string; categories?: string[]; site?: "60" | "76" },
) {
  const selectedCategories = filters.categories?.filter(Boolean) ?? [];
  if (selectedCategories.length > 0 && !selectedCategories.includes(article.category)) {
    return false;
  }

  // Filtre recyclerie : un article sans site renseigné (stock antérieur au
  // champ) n'apparaît que dans « Toutes les recycleries ».
  if (filters.site && article.site !== filters.site) {
    return false;
  }

  const rawSearch = filters.searchText?.trim();
  if (!rawSearch) return true;

  const normalizedSearch = normalizeText(rawSearch);
  const digitSearch = normalizeDigits(rawSearch);
  const haystack = [
    article.title,
    article.category,
    article.subcategory,
    article.internalReference,
    ...(article.keywords ?? []),
    article.themeKey,
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeText);

  const textMatch = haystack.some((value) => value.includes(normalizedSearch));
  const digitMatch =
    digitSearch.length > 0 &&
    [article.internalReference]
      .filter((value): value is string => Boolean(value))
      .map(normalizeDigits)
      .some((value) => value.includes(digitSearch));

  return textMatch || digitMatch;
}

/**
 * Boutique publique : articles disponibles ET en cours d'achat (réservés mais
 * pas encore vendus). Les articles vendus sont masqués.
 */
export const listPublic = query({
  args: {
    categories: v.optional(v.array(v.string())),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
  },
  handler: async (ctx, args) => {
    const articles = await ctx.db
      .query("articles")
      .order("desc")
      .collect();
    const visible = articles.filter(
      (a) =>
        a.status !== "vendu" &&
        a.status !== "attente" &&
        a.status !== "lot" &&
        matchesArticleFilters(a, args),
    );
    const codes = await caisseCodesById(ctx);
    return Promise.all(
      visible.map(async (a) => ({
        ...(await withCoverImageUrl(ctx, a)),
        caisseCode: caisseCodeOf(a, codes),
      })),
    );
  },
});

/** Détail public d'un article. */
export const getPublic = query({
  args: { id: v.id("articles") },
  handler: async (ctx, { id }) => {
    const article = await ctx.db.get(id);
    if (!article) return null;
    const enriched = await withBundleDetails(ctx, article);
    const similarArticles = await similarArticlesFor(ctx, article);
    const caisse = article.caisseId ? await ctx.db.get(article.caisseId) : null;
    return {
      ...enriched,
      caisseCode: caisse?.code,
      similarArticles,
    };
  },
});

export const viewerCount = query({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    const threshold = Date.now() - 45_000;
    const views = await ctx.db
      .query("articleViews")
      .withIndex("by_articleId", (q) => q.eq("articleId", articleId))
      .collect();
    return views.filter((view) => view.lastSeenAt >= threshold).length;
  },
});

export const heartbeatView = mutation({
  args: { articleId: v.id("articles"), sessionId: v.string() },
  handler: async (ctx, { articleId, sessionId }) => {
    const article = await ctx.db.get(articleId);
    if (!article) return null;

    const existing = await ctx.db
      .query("articleViews")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .collect();

    const now = Date.now();
    const sameArticle = existing.find((view) => view.articleId === articleId);

    await Promise.all(
      existing
        .filter((view) => view.articleId !== articleId)
        .map((view) => ctx.db.delete(view._id)),
    );

    if (sameArticle) {
      await ctx.db.patch(sameArticle._id, { lastSeenAt: now });
      return sameArticle._id;
    }

    return await ctx.db.insert("articleViews", {
      articleId,
      sessionId,
      lastSeenAt: now,
    });
  },
});

export const leaveView = mutation({
  args: { articleId: v.id("articles"), sessionId: v.string() },
  handler: async (ctx, { articleId, sessionId }) => {
    const existing = await ctx.db
      .query("articleViews")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .collect();

    await Promise.all(
      existing
        .filter((view) => view.articleId === articleId)
        .map((view) => ctx.db.delete(view._id)),
    );
    return null;
  },
});

export const getManyPublic = query({
  args: { ids: v.array(v.id("articles")) },
  handler: async (ctx, { ids }) => {
    const uniqueIds = Array.from(new Set(ids)).slice(0, 30);
    const articles = [];
    for (const id of uniqueIds) {
      const article = await ctx.db.get(id);
      if (
        article &&
        article.status !== "vendu" &&
        article.status !== "attente" &&
        article.status !== "lot"
      ) {
        articles.push(await withImageUrls(ctx, article));
      }
    }
    return articles;
  },
});

/** CRM : détails des articles d'un lot (pour la génération IA de description). */
export const getManyForLot = query({
  args: { ids: v.array(v.id("articles")) },
  handler: async (ctx, { ids }) => {
    await requireCrmPermission(ctx, "articles", "read");
    const out = [];
    for (const id of ids.slice(0, 30)) {
      const article = await ctx.db.get(id);
      if (!article) continue;
      out.push({
        title: article.title,
        description: article.description.slice(0, 200),
        category: article.category,
        subcategory: article.subcategory,
        condition: article.condition,
        price: article.price,
        keywords: article.keywords?.slice(0, 8),
      });
    }
    return out;
  },
});

/** CRM : tous les articles, quel que soit le statut. */
export const listAll = query({
  args: {
    searchText: v.optional(v.string()),
    categories: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "articles", "read");
    const articles = await ctx.db.query("articles").order("desc").collect();
    const filtered = articles.filter((a) => matchesArticleFilters(a, args));
    return Promise.all(filtered.map((a) => withImageUrls(ctx, a)));
  },
});

/** Fiche article complète pour le CRM (page /crm/articles/:id). */
export const getForCrm = query({
  args: { id: v.id("articles") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "articles", "read");
    const article = await ctx.db.get(id);
    if (!article) return null;
    return withImageUrls(ctx, article);
  },
});

/**
 * Le panier d'une demande boutique, vu du CRM.
 *
 * Une seule requête pour toute la commande : chaque article arrive avec sa
 * photo, son prix, sa référence (celle du QR code) et surtout son emplacement
 * physique — caisse et recyclerie. Depuis une demande, l'équipe n'a autrement
 * aucune idée de l'endroit où sont rangés les objets à préparer.
 *
 * Contrairement à `getManyPublic`, les articles vendus sont conservés : dans
 * une commande payée, ils le sont tous.
 */
export const cartForCrm = query({
  args: { ids: v.array(v.id("articles")) },
  handler: async (ctx, { ids }) => {
    await requireCrmPermission(ctx, "demandes", "read");
    const items = [];
    for (const id of ids.slice(0, 40)) {
      const article = await ctx.db.get(id);
      if (!article) {
        items.push({ id, article: null });
        continue;
      }
      const caisse = article.caisseId ? await ctx.db.get(article.caisseId) : null;
      const enriched = await withImageUrls(ctx, article);
      items.push({
        id,
        article: {
          _id: enriched._id,
          title: enriched.title,
          price: enriched.price,
          originalPrice: enriched.originalPrice ?? null,
          category: enriched.category,
          weightKg: enriched.weightKg ?? null,
          status: enriched.status,
          imageUrls: enriched.imageUrls,
          internalReference: enriched.internalReference ?? null,
          site: enriched.site ?? null,
          location: enriched.location ?? null,
          caisse: caisse
            ? {
                code: caisse.code,
                label: caisse.label ?? null,
                zone: caisse.zone ?? null,
              }
            : null,
        },
      });
    }
    return items;
  },
});

export const listForLotAnalysis = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "articles", "analyze");
    const articles = await ctx.db.query("articles").order("desc").collect();
    const candidates = articles.filter(
      (article) =>
        !article.isLot &&
        // Un brouillon n'a ni titre ni description exploitables par l'IA.
        !article.draft &&
        !article.bundleKey &&
        article.status !== "vendu" &&
        article.status !== "reserve",
    );

    return Promise.all(
      candidates.slice(0, 80).map(async (article) => {
        const enriched = await withImageUrls(ctx, article);
        return {
          _id: enriched._id,
          title: enriched.title,
          description: enriched.description,
          price: enriched.price,
          category: enriched.category,
          subcategory: enriched.subcategory,
          condition: enriched.condition,
          status: enriched.status,
          keywords: deriveKeywords(enriched),
          themeKey: deriveThemeKey(enriched),
          imageUrls: enriched.imageUrls,
        };
      }),
    );
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    description: v.string(),
    price: v.number(),
    weightKg: v.number(),
    location: v.optional(v.string()),
    caisseId: v.optional(v.id("caisses")),
    /**
     * Référence d'un QR code déjà imprimé et collé sur l'objet. Fournie, elle
     * devient la référence interne de l'article au lieu d'en tirer une neuve.
     */
    qrReference: v.optional(v.string()),
    originalPrice: v.optional(v.number()),
    /** Recyclerie qui détient l'article (site de retrait pour le client). */
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    category: v.string(),
    subcategory: v.optional(v.string()),
    condition: v.string(),
    keywords: v.optional(v.array(v.string())),
    themeKey: v.optional(v.string()),
    images: v.array(v.id("_storage")),
    desiredStatus: v.optional(
      v.union(v.literal("disponible"), v.literal("attente"), v.literal("lot")),
    ),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "articles", "create");
    const scanned = args.qrReference ? normalizeReference(args.qrReference) : "";
    const internalReference = scanned || (await generateInternalReference(ctx));
    assertArticleReferences({ internalReference });
    const { desiredStatus, qrReference: _qrReference, ...articleArgs } = args;
    const shouldKeepForLot = desiredStatus === "attente" || desiredStatus === "lot";
    const articleId = await ctx.db.insert("articles", {
      ...articleArgs,
      weightKg: normalizeWeightKg(args.weightKg),
      location: args.location?.trim() || undefined,
      internalReference,
      keywords: args.keywords?.length ? uniqueKeywords(args.keywords) : undefined,
      themeKey: args.themeKey
        ? normalizeKeyword(args.themeKey).replace(/\s+/g, "-")
        : undefined,
      status: shouldKeepForLot ? "attente" : "disponible",
      createdAt: Date.now(),
    });
    if (scanned) await claimQrCode(ctx, scanned, articleId);
    await scheduleStripeSync(ctx, articleId);
    return articleId;
  },
});

/**
 * Ajout rapide au stock boutique : on ne fournit QUE des photos, une par
 * article. Chaque photo crée un article « brouillon » avec sa référence interne
 * (donc son QR code) ; l'annonce et le détourage sont produits plus tard par un
 * run IA groupé (cf. `applyAiListing`).
 */
export const createDraftsFromPhotos = mutation({
  args: {
    storageIds: v.array(v.id("_storage")),
    /** Caisse dans laquelle ranger tous les brouillons créés. */
    caisseId: v.optional(v.id("caisses")),
    /**
     * QR codes déjà collés sur les objets, alignés sur `storageIds`. Une chaîne
     * vide laisse tirer une référence neuve pour cette photo.
     */
    qrReferences: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { storageIds, caisseId, qrReferences }) => {
    await requireCrmPermission(ctx, "articles", "create");
    if (storageIds.length === 0) {
      throw new Error("Ajoutez au moins une photo.");
    }
    if (caisseId && !(await ctx.db.get(caisseId))) {
      throw new Error("Caisse introuvable.");
    }

    const created: Array<{ id: Id<"articles">; internalReference: string }> = [];
    // Les références sont tirées une par une : `generateInternalReference` relit
    // la table, donc les brouillons déjà insérés sont bien pris en compte.
    for (const [index, storageId] of storageIds.entries()) {
      const scanned = normalizeReference(qrReferences?.[index] ?? "");
      const internalReference = scanned || (await generateInternalReference(ctx));
      const id = await ctx.db.insert("articles", {
        title: `Article ${internalReference}`,
        description: "",
        price: 0,
        category: DRAFT_CATEGORY,
        condition: DRAFT_CONDITION,
        caisseId,
        internalReference,
        images: [storageId],
        status: "attente",
        draft: true,
        createdAt: Date.now(),
      });
      if (scanned) await claimQrCode(ctx, scanned, id);
      await scheduleStripeSync(ctx, id);
      created.push({ id, internalReference });
    }
    return created;
  },
});

/**
 * Applique à un article le résultat d'un run IA (annonce générée, éventuelles
 * images détourées) et le sort de l'état brouillon.
 */
export const applyAiListing = mutation({
  args: {
    id: v.id("articles"),
    title: v.string(),
    description: v.string(),
    price: v.number(),
    originalPrice: v.optional(v.number()),
    weightKg: v.optional(v.number()),
    category: v.string(),
    subcategory: v.optional(v.string()),
    condition: v.string(),
    keywords: v.optional(v.array(v.string())),
    themeKey: v.optional(v.string()),
    images: v.optional(v.array(v.id("_storage"))),
    status: v.optional(
      v.union(v.literal("disponible"), v.literal("attente"), v.literal("lot")),
    ),
  },
  handler: async (ctx, { id, images, status, ...rest }) => {
    await requireCrmPermission(ctx, "articles", "update");
    const article = await ctx.db.get(id);
    if (!article) throw new Error("Article introuvable.");
    if (!rest.title.trim()) throw new Error("Le titre est requis.");
    if (rest.price < 0) throw new Error("Prix invalide.");

    await ctx.db.patch(id, {
      title: rest.title.trim(),
      description: rest.description,
      price: rest.price,
      originalPrice: rest.originalPrice,
      weightKg:
        rest.weightKg !== undefined
          ? normalizeWeightKg(rest.weightKg)
          : article.weightKg,
      category: rest.category,
      subcategory: rest.subcategory || undefined,
      condition: rest.condition,
      keywords: rest.keywords?.length ? uniqueKeywords(rest.keywords) : undefined,
      themeKey: rest.themeKey
        ? normalizeKeyword(rest.themeKey).replace(/\s+/g, "-")
        : undefined,
      ...(images ? { images } : {}),
      ...(status ? { status } : {}),
      draft: undefined,
    });
    await scheduleStripeSync(ctx, id);
  },
});

export const publishLot = mutation({
  args: {
    articleIds: v.array(v.id("articles")),
    title: v.string(),
    description: v.string(),
    price: v.number(),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "articles", "create");
    if (args.articleIds.length < 2) {
      throw new Error("Un lot doit contenir au moins 2 articles.");
    }

    const articles: Doc<"articles">[] = [];
    for (const articleId of args.articleIds) {
      const article = await ctx.db.get(articleId);
      if (article && !article.isLot && article.status !== "vendu") {
        articles.push(article);
      }
    }
    if (articles.length < 2) {
      throw new Error("Aucun lot publiable avec ces articles.");
    }
    const compatible = articles.every((article, index) =>
      index === 0 ? true : areLotCompatible(articles[0], article),
    );
    if (!compatible) {
      throw new Error(
        "Ce lot n'est pas assez cohérent : les articles ne partagent pas le même thème ou assez de mots-clés.",
      );
    }

    const first = articles[0];
    const sameSubcategory = articles.every(
      (article) => article.subcategory === first.subcategory,
    );
    const sameCategory = articles.every((article) => article.category === first.category);
    const totalWeight = articles.reduce(
      (sum, article) => sum + (article.weightKg ?? 0),
      0,
    );
    const bundleKey = normalizeText(
      `manual::${deriveThemeKey(first) || first.category}::${Date.now()}`,
    );
    const images = Array.from(
      new Set(articles.flatMap((article) => article.images)),
    ).slice(0, 10);
    const internalReference = await generateInternalReference(ctx);
    const lotId = await ctx.db.insert("articles", {
      title: args.title.trim() || `Lot ${first.subcategory || first.category}`,
      description: args.description.trim(),
      price: Math.max(1, args.price),
      weightKg: normalizeWeightKg(totalWeight),
      internalReference,
      category: sameCategory ? first.category : "Loisirs",
      subcategory: sameSubcategory ? first.subcategory : undefined,
      condition: "Lot",
      keywords: uniqueKeywords(articles.flatMap((article) => deriveKeywords(article))),
      themeKey: deriveThemeKey(first) || undefined,
      images,
      status: "disponible",
      isLot: true,
      bundledArticleIds: articles.map((article) => article._id),
      bundleKey,
      bundleReason:
        "Lot publié depuis l'analyse des lots potentiels du CRM.",
      createdAt: Date.now(),
    });

    await Promise.all(
      articles.map((article) =>
        ctx.db.patch(article._id, {
          status: "lot",
          bundleKey,
          bundleReason: `Inclus dans le lot "${args.title}".`,
        }),
      ),
    );

    await scheduleStripeSync(ctx, lotId);
    for (const article of articles) {
      await scheduleStripeSync(ctx, article._id);
    }

    return lotId;
  },
});

export const patchStatus = mutation({
  args: {
    id: v.id("articles"),
    status: v.union(
      v.literal("disponible"),
      v.literal("reserve"),
      v.literal("vendu"),
      v.literal("attente"),
      v.literal("lot"),
    ),
  },
  handler: async (ctx, { id, status }) => {
    await requireCrmPermission(ctx, "articles", "update");
    await ctx.db.patch(id, { status });
    await scheduleStripeSync(ctx, id);
  },
});

export const update = mutation({
  args: {
    id: v.id("articles"),
    title: v.string(),
    description: v.string(),
    price: v.number(),
    weightKg: v.number(),
    location: v.optional(v.string()),
    caisseId: v.optional(v.id("caisses")),
    originalPrice: v.optional(v.number()),
    internalReference: v.string(),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    category: v.string(),
    subcategory: v.optional(v.string()),
    condition: v.string(),
    keywords: v.optional(v.array(v.string())),
    themeKey: v.optional(v.string()),
    images: v.array(v.id("_storage")),
    status: v.union(
      v.literal("disponible"),
      v.literal("reserve"),
      v.literal("vendu"),
      v.literal("attente"),
      v.literal("lot"),
    ),
  },
  handler: async (ctx, { id, ...rest }) => {
    await requireCrmPermission(ctx, "articles", "update");
    assertArticleReferences(rest);
    await ctx.db.patch(id, {
      ...rest,
      weightKg: normalizeWeightKg(rest.weightKg),
      location: rest.location?.trim() || undefined,
      // Explicite : le formulaire pilote la caisse, y compris pour la vider
      // (`undefined` retire le champ, alors qu'un argument absent le garderait).
      caisseId: rest.caisseId ?? undefined,
      site: rest.site ?? undefined,
      keywords: rest.keywords?.length ? uniqueKeywords(rest.keywords) : undefined,
      themeKey: rest.themeKey
        ? normalizeKeyword(rest.themeKey).replace(/\s+/g, "-")
        : undefined,
    });
    await scheduleStripeSync(ctx, id);
  },
});

export const remove = mutation({
  args: { id: v.id("articles") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "articles", "delete");
    // L'étiquette reste collée quelque part : on rend le code au pool plutôt
    // que de le perdre avec l'article.
    await releaseQrCodes(ctx, id);
    // Les identifiants Stripe disparaissent avec le document : on planifie
    // l'archivage du produit AVANT de supprimer l'article.
    const article = await ctx.db.get(id);
    if (article?.stripeProductId) {
      await ctx.scheduler.runAfter(0, internal.stripeCatalog.archiveProduct, {
        stripeProductId: article.stripeProductId,
        stripePriceId: article.stripePriceId,
      });
    }
    await ctx.db.delete(id);
  },
});

// ─── Produit du jour ────────────────────────────────────────────────────────

/** CRM : bascule l'article en "Produit du jour" (un seul à la fois). */
export const toggleProductOfDay = mutation({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    await requireCrmPermission(ctx, "articles", "update");
    const target = await ctx.db.get(articleId);
    if (!target) throw new Error("Article introuvable.");
    const willEnable = !target.productOfDay;

    const current = await ctx.db
      .query("articles")
      .withIndex("by_productOfDay", (q) => q.eq("productOfDay", true))
      .collect();
    await Promise.all(
      current
        .filter((a) => a._id !== articleId)
        .map((a) => ctx.db.patch(a._id, { productOfDay: undefined })),
    );

    await ctx.db.patch(articleId, { productOfDay: willEnable ? true : undefined });
    return willEnable;
  },
});

/** Public : article mis en avant (ou null). */
export const getProductOfDay = query({
  args: {},
  handler: async (ctx) => {
    const featured = await ctx.db
      .query("articles")
      .withIndex("by_productOfDay", (q) => q.eq("productOfDay", true))
      .first();
    if (!featured) return null;
    if (featured.status === "vendu" || featured.status === "attente" || featured.status === "lot") {
      return null;
    }
    return withImageUrls(ctx, featured);
  },
});

// ─── Wishlist (favoris clients) ───────────────────────────────────────────────

/** Ajoute/retire un article des favoris du client connecté. Renvoie l'état final. */
export const toggleWishlist = mutation({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Connexion requise pour sauvegarder un article.");
    const existing = await ctx.db
      .query("wishlists")
      .withIndex("by_user_article", (q) =>
        q.eq("userId", identity.subject).eq("articleId", articleId),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
      return false;
    }
    await ctx.db.insert("wishlists", {
      userId: identity.subject,
      articleId,
      createdAt: Date.now(),
    });
    return true;
  },
});

/** IDs des favoris du client connecté (pour l'état des cœurs). */
export const myWishlistIds = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("wishlists")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
    return rows.map((r) => r.articleId);
  },
});

/** Favoris du client connecté (articles disponibles). */
export const myWishlist = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("wishlists")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .collect();
    const out = [];
    for (const r of rows) {
      const a = await ctx.db.get(r.articleId);
      // On garde aussi les articles réservés/vendus pour afficher leur statut,
      // mais pas les brouillons (attente) ni les lots.
      if (a && a.status !== "attente" && a.status !== "lot") {
        out.push(await withCoverImageUrl(ctx, a));
      }
    }
    return out;
  },
});

/**
 * Recommandations "Produits susceptibles de vous intéresser".
 * Renvoie jusqu'à 10 articles seulement si le client a plus de 5 favoris,
 * scorés par mots-clés / catégorie / sous-catégorie des favoris.
 */
export const recommendations = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("wishlists")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
    if (rows.length <= 5) return [];

    const savedIds = new Set(rows.map((r) => String(r.articleId)));
    const saved: Doc<"articles">[] = [];
    for (const r of rows) {
      const a = await ctx.db.get(r.articleId);
      if (a) saved.push(a);
    }

    const profileKeywords = new Set<string>();
    const categories = new Set<string>();
    const subcategories = new Set<string>();
    for (const a of saved) {
      for (const k of deriveKeywords(a)) profileKeywords.add(k);
      categories.add(a.category);
      if (a.subcategory) subcategories.add(a.subcategory);
    }
    const keywordList = [...profileKeywords];

    const pool = await ctx.db.query("articles").order("desc").take(160);
    const scored = pool
      .filter(
        (c) =>
          !savedIds.has(String(c._id)) &&
          !c.isLot &&
          c.status !== "vendu" &&
          c.status !== "attente" &&
          c.status !== "lot",
      )
      .map((c) => {
        const overlap = keywordOverlap(deriveKeywords(c), keywordList).length;
        const catScore = categories.has(c.category) ? 2 : 0;
        const subScore = c.subcategory && subcategories.has(c.subcategory) ? 3 : 0;
        return { c, score: overlap + catScore + subScore };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    return Promise.all(scored.map((x) => withCoverImageUrl(ctx, x.c)));
  },
});

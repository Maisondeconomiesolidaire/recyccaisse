import { action, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { accessAllows } from "./lib";

// Dépôt de départ pour le calcul des frais de livraison (identique aux tournées).
const DEPOT_ADDRESS = "4 rue de la prairie 60650 Lachapelle-aux-Pots";
// Rayon maximal pour considérer une collecte comme « créneau avantageux ».
const ADVANTAGEOUS_RADIUS_KM = 5;

const ARTICLE_CATEGORIES: Record<string, string[]> = {
  "Maison et Jardin": [
    "Ameublement",
    "Électroménager",
    "Décoration",
    "Bricolage",
    "Vaisselle",
  ],
  Électronique: [
    "Ordinateurs",
    "Téléphones",
    "Tablettes",
    "Photo, audio et vidéo",
    "Accessoires informatique",
  ],
  Loisirs: [
    "Jeux et Jouets",
    "Vélos",
    "CD - Musique",
    "DVD - Films",
    "Instruments de musique",
    "Livres",
  ],
};

// ─── Helpers Mapbox ──────────────────────────────────────────────────────────

export async function geocode(
  address: string,
  accessToken: string,
): Promise<{ longitude: number; latitude: number }> {
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

/** Distance routière (km) entre deux points via Mapbox Directions. */
export async function drivingDistanceKm(
  from: { longitude: number; latitude: number },
  to: { longitude: number; latitude: number },
  accessToken: string,
): Promise<number> {
  const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const url = new URL(
    `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}`,
  );
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("overview", "false");
  url.searchParams.set("alternatives", "false");

  const response = await fetch(url.toString());
  const payload = (await response.json()) as {
    code?: string;
    message?: string;
    routes?: Array<{ distance?: number }>;
  };
  if (!response.ok || payload.code !== "Ok" || !payload.routes?.length) {
    throw new Error(payload.message || "Calcul d'itinéraire Mapbox impossible.");
  }
  return (payload.routes[0].distance ?? 0) / 1000;
}

/** Distance ET durée routières (aller simple) entre deux points via Mapbox. */
export async function drivingRoute(
  from: { longitude: number; latitude: number },
  to: { longitude: number; latitude: number },
  accessToken: string,
): Promise<{ km: number; minutes: number }> {
  const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const url = new URL(
    `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}`,
  );
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("overview", "false");
  url.searchParams.set("alternatives", "false");

  const response = await fetch(url.toString());
  const payload = (await response.json()) as {
    code?: string;
    message?: string;
    routes?: Array<{ distance?: number; duration?: number }>;
  };
  if (!response.ok || payload.code !== "Ok" || !payload.routes?.length) {
    throw new Error(payload.message || "Calcul d'itinéraire Mapbox impossible.");
  }
  const route = payload.routes[0];
  return { km: (route.distance ?? 0) / 1000, minutes: (route.duration ?? 0) / 60 };
}

/** Distance à vol d'oiseau (km) — pour filtrer rapidement les créneaux. */
function haversineKm(
  a: { longitude: number; latitude: number },
  b: { longitude: number; latitude: number },
): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function buildAddressString(a: {
  address?: string;
  postalCode?: string;
  city?: string;
}): string {
  return [a.address, a.postalCode, a.city]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
}

// ─── Analyse IA des 2 photos (article + référence) ───────────────────────────

const VISION_PROMPT = `Tu es un agent de recyclerie qui catégorise un article à livrer à partir d'une photo.
Retourne UNIQUEMENT un JSON valide (sans markdown) :
{
  "title": "nom court et précis de l'article en français (max 60 caractères)",
  "category": "Exactement une de : Maison et Jardin | Électronique | Loisirs",
  "subcategory": "Exactement une des sous-catégories de la catégorie choisie"
}
Sous-catégories :
- Maison et Jardin : Ameublement, Électroménager, Décoration, Bricolage, Vaisselle
- Électronique : Ordinateurs, Téléphones, Tablettes, Photo, audio et vidéo, Accessoires informatique
- Loisirs : Jeux et Jouets, Vélos, CD - Musique, DVD - Films, Instruments de musique, Livres`;

const BARCODE_PROMPT = `Tu lis une étiquette / code-barres / référence sur une photo.
Retourne UNIQUEMENT un JSON valide (sans markdown) :
{
  "code": "la suite de chiffres lue sur le code-barres ou la référence, sans espaces ni lettres. null si illisible.",
  "price": "le prix visible sur l'etiquette en euros, sous forme numerique uniquement, par exemple 19.99. null si absent ou illisible."
}`;

function normalizeVisionPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^\d,.-]/g, "").replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

async function callOpenAIVision<T>(
  apiKey: string,
  systemPrompt: string,
  imageUrl: string,
  userText: string,
): Promise<T> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 300,
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
            { type: "text", text: userText },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Erreur API OpenAI (${response.status}): ${err.slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  let cleaned = (data.choices?.[0]?.message?.content ?? "")
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
  if (!cleaned.startsWith("{")) {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) cleaned = cleaned.slice(first, last + 1);
  }
  return JSON.parse(cleaned) as T;
}

/** Références de livraison déjà utilisées (pour générer un numéro unique). */
export const usedLivraisonReferences = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_type", (q) => q.eq("type", "livraison"))
      .collect();
    return requests
      .map((r) => r.livraison?.reference)
      .filter((ref): ref is string => Boolean(ref));
  },
});

/** Prix et titre d'un article identifié par sa référence (code-barres scanné). */
export const articleByReference = internalQuery({
  args: { reference: v.string() },
  handler: async (
    ctx,
    { reference },
  ): Promise<{ price: number; title: string } | null> => {
    const ref = reference.replace(/\D/g, "");
    if (!ref) return null;
    const byInternal = await ctx.db
      .query("articles")
      .withIndex("by_internalReference", (q) => q.eq("internalReference", ref))
      .first();
    if (byInternal) return { price: byInternal.price, title: byInternal.title };
    return null;
  },
});

export const analyzePhotos = action({
  args: {
    articlePhotoId: v.id("_storage"),
    referencePhotoId: v.optional(v.id("_storage")),
  },
  handler: async (
    ctx,
    { articlePhotoId, referencePhotoId },
  ): Promise<{
    articleTitle: string;
    category: string;
    subcategory: string;
    condition: string;
    reference: string;
    referenceFromBarcode: boolean;
    articlePrice: number | null;
  }> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "demandes", "create")) {
      throw new Error("Accès CRM insuffisant.");
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Clé OpenAI non configurée. Exécutez : npx convex env set OPENAI_API_KEY sk-...",
      );
    }

    const articleUrl = await ctx.storage.getUrl(articlePhotoId);
    if (!articleUrl) throw new Error("Photo de l'article introuvable.");

    // 1) Catégorisation de l'article à partir de sa photo.
    const vision = await callOpenAIVision<{
      title: string;
      category: string;
      subcategory: string;
    }>(apiKey, VISION_PROMPT, articleUrl, "Catégorise cet article.");

    const category = Object.keys(ARTICLE_CATEGORIES).includes(vision.category)
      ? vision.category
      : "Maison et Jardin";
    const subcategory = ARTICLE_CATEGORIES[category].includes(vision.subcategory)
      ? vision.subcategory
      : ARTICLE_CATEGORIES[category][0];

    // 2) Référence : lecture du code-barres si une photo de référence est fournie,
    //    sinon génération d'un nouveau numéro interne unique.
    let barcode: string | null = null;
    let visiblePrice: number | null = null;
    if (referencePhotoId) {
      const refUrl = await ctx.storage.getUrl(referencePhotoId);
      if (refUrl) {
        try {
          const read = await callOpenAIVision<{ code: string | null; price: number | string | null }>(
            apiKey,
            BARCODE_PROMPT,
            refUrl,
            "Lis le code-barres, la référence et le prix affiché sur l'étiquette.",
          );
          const digits = (read.code ?? "").replace(/\D/g, "");
          barcode = digits.length >= 4 ? digits : null;
          visiblePrice = normalizeVisionPrice(read.price);
        } catch {
          barcode = null;
          visiblePrice = null;
        }
      }
    }

    // Prix de l'article : si le code-barres correspond à un article connu, on
    // reprend son prix réel ; sinon le prix reste à renseigner manuellement.
    let articlePrice: number | null = null;
    let matchedTitle: string | null = null;
    if (barcode) {
      const match = await ctx.runQuery(internal.livraison.articleByReference, {
        reference: barcode,
      });
      if (match) {
        articlePrice = match.price;
        matchedTitle = match.title;
      }
    }
    if (articlePrice === null && visiblePrice !== null) {
      articlePrice = Math.round(visiblePrice * 100) / 100;
    }

    const used = new Set(
      await ctx.runQuery(internal.livraison.usedLivraisonReferences, {}),
    );

    let reference: string;
    let referenceFromBarcode: boolean;
    if (barcode && !used.has(barcode)) {
      // Même numéro que le code-barres scanné, en référence interne.
      reference = barcode;
      referenceFromBarcode = true;
    } else {
      referenceFromBarcode = false;
      let candidate = "";
      for (let i = 0; i < 200; i += 1) {
        candidate = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
        if (!used.has(candidate)) break;
      }
      reference = candidate;
    }

    return {
      articleTitle: matchedTitle ?? vision.title?.slice(0, 80) ?? "Article",
      category,
      subcategory,
      condition: "",
      reference,
      referenceFromBarcode,
      articlePrice,
    };
  },
});

// ─── Calcul des frais de livraison (0,50 € / km aller-retour) ────────────────

export const computeDeliveryFee = action({
  args: {
    address: v.string(),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ distanceKm: number; deliveryFee: number }> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "demandes", "create")) {
      throw new Error("Accès CRM insuffisant.");
    }
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error("MAPBOX_ACCESS_TOKEN n'est pas configurée côté Convex.");
    }

    const destination = buildAddressString(args);
    if (!destination) throw new Error("Adresse de livraison manquante.");

    const [depot, target] = await Promise.all([
      geocode(DEPOT_ADDRESS, accessToken),
      geocode(destination, accessToken),
    ]);
    const oneWayKm = await drivingDistanceKm(depot, target, accessToken);
    // Distance aller-retour (le véhicule fait l'aller et le retour au dépôt).
    const distanceKm = Math.round(oneWayKm * 2 * 10) / 10;
    // Tarif : 0,50 € du kilomètre (aller-retour).
    const deliveryFee = Math.max(0, Math.round(distanceKm * 0.5 * 100) / 100);
    return { distanceKm, deliveryFee };
  },
});

// Adresses de départ des collectes (devis C3).
const C3_DEPARTURE_ADDRESSES = {
  LCP: "4 rue de la prairie 60650 Lachapelle-aux-Pots",
  GEB: "150 route de paris 76220 Gournay-en-Bray",
} as const;

/**
 * Distance + durée routières (aller simple) entre un départ collecte (LCP/GEB)
 * et l'adresse de collecte du client, pour le calcul devis à 1 €/km.
 */
export const estimateCollecteRoute = action({
  args: {
    departure: v.union(v.literal("LCP"), v.literal("GEB")),
    address: v.string(),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ km: number; minutes: number } | null> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "demandes", "read")) {
      throw new Error("Accès CRM insuffisant.");
    }
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error("MAPBOX_ACCESS_TOKEN n'est pas configurée côté Convex.");
    }
    const destination = buildAddressString(args);
    if (!destination) return null;

    const [from, to] = await Promise.all([
      geocode(C3_DEPARTURE_ADDRESSES[args.departure], accessToken),
      geocode(destination, accessToken),
    ]);
    return await drivingRoute(from, to, accessToken);
  },
});

// ─── Créneaux avantageux (collectes planifiées à proximité) ──────────────────

/** Collectes/livraisons planifiées à venir, avec une adresse exploitable. */
export const scheduledNearbyCandidates = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    Array<{
      reference: string;
      scheduledDate: number;
      address: string;
      city: string | null;
    }>
  > => {
    const now = Date.now();
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_scheduledDate", (q) => q.gte("scheduledDate", now))
      .collect();
    return requests
      .filter((r) => r.type === "collecte" || r.type === "livraison")
      .map((r) => {
        const collectAddr = r.collecte?.collectAddress;
        const livAddr = r.livraison?.deliveryAddress;
        const source = collectAddr?.address
          ? collectAddr
          : livAddr?.address
            ? livAddr
            : r.customer;
        const address = buildAddressString({
          address: source.address,
          postalCode: source.postalCode,
          city: source.city,
        });
        return {
          reference: r.reference ?? String(r._id).slice(-6),
          scheduledDate: r.scheduledDate as number,
          address,
          city: source.city ?? null,
        };
      })
      .filter((c) => Boolean(c.address));
  },
});

export const advantageousSlots = action({
  args: {
    address: v.string(),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
    deliveryFee: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    slots: Array<{
      requestReference: string;
      scheduledDate: number;
      distanceKm: number;
      city: string | null;
      discount: number;
      reducedDeliveryFee: number;
    }>;
    message: string;
  }> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "demandes", "create")) {
      throw new Error("Accès CRM insuffisant.");
    }
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error("MAPBOX_ACCESS_TOKEN n'est pas configurée côté Convex.");
    }

    const destination = buildAddressString(args);
    if (!destination) throw new Error("Adresse de livraison manquante.");

    const target = await geocode(destination, accessToken);
    const candidates = await ctx.runQuery(
      internal.livraison.scheduledNearbyCandidates,
      {},
    );

    const fee = Math.max(0, args.deliveryFee ?? 0);
    const slots: Array<{
      requestReference: string;
      scheduledDate: number;
      distanceKm: number;
      city: string | null;
      discount: number;
      reducedDeliveryFee: number;
    }> = [];

    // Limite le nombre de géocodages pour rester sous les quotas Mapbox.
    for (const candidate of candidates.slice(0, 25)) {
      let point;
      try {
        point = await geocode(candidate.address, accessToken);
      } catch {
        continue;
      }
      const km = haversineKm(target, point);
      if (km <= ADVANTAGEOUS_RADIUS_KM) {
        const groupedOneWay = await drivingDistanceKm(point, target, accessToken);
        if (groupedOneWay > ADVANTAGEOUS_RADIUS_KM) {
          continue;
        }
        // Frais réduits : 0,50 €/km aller-retour entre la collecte et le client.
        const groupedRoundTrip = Math.round(groupedOneWay * 2 * 10) / 10;
        const reducedDeliveryFee = Math.max(
          0,
          Math.round(groupedRoundTrip * 0.5 * 100) / 100,
        );
        slots.push({
          requestReference: candidate.reference,
          scheduledDate: candidate.scheduledDate,
          distanceKm: Math.round(km * 10) / 10,
          city: candidate.city,
          reducedDeliveryFee,
          discount: fee > 0 ? Math.max(0, fee - reducedDeliveryFee) : 0,
        });
      }
    }

    slots.sort((a, b) => a.scheduledDate - b.scheduledDate);

    const message =
      slots.length === 0
        ? `Aucune collecte planifiée à moins de ${ADVANTAGEOUS_RADIUS_KM} km de l'adresse de livraison. Aucun créneau groupé à proposer pour l'instant.`
        : `${slots.length} créneau(x) avantageux : nous passons déjà à proximité (≤ ${ADVANTAGEOUS_RADIUS_KM} km). En proposant au client d'attendre l'une de ces dates, la livraison est groupée et une réduction peut être offerte.`;

    return { slots, message };
  },
});

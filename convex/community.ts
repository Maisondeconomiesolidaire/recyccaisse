import { v } from "convex/values";
import { action, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  emailForClerkId,
  formatUserName,
  hasCrmPermission,
  livePhoto,
  livePhotosByClerkId,
  requireCrmPermission,
  requireStaff,
  requireUser,
} from "./lib";
import { createMesoutilsNotification } from "./mesoutilsNotifications";

const PAGE_KEY = "mesoutils:actualites";

const dealType = v.union(
  v.literal("pret"),
  v.literal("don"),
  v.literal("vente"),
  v.literal("echange"),
  v.literal("location"),
);

/** Unité de facturation d'une location (le prix s'entend « par période »). */
const rentalPeriod = v.union(
  v.literal("jour"),
  v.literal("semaine"),
  v.literal("mois"),
  v.literal("annee"),
);

const dealAdKind = v.union(v.literal("offre"), v.literal("demande"));

function displayName(identity: {
  name?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
}) {
  return formatUserName(identity);
}

function pictureUrl(identity: unknown) {
  return (identity as { pictureUrl?: string | null }).pictureUrl ?? undefined;
}

function pairKey(a: string, b: string) {
  return [a, b].sort().join("__");
}

async function resolveImages(ctx: QueryCtx | MutationCtx, images: Id<"_storage">[] | undefined) {
  if (!images?.length) return [];
  const urls = await Promise.all(images.map((id) => ctx.storage.getUrl(id)));
  return urls.filter((value): value is string => Boolean(value));
}

async function notifyDealInterest(
  ctx: MutationCtx,
  deal: Doc<"dealPosts">,
  identity: {
    subject: string;
    name?: string | null;
    givenName?: string | null;
    familyName?: string | null;
    email?: string | null;
  },
) {
  // On ne se notifie pas soi-même.
  if (deal.authorClerkId === identity.subject) return;

  const interestedName = displayName(identity);
  await createMesoutilsNotification(ctx, {
    recipientClerkId: deal.authorClerkId,
    kind: "deal_interest",
    title: `${interestedName} est intéressé·e par votre annonce`,
    body: deal.title,
    actorName: interestedName,
    actorClerkId: identity.subject,
    actorImageUrl: pictureUrl(identity),
    href: `/messagerie?to=${encodeURIComponent(identity.subject)}&name=${encodeURIComponent(interestedName)}`,
  });

  const email = await emailForClerkId(ctx, deal.authorClerkId);
  if (email) {
    await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendDealInterestEmail, {
      email,
      authorName: deal.authorName,
      interestedName,
      dealTitle: deal.title,
      interestedPhotoUrl: pictureUrl(identity),
      dealImageStorageId: deal.images[0] ? String(deal.images[0]) : undefined,
    });
  }
}

/* ─── Événements ─────────────────────────────────────────────────────────── */

export const listEvents = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const events = await ctx.db.query("events").withIndex("by_start").order("desc").take(100);
    const photos = await livePhotosByClerkId(ctx, events.map((e) => e.authorClerkId));
    return await Promise.all(
      events.map(async (event) => ({
        ...event,
        authorImageUrl: livePhoto(photos, event.authorClerkId, event.authorImageUrl),
        imageUrls: await resolveImages(ctx, event.images),
        canManage: event.authorClerkId === identity.subject,
      })),
    );
  },
});

export const createEvent = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    start: v.optional(v.number()),
    end: v.optional(v.number()),
    images: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    if (!args.title.trim()) throw new Error("Titre requis.");
    return await ctx.db.insert("events", {
      authorClerkId: identity.subject,
      authorName: displayName(identity),
      authorImageUrl: pictureUrl(identity),
      title: args.title.trim(),
      description: args.description?.trim() || undefined,
      location: args.location?.trim() || undefined,
      start: args.start,
      end: args.end,
      images: args.images ?? [],
      createdAt: Date.now(),
    });
  },
});

export const removeEvent = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const event = await ctx.db.get(args.eventId);
    if (!event) return;
    const isManager = await canManage(ctx);
    if (event.authorClerkId !== identity.subject && !isManager) {
      throw new Error("Suppression non autorisée.");
    }
    await ctx.db.delete(args.eventId);
  },
});

/* ─── Assistant IA pour les posts d'événements ───────────────────────────── */

export const assertCanCreateEvent = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "create");
    return true;
  },
});

const EVENT_POST_SYSTEM_PROMPT = `Tu es un assistant IA spécialisé dans la rédaction de posts engageants pour un réseau social d'entreprise. Ton objectif est d'aider les collaborateurs à rédiger des publications claires, impactantes et dynamiques en fonction de quelques mots-clés fournis, n'hésite pas à visiter le site www.eco-solidaire.fr pour récupérer plus d'informations. Tu as le droit à un nombre de caractères maximum de 360.
Ton & Style :
Léger et accessible, avec une pointe d'humour bien dosée.
Sérieux dans le fond, fun dans la forme.
Inspirant et humain : on parle d'économie solidaire, d'impact social et d'innovation locale !
Public :
Principalement les collaborateurs (communication interne).
Possibilité d'être partagé en externe sur notre site, donc un ton accessible au grand public.
Structure suggérée :
Accroche : Une phrase punchy ou une question qui capte l'attention.
Message clé : Expliquer l'info de manière concise et engageante.
Call-to-action (optionnel) : Encourager l'interaction (commentaire, partage, participation…).
Exemples de styles attendus :
"Besoin d'un coup de main pour ta pelouse ? Pas de panique, notre équipe de Pays de Bray Emploi a la main verte ! 🌿💪 #SolidaritéEnAction #JardinageSansStress"
"Aujourd'hui, on a sauvé 12 fauteuils roulants de l'oubli ! 🦸‍♂️♻️ Direction la recyclerie pour une seconde vie. #ÉconomieCirculaire #SantéPourTous"
"Chez Les Sens du Bray, on construit du solide... et du sens. 🌱🏗️ Envie de voir nos dernières réalisations ? Spoiler : c'est du bois, du local et du beau ! #ArchitectureDurable #MadeInBray"
Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, au format exact :
{
  "title": "titre court et accrocheur de l'événement (max ~60 caractères, sans hashtag)",
  "description": "le post complet prêt à publier, max 360 caractères, dans le ton décrit ci-dessus (accroche + message + call-to-action + hashtags)",
  "location": "le lieu si mentionné ou déductible du contexte, sinon une chaîne vide"
}`;

type GeneratedEventPost = { title: string; description: string; location: string };

/** Génère un post d'événement complet (titre, description, lieu) depuis un contexte libre. */
export const generateEventPost = action({
  args: { context: v.string() },
  handler: async (ctx, { context }): Promise<GeneratedEventPost> => {
    await ctx.runQuery(internal.community.assertCanCreateEvent, {});
    const brief = context.trim();
    if (!brief) throw new Error("Quelques éléments de contexte sont nécessaires.");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("Clé OpenAI absente du déploiement Convex partagé.");
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.8,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EVENT_POST_SYSTEM_PROMPT },
          { role: "user", content: `Contexte de l'événement : ${brief}` },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Erreur OpenAI (${response.status}): ${(await response.text()).slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    let parsed: { title?: string; description?: string; location?: string } = {};
    try {
      parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    } catch {
      parsed = {};
    }
    const description = (parsed.description ?? "").trim();
    return {
      title: (parsed.title ?? "").trim().slice(0, 120),
      description:
        description.length > 360 ? `${description.slice(0, 359).trimEnd()}…` : description,
      location: (parsed.location ?? "").trim().slice(0, 120),
    };
  },
});

/* ─── Bons plans ─────────────────────────────────────────────────────────── */

export const listDeals = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const deals = await ctx.db.query("dealPosts").withIndex("by_createdAt").order("desc").take(100);
    const photos = await livePhotosByClerkId(ctx, deals.map((d) => d.authorClerkId));
    return await Promise.all(
      deals.map(async (deal) => ({
        ...deal,
        authorImageUrl: livePhoto(photos, deal.authorClerkId, deal.authorImageUrl),
        adKind: deal.adKind ?? "offre",
        imageUrls: await resolveImages(ctx, deal.images),
        canManage: deal.authorClerkId === identity.subject,
        isMine: deal.authorClerkId === identity.subject,
      })),
    );
  },
});

export const createDeal = mutation({
  args: {
    title: v.string(),
    description: v.string(),
    adKind: dealAdKind,
    dealType,
    price: v.optional(v.number()),
    rentalPeriod: v.optional(rentalPeriod),
    availableFrom: v.optional(v.number()),
    availableTo: v.optional(v.number()),
    images: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    if (!args.title.trim()) throw new Error("Titre requis.");
    return await ctx.db.insert("dealPosts", {
      authorClerkId: identity.subject,
      authorName: displayName(identity),
      authorImageUrl: pictureUrl(identity),
      title: args.title.trim(),
      description: args.description.trim(),
      adKind: args.adKind,
      dealType: args.dealType,
      price: args.price,
      rentalPeriod: args.dealType === "location" ? args.rentalPeriod : undefined,
      availableFrom: args.availableFrom,
      availableTo: args.availableTo,
      images: args.images ?? [],
      status: "open",
      createdAt: Date.now(),
    });
  },
});

export const setDealStatus = mutation({
  args: {
    dealId: v.id("dealPosts"),
    status: v.union(v.literal("open"), v.literal("closed")),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const deal = await ctx.db.get(args.dealId);
    if (!deal) return;
    if (deal.authorClerkId !== identity.subject && !(await canManage(ctx))) {
      throw new Error("Action non autorisée.");
    }
    await ctx.db.patch(args.dealId, { status: args.status });
  },
});

export const removeDeal = mutation({
  args: { dealId: v.id("dealPosts") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const deal = await ctx.db.get(args.dealId);
    if (!deal) return;
    if (deal.authorClerkId !== identity.subject && !(await canManage(ctx))) {
      throw new Error("Suppression non autorisée.");
    }
    await ctx.db.delete(args.dealId);
  },
});

/**
 * Une personne se déclare intéressée par un bon plan : notifie l'auteur dans
 * l'app et lui envoie un email « (nom) est intéressé·e par votre annonce ».
 */
export const expressDealInterest = mutation({
  args: { dealId: v.id("dealPosts") },
  handler: async (ctx, args) => {
    const identity = await requireStaff(ctx);
    const deal = await ctx.db.get(args.dealId);
    if (!deal) throw new Error("Bon plan introuvable.");
    await notifyDealInterest(ctx, deal, identity);
  },
});

/* ─── Messagerie interne ─────────────────────────────────────────────────── */

export const listConversations = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireStaff(ctx);
    const me = identity.subject;

    const [received, sent] = await Promise.all([
      ctx.db.query("directMessages").withIndex("by_to", (q) => q.eq("toClerkId", me)).collect(),
      ctx.db.query("directMessages").withIndex("by_from", (q) => q.eq("fromClerkId", me)).collect(),
    ]);

    const byCounterpart = new Map<
      string,
      { clerkId: string; name: string; imageUrl?: string; lastBody: string; lastAt: number; unread: number }
    >();

    for (const message of [...received, ...sent]) {
      const isIncoming = message.toClerkId === me;
      const counterpartId = isIncoming ? message.fromClerkId : message.toClerkId;
      const counterpartName = isIncoming ? message.fromName : message.toName;
      const counterpartImage = isIncoming ? message.fromImageUrl : undefined;
      const existing = byCounterpart.get(counterpartId);
      const unreadInc = isIncoming && !message.readAt ? 1 : 0;
      if (!existing || message.createdAt > existing.lastAt) {
        byCounterpart.set(counterpartId, {
          clerkId: counterpartId,
          name: counterpartName,
          imageUrl: counterpartImage ?? existing?.imageUrl,
          lastBody: message.body,
          lastAt: message.createdAt,
          unread: (existing?.unread ?? 0) + unreadInc,
        });
      } else {
        existing.unread += unreadInc;
        if (counterpartImage && !existing.imageUrl) existing.imageUrl = counterpartImage;
      }
    }

    // Avatar du correspondant résolu à la lecture : il doit refléter sa photo
    // actuelle, pas celle figée sur le dernier message reçu.
    const conversations = Array.from(byCounterpart.values());
    const photos = await livePhotosByClerkId(ctx, conversations.map((c) => c.clerkId));
    return conversations
      .map((c) => ({ ...c, imageUrl: livePhoto(photos, c.clerkId, c.imageUrl) }))
      .sort((a, b) => b.lastAt - a.lastAt);
  },
});

export const listThread = query({
  args: { otherClerkId: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireStaff(ctx);
    const key = pairKey(identity.subject, args.otherClerkId);
    const messages = await ctx.db
      .query("directMessages")
      .withIndex("by_pair", (q) => q.eq("pairKey", key))
      .collect();
    const photos = await livePhotosByClerkId(ctx, messages.map((m) => m.fromClerkId));
    return messages
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((message) => ({
        ...message,
        fromImageUrl: livePhoto(photos, message.fromClerkId, message.fromImageUrl),
        mine: message.fromClerkId === identity.subject,
      }));
  },
});

export const sendMessage = mutation({
  args: {
    toClerkId: v.string(),
    toName: v.string(),
    body: v.string(),
    // Image jointe (première photo d'un bon plan) attachée au premier message.
    attachmentImageUrl: v.optional(v.string()),
    attachmentTitle: v.optional(v.string()),
    dealId: v.optional(v.id("dealPosts")),
  },
  handler: async (ctx, args) => {
    const identity = await requireStaff(ctx);
    const body = args.body.trim();
    if (!body) throw new Error("Message vide.");
    if (args.toClerkId === identity.subject) throw new Error("Destinataire invalide.");
    const messageId = await ctx.db.insert("directMessages", {
      pairKey: pairKey(identity.subject, args.toClerkId),
      fromClerkId: identity.subject,
      fromName: displayName(identity),
      fromImageUrl: pictureUrl(identity),
      toClerkId: args.toClerkId,
      toName: args.toName.trim() || "Utilisateur",
      body,
      attachmentImageUrl: args.attachmentImageUrl?.trim() || undefined,
      attachmentTitle: args.attachmentTitle?.trim() || undefined,
      createdAt: Date.now(),
    });
    await createMesoutilsNotification(ctx, {
      recipientClerkId: args.toClerkId,
      kind: "new_direct_message",
      title: `Nouveau message de ${displayName(identity)}`,
      body,
      actorName: displayName(identity),
      actorClerkId: identity.subject,
    actorImageUrl: pictureUrl(identity),
      href: `/messagerie?to=${encodeURIComponent(identity.subject)}&name=${encodeURIComponent(displayName(identity))}`,
    });
    if (args.dealId) {
      const deal = await ctx.db.get(args.dealId);
      if (deal?.authorClerkId === args.toClerkId) {
        await notifyDealInterest(ctx, deal, identity);
      }
    }
    return messageId;
  },
});

export const unreadDirectCount = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireStaff(ctx);
    const messages = await ctx.db
      .query("directMessages")
      .withIndex("by_to", (q) => q.eq("toClerkId", identity.subject))
      .collect();
    return messages.filter((message) => !message.readAt).length;
  },
});

export const markThreadRead = mutation({
  args: { otherClerkId: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireStaff(ctx);
    const key = pairKey(identity.subject, args.otherClerkId);
    const messages = await ctx.db
      .query("directMessages")
      .withIndex("by_pair", (q) => q.eq("pairKey", key))
      .collect();
    const now = Date.now();
    await Promise.all(
      messages
        .filter((message) => message.toClerkId === identity.subject && !message.readAt)
        .map((message) => ctx.db.patch(message._id, { readAt: now })),
    );
  },
});

/**
 * Recherche des membres de l'équipe (par nom ou email) pour démarrer une
 * nouvelle conversation sans passer par une interaction de l'app. On ne renvoie
 * que les personnes staff/admin déjà connectées (joignables via leur clerkId),
 * hors soi-même.
 */
export const searchStaff = query({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const identity = await requireStaff(ctx);
    const needle = query.trim().toLowerCase();

    const perms = await ctx.db.query("crmPermissions").collect();
    const results: Array<{ clerkId: string; name: string; email: string }> = [];
    const seen = new Set<string>();

    for (const perm of perms) {
      if (!perm.active) continue;
      if (perm.role === "client") continue;
      const email = perm.email.trim().toLowerCase();
      if (!email) continue;
      const user = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (!user) continue; // jamais connecté → pas de clerkId, injoignable
      if (user.clerkId === identity.subject) continue;
      if (seen.has(user.clerkId)) continue;
      const name =
        perm.name?.trim() ||
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
        email;
      if (needle && !name.toLowerCase().includes(needle) && !email.includes(needle)) {
        continue;
      }
      seen.add(user.clerkId);
      results.push({ clerkId: user.clerkId, name, email });
    }

    return results.sort((a, b) => a.name.localeCompare(b.name, "fr")).slice(0, 25);
  },
});

/* ─── Annuaire staff (pour réserver au nom d'un collègue) ────────────────── */

/**
 * Membres internes (admins / staff) sélectionnables dans « Réserver pour ». On
 * exclut les clients et on ne renvoie que les personnes déjà connectées (donc
 * dotées d'un clerkId + email) pour que les emails de réservation, confirmation
 * et annulation puissent réellement leur parvenir.
 */
export const listStaffDirectory = query({
  args: {},
  handler: async (ctx): Promise<Array<{ clerkId: string; name: string; imageUrl: string | null }>> => {
    const identity = await requireStaff(ctx);

    const perms = await ctx.db.query("crmPermissions").collect();
    const results: Array<{ clerkId: string; name: string; imageUrl: string | null }> = [];
    const seen = new Set<string>();

    for (const perm of perms) {
      if (!perm.active) continue;
      if (perm.role === "client") continue; // membres internes uniquement
      const email = perm.email.trim().toLowerCase();
      if (!email) continue;
      const user = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (!user) continue; // jamais connecté → pas de clerkId, injoignable
      if (user.clerkId === identity.subject) continue;
      if (seen.has(user.clerkId)) continue;
      seen.add(user.clerkId);
      const name =
        perm.name?.trim() ||
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
        email;
      results.push({ clerkId: user.clerkId, name, imageUrl: user.imageUrl ?? null });
    }

    return results.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  },
});

async function canManage(ctx: QueryCtx | MutationCtx) {
  return await hasCrmPermission(ctx, PAGE_KEY, "manage");
}

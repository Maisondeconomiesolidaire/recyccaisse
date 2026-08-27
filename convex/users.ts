import { v } from "convex/values";
import { action, env, internalAction, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { fetchAllClerkUsers, normalizeCustomer, normalizeEmail, requireCrmPermission, requireUser, titleCaseName } from "./lib";
import { STEP } from "./processes";
import type { DataModel, Doc, Id } from "./_generated/dataModel";

/**
 * Statut client dérivé de l'avancement réel de la demande (et non du champ
 * `stage` figé). Reste synchronisé avec le CRM : à chaque étape cochée /
 * outcome modifié côté staff, le client voit le statut bouger.
 *
 * Flux : Demande reçue → Validation → Planifiée → Terminée (ou Annulée).
 */
export const CLIENT_STATUS_FLOW = [
  { key: "nouveau", label: "Demande reçue" },
  { key: "validation", label: "Validation" },
  { key: "planifie", label: "Planifiée" },
  { key: "termine", label: "Terminée" },
] as const;

export function deriveClientStatus(request: Doc<"requests">) {
  if (request.outcome === "perdue") {
    return { key: "annulee", label: "Annulée", index: -1, cancelled: true };
  }
  if (request.outcome === "gagnee") {
    return { key: "termine", label: "Terminée", index: 3, cancelled: false };
  }
  const done = (request.processSteps ?? []).slice(0, request.completedSteps ?? 0);
  if (done.includes(STEP.prestaPlanifiee)) {
    return { key: "planifie", label: "Planifiée", index: 2, cancelled: false };
  }
  if (done.includes(STEP.devisEdite) || done.includes(STEP.devisSigne)) {
    return { key: "validation", label: "Validation", index: 1, cancelled: false };
  }
  return { key: "nouveau", label: "Demande reçue", index: 0, cancelled: false };
}

async function getProfileByClerkId(ctx: QueryCtx | MutationCtx, clerkId: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
    .unique();
}

async function getProfileByEmail(ctx: QueryCtx | MutationCtx, email: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", normalized))
    .first();
}

function directPairKey(a: string, b: string) {
  return [a, b].sort().join("__");
}

async function updateClerkNameCase(
  secret: string,
  clerkId: string,
  firstName?: string,
  lastName?: string,
) {
  if (!firstName && !lastName) return false;
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...(firstName ? { first_name: firstName } : {}), ...(lastName ? { last_name: lastName } : {}) }),
  });
  if (!response.ok) throw new Error(`Clerk a répondu ${response.status} lors de la normalisation du nom.`);
  return true;
}

export const normalizeClerkUserName = internalAction({
  args: { clerkId: v.string(), firstName: v.optional(v.string()), lastName: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    const secret = env.CLERK_SECRET_KEY;
    if (!secret) throw new Error("Annuaire Clerk indisponible.");
    return await updateClerkNameCase(secret, args.clerkId, args.firstName, args.lastName);
  },
});

export const assertCanNormalizeNames = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "mesoutils:admin", "manage");
    return true;
  },
});

export const normalizeAllClerkUserNames = action({
  args: {},
  handler: async (ctx) => {
    await ctx.runQuery(api.users.assertCanNormalizeNames, {});
    const secret = env.CLERK_SECRET_KEY;
    if (!secret) throw new Error("Annuaire Clerk indisponible.");
    let updated = 0;
    for (const user of await fetchAllClerkUsers(secret)) {
      const clerkId = user.id ?? "";
      const firstName = user.first_name ? titleCaseName(user.first_name) : undefined;
      const lastName = user.last_name ? titleCaseName(user.last_name) : undefined;
      if (!clerkId || (firstName === user.first_name && lastName === user.last_name)) continue;
      await updateClerkNameCase(secret, clerkId, firstName, lastName);
      updated += 1;
    }
    return { updated };
  },
});

function replaceClerkIdInHref(href: string | undefined, oldClerkId: string, newClerkId: string) {
  if (!href) return href;
  return href
    .replaceAll(oldClerkId, newClerkId)
    .replaceAll(encodeURIComponent(oldClerkId), encodeURIComponent(newClerkId));
}

async function remapClerkIdEverywhere(
  ctx: MutationCtx,
  oldClerkId: string,
  newClerkId: string,
  now: number,
) {
  if (!oldClerkId || oldClerkId === newClerkId) return;

  const requests = await ctx.db
    .query("requests")
    .withIndex("by_userId", (q) => q.eq("userId", oldClerkId))
    .collect();
  for (const request of requests) {
    await ctx.db.patch(request._id, { userId: newClerkId, updatedAt: now });
  }

  const wishlists = await ctx.db
    .query("wishlists")
    .withIndex("by_user", (q) => q.eq("userId", oldClerkId))
    .collect();
  for (const wishlist of wishlists) {
    await ctx.db.patch(wishlist._id, { userId: newClerkId });
  }

  const customerMessages = await ctx.db
    .query("messages")
    .withIndex("by_senderClerkId", (q) => q.eq("senderClerkId", oldClerkId))
    .collect();
  for (const message of customerMessages) {
    await ctx.db.patch(message._id, { senderClerkId: newClerkId });
  }

  const posts = await ctx.db
    .query("posts")
    .withIndex("by_authorClerkId", (q) => q.eq("authorClerkId", oldClerkId))
    .collect();
  for (const post of posts) {
    await ctx.db.patch(post._id, { authorClerkId: newClerkId });
  }

  const postComments = await ctx.db
    .query("postComments")
    .withIndex("by_authorClerkId", (q) => q.eq("authorClerkId", oldClerkId))
    .collect();
  for (const comment of postComments) {
    await ctx.db.patch(comment._id, { authorClerkId: newClerkId });
  }

  const postLikes = await ctx.db
    .query("postLikes")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", oldClerkId))
    .collect();
  for (const like of postLikes) {
    await ctx.db.patch(like._id, { clerkId: newClerkId });
  }

  const notifications = await ctx.db
    .query("mesoutilsNotifications")
    .withIndex("by_recipient_createdAt", (q) => q.eq("recipientClerkId", oldClerkId))
    .collect();
  for (const notification of notifications) {
    await ctx.db.patch(notification._id, {
      recipientClerkId: newClerkId,
      href: replaceClerkIdInHref(notification.href, oldClerkId, newClerkId),
    });
  }

  const roomReservations = await ctx.db
    .query("roomReservations")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", oldClerkId))
    .collect();
  for (const reservation of roomReservations) {
    await ctx.db.patch(reservation._id, { clerkId: newClerkId });
  }
  const roomReservationsFor = await ctx.db
    .query("roomReservations")
    .withIndex("by_bookedForClerkId", (q) => q.eq("bookedForClerkId", oldClerkId))
    .collect();
  for (const reservation of roomReservationsFor) {
    await ctx.db.patch(reservation._id, { bookedForClerkId: newClerkId });
  }

  const vehicleReservations = await ctx.db
    .query("vehicleReservations")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", oldClerkId))
    .collect();
  for (const reservation of vehicleReservations) {
    await ctx.db.patch(reservation._id, { clerkId: newClerkId });
  }
  const vehicleReservationsFor = await ctx.db
    .query("vehicleReservations")
    .withIndex("by_bookedForClerkId", (q) => q.eq("bookedForClerkId", oldClerkId))
    .collect();
  for (const reservation of vehicleReservationsFor) {
    await ctx.db.patch(reservation._id, { bookedForClerkId: newClerkId });
  }

  const leaveRequests = await ctx.db
    .query("leaveRequests")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", oldClerkId))
    .collect();
  for (const leave of leaveRequests) {
    await ctx.db.patch(leave._id, { clerkId: newClerkId });
  }

  const events = await ctx.db
    .query("events")
    .withIndex("by_authorClerkId", (q) => q.eq("authorClerkId", oldClerkId))
    .collect();
  for (const event of events) {
    await ctx.db.patch(event._id, { authorClerkId: newClerkId });
  }

  const deals = await ctx.db
    .query("dealPosts")
    .withIndex("by_authorClerkId", (q) => q.eq("authorClerkId", oldClerkId))
    .collect();
  for (const deal of deals) {
    await ctx.db.patch(deal._id, { authorClerkId: newClerkId });
  }

  const sentDirectMessages = await ctx.db
    .query("directMessages")
    .withIndex("by_from", (q) => q.eq("fromClerkId", oldClerkId))
    .collect();
  for (const message of sentDirectMessages) {
    await ctx.db.patch(message._id, {
      fromClerkId: newClerkId,
      pairKey: directPairKey(newClerkId, message.toClerkId),
    });
  }
  const receivedDirectMessages = await ctx.db
    .query("directMessages")
    .withIndex("by_to", (q) => q.eq("toClerkId", oldClerkId))
    .collect();
  for (const message of receivedDirectMessages) {
    await ctx.db.patch(message._id, {
      toClerkId: newClerkId,
      pairKey: directPairKey(message.fromClerkId, newClerkId),
    });
  }

  const klydeOrders = await ctx.db
    .query("klydeOrders")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", oldClerkId))
    .collect();
  for (const order of klydeOrders) {
    await ctx.db.patch(order._id, { clerkId: newClerkId });
  }

  const klydeWishlists = await ctx.db
    .query("klydeWishlists")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", oldClerkId))
    .collect();
  for (const wishlist of klydeWishlists) {
    await ctx.db.patch(wishlist._id, { clerkId: newClerkId });
  }

  const feedback = await ctx.db.query("feedback").withIndex("by_author_and_createdAt", (q) => q.eq("authorClerkId", oldClerkId)).collect();
  for (const item of feedback) await ctx.db.patch(item._id, { authorClerkId: newClerkId });
  const feedbackComments = (await ctx.db.query("feedbackComments").take(1000)).filter((item) => item.authorClerkId === oldClerkId);
  for (const item of feedbackComments) await ctx.db.patch(item._id, { authorClerkId: newClerkId });
}

/**
 * Appelée à la connexion : crée le profil s'il n'existe pas et rattache
 * automatiquement les demandes passées dont l'email correspond.
 */
/**
 * Corrige l'application d'origine d'un compte (`signupApp`).
 *
 * Outil de maintenance : un compte créé depuis un lien Mes Outils alors que
 * l'utilisateur est en réalité un client Recyclerie / Bennes & Pro fausse le
 * décompte « clients par application » du tableau de bord admin. Interne, donc
 * appelable uniquement en CLI (`npx convex run`) ou depuis une autre fonction —
 * jamais depuis le navigateur.
 */
export const setSignupApp = internalMutation({
  args: {
    email: v.string(),
    app: v.union(
      v.literal("mesoutils"),
      v.literal("recycapp"),
      v.literal("klyde"),
      v.literal("cycleenbray"),
      v.literal("bennespro"),
      v.literal("pointeuse"),
      v.literal("feedback"),
    ),
    /** Chemin d'inscription à réécrire ; laissé tel quel si absent. */
    path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const users = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    if (users.length === 0) return { email, updated: 0, previous: [] as string[] };

    const previous: string[] = [];
    for (const user of users) {
      previous.push(user.signupApp ?? "—");
      await ctx.db.patch(user._id, {
        signupApp: args.app,
        ...(args.path === undefined ? {} : { signupPath: args.path }),
        updatedAt: Date.now(),
      });
    }
    return { email, updated: users.length, previous, app: args.app };
  },
});

export const syncProfile = mutation({
  args: {
    // Origine de l'inscription (app + chemin/formulaire), enregistrée une seule
    // fois, à la création du profil.
    source: v.optional(v.object({ app: v.string(), path: v.string() })),
  },
  handler: async (ctx, { source }) => {
    const identity = await requireUser(ctx);
    const clerkId = identity.subject;
    const email = normalizeEmail(identity.email);

    let profile = await getProfileByClerkId(ctx, clerkId);
    const now = Date.now();
    const imageUrl = (identity as { pictureUrl?: string | null }).pictureUrl ?? undefined;

    if (!profile) {
      const profileByEmail = email ? await getProfileByEmail(ctx, email) : null;
      if (profileByEmail) {
        const previousClerkIds = Array.from(
          new Set([...(profileByEmail.previousClerkIds ?? []), profileByEmail.clerkId]),
        ).filter((id) => id && id !== clerkId);
        await remapClerkIdEverywhere(ctx, profileByEmail.clerkId, clerkId, now);
        await ctx.db.patch(profileByEmail._id, {
          clerkId,
          previousClerkIds,
          lastClerkMigrationAt: now,
          firstName: identity.givenName
            ? titleCaseName(identity.givenName)
            : profileByEmail.firstName,
          lastName: identity.familyName
            ? titleCaseName(identity.familyName)
            : profileByEmail.lastName,
          imageUrl: imageUrl ?? profileByEmail.imageUrl,
          signupApp: profileByEmail.signupApp ?? source?.app,
          signupPath: profileByEmail.signupPath ?? source?.path,
          updatedAt: now,
        });
        profile = await ctx.db.get(profileByEmail._id);
      } else {
        const profileId = await ctx.db.insert("users", {
          clerkId,
          email,
          firstName: identity.givenName ? titleCaseName(identity.givenName) : undefined,
          lastName: identity.familyName ? titleCaseName(identity.familyName) : undefined,
          imageUrl,
          signupApp: source?.app,
          signupPath: source?.path,
          createdAt: now,
          updatedAt: now,
        });
        profile = await ctx.db.get(profileId);
      }
    } else if (source && (!profile.signupApp || !profile.signupPath)) {
      // Complète la source si elle manquait (profils créés avant le suivi).
      await ctx.db.patch(profile._id, {
        signupApp: profile.signupApp ?? source.app,
        signupPath: profile.signupPath ?? source.path,
        updatedAt: now,
      });
      profile = await ctx.db.get(profile._id);
    }

    if (profile) {
      const patch: { email?: string; imageUrl?: string; firstName?: string; lastName?: string; updatedAt?: number } = {};
      if (email && profile.email !== email) patch.email = email;
      if (imageUrl && profile.imageUrl !== imageUrl) patch.imageUrl = imageUrl;
      const firstName = identity.givenName ? titleCaseName(identity.givenName) : undefined;
      const lastName = identity.familyName ? titleCaseName(identity.familyName) : undefined;
      if (firstName && profile.firstName !== firstName) patch.firstName = firstName;
      if (lastName && profile.lastName !== lastName) patch.lastName = lastName;
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = now;
        await ctx.db.patch(profile._id, patch);
      }
      if (firstName !== identity.givenName || lastName !== identity.familyName) {
        await ctx.scheduler.runAfter(0, internal.users.normalizeClerkUserName, { clerkId, firstName, lastName });
      }
    }

    // Rattacher les demandes existantes créées sans compte (demandes internes
    // saisies par l'équipe incluses) dont l'email correspond, à l'inscription.
    if (email) {
      const candidates = await ctx.db.query("requests").collect();
      await Promise.all(
        candidates
          .filter((r) => !r.userId && normalizeEmail(r.customer.email) === email)
          .map((r) => ctx.db.patch(r._id, { userId: clerkId })),
      );
    }

    return profile;
  },
});

/** Rattrapage administrateur des noms historiques conservés dans les écrans. */
export const normalizeExistingUserNames = mutation({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "mesoutils:admin", "manage");
    const normalize = (value: string | undefined) => value ? titleCaseName(value) : undefined;
    let updated = 0;
    const patchName = async <TableName extends keyof DataModel>(
      doc: { _id: Id<TableName> },
      fields: Partial<Doc<TableName>>,
    ) => {
      const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
      if (Object.keys(patch).length > 0) { await ctx.db.patch(doc._id, patch as Partial<Doc<TableName>>); updated += 1; }
    };
    for (const user of await ctx.db.query("users").take(1000)) {
      await patchName(user, {
        firstName: user.firstName && normalize(user.firstName) !== user.firstName ? normalize(user.firstName) : undefined,
        lastName: user.lastName && normalize(user.lastName) !== user.lastName ? normalize(user.lastName) : undefined,
      });
    }
    for (const row of await ctx.db.query("userPoints").take(1000)) {
      await patchName(row, { displayName: normalize(row.displayName) !== row.displayName ? normalize(row.displayName) : undefined });
    }
    for (const row of await ctx.db.query("feedback").take(1000)) {
      await patchName(row, { authorName: row.authorName && normalize(row.authorName) !== row.authorName ? normalize(row.authorName) : undefined });
    }
    for (const row of await ctx.db.query("posts").take(1000)) {
      await patchName(row, { authorName: normalize(row.authorName) !== row.authorName ? normalize(row.authorName) : undefined });
    }
    for (const row of await ctx.db.query("postComments").take(1000)) {
      await patchName(row, { authorName: normalize(row.authorName) !== row.authorName ? normalize(row.authorName) : undefined });
    }
    for (const table of ["roomReservations", "vehicleReservations", "equipmentReservations"] as const) {
      for (const row of await ctx.db.query(table).take(1000)) {
        await patchName(row, {
          userName: normalize(row.userName) !== row.userName ? normalize(row.userName) : undefined,
          bookedByName: row.bookedByName && normalize(row.bookedByName) !== row.bookedByName ? normalize(row.bookedByName) : undefined,
        });
      }
    }
    return { updated };
  },
});

export const getMyProfile = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const profile = await getProfileByClerkId(ctx, identity.subject);
    if (!profile) return null;
    return {
      ...profile,
      firstName: profile.firstName ? titleCaseName(profile.firstName) : profile.firstName,
      lastName: profile.lastName ? titleCaseName(profile.lastName) : profile.lastName,
    };
  },
});

export const updateMyProfile = mutation({
  args: {
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireUser(ctx);
    const patch = {
      ...args,
      ...(args.firstName !== undefined ? { firstName: titleCaseName(args.firstName) } : {}),
      ...(args.lastName !== undefined ? { lastName: titleCaseName(args.lastName) } : {}),
      updatedAt: Date.now(),
    };
    const profile = await getProfileByClerkId(ctx, identity.subject);
    if (profile) {
      await ctx.db.patch(profile._id, patch);
      return;
    }
    // Le profil n'existe pas encore (syncProfile pas encore passé) : on le crée
    // pour ne jamais perdre les coordonnées saisies par le client.
    await ctx.db.insert("users", {
      clerkId: identity.subject,
      email: (identity.email ?? "").toLowerCase(),
      createdAt: Date.now(),
      ...patch,
    });
  },
});

const PROGRESS_LABELS: Record<string, string> = {
  nouveau: "Demande reçue",
  validation: "En cours de validation",
  planifie: "Planifiée",
};

export const listMyRequests = query({
  args: {
    type: v.optional(
      v.union(
        v.literal("aerogommage"),
        v.literal("collecte"),
        v.literal("article"),
        v.literal("velo"),
      ),
    ),
  },
  handler: async (ctx, { type }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const requests = await ctx.db
      .query("requests")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .collect();

    const filtered = type ? requests.filter((r) => r.type === type) : requests;

    return await Promise.all(
      filtered.map(async (r) => {
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_requestId", (q) => q.eq("requestId", r._id))
          .collect();
        const unread = messages.filter(
          (m) => m.senderRole === "staff" && !m.readByClientAt,
        ).length;

        // Vignette : photo de couverture de l'article pour les demandes boutique.
        let imageUrl: string | null = null;
        if (r.type === "article") {
          const articleId = r.article?.articleId ?? r.articles?.[0]?.articleId;
          if (articleId) {
            const article = await ctx.db.get(articleId);
            const cover = article?.images?.[0];
            if (cover) imageUrl = await ctx.storage.getUrl(cover);
          }
        }

        return {
          _id: r._id,
          type: r.type,
          imageUrl,
          reference: r.reference ?? null,
          stage: r.stage,
          outcome: r.outcome,
          status: deriveClientStatus(r),
          stageLabel: PROGRESS_LABELS[r.stage] ?? r.stage,
          complete: r.complete,
          processSteps: r.processSteps,
          completedSteps: r.completedSteps,
          scheduledDate: r.scheduledDate ?? null,
          quoteAmount: r.quoteAmount ?? null,
          collecteType: r.collecteType ?? null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          unreadMessages: unread,
          messageCount: messages.length,
        };
      }),
    );
  },
});

async function findTrackingTokenForRequest(
  ctx: QueryCtx,
  requestId: Id<"requests">,
) {
  const link = await ctx.db
    .query("tourneeTrackingLinks")
    .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
    .first();
  if (!link) return null;
  const tournee = await ctx.db.get(link.tourneeId);
  return {
    shareToken: link.shareToken,
    tourneeStatus: tournee?.status ?? null,
    tourneeDate: tournee?.date ?? null,
  };
}

export const getMyRequest = query({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const request = await ctx.db.get(requestId);
    if (!request || request.userId !== identity.subject) return null;

    const tracking =
      request.type === "collecte" ? await findTrackingTokenForRequest(ctx, requestId) : null;

    // Articles réservés (boutique) avec leur photo de couverture, pour le récap.
    let articles: Array<{ title: string; imageUrl: string | null }> = [];
    if (request.type === "article") {
      const list = request.articles ?? (request.article ? [request.article] : []);
      articles = await Promise.all(
        list.map(async (a) => {
          const art = await ctx.db.get(a.articleId);
          const cover = art?.images?.[0];
          return {
            title: a.articleTitle,
            imageUrl: cover ? await ctx.storage.getUrl(cover) : null,
          };
        }),
      );
    }

    const aerogommage = await Promise.all(
      (request.aerogommage ?? []).map(async (item) => ({
        objectType: item.objectType ?? null,
        label: item.label ?? null,
        quantity: item.quantity ?? null,
        photoUrls: (
          await Promise.all((item.photos ?? []).map((photo) => ctx.storage.getUrl(photo)))
        ).filter((url): url is string => url !== null),
      })),
    );

    const collecteCategoryPhotos = await Promise.all(
      (request.collecte?.categoryPhotos ?? []).map(async (entry) => ({
        category: entry.category,
        urls: (
          await Promise.all(entry.photos.map((photo) => ctx.storage.getUrl(photo)))
        ).filter((url): url is string => url !== null),
      })),
    );

    return {
      articles,
      aerogommage,
      collecte: request.collecte
        ? {
            objectCategories: request.collecte.objectCategories ?? [],
            categoryPhotos: collecteCategoryPhotos,
          }
        : null,
      _id: request._id,
      type: request.type,
      reference: request.reference ?? null,
      stage: request.stage,
      stageLabel: PROGRESS_LABELS[request.stage] ?? request.stage,
      outcome: request.outcome,
      status: deriveClientStatus(request),
      complete: request.complete,
      processSteps: request.processSteps,
      completedSteps: request.completedSteps,
      scheduledDate: request.scheduledDate ?? null,
      quoteAmount: request.quoteAmount ?? null,
      quoteDetails: request.quoteDetails ?? null,
      collecteType: request.collecteType ?? null,
      // Le dépôt sert au client à retrouver son créneau et à l'annuler.
      depot: request.depot
        ? {
            site: request.depot.site,
            slotStart: request.depot.slotStart,
            slotEnd: request.depot.slotEnd,
            vehicleType: request.depot.vehicleType,
          }
        : null,
      comment: request.comment ?? null,
      customer: normalizeCustomer(request.customer),
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      tracking,
    };
  },
});

async function requireOwnedRequest(
  ctx: MutationCtx,
  requestId: Id<"requests">,
) {
  const identity = await requireUser(ctx);
  const request = await ctx.db.get(requestId);
  if (!request || request.userId !== identity.subject) {
    throw new Error("Demande introuvable.");
  }
  return request;
}

export const addMyAerogommageItemPhotos = mutation({
  args: {
    requestId: v.id("requests"),
    itemIndex: v.number(),
    storageIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, { requestId, itemIndex, storageIds }) => {
    const request = await requireOwnedRequest(ctx, requestId);
    if (request.type !== "aerogommage") {
      throw new Error("Cette demande n'est pas une demande d'aérogommage.");
    }
    const items = [...(request.aerogommage ?? [])];
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= items.length) {
      throw new Error("Objet introuvable.");
    }
    const item = items[itemIndex];
    items[itemIndex] = {
      ...item,
      photos: [...(item.photos ?? []), ...storageIds],
    };
    await ctx.db.patch(requestId, { aerogommage: items, updatedAt: Date.now() });
  },
});

export const addMyCollecteCategoryPhotos = mutation({
  args: {
    requestId: v.id("requests"),
    category: v.string(),
    storageIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, { requestId, category, storageIds }) => {
    const request = await requireOwnedRequest(ctx, requestId);
    if (request.type !== "collecte") {
      throw new Error("Cette demande n'est pas une demande de collecte.");
    }
    const details = request.collecte ?? {};
    const categoryPhotos = [...(details.categoryPhotos ?? [])];
    const existingIndex = categoryPhotos.findIndex((entry) => entry.category === category);
    if (existingIndex >= 0) {
      const existing = categoryPhotos[existingIndex];
      categoryPhotos[existingIndex] = {
        ...existing,
        photos: [...existing.photos, ...storageIds],
      };
    } else {
      categoryPhotos.push({ category, photos: storageIds });
    }
    await ctx.db.patch(requestId, {
      collecte: { ...details, categoryPhotos },
      updatedAt: Date.now(),
    });
  },
});

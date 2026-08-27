import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { feedbackApp, feedbackPriority, feedbackStatus, feedbackType } from "./schema";
import {
  hasCrmPermission,
  formatUserName,
  livePhoto,
  livePhotosByClerkId,
  normalizeEmail,
  requireCrmPermission,
  requireUser,
} from "./lib";
import { awardEngagementPoints } from "./points";

/**
 * App « Feedback » (feedback.groupemes.fr) — retours des utilisateurs sur les
 * apps de l'écosystème.
 *
 * Droits gérés comme partout ailleurs, dans `crmPermissions`, avec des
 * `pageKey` namespacés (administrés depuis la page Admin de Mes Outils) :
 *
 * - `feedback:retours` — porte d'entrée : déposer un retour et suivre les
 *   siens. Sans elle, ni l'app ni le bouton d'aide des autres apps n'ont de
 *   raison d'apparaître.
 * - `feedback:kanban` — sous-fonctionnalité : traiter les retours de tout le
 *   monde (statut, réponse, suppression).
 *
 * Les admins passent partout (`hasCrmPermission` le gère), donc aucune liste
 * d'emails en dur à maintenir ici.
 */
const FEEDBACK_PAGE_KEY = "feedback:retours";
const FEEDBACK_KANBAN_PAGE_KEY = "feedback:kanban";

/** Nom affichable de l'auteur d'une action (email « traité par … »). */
function feedbackDisplayName(identity: {
  name?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
}) {
  return formatUserName(identity, "L'équipe produit");
}

/** Peut traiter les retours (kanban) : statut, réponse d'équipe, suppression. */
async function canModerateFeedback(ctx: QueryCtx | MutationCtx) {
  return await hasCrmPermission(ctx, FEEDBACK_KANBAN_PAGE_KEY, "manage");
}

/** Identité + garde-fou kanban. Lève si l'utilisateur n'est pas autorisé. */
async function requireFeedbackAdmin(ctx: QueryCtx | MutationCtx) {
  const identity = await requireUser(ctx);
  if (!(await canModerateFeedback(ctx))) {
    throw new Error("Accès réservé à l'équipe produit.");
  }
  return identity;
}

/**
 * Droits Feedback de l'utilisateur courant.
 *
 * `canOpen` pilote le bouton d'aide des 7 apps et l'accès à l'app ;
 * `canModerate` n'affiche le tableau de bord qu'aux ayants droit. La sécurité
 * réelle reste côté serveur : chaque fonction re-vérifie.
 */
export const myFeedbackAccess = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { canOpen: false, canModerate: false };
    return {
      canOpen: await hasCrmPermission(ctx, FEEDBACK_PAGE_KEY, "read"),
      canModerate: await canModerateFeedback(ctx),
    };
  },
});

/**
 * Nombre de retours encore à traiter, **tous auteurs et toutes apps
 * confondus** : c'est la charge de travail de l'équipe, affichée sur « Mes
 * retours » pour situer l'attente.
 *
 * Ne renvoie qu'un entier — aucun contenu ni auteur — mais reste derrière
 * `feedback:retours` : qui n'a pas l'app n'a pas à connaître sa file.
 */
export const pendingCount = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, FEEDBACK_PAGE_KEY, "read");
    const [waiting, inProgress] = await Promise.all([
      ctx.db
        .query("feedback")
        .withIndex("by_status", (q) => q.eq("status", "nouveau"))
        .collect(),
      ctx.db
        .query("feedback")
        .withIndex("by_status", (q) => q.eq("status", "en_cours"))
        .collect(),
    ]);
    return waiting.length + inProgress.length;
  },
});

/** Dépôt d'un retour — réservé aux comptes ayant `feedback:retours`. */
export const submit = mutation({
  args: {
    /** Absente pour un retour « nouvelle application » : cf. schema.ts. */
    app: v.optional(feedbackApp),
    type: feedbackType,
    description: v.string(),
    attachments: v.optional(v.array(v.id("_storage"))),
    priority: v.optional(feedbackPriority),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FEEDBACK_PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    const description = args.description.trim();
    if (description.length === 0) {
      throw new Error("La description est obligatoire.");
    }
    // Tous les autres types visent une app existante : sans elle, le retour
    // n'est rattachable à rien dans le kanban.
    if (args.type !== "nouvelle_application" && args.app === undefined) {
      throw new Error("L'application concernée est obligatoire.");
    }

    const email = normalizeEmail(identity.email);
    if (email === "") {
      throw new Error("Compte sans adresse email : retour impossible.");
    }

    const now = Date.now();
    const feedbackId = await ctx.db.insert("feedback", {
      app: args.type === "nouvelle_application" ? undefined : args.app,
      type: args.type,
      description,
      attachments: args.attachments?.slice(0, 8),
      status: "nouveau",
      priority: args.priority ?? "normale",
      authorClerkId: identity.subject,
      authorEmail: email,
      authorName: feedbackDisplayName(identity),
      authorImageUrl: identity.pictureUrl ?? undefined,
      createdAt: now,
      updatedAt: now,
    });
    await awardEngagementPoints(ctx, {
      clerkId: identity.subject,
      displayName: feedbackDisplayName(identity),
      eventKey: `feedback:${feedbackId}`,
    });

    await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendFeedbackCreatedEmail, {
      app: args.type === "nouvelle_application" ? undefined : args.app,
      feedbackType: args.type,
      description,
      authorName: feedbackDisplayName(identity),
      authorEmail: email,
      authorPhotoUrl: typeof identity.pictureUrl === "string" ? identity.pictureUrl : undefined,
    });

    return feedbackId;
  },
});

/**
 * Les retours de l'utilisateur connecté (sa page « Mes retours »).
 *
 * On lit par `authorClerkId`, mais on complète avec les retours déposés sous un
 * **ancien** `clerkId` : la table `users` conserve `previousClerkIds` après la
 * migration Clerk dev → prod, et un utilisateur ne doit pas « perdre » ses
 * retours. Repli par email, qui lui ne change pas.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, FEEDBACK_PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const email = normalizeEmail(identity.email);

    const mine = await ctx.db
      .query("feedback")
      .withIndex("by_author_and_createdAt", (q) =>
        q.eq("authorClerkId", identity.subject),
      )
      .order("desc")
      .collect();

    // Retours d'un ancien clerkId : rattrapés par email. Sans email (rare :
    // compte Clerk sans adresse), on s'en tient au clerkId courant — mais on
    // enrichit quand même, sinon la page reçoit des objets sans compteurs.
    const seen = new Set(mine.map((item) => item._id));
    const byEmail =
      email === ""
        ? []
        : (
            await ctx.db
              .query("feedback")
              .withIndex("by_createdAt")
              .order("desc")
              .collect()
          ).filter((item) => item.authorEmail === email && !seen.has(item._id));

    const items = [...mine, ...byEmail].sort((a, b) => b.createdAt - a.createdAt);

    // Compteurs de conversation : l'utilisateur doit voir depuis la liste
    // qu'on lui a répondu, sans ouvrir chaque fiche.
    const ids = new Set(items.map((item) => String(item._id)));
    const comments = (await ctx.db.query("feedbackComments").collect()).filter((comment) =>
      ids.has(String(comment.feedbackId)),
    );
    const stats = new Map<string, { count: number; teamReplies: number }>();
    for (const comment of comments) {
      const key = String(comment.feedbackId);
      const current = stats.get(key) ?? { count: 0, teamReplies: 0 };
      current.count += 1;
      if (comment.fromTeam) current.teamReplies += 1;
      stats.set(key, current);
    }

    const photos = await livePhotosByClerkId(ctx, items.map((item) => item.authorClerkId));
    return items.map((item) => {
      const stat = stats.get(String(item._id)) ?? { count: 0, teamReplies: 0 };
      return {
        ...item,
        authorImageUrl: livePhoto(photos, item.authorClerkId, item.authorImageUrl),
        commentCount: stat.count,
        teamReplyCount: stat.teamReplies,
      };
    });
  },
});

/** Vrai si `clerkId`/`email` est l'auteur du retour (repli email : cf. listMine). */
function isAuthor(
  item: { authorClerkId: string; authorEmail: string },
  clerkId: string,
  email: string,
) {
  return item.authorClerkId === clerkId || (email !== "" && item.authorEmail === email);
}

/**
 * Un retour et sa conversation. Accessible à **l'auteur** (sa fiche) et à
 * l'équipe produit (le kanban) — personne d'autre : les retours peuvent
 * contenir des captures de situations internes.
 */
export const thread = query({
  args: { id: v.id("feedback") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FEEDBACK_PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const item = await ctx.db.get(args.id);
    if (!item) return null;

    const email = normalizeEmail(identity.email);
    const admin = await canModerateFeedback(ctx);
    if (!admin && !isAuthor(item, identity.subject, email)) {
      throw new Error("Ce retour ne vous appartient pas.");
    }

    const comments = await ctx.db
      .query("feedbackComments")
      .withIndex("by_feedback_and_createdAt", (q) => q.eq("feedbackId", args.id))
      .order("asc")
      .collect();

    const photos = await livePhotosByClerkId(ctx, [
      item.authorClerkId,
      ...comments.map((comment) => comment.authorClerkId),
    ]);
    const attachmentUrls = await Promise.all(
      (item.attachments ?? []).map((attachment) => ctx.storage.getUrl(attachment)),
    );
    return {
      item: {
        ...item,
        authorImageUrl: livePhoto(photos, item.authorClerkId, item.authorImageUrl),
        attachmentUrls: attachmentUrls.filter((url): url is string => Boolean(url)),
      },
      comments: comments.map((comment) => ({
        ...comment,
        authorImageUrl: livePhoto(photos, comment.authorClerkId, comment.authorImageUrl),
      })),
      canModerate: admin,
    };
  },
});

/**
 * Ajout d'un message. Ouvert à l'auteur **et** à l'équipe produit : c'est ce
 * qui fait la conversation. `fromTeam` fige le rôle au moment de l'écriture,
 * pour que l'affichage reste juste même si les droits changent plus tard.
 */
export const addComment = mutation({
  args: { id: v.id("feedback"), body: v.string() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FEEDBACK_PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    const item = await ctx.db.get(args.id);
    if (!item) throw new Error("Retour introuvable.");

    const email = normalizeEmail(identity.email);
    const admin = await canModerateFeedback(ctx);
    if (!admin && !isAuthor(item, identity.subject, email)) {
      throw new Error("Ce retour ne vous appartient pas.");
    }

    const body = args.body.trim();
    if (body === "") throw new Error("Le message est vide.");

    const now = Date.now();
    const commentId = await ctx.db.insert("feedbackComments", {
      feedbackId: args.id,
      body,
      authorClerkId: identity.subject,
      authorEmail: email,
      authorName: feedbackDisplayName(identity),
      authorImageUrl: identity.pictureUrl ?? undefined,
      fromTeam: admin,
      createdAt: now,
    });
    await ctx.db.patch(args.id, { lastCommentAt: now, updatedAt: now });

    // On prévient l'auteur qu'on lui a répondu — pas quand c'est lui qui
    // écrit, il n'a pas besoin d'un email de son propre message.
    const answeringSomeoneElse = !isAuthor(item, identity.subject, email);
    if (answeringSomeoneElse && item.authorEmail) {
      await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendFeedbackCommentEmail, {
        email: item.authorEmail,
        authorName: item.authorName,
        commenterName: feedbackDisplayName(identity),
        commenterPhotoUrl: typeof identity.pictureUrl === "string" ? identity.pictureUrl : undefined,
        body,
        feedbackType: item.type,
        description: item.description,
      });
    }

    return commentId;
  },
});

/** Suppression de son propre message (ou de n'importe lequel pour l'équipe). */
export const removeComment = mutation({
  args: { commentId: v.id("feedbackComments") },
  handler: async (ctx, args) => {
    const identity = await requireUser(ctx);
    const comment = await ctx.db.get(args.commentId);
    if (!comment) return;
    const admin = await canModerateFeedback(ctx);
    if (!admin && comment.authorClerkId !== identity.subject) {
      throw new Error("Ce message n'est pas le vôtre.");
    }
    await ctx.db.delete(args.commentId);
  },
});

/** Kanban complet — réservé à l'équipe produit. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireFeedbackAdmin(ctx);
    const items = await ctx.db
      .query("feedback")
      .withIndex("by_createdAt")
      .order("desc")
      .collect();
    const comments = await ctx.db.query("feedbackComments").collect();
    const countById = new Map<string, number>();
    for (const comment of comments) {
      countById.set(comment.feedbackId, (countById.get(comment.feedbackId) ?? 0) + 1);
    }
    const photos = await livePhotosByClerkId(ctx, items.map((item) => item.authorClerkId));
    return items.map((item) => ({
      ...item,
      authorImageUrl: livePhoto(photos, item.authorClerkId, item.authorImageUrl),
      commentCount: countById.get(item._id) ?? 0,
    }));
  },
});

/**
 * Changement d'urgence d'un retour.
 *
 * Contrairement au statut (qui appartient à l'équipe produit), l'urgence est
 * la parole de **l'auteur** : c'est lui qui sait si sa situation s'est
 * aggravée. Il peut donc la revoir depuis « Mes retours » à tout moment.
 * L'équipe produit y a aussi accès, pour arbitrer depuis le kanban.
 */
export const setPriority = mutation({
  args: {
    id: v.id("feedback"),
    priority: feedbackPriority,
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, FEEDBACK_PAGE_KEY, "read");
    const identity = await requireUser(ctx);
    const item = await ctx.db.get(args.id);
    if (!item) throw new Error("Retour introuvable.");

    const email = normalizeEmail(identity.email);
    const admin = await canModerateFeedback(ctx);
    if (!admin && !isAuthor(item, identity.subject, email)) {
      throw new Error("Ce retour ne vous appartient pas.");
    }

    await ctx.db.patch(args.id, { priority: args.priority, updatedAt: Date.now() });
  },
});

/** Déplacement d'une carte dans le kanban — réservé à l'équipe produit. */
export const setStatus = mutation({
  args: {
    id: v.id("feedback"),
    status: feedbackStatus,
  },
  handler: async (ctx, args) => {
    const identity = await requireFeedbackAdmin(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Retour introuvable.");
    await ctx.db.patch(args.id, { status: args.status, updatedAt: Date.now() });

    // Prévenir l'auteur au passage en « Terminée », et seulement au passage :
    // re-déposer une carte déjà terminée dans la même colonne ne doit pas
    // renvoyer un email. On ne s'envoie pas de mail à soi-même non plus.
    const becameResolved = args.status === "termine" && existing.status !== "termine";
    if (becameResolved && existing.authorEmail && existing.authorClerkId !== identity.subject) {
      await ctx.scheduler.runAfter(0, internal.mesoutilsEmails.sendFeedbackResolvedEmail, {
        email: existing.authorEmail,
        authorName: existing.authorName,
        resolvedByName: feedbackDisplayName(identity),
        resolvedByPhotoUrl: typeof identity.pictureUrl === "string" ? identity.pictureUrl : undefined,
        feedbackType: existing.type,
        description: existing.description,
      });
    }
  },
});

/**
 * Suppression d'un retour — réservé à l'équipe produit. La conversation part
 * avec : sans ça les messages resteraient en base, rattachés à un retour
 * inexistant.
 */
export const remove = mutation({
  args: { id: v.id("feedback") },
  handler: async (ctx, args) => {
    await requireFeedbackAdmin(ctx);
    const comments = await ctx.db
      .query("feedbackComments")
      .withIndex("by_feedback_and_createdAt", (q) => q.eq("feedbackId", args.id))
      .collect();
    for (const comment of comments) {
      await ctx.db.delete(comment._id);
    }
    await ctx.db.delete(args.id);
  },
});

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { livePhoto, livePhotosByClerkId, requireUser } from "./lib";

export async function createMesoutilsNotification(
  ctx: MutationCtx,
  args: {
    recipientClerkId?: string;
    kind: "room_reservation_confirmed" | "equipment_reservation_confirmed" | "vehicle_reservation_decided" | "new_direct_message" | "post_liked" | "post_commented" | "deal_interest" | "vehicle_reservation_request";
    title: string;
    body?: string;
    actorName?: string;
    actorClerkId?: string;
    actorImageUrl?: string;
    assetImageUrl?: string;
    href?: string;
  },
) {
  const recipientClerkId = args.recipientClerkId?.trim();
  if (!recipientClerkId) return null;
  return await ctx.db.insert("mesoutilsNotifications", {
    recipientClerkId,
    kind: args.kind,
    title: args.title.trim(),
    body: args.body?.trim() || undefined,
    actorName: args.actorName?.trim() || undefined,
    actorClerkId: args.actorClerkId?.trim() || undefined,
    actorImageUrl: args.actorImageUrl?.trim() || undefined,
    assetImageUrl: args.assetImageUrl?.trim() || undefined,
    href: args.href,
    read: false,
    createdAt: Date.now(),
  });
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const notifications = await ctx.db
      .query("mesoutilsNotifications")
      .withIndex("by_recipient_createdAt", (q) => q.eq("recipientClerkId", identity.subject))
      .order("desc")
      .take(100);
    const photos = await livePhotosByClerkId(
      ctx,
      notifications.map((notification) => notification.actorClerkId),
    );
    return notifications.map((notification) => ({
      ...notification,
      actorImageUrl: livePhoto(photos, notification.actorClerkId, notification.actorImageUrl),
    }));
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const unread = await ctx.db
      .query("mesoutilsNotifications")
      .withIndex("by_recipient_read_createdAt", (q) =>
        q.eq("recipientClerkId", identity.subject).eq("read", false),
      )
      .collect();
    return unread.length;
  },
});

/**
 * Notifications non lues regroupées par destination (`href`).
 *
 * Le badge de la sidebar dit « il se passe quelque chose dans Gotravaux » ;
 * celui-ci sert à dire *où*, une fois la page ouverte. Les `href` pointent déjà
 * le sous-onglet concerné (`/gotravaux?v=reservations`), il suffit de les
 * compter — pas besoin d'un compteur dédié par onglet, qui divergerait du
 * contenu réel des notifications.
 */
export const unreadCountsByHref = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const unread = await ctx.db
      .query("mesoutilsNotifications")
      .withIndex("by_recipient_read_createdAt", (q) =>
        q.eq("recipientClerkId", identity.subject).eq("read", false),
      )
      .collect();
    const counts: Record<string, number> = {};
    for (const notification of unread) {
      if (!notification.href) continue;
      counts[notification.href] = (counts[notification.href] ?? 0) + 1;
    }
    return counts;
  },
});

export const markRead = mutation({
  args: { notificationId: v.id("mesoutilsNotifications") },
  handler: async (ctx, args) => {
    const identity = await requireUser(ctx);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.recipientClerkId !== identity.subject) return;
    await ctx.db.patch(args.notificationId, { read: true });
  },
});

/** clerkId de l'acteur encodé dans le href (`?to=<clerkId>`) des notifications. */
function clerkIdFromHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const match = href.match(/[?&]to=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Backfill : renseigne `actorImageUrl` sur les anciennes notifications liées à
 * un autre utilisateur (message, intérêt annonce, like, commentaire). La photo
 * est retrouvée depuis les messages/likes/commentaires existants, par clerkId
 * (précis, via le href) puis par nom d'affichage en repli.
 */
export const backfillActorImages = internalMutation({
  args: {},
  handler: async (ctx) => {
    const [messages, likes, comments] = await Promise.all([
      ctx.db.query("directMessages").collect(),
      ctx.db.query("postLikes").collect(),
      ctx.db.query("postComments").collect(),
    ]);

    const byClerkId = new Map<string, string>();
    const byName = new Map<string, string>();
    function remember(name: string | undefined, image: string | undefined | null, clerkId?: string) {
      if (!image) return;
      if (clerkId && !byClerkId.has(clerkId)) byClerkId.set(clerkId, image);
      const key = name?.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, image);
    }
    for (const message of messages) remember(message.fromName, message.fromImageUrl, message.fromClerkId);
    for (const like of likes) remember(like.actorName, like.actorImageUrl, like.clerkId);
    for (const comment of comments) remember(comment.authorName, comment.authorImageUrl, comment.authorClerkId);

    const kinds = new Set([
      "new_direct_message",
      "deal_interest",
      "post_liked",
      "post_commented",
    ]);
    const notifications = await ctx.db.query("mesoutilsNotifications").collect();
    let updated = 0;
    for (const notification of notifications) {
      if (notification.actorImageUrl || !kinds.has(notification.kind)) continue;
      const clerkId = clerkIdFromHref(notification.href);
      const image =
        (clerkId ? byClerkId.get(clerkId) : undefined) ??
        (notification.actorName ? byName.get(notification.actorName.trim().toLowerCase()) : undefined);
      if (image) {
        await ctx.db.patch(notification._id, { actorImageUrl: image });
        updated += 1;
      }
    }
    return { scanned: notifications.length, updated };
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const unread = await ctx.db
      .query("mesoutilsNotifications")
      .withIndex("by_recipient_read_createdAt", (q) =>
        q.eq("recipientClerkId", identity.subject).eq("read", false),
      )
      .collect();
    await Promise.all(unread.map((notification) => ctx.db.patch(notification._id, { read: true })));
  },
});

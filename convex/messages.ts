import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  customerFullName,
  hasCrmPermission,
  requireCrmPermission,
  requireRequestParticipant,
  titleCaseName,
} from "./lib";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

function serializeMessage(message: Doc<"messages">) {
  return {
    _id: message._id,
    senderRole: message.senderRole,
    senderName:
      message.senderRole === "client"
        ? titleCaseName(message.senderName)
        : message.senderName,
    body: message.body,
    createdAt: message.createdAt,
    readByClientAt: message.readByClientAt ?? null,
    readByStaffAt: message.readByStaffAt ?? null,
  };
}

export const listForRequest = query({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const request = await ctx.db.get(requestId);
    if (!request) return [];
    const staff = await hasCrmPermission(ctx, "messages", "read");
    if (!staff && request.userId !== identity.subject) return [];

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
      .collect();
    return messages.sort((a, b) => a.createdAt - b.createdAt).map(serializeMessage);
  },
});

export const sendMessage = mutation({
  args: {
    requestId: v.id("requests"),
    body: v.string(),
    // Côté depuis lequel le message est envoyé (portail client ou CRM). Un même
    // utilisateur peut être à la fois admin ET client : c'est le portail utilisé
    // qui détermine le côté, pas ses permissions.
    as: v.optional(v.union(v.literal("client"), v.literal("staff"))),
  },
  handler: async (ctx, { requestId, body, as }) => {
    const trimmed = body.trim();
    if (!trimmed) throw new Error("Message vide.");
    const { identity, request, staff } = await requireRequestParticipant(
      ctx,
      requestId,
      "messages",
      "reply",
    );

    const isOwner = !!request.userId && request.userId === identity.subject;

    // Le rôle effectif du message est déterminé par le côté d'envoi (`as`),
    // avec vérification des droits : on ne peut écrire comme « staff » qu'avec
    // la permission CRM, et comme « client » qu'en étant le propriétaire de la
    // demande. À défaut d'`as`, on retombe sur la capacité (compat ascendante).
    let senderRole: "client" | "staff";
    if (as === "staff") {
      if (!staff) throw new Error("Accès refusé.");
      senderRole = "staff";
    } else if (as === "client") {
      if (!isOwner) throw new Error("Accès refusé.");
      senderRole = "client";
    } else {
      senderRole = staff ? "staff" : "client";
    }
    const fromStaff = senderRole === "staff";

    let senderName: string;
    if (fromStaff) {
      senderName = identity.name ?? identity.email ?? "Administrateur";
    } else {
      const profile = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
        .unique();
      senderName =
        [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim() ||
        identity.name ||
        customerFullName(request.customer) ||
        "Client";
    }

    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      requestId,
      senderRole,
      senderName,
      senderClerkId: identity.subject,
      body: trimmed,
      createdAt: now,
      // Le message est lu par son auteur d'office.
      readByStaffAt: fromStaff ? now : undefined,
      readByClientAt: fromStaff ? undefined : now,
    });

    // Notifier le staff quand un client écrit.
    if (!fromStaff) {
      const messagePreview = trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
      // Une conversation garde une seule alerte de message, mise à jour avec
      // le dernier texte : une rafale de messages ne noie plus les demandes.
      const previousMessageNotifications = await ctx.db
        .query("notifications")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .collect();
      const existing = previousMessageNotifications
        .filter((notification) => notification.kind === "new_message")
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (existing) {
        await ctx.db.patch(existing._id, {
          title: "Nouveau message client",
          customerName: customerFullName(request.customer),
          messagePreview,
          read: false,
          createdAt: now,
        });
      } else {
        await ctx.db.insert("notifications", {
          kind: "new_message",
          title: "Nouveau message client",
          requestId,
          requestType: request.type,
          customerName: customerFullName(request.customer),
          messagePreview,
          read: false,
          createdAt: now,
        });
      }
    } else if (request.customer.email) {
      // Prévenir le client par email quand le staff répond (Resend).
      await ctx.scheduler.runAfter(0, internal.emails.sendNewMessage, {
        email: request.customer.email,
        name: customerFullName(request.customer),
        reference: request.reference ?? String(request._id).slice(-6),
        type: request.type,
        requestId: String(request._id),
        snippet: trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed,
      });
    }

    return messageId;
  },
});

export const markRead = mutation({
  args: {
    requestId: v.id("requests"),
    // Côté depuis lequel on consulte la conversation (voir sendMessage).
    as: v.optional(v.union(v.literal("client"), v.literal("staff"))),
  },
  handler: async (ctx, { requestId, as }) => {
    const { identity, request, staff } = await requireRequestParticipant(
      ctx,
      requestId,
      "messages",
      "read",
    );
    const isOwner = !!request.userId && request.userId === identity.subject;

    // Le côté de lecture suit le portail utilisé, pas les permissions.
    let asStaff: boolean;
    if (as === "staff") asStaff = staff;
    else if (as === "client") asStaff = !isOwner && staff; // non-propriétaire => reste staff
    else asStaff = staff;

    const now = Date.now();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
      .collect();

    await Promise.all(
      messages.map((m) => {
        if (asStaff && m.senderRole === "client" && !m.readByStaffAt) {
          return ctx.db.patch(m._id, { readByStaffAt: now });
        }
        if (!asStaff && m.senderRole === "staff" && !m.readByClientAt) {
          return ctx.db.patch(m._id, { readByClientAt: now });
        }
        return Promise.resolve();
      }),
    );
  },
});

/** Badge client : nombre de messages staff non lus, toutes demandes confondues. */
export const myUnreadCount = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .collect();
    let count = 0;
    for (const request of requests) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_requestId", (q) => q.eq("requestId", request._id))
        .collect();
      count += messages.filter((m) => m.senderRole === "staff" && !m.readByClientAt).length;
    }
    return count;
  },
});

/** Liste des conversations côté CRM (une par demande contenant des messages). */
export const listConversations = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "messages", "read");
    const messages = await ctx.db.query("messages").withIndex("by_createdAt").collect();

    const byRequest = new Map<
      Id<"requests">,
      { last: Doc<"messages">; total: number; unread: number }
    >();
    for (const message of messages) {
      const entry = byRequest.get(message.requestId);
      const isUnread = message.senderRole === "client" && !message.readByStaffAt;
      if (!entry) {
        byRequest.set(message.requestId, {
          last: message,
          total: 1,
          unread: isUnread ? 1 : 0,
        });
      } else {
        entry.total += 1;
        if (isUnread) entry.unread += 1;
        if (message.createdAt > entry.last.createdAt) entry.last = message;
      }
    }

    const conversations = await Promise.all(
      [...byRequest.entries()].map(async ([requestId, info]) => {
        const request = await ctx.db.get(requestId);
        if (!request) return null;

        let imageUrl: string | null = null;
        if (request.type === "article") {
          const articleId = request.article?.articleId ?? request.articles?.[0]?.articleId;
          if (articleId) {
            const article = await ctx.db.get(articleId);
            const cover = article?.images?.[0];
            if (cover) imageUrl = await ctx.storage.getUrl(cover);
          }
        }

        return {
          requestId,
          requestType: request.type,
          reference: request.reference ?? null,
          imageUrl,
          customerName: customerFullName(request.customer),
          lastBody: info.last.body,
          lastSenderRole: info.last.senderRole,
          lastAt: info.last.createdAt,
          total: info.total,
          unread: info.unread,
        };
      }),
    );

    return conversations
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.lastAt - a.lastAt);
  },
});

export const staffUnreadCount = query({
  args: {},
  handler: async (ctx) => {
    // Badge permanent → 0 sans erreur si pas d'accès messages.
    if (!(await hasCrmPermission(ctx, "messages", "read"))) return 0;
    const messages = await ctx.db.query("messages").withIndex("by_createdAt").collect();
    return messages.filter((m) => m.senderRole === "client" && !m.readByStaffAt).length;
  },
});

/** Contexte d'une demande pour l'en-tête + récapitulatif côté CRM. */
export const getConversationContext = query({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    await requireCrmPermission(ctx, "messages", "read");
    const request = await ctx.db.get(requestId);
    if (!request) return null;
    const c = request.customer;
    const collectAddress = request.collecte?.collectAddress;
    return {
      requestId: request._id,
      type: request.type,
      reference: request.reference ?? null,
      stage: request.stage,
      outcome: request.outcome,
      complete: request.complete,
      collecteType: request.collecteType ?? null,
      scheduledDate: request.scheduledDate ?? null,
      quoteAmount: request.quoteAmount ?? null,
      comment: request.comment ?? null,
      createdAt: request.createdAt,
      customerName: customerFullName(c),
      customerEmail: c.email,
      customerPhone: c.phone,
      customerAddress:
        [c.address, [c.postalCode, c.city].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(", ") || null,
      collectAddress: collectAddress
        ? [
            collectAddress.address,
            [collectAddress.postalCode, collectAddress.city].filter(Boolean).join(" "),
          ]
            .filter(Boolean)
            .join(", ")
        : null,
      // Articles réservés (type boutique) pour le récapitulatif.
      articles: (request.articles ?? []).map((a) => a.articleTitle),
    };
  },
});

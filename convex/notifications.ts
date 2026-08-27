import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  titleCaseName,
  requireCrmPermission,
  hasCrmPermission,
  requireUser,
} from "./lib";
import type { Doc } from "./_generated/dataModel";

function currentProcessStep(request: Doc<"requests">) {
  if (!request.processSteps.length) return null;
  if (request.completedSteps <= 0) return "Nouvelle demande";
  return (
    request.processSteps[
      Math.min(request.completedSteps, request.processSteps.length) - 1
    ] ?? null
  );
}

function requestPreview(request: Doc<"requests">) {
  switch (request.type) {
    case "aerogommage": {
      const items = request.aerogommage ?? [];
      if (items.length === 0) {
        return {
          preview: "Demande d'aérogommage à qualifier.",
          secondaryPreview: request.comment ?? undefined,
        };
      }
      if (items.length === 1) {
        const item = items[0];
        const name =
          item.label?.trim() ||
          item.objectType?.trim() ||
          "Objet à aérogommer";
        return {
          preview: name,
          secondaryPreview:
            [item.woodType, item.coating].filter(Boolean).join(" · ") ||
            request.comment ||
            undefined,
        };
      }
      return {
        preview: `${items.length} objets à aérogommer`,
        secondaryPreview: request.comment ?? undefined,
      };
    }
    case "collecte": {
      const address = request.collecte?.collectAddress;
      return {
        preview:
          [address?.postalCode, address?.city].filter(Boolean).join(" ") ||
          "Collecte à domicile",
        secondaryPreview:
          [
            request.collecteType && request.collecteType !== "indefini"
              ? `Collecte ${request.collecteType}`
              : "Collecte à définir",
            request.comment,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      };
    }
    case "article": {
      const count = request.articles?.length ?? (request.article ? 1 : 0);
      const firstTitle =
        request.articles?.[0]?.articleTitle ?? request.article?.articleTitle;
      return {
        preview:
          count > 1
            ? `${count} articles réservés`
            : firstTitle || "Réservation boutique",
        secondaryPreview:
          request.payment?.method === "cb"
            ? request.payment.validated
              ? "Paiement carte validé"
              : "Paiement carte en attente"
            : "Paiement en espèces prévu en boutique",
      };
    }
    case "velo":
      return {
        preview:
          [request.velo?.bikeType, request.velo?.service]
            .filter(Boolean)
            .join(" · ") || "Atelier vélo",
        secondaryPreview:
          request.velo?.brand || request.comment || undefined,
      };
    default:
      return {
        preview: request.comment || "Nouvelle demande",
        secondaryPreview: undefined,
      };
  }
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "notifications", "read");
    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_createdAt")
      .order("desc")
      .collect();

    return await Promise.all(
      notifications.map(async (notification) => {
        const request = await ctx.db.get(notification.requestId);
        if (!request) {
        return {
          ...notification,
          customerName: titleCaseName(notification.customerName),
          requestPreview: "Demande introuvable",
          requestSecondaryPreview: undefined,
            requestReference: undefined,
            requestOrigin: undefined,
            requestComplete: undefined,
            requestOutcome: undefined,
            currentStep: undefined,
            scheduledDate: undefined,
            articleCount: undefined,
            paymentMethod: undefined,
            paymentValidated: undefined,
            paymentCaptured: undefined,
          };
        }

        const preview = requestPreview(request);
        return {
          ...notification,
          customerName: titleCaseName(notification.customerName),
          requestPreview: preview.preview,
          requestSecondaryPreview: preview.secondaryPreview,
          requestReference: request.reference,
          requestOrigin: request.requestOrigin,
          requestComplete: request.complete,
          requestOutcome: request.outcome,
          currentStep: currentProcessStep(request),
          scheduledDate: request.scheduledDate,
          articleCount:
            request.type === "article"
              ? request.articles?.length ?? (request.article ? 1 : 0)
              : undefined,
          paymentMethod: request.payment?.method,
          paymentValidated: request.payment?.validated,
          paymentCaptured: request.payment?.captured,
        };
      }),
    );
  },
});

/** Repère de lecture personnel d'un compte (null s'il n'a jamais ouvert la page). */
async function readState(ctx: QueryCtx | MutationCtx, clerkId: string) {
  return await ctx.db
    .query("notificationReads")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
    .unique();
}

/**
 * Nombre de notifications non lues **par utilisateur**.
 *
 * Chacun a son propre repère de lecture : qu'un collègue ouvre la page ne
 * remet pas le compteur des autres à zéro.
 *
 * Tant qu'un compte n'a jamais ouvert la page, il n'a pas de repère — on
 * retombe alors sur l'ancien drapeau global `read`, qui sert de valeur de
 * départ. Évite qu'au déploiement tout le monde se retrouve avec l'historique
 * complet des notifications d'un coup, sans avoir à migrer les données.
 */
export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    // Badge permanent → 0 sans erreur si pas connecté ou pas d'accès
    // notifications. L'identité se lit avant `hasCrmPermission`, qui lève
    // quand personne n'est authentifié.
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;
    if (!(await hasCrmPermission(ctx, "notifications", "read"))) return 0;

    const state = await readState(ctx, identity.subject);
    if (!state) {
      const unread = await ctx.db
        .query("notifications")
        .withIndex("by_read_and_createdAt", (q) => q.eq("read", false))
        .collect();
      return unread.length;
    }

    const since = await ctx.db
      .query("notifications")
      .withIndex("by_createdAt", (q) => q.gt("createdAt", state.lastReadAt))
      .collect();
    return since.length;
  },
});

/**
 * L'utilisateur courant a tout vu : on avance **son** repère de lecture.
 *
 * Ne touche plus au drapeau global `read` — c'était lui qui vidait le
 * compteur de toute l'équipe. Demande le droit `read` et non `manage` :
 * marquer ses propres notifications comme vues n'est pas un acte
 * d'administration, et sans ça un compte en lecture seule ne pourrait jamais
 * faire retomber son badge.
 */
export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "notifications", "read");
    const identity = await requireUser(ctx);

    const now = Date.now();
    const state = await readState(ctx, identity.subject);
    if (state) {
      await ctx.db.patch(state._id, { lastReadAt: now });
      return;
    }
    await ctx.db.insert("notificationReads", {
      clerkId: identity.subject,
      lastReadAt: now,
    });
  },
});

import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireAdmin, requireCrmPermission } from "./lib";
import { STEP } from "./processes";
import { Doc } from "./_generated/dataModel";

const REQUEST_TYPE = v.union(
  v.literal("aerogommage"),
  v.literal("collecte"),
  v.literal("article"),
  v.literal("velo"),
  v.literal("livraison"),
  v.literal("depot"),
);

/** Colonne Kanban déduite de l'avancement du process. */
function deriveStage(r: Doc<"requests">): "nouveau" | "validation" | "planifie" {
  const completed = r.completedSteps ?? 0;
  if (completed === 0) return "nouveau";
  const done = (r.processSteps ?? []).slice(0, completed);
  if (done.includes(STEP.prestaPlanifiee)) return "planifie";
  return "validation";
}

/** Statistiques agrégées pour le tableau de bord du CRM. */
export const stats = query({
  args: { type: v.optional(REQUEST_TYPE) },
  handler: async (ctx, { type }) => {
    await requireCrmPermission(ctx, "dashboard", "read");
    const all = await ctx.db.query("requests").collect();
    const requests = type ? all.filter((r) => r.type === type) : all;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const byType = { aerogommage: 0, collecte: 0, article: 0, velo: 0, livraison: 0, depot: 0 };
    const byStage = { nouveau: 0, validation: 0, planifie: 0 };
    let open = 0;
    let won = 0;
    let lost = 0;
    let incomplete = 0;
    let scheduledToday = 0;
    const quoteTotals = {
      open: 0,
      won: 0,
      lost: 0,
    };

    for (const r of all) {
      byType[r.type]++;
    }

    for (const r of requests) {
      if (r.outcome === "open") {
        open++;
        quoteTotals.open += r.quoteAmount ?? 0;
        byStage[deriveStage(r)]++;
        if (!r.complete) incomplete++;
      } else if (r.outcome === "gagnee") {
        won++;
        quoteTotals.won += r.quoteAmount ?? 0;
      } else {
        lost++;
        quoteTotals.lost += r.quoteAmount ?? 0;
      }
      if (
        r.scheduledDate &&
        r.scheduledDate >= startOfDay.getTime() &&
        r.scheduledDate <= endOfDay.getTime()
      ) {
        scheduledToday++;
      }
    }

    return {
      total: requests.length,
      open,
      won,
      lost,
      incomplete,
      scheduledToday,
      byType,
      byStage,
      quoteTotals,
    };
  },
});

/** Un compte @eco-solidaire.fr = membre interne, sinon client. */
function isInternalEmail(email: string) {
  return email.trim().toLowerCase().endsWith("@eco-solidaire.fr");
}

/**
 * Audience par application pour la page admin : d'où viennent les comptes
 * utilisateurs, et combien de fiches « client » chaque app gère en propre.
 *
 * Les comptes sont partagés par les 7 apps (une seule instance Clerk) : ce qui
 * distingue un « client Recyclerie » d'un « client Klyd », c'est l'app depuis
 * laquelle il s'est inscrit (`signupApp`). Les comptes internes
 * (@eco-solidaire.fr) sont comptés à part pour ne pas les mélanger aux clients.
 *
 * Le décompte du staff n'est pas ici : il se déduit des droits `crmPermissions`
 * côté page admin, qui possède déjà le catalogue des pages par app.
 */
export const appAudience = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const [users, crmCustomers, cycleCustomers, klydeOrders, bpCompanies, ptClients, feedbackEntries] =
      await Promise.all([
        ctx.db.query("users").collect(),
        ctx.db.query("crmCustomers").collect(),
        ctx.db.query("cycleCustomers").collect(),
        ctx.db.query("klydeOrders").collect(),
        ctx.db.query("bpCompanies").collect(),
        ctx.db.query("ptClients").collect(),
        ctx.db.query("feedback").collect(),
      ]);

    // Comptes clients (externes) par app d'inscription ; sans `signupApp`, le
    // compte est antérieur à la traçabilité de l'origine et n'est rattaché à
    // aucune app. La liste nominative sert au détail affiché au clic.
    const clientsByApp: Record<string, Array<{ email: string; name: string; createdAt: number }>> = {};
    let internalAccounts = 0;
    let clientAccounts = 0;
    let unknownOrigin = 0;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let newClientsLast30Days = 0;

    for (const user of users) {
      if (isInternalEmail(user.email)) {
        internalAccounts += 1;
        continue;
      }
      clientAccounts += 1;
      if (user.createdAt >= thirtyDaysAgo) newClientsLast30Days += 1;
      if (!user.signupApp) {
        unknownOrigin += 1;
        continue;
      }
      const list = (clientsByApp[user.signupApp] ??= []);
      list.push({
        email: user.email,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ").trim(),
        createdAt: user.createdAt,
      });
    }

    for (const list of Object.values(clientsByApp)) {
      // Les inscriptions les plus récentes d'abord dans le détail.
      list.sort((a, b) => b.createdAt - a.createdAt);
    }

    const klydeBuyers = new Set(
      klydeOrders.map((order) => order.clerkId).filter(Boolean),
    ).size;

    return {
      accounts: {
        total: users.length,
        clients: clientAccounts,
        internal: internalAccounts,
        unknownOrigin,
        newClientsLast30Days,
      },
      clientsByApp,
      /** Fiches gérées en propre par chaque app (≠ comptes utilisateurs). */
      records: {
        recycapp: { label: "Fiches clients CRM", count: crmCustomers.length },
        cycleenbray: { label: "Fiches clients", count: cycleCustomers.length },
        klyde: { label: "Acheteurs distincts", count: klydeBuyers },
        bennespro: { label: "Entreprises clientes", count: bpCompanies.length },
        pointeuse: { label: "Clients chantiers", count: ptClients.length },
        feedback: { label: "Retours reçus", count: feedbackEntries.length },
      },
    };
  },
});

/**
 * Vue « maison mère » : agrégat du chiffre d'affaires et de l'activité de
 * toutes les applications (Recyclerie, Klyde, Cycle en Bray). Réservé aux
 * administrateurs. Parcourt les tables en entier (acceptable : usage admin,
 * faible fréquence) — à dénormaliser via compteurs si le volume explose.
 */
export const globalStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const [requests, ventes, klydeOrders, klydeItems, bikes, cycleRequests] =
      await Promise.all([
        ctx.db.query("requests").collect(),
        ctx.db.query("ventes").collect(),
        ctx.db.query("klydeOrders").collect(),
        ctx.db.query("klydeItems").collect(),
        ctx.db.query("bikes").collect(),
        ctx.db.query("cycleRequests").collect(),
      ]);

    // — Recyclerie : collecte + aérogommage (devis gagnés) + boutique (caisse) —
    const recyclerieSegment = (type: "collecte" | "aerogommage") => {
      const items = requests.filter((request) => request.type === type);
      const won = items.filter((request) => request.outcome === "gagnee");
      return {
        requests: items.length,
        open: items.filter((request) => request.outcome === "open").length,
        won: won.length,
        revenue: won.reduce((sum, request) => sum + (request.quoteAmount ?? 0), 0),
      };
    };
    const collecte = recyclerieSegment("collecte");
    const aerogommage = recyclerieSegment("aerogommage");
    const boutique = {
      revenue: ventes.reduce((sum, vente) => sum + vente.total, 0),
      sales: ventes.length,
    };
    const recyclerieRevenue = collecte.revenue + aerogommage.revenue + boutique.revenue;

    // — Klyde : commandes boutique payées —
    const paidKlyde = klydeOrders.filter((order) => order.status === "payee");
    const klyde = {
      revenue: paidKlyde.reduce((sum, order) => sum + order.total, 0),
      orders: klydeOrders.length,
      paidOrders: paidKlyde.length,
      pendingOrders: klydeOrders.length - paidKlyde.length,
      items: klydeItems.length,
    };

    // — Cycle en Bray : vélos vendus + pipeline des demandes —
    const cycleOpenStatuses = ["nouveau", "validation", "en_cours"];
    const soldBikes = bikes.filter((bike) => bike.status === "sold");
    const cycle = {
      revenue: soldBikes.reduce((sum, bike) => sum + (bike.price ?? 0), 0),
      requests: cycleRequests.length,
      open: cycleRequests.filter((request) => cycleOpenStatuses.includes(request.pipelineStatus)).length,
      won: cycleRequests.filter((request) => request.pipelineStatus === "gagnee").length,
      bikes: bikes.length,
      bikesSold: soldBikes.length,
      bikesAvailable: bikes.filter((bike) =>
        ["available", "online", "ready"].includes(bike.status),
      ).length,
    };

    return {
      totalRevenue: recyclerieRevenue + klyde.revenue + cycle.revenue,
      recyclerie: {
        revenue: recyclerieRevenue,
        requests: requests.length,
        open: requests.filter((request) => request.outcome === "open").length,
        collecte,
        aerogommage,
        boutique,
      },
      klyde,
      cycle,
    };
  },
});

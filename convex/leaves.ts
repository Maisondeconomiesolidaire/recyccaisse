import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { formatUserName, getCrmAccessForIdentity, requireCrmPermission, requireUser } from "./lib";

function displayName(identity: {
  name?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
}) {
  return formatUserName(identity);
}

function parseDay(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error("Date invalide.");
  return date;
}

async function requireMesoutilsStaff(ctx: QueryCtx | MutationCtx) {
  const identity = await requireUser(ctx);
  const access = await getCrmAccessForIdentity(ctx, identity);
  return { identity, access };
}

const leaveTypeValidator = v.union(
  v.literal("cp"),
  v.literal("rtt"),
  v.literal("sans_solde"),
  v.literal("maladie"),
  v.literal("autre"),
);

const leaveStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("cancelled"),
);

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "mesoutils:conges", "read");
    const { identity, access } = await requireMesoutilsStaff(ctx);
    const mine = await ctx.db
      .query("leaveRequests")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .collect();

    const pendingAll = access.admin
      ? await ctx.db
          .query("leaveRequests")
          .withIndex("by_status_and_startDate", (q) => q.eq("status", "pending"))
          .collect()
      : [];

    return {
      mine: mine.sort((a, b) => b.createdAt - a.createdAt),
      pendingAll: pendingAll
        .sort((a, b) => {
          if (a.startDate === b.startDate) return b.createdAt - a.createdAt;
          return a.startDate.localeCompare(b.startDate);
        }),
      isAdmin: access.admin,
    };
  },
});

export const create = mutation({
  args: {
    type: leaveTypeValidator,
    startDate: v.string(),
    endDate: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "mesoutils:conges", "create");
    const { identity } = await requireMesoutilsStaff(ctx);
    const start = parseDay(args.startDate);
    const end = parseDay(args.endDate);
    if (end.getTime() < start.getTime()) {
      throw new Error("La date de fin doit être postérieure ou égale à la date de début.");
    }

    const now = Date.now();
    return await ctx.db.insert("leaveRequests", {
      clerkId: identity.subject,
      requesterName: displayName(identity),
      requesterEmail: identity.email?.trim().toLowerCase() || undefined,
      type: args.type,
      status: "pending",
      startDate: args.startDate,
      endDate: args.endDate,
      note: args.note?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const cancel = mutation({
  args: { leaveId: v.id("leaveRequests") },
  handler: async (ctx, { leaveId }) => {
    await requireCrmPermission(ctx, "mesoutils:conges", "read");
    const { identity, access } = await requireMesoutilsStaff(ctx);
    const leave = await ctx.db.get(leaveId);
    if (!leave) throw new Error("Demande introuvable.");
    const isOwner = leave.clerkId === identity.subject;
    if (!isOwner && !access.admin) {
      throw new Error("Vous ne pouvez pas annuler cette demande.");
    }
    if (leave.status !== "pending") {
      throw new Error("Seules les demandes en attente peuvent être annulées.");
    }
    await ctx.db.patch(leaveId, {
      status: "cancelled",
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const decide = mutation({
  args: {
    leaveId: v.id("leaveRequests"),
    status: v.union(v.literal("approved"), v.literal("rejected")),
    decisionNote: v.optional(v.string()),
  },
  handler: async (ctx, { leaveId, status, decisionNote }) => {
    await requireCrmPermission(ctx, "mesoutils:conges", "manage");
    const { identity, access } = await requireMesoutilsStaff(ctx);
    if (!access.admin) throw new Error("Accès administrateur requis.");
    const leave = await ctx.db.get(leaveId);
    if (!leave) throw new Error("Demande introuvable.");
    if (leave.status !== "pending") {
      throw new Error("Cette demande a déjà été traitée.");
    }
    await ctx.db.patch(leaveId, {
      status,
      decisionNote: decisionNote?.trim() || undefined,
      decidedAt: Date.now(),
      decidedByClerkId: identity.subject,
      decidedByName: displayName(identity),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const listAll = query({
  args: {
    status: v.optional(leaveStatusValidator),
  },
  handler: async (ctx, { status }) => {
    await requireCrmPermission(ctx, "mesoutils:conges", "manage");
    const { access } = await requireMesoutilsStaff(ctx);
    if (!access.admin) throw new Error("Accès administrateur requis.");
    const leaves = status
      ? await ctx.db
          .query("leaveRequests")
          .withIndex("by_status_and_startDate", (q) => q.eq("status", status))
          .collect()
      : await ctx.db.query("leaveRequests").collect();

    return leaves.sort((a, b) => {
      if (a.startDate === b.startDate) return b.createdAt - a.createdAt;
      return a.startDate.localeCompare(b.startDate);
    });
  },
});

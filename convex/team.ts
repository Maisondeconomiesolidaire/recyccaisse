import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { customerFullName, requireCrmPermission, requireStaff } from "./lib";

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, "equipe", "read");
    return await ctx.db.query("teamMembers").order("desc").collect();
  },
});

/**
 * Liste des encadrants (membres actifs de l'équipe) pour la sélection de persona
 * sur le compte partagé accueil. Accessible à tout staff (pas de droit `equipe`).
 */
export const listPersonas = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const members = await ctx.db.query("teamMembers").order("asc").collect();
    return members
      .filter((member) => member.active)
      .map((member) => ({ _id: member._id, name: member.name, role: member.role ?? null }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    role: v.optional(v.string()),
    email: v.optional(v.string()),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    sites: v.optional(v.array(v.union(v.literal("60"), v.literal("76")))),
    employmentType: v.optional(v.union(v.literal("permanent"), v.literal("polyvalent"))),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, "equipe", "create");
    return await ctx.db.insert("teamMembers", {
      ...args,
      active: true,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("teamMembers"),
    name: v.string(),
    role: v.optional(v.string()),
    email: v.optional(v.string()),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    sites: v.optional(v.array(v.union(v.literal("60"), v.literal("76")))),
    employmentType: v.optional(v.union(v.literal("permanent"), v.literal("polyvalent"))),
    active: v.boolean(),
  },
  handler: async (ctx, { id, ...rest }) => {
    await requireCrmPermission(ctx, "equipe", "update");
    await ctx.db.patch(id, rest);
  },
});

export const get = query({
  args: { id: v.id("teamMembers") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "equipe", "read");
    const member = await ctx.db.get(id);
    if (!member) return null;

    const requests = (await ctx.db.query("requests").order("desc").collect())
      .filter((request) => request.assignedTo === id)
      .slice(0, 100);

    return {
      member,
      requests: requests.map((request) => ({
        _id: request._id,
        type: request.type,
        collecteType: request.collecteType,
        outcome: request.outcome,
        createdAt: request.createdAt,
        customerName: customerFullName(request.customer),
      })),
    };
  },
});

export const remove = mutation({
  args: { id: v.id("teamMembers") },
  handler: async (ctx, { id }) => {
    await requireCrmPermission(ctx, "equipe", "delete");
    await ctx.db.delete(id);
  },
});

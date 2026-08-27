import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib";

async function requireMyCompanyId(ctx: QueryCtx | MutationCtx) {
  const identity = await requireUser(ctx);
  const company = await ctx.db
    .query("bpCompanies")
    .withIndex("by_owner", (q) => q.eq("ownerUserId", identity.subject))
    .first();
  if (!company) throw new Error("Aucune entreprise associee a ce compte.");
  return company._id;
}

export const listMyVehicles = query({
  args: {},
  handler: async (ctx) => {
    const companyId = await requireMyCompanyId(ctx);
    const vehicles = await ctx.db
      .query("bpVehicles")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    return vehicles.sort((a, b) => a.label.localeCompare(b.label, "fr"));
  },
});

export const addMyVehicle = mutation({
  args: {
    label: v.string(),
    plate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const companyId = await requireMyCompanyId(ctx);
    const label = args.label.trim();
    if (!label) throw new Error("Le vehicule doit avoir un libelle.");
    return await ctx.db.insert("bpVehicles", {
      companyId,
      label,
      plate: args.plate?.trim() || undefined,
      createdAt: Date.now(),
    });
  },
});

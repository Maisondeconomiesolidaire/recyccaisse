import { v } from "convex/values";
import { action, env, internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { fetchInternalClerkDirectory, formatUserName, livePhoto, livePhotosByClerkId, requireUser } from "./lib";

export const INITIAL_POINTS = 100;
export const ENGAGEMENT_POINTS = 100;

function nameFor(identity: { name?: string | null; givenName?: string | null; familyName?: string | null; email?: string | null }) {
  return formatUserName(identity);
}

/** Attribution idempotente, utilisable par les mutations métier du backend partagé. */
export async function awardEngagementPoints(ctx: MutationCtx, args: { clerkId: string; displayName: string; eventKey: string; profileImageUrl?: string }) {
  const existingAward = await ctx.db.query("userPointAwards").withIndex("by_clerkId_and_eventKey", (q) => q.eq("clerkId", args.clerkId).eq("eventKey", args.eventKey)).unique();
  if (existingAward) return;
  const now = Date.now();
  const account = await ctx.db.query("userPoints").withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId)).unique();
  if (account) await ctx.db.patch(account._id, { displayName: args.displayName || account.displayName, profileImageUrl: args.profileImageUrl ?? account.profileImageUrl, points: account.points + ENGAGEMENT_POINTS, updatedAt: now });
  else await ctx.db.insert("userPoints", { clerkId: args.clerkId, displayName: args.displayName || "Utilisateur", profileImageUrl: args.profileImageUrl, points: INITIAL_POINTS + ENGAGEMENT_POINTS, updatedAt: now });
  await ctx.db.insert("userPointAwards", { clerkId: args.clerkId, eventKey: args.eventKey, points: ENGAGEMENT_POINTS, createdAt: now });
}

export const myPoints = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const account = await ctx.db.query("userPoints").withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject)).unique();
    return account?.points ?? INITIAL_POINTS;
  },
});

export const ensureMine = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const current = await ctx.db.query("userPoints").withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject)).unique();
    if (current) return current.points;
    await ctx.db.insert("userPoints", { clerkId: identity.subject, displayName: nameFor(identity), profileImageUrl: identity.pictureUrl ?? undefined, points: INITIAL_POINTS, updatedAt: Date.now() });
    return INITIAL_POINTS;
  },
});

export const leaderboard = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db.query("userPoints").withIndex("by_points").order("desc").take(100);
    // Photo résolue à la lecture (users.imageUrl, à jour à chaque connexion) :
    // évite qu'une photo figée disparaisse, comme pour les posts/deals/events.
    const photos = await livePhotosByClerkId(ctx, rows.map((row) => row.clerkId));
    return rows.map((row, index) => ({
      rank: index + 1,
      displayName: row.displayName,
      profileImageUrl: livePhoto(photos, row.clerkId, row.profileImageUrl),
      points: row.points,
    }));
  },
});

export const syncLeaderboardDirectory = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.runQuery(api.points.assertSignedIn, {});
    const secret = env.CLERK_SECRET_KEY;
    if (!secret) throw new Error("Annuaire indisponible.");
    const directory = await fetchInternalClerkDirectory(secret, identity.email ?? "");
    directory.push({ clerkId: identity.subject, name: nameFor(identity), imageUrl: identity.pictureUrl ?? null });
    await ctx.runMutation(internal.points.syncHistorical, { directory: directory.map(({ clerkId, name, imageUrl }) => ({ clerkId, name, imageUrl: imageUrl ?? undefined })) });
    return null;
  },
});

export const assertSignedIn = query({ args: {}, handler: async (ctx) => await requireUser(ctx) });

export const syncHistorical = internalMutation({
  args: { directory: v.array(v.object({ clerkId: v.string(), name: v.string(), imageUrl: v.optional(v.string()) })) },
  handler: async (ctx, { directory }) => {
    const names = new Map(directory.map((entry) => [entry.clerkId, entry.name]));
    for (const entry of directory) {
      const current = await ctx.db.query("userPoints").withIndex("by_clerkId", (q) => q.eq("clerkId", entry.clerkId)).unique();
      if (!current) {
        await ctx.db.insert("userPoints", { clerkId: entry.clerkId, displayName: entry.name, profileImageUrl: entry.imageUrl, points: INITIAL_POINTS, updatedAt: Date.now() });
        continue;
      }
      // Ne jamais écraser une photo existante par `undefined` (compte Clerk sans
      // photo). Et ne patcher que si quelque chose change réellement : sinon le
      // `updatedAt` invalide la requête `leaderboard` à chaque montage de page
      // et provoque des « refresh » visuels intempestifs.
      const nextPhoto = entry.imageUrl ?? current.profileImageUrl;
      if (current.displayName !== entry.name || current.profileImageUrl !== nextPhoto) {
        await ctx.db.patch(current._id, { displayName: entry.name, profileImageUrl: nextPhoto, updatedAt: Date.now() });
      }
    }
    const rooms = await ctx.db.query("roomReservations").take(1000);
    for (const row of rooms) await awardEngagementPoints(ctx, { clerkId: row.bookedForClerkId ?? row.clerkId, displayName: row.userName, eventKey: `room-reservation:${row._id}` });
    const vehicles = await ctx.db.query("vehicleReservations").take(1000);
    for (const row of vehicles) {
      const clerkId = row.bookedForClerkId ?? row.clerkId;
      await awardEngagementPoints(ctx, { clerkId, displayName: row.userName, eventKey: `vehicle-reservation:${row._id}` });
      if (row.feedbackSubmittedAt) await awardEngagementPoints(ctx, { clerkId, displayName: names.get(clerkId) ?? row.userName, eventKey: `vehicle-return:${row._id}` });
    }
    const feedback = await ctx.db.query("feedback").take(1000);
    for (const row of feedback) await awardEngagementPoints(ctx, { clerkId: row.authorClerkId, displayName: row.authorName ?? names.get(row.authorClerkId) ?? "Utilisateur", eventKey: `feedback:${row._id}` });
  },
});

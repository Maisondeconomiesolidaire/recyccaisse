import { v } from "convex/values";
import { action, env, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { esc, resendSend } from "./emails";
import {
  type ClerkApiUser,
  fetchAllClerkUsers,
  formatUserName,
  getCrmAccessForIdentity,
  hasCrmPermission,
  isAdminIdentity,
  requireAdmin,
  requireUser,
} from "./lib";

const grantValidator = v.object({
  pageKey: v.string(),
  actions: v.array(v.string()),
});

const ACCESS_REQUEST_RECIPIENT = "s.lahmer@eco-solidaire.fr";
const ACCESS_REQUEST_FROM = "Mes Outils <no-reply@mesoutils.eco-solidaire.fr>";

const requestedActionLabel = (value?: string) => {
  const labels: Record<string, string> = {
    read: "consulter",
    create: "créer",
    manage: "gérer",
  };
  return labels[value ?? "read"] ?? "consulter";
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeGrants(grants: { pageKey: string; actions: string[] }[]) {
  return grants
    .map((grant) => ({
      pageKey: grant.pageKey.trim(),
      actions: Array.from(
        new Set(grant.actions.map((action) => action.trim()).filter(Boolean)),
      ),
    }))
    .filter((grant) => grant.pageKey && grant.actions.length > 0);
}

async function requirePermissionManager(ctx: Parameters<typeof requireAdmin>[0]) {
  const identity = await requireUser(ctx);
  if (isAdminIdentity(identity)) return identity;
  if ("db" in ctx && await hasCrmPermission(ctx, "mesoutils:admin", "manage")) {
    return identity;
  }
  throw new Error("Accès réservé aux administrateurs.");
}

export const myAccess = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const access = await getCrmAccessForIdentity(ctx, identity);

    return {
      role: access.admin ? "admin" : access.staff ? "staff" : "none",
      isStaff: access.staff,
      isAdmin: access.admin,
      email: access.email,
      bootstrapMode: access.bootstrapMode,
      grants: access.grants,
    };
  },
});

/** Envoie à l'administrateur une demande formulée depuis un écran d'accès refusé. */
export const requestAccess = action({
  args: {
    pageKey: v.optional(v.string()),
    pageLabel: v.string(),
    requestedAction: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireUser(ctx);
    const requesterName = formatUserName(identity);
    const requesterEmail = identity.email?.trim() || "Adresse e-mail non renseignée";
    const pageLabel = args.pageLabel.trim().slice(0, 120) || "une fonctionnalité du CRM";
    const pageKey = args.pageKey?.trim().slice(0, 120);
    const actionLabel = requestedActionLabel(args.requestedAction);

    const sent = await resendSend(
      ACCESS_REQUEST_RECIPIENT,
      `Demande d'accès · ${pageLabel}`,
      `<!doctype html><html lang="fr"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.55;">
        <h2 style="margin:0 0 16px;">Nouvelle demande d'accès</h2>
        <p><strong>${esc(requesterName)}</strong> (${esc(requesterEmail)}) demande à <strong>${esc(actionLabel)}</strong> : <strong>${esc(pageLabel)}</strong>.</p>
        ${pageKey ? `<p style="color:#71717a;font-size:13px;">Référence : ${esc(pageKey)}</p>` : ""}
      </body></html>`,
      ACCESS_REQUEST_FROM,
    );

    if (!sent) throw new Error("L'email n'a pas pu être envoyé.");
    return { ok: true };
  },
});

export const canManagePermissions = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requirePermissionManager(ctx);
    return true;
  },
});

export const listManaged = query({
  args: {},
  handler: async (ctx) => {
    await requirePermissionManager(ctx);
    const permissionRecords = await ctx.db
      .query("crmPermissions")
      .order("desc")
      .take(300);

    return {
      people: permissionRecords
        .map((record) => ({
          email: record.email,
          name: record.name,
          role: record.role ?? "staff",
          permissionActive: record.active,
          grants: record.grants,
          updatedAt: record.updatedAt,
        }))
        .sort((a, b) =>
          (a.name ?? a.email).localeCompare(b.name ?? b.email, "fr"),
        ),
    };
  },
});

/**
 * Origine d'inscription par email (app + formulaire/chemin), pour le panneau
 * admin. On garde la trace la plus ancienne (première inscription).
 */
export const listSignupSources = query({
  args: {},
  handler: async (ctx) => {
    await requirePermissionManager(ctx);
    const users = await ctx.db.query("users").collect();
    const byEmail: Record<string, { app?: string; path?: string; at: number }> = {};
    for (const user of users) {
      const email = user.email.trim().toLowerCase();
      if (!email) continue;
      const existing = byEmail[email];
      if (!existing || user.createdAt < existing.at) {
        byEmail[email] = { app: user.signupApp, path: user.signupPath, at: user.createdAt };
      }
    }
    return byEmail;
  },
});

type ClerkEmailAddress = {
  id?: unknown;
  email_address?: unknown;
};

type ClerkUserPayload = {
  id?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
  image_url?: unknown;
  primary_email_address_id?: unknown;
  email_addresses?: unknown;
  public_metadata?: unknown;
  created_at?: unknown;
  last_sign_in_at?: unknown;
};

const roleValidator = v.union(
  v.literal("client"),
  v.literal("staff"),
  v.literal("admin"),
);

type CrmRole = "client" | "staff" | "admin";

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roleFromMetadata(value: unknown): CrmRole {
  if (!value || typeof value !== "object") return "client";
  const role = (value as { role?: unknown }).role;
  return role === "staff" || role === "admin" ? role : "client";
}

function clerkPrimaryEmail(user: ClerkUserPayload) {
  const emails = Array.isArray(user.email_addresses)
    ? (user.email_addresses as ClerkEmailAddress[])
    : [];
  const primaryId = stringOrNull(user.primary_email_address_id);
  const primary = emails.find((email) => email.id === primaryId) ?? emails[0];
  return stringOrNull(primary?.email_address)?.toLowerCase() ?? null;
}

function normalizeClerkUser(user: ClerkUserPayload) {
  const email = clerkPrimaryEmail(user);
  if (!email) return null;
  const firstName = stringOrNull(user.first_name);
  const lastName = stringOrNull(user.last_name);
  return {
    clerkId: stringOrNull(user.id) ?? email,
    email,
    name: formatUserName({ givenName: firstName, familyName: lastName, name: stringOrNull(user.username), email }),
    role: roleFromMetadata(user.public_metadata),
    imageUrl: stringOrNull(user.image_url),
    createdAt: numberOrNull(user.created_at),
    lastSignInAt: numberOrNull(user.last_sign_in_at),
  };
}

export const listClerkUsers = action({
  args: {
    limit: v.optional(v.number()),
    query: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.permissions.canManagePermissions);
    const secretKey = env.CLERK_SECRET_KEY;
    if (!secretKey) {
      return {
        users: [],
        totalCount: 0,
        setupError: "missing_clerk_secret_key",
      };
    }

    const limit = Math.min(Math.max(Math.floor(args.limit ?? 200), 1), 500);
    let rawUsers: ClerkApiUser[];
    try {
      rawUsers = await fetchAllClerkUsers(secretKey, { query: args.query });
    } catch (error) {
      console.error("listClerkUsers", error);
      return { users: [], totalCount: 0, setupError: "clerk_api_error" };
    }

    const users = rawUsers
      .map((user) => normalizeClerkUser(user as ClerkUserPayload))
      .filter((user): user is NonNullable<ReturnType<typeof normalizeClerkUser>> =>
        Boolean(user),
      )
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    return {
      users: users.slice(0, limit),
      totalCount: users.length,
      setupError: null,
    };
  },
});

export const updateClerkRole = action({
  args: {
    clerkId: v.string(),
    role: roleValidator,
  },
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.permissions.canManagePermissions);
    const secretKey = env.CLERK_SECRET_KEY;
    if (!secretKey) {
      return { ok: false, setupError: "missing_clerk_secret_key" };
    }

    const response = await fetch(
      `https://api.clerk.com/v1/users/${encodeURIComponent(args.clerkId)}/metadata`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          public_metadata: {
            role: args.role,
          },
        }),
      },
    );

    if (!response.ok) {
      return { ok: false, setupError: `clerk_api_${response.status}` };
    }

    return { ok: true, setupError: null };
  },
});

export const upsert = mutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    role: v.optional(roleValidator),
    active: v.boolean(),
    grants: v.array(grantValidator),
  },
  handler: async (ctx, args) => {
    const admin = await requirePermissionManager(ctx);
    const email = normalizeEmail(args.email);
    if (!email) throw new Error("Email requis.");

    const existing = await ctx.db
      .query("crmPermissions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    const payload = {
      email,
      name: args.name?.trim() || undefined,
      role: args.role ?? "staff",
      active: args.active,
      grants: normalizeGrants(args.grants),
      updatedAt: Date.now(),
      updatedBy: admin.email ?? admin.tokenIdentifier,
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }

    return await ctx.db.insert("crmPermissions", {
      ...payload,
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    await requirePermissionManager(ctx);
    const email = normalizeEmail(args.email);
    const existing = await ctx.db
      .query("crmPermissions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const debugRole = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireUser(ctx);
    const access = await getCrmAccessForIdentity(ctx, identity);
    return {
      email: access.email,
      isStaff: access.staff,
      isAdmin: access.admin,
    };
  },
});

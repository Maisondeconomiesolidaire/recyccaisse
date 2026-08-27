/**
 * Profils d'un compte Bennes & Pro partagé.
 *
 * Un même compte Clerk est utilisé par plusieurs personnes : à l'ouverture de
 * l'app, chacun choisit son profil, et c'est ce nom qui est inscrit sur les
 * dépôts qu'il enregistre. Sans ça, toute la traçabilité se résume à une seule
 * adresse email et on ne sait jamais qui était sur le terrain.
 *
 * L'administration des profils est réservée au titulaire du compte partagé et
 * protégée par un code PIN. Ce code est vérifié CÔTÉ SERVEUR : une garde
 * uniquement dans le navigateur se contourne en ouvrant les outils de
 * développement. Un PIN à 4 chiffres reste un garde-fou d'équipe, pas un
 * secret — il empêche une manipulation distraite, pas un utilisateur
 * déterminé qui possède déjà les identifiants du compte.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireUser } from "./lib";
import type { Id } from "./_generated/dataModel";

/** Comptes partagés qui disposent du sélecteur de profils. */
const SHARED_ACCOUNTS = ["m.verzeri@eco-solidaire.fr"];

const SETTINGS_KEY = "bennespro";
const DEFAULT_PIN = "0205";

function normalizeEmail(email: string | undefined | null) {
  return (email ?? "").trim().toLowerCase();
}

/** Vrai quand ce compte est partagé et doit passer par un profil. */
export function isSharedAccount(email: string | undefined | null) {
  return SHARED_ACCOUNTS.includes(normalizeEmail(email));
}

async function currentEmail(ctx: QueryCtx | MutationCtx) {
  const identity = await requireUser(ctx);
  return normalizeEmail(identity.email);
}

async function readPin(ctx: QueryCtx | MutationCtx): Promise<string> {
  const settings = await ctx.db
    .query("bpSettings")
    .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
    .unique();
  return settings?.profilesPin ?? DEFAULT_PIN;
}

/**
 * Autorise l'administration des profils : titulaire du compte partagé ET code
 * PIN correct. Les deux, systématiquement — le PIN protège le compte de
 * lui-même, l'email empêche un autre utilisateur du CRM d'y toucher.
 */
async function requireProfileAdmin(ctx: MutationCtx, pin: string) {
  const email = await currentEmail(ctx);
  if (!isSharedAccount(email)) {
    throw new ConvexError("Ce compte ne gère pas de profils.");
  }
  const expected = await readPin(ctx);
  if (pin.trim() !== expected) {
    throw new ConvexError("Code PIN incorrect.");
  }
  return email;
}

/** Le compte courant utilise-t-il des profils, et lesquels ? */
export const myProfiles = query({
  args: {},
  handler: async (ctx) => {
    const email = await currentEmail(ctx);
    if (!isSharedAccount(email)) {
      return { usesProfiles: false, profiles: [] };
    }
    const profiles = await ctx.db
      .query("bpProfiles")
      .withIndex("by_owner", (q) => q.eq("ownerEmail", email))
      .collect();
    return {
      usesProfiles: true,
      profiles: profiles
        .filter((profile) => !profile.archived)
        .sort((a, b) => a.name.localeCompare(b.name, "fr"))
        .map((profile) => ({
          _id: profile._id,
          name: profile.name,
          role: profile.role ?? null,
          color: profile.color ?? null,
        })),
    };
  },
});

/** Vérifie le code PIN avant d'ouvrir l'administration des profils. */
export const checkPin = query({
  args: { pin: v.string() },
  handler: async (ctx, { pin }) => {
    const email = await currentEmail(ctx);
    if (!isSharedAccount(email)) return { ok: false };
    const expected = await readPin(ctx);
    return { ok: pin.trim() === expected };
  },
});

export const create = mutation({
  args: {
    pin: v.string(),
    name: v.string(),
    role: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, { pin, name, role, color }) => {
    const ownerEmail = await requireProfileAdmin(ctx, pin);
    const trimmed = name.trim();
    if (!trimmed) throw new ConvexError("Le nom du profil est requis.");

    const now = Date.now();
    return await ctx.db.insert("bpProfiles", {
      ownerEmail,
      name: trimmed,
      role: role?.trim() || undefined,
      color: color?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    pin: v.string(),
    id: v.id("bpProfiles"),
    name: v.string(),
    role: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, { pin, id, name, role, color }) => {
    const ownerEmail = await requireProfileAdmin(ctx, pin);
    const profile = await ctx.db.get(id);
    if (!profile || profile.ownerEmail !== ownerEmail) {
      throw new ConvexError("Profil introuvable.");
    }
    const trimmed = name.trim();
    if (!trimmed) throw new ConvexError("Le nom du profil est requis.");

    await ctx.db.patch(id, {
      name: trimmed,
      role: role?.trim() || undefined,
      color: color?.trim() || undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Retire un profil.
 *
 * Le document est ARCHIVÉ, pas supprimé : les dépôts déjà enregistrés y
 * renvoient, et effacer la fiche reviendrait à effacer la trace de qui les a
 * faits. Le profil disparaît simplement du sélecteur.
 */
export const remove = mutation({
  args: { pin: v.string(), id: v.id("bpProfiles") },
  handler: async (ctx, { pin, id }) => {
    const ownerEmail = await requireProfileAdmin(ctx, pin);
    const profile = await ctx.db.get(id);
    if (!profile || profile.ownerEmail !== ownerEmail) {
      throw new ConvexError("Profil introuvable.");
    }
    await ctx.db.patch(id, { archived: true, updatedAt: Date.now() });
    return null;
  },
});

/** Change le code PIN de l'onglet Profils. */
export const setPin = mutation({
  args: { pin: v.string(), newPin: v.string() },
  handler: async (ctx, { pin, newPin }) => {
    const email = await requireProfileAdmin(ctx, pin);
    const next = newPin.trim();
    if (!/^\d{4}$/.test(next)) {
      throw new ConvexError("Le code PIN doit contenir exactement 4 chiffres.");
    }
    const settings = await ctx.db
      .query("bpSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
    if (settings) {
      await ctx.db.patch(settings._id, {
        profilesPin: next,
        updatedAt: Date.now(),
        updatedBy: email,
      });
    } else {
      await ctx.db.insert("bpSettings", {
        key: SETTINGS_KEY,
        profilesPin: next,
        updatedAt: Date.now(),
        updatedBy: email,
      });
    }
    return null;
  },
});

/**
 * Résout le profil à inscrire sur une action, pour les mutations métier.
 *
 * Le nom est recopié sur le dépôt : un profil renommé ou archivé plus tard ne
 * doit pas réécrire l'histoire des dépôts déjà enregistrés.
 */
export async function resolveActingProfile(
  ctx: MutationCtx,
  profileId: Id<"bpProfiles"> | undefined,
): Promise<{
  createdByProfileId?: Id<"bpProfiles">;
  createdByProfile?: string;
}> {
  if (!profileId) return {};
  const profile = await ctx.db.get(profileId);
  if (!profile) return {};
  const email = await currentEmail(ctx);
  // Un profil d'un autre compte n'a rien à faire sur nos dépôts.
  if (profile.ownerEmail !== email) return {};
  return { createdByProfileId: profile._id, createdByProfile: profile.name };
}

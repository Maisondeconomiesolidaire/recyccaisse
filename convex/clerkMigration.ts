import { action, query } from "./_generated/server";
import { api } from "./_generated/api";

/**
 * Migration Clerk dev -> prod (domaine groupemes.fr).
 *
 * On exporte les utilisateurs DEV vers l'instance Clerk PROD en les recréant
 * par email (sans mot de passe) : ils n'auront qu'à faire « mot de passe
 * oublié ».
 * Leurs données restent rattachées automatiquement : à la première connexion
 * prod, `users.syncProfile` retrouve le profil par email et remplace l'ancien
 * clerkId dev par le nouveau clerkId prod (remapClerkIdEverywhere).
 *
 * Prérequis recommandés pendant la bascule :
 * - `CLERK_DEV_SECRET_KEY`  : ancienne clé DEV (source des comptes à exporter)
 * - `CLERK_SECRET_KEY`      : clé PROD active (source de vérité après bascule)
 * - `CLERK_PROD_SECRET_KEY` : fallback si `CLERK_SECRET_KEY` pointe encore DEV
 */

export const usersForClerkExport = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const access = await ctx.runQuery(api.permissions.myAccess, {});
      if (!access.isAdmin) throw new Error("Réservé aux administrateurs.");
    }
    const users = await ctx.db.query("users").collect();
    return users
      .map((user) => ({
        email: user.email.trim().toLowerCase(),
        firstName: user.firstName?.trim() || undefined,
        lastName: user.lastName?.trim() || undefined,
      }))
      .filter((user) => Boolean(user.email));
  },
});

type ClerkErrorBody = { errors?: Array<{ code?: string; message?: string }> };
type ClerkEmailAddress = { id?: string; email_address?: string };
type ClerkUserPayload = {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
};

function clerkPrimaryEmail(user: ClerkUserPayload) {
  const emails = Array.isArray(user.email_addresses) ? user.email_addresses : [];
  const primaryId = user.primary_email_address_id ?? null;
  const primary = emails.find((email) => email.id === primaryId) ?? emails[0];
  const value = primary?.email_address?.trim().toLowerCase() ?? "";
  return value || null;
}

function isClerkDuplicateError(responseStatus: number, body: ClerkErrorBody) {
  const errors = Array.isArray(body.errors) ? body.errors : [];
  return (
    responseStatus === 409 ||
    errors.some((error) => {
      const code = (error.code ?? "").toLowerCase();
      const message = (error.message ?? "").toLowerCase();
      return (
        code.includes("already_exists") ||
        code.includes("identifier_exists") ||
        code.includes("duplicate") ||
        message.includes("already exists") ||
        message.includes("has already been taken")
      );
    })
  );
}

async function listClerkUsers(secret: string) {
  const users: Array<{ email: string; firstName?: string; lastName?: string }> = [];
  const pageSize = 100;
  let offset = 0;

  for (;;) {
    const url = new URL("https://api.clerk.com/v1/users");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("order_by", "created_at");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ClerkErrorBody;
      throw new Error(body.errors?.[0]?.message ?? `Clerk source API ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const rawUsers = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : [];

    for (const rawUser of rawUsers) {
      const user = rawUser as ClerkUserPayload;
      const email = clerkPrimaryEmail(user);
      if (!email) continue;
      users.push({
        email,
        firstName: user.first_name?.trim() || undefined,
        lastName: user.last_name?.trim() || undefined,
      });
    }

    if (rawUsers.length < pageSize) break;
    offset += rawUsers.length;
  }

  return users;
}

export const exportUsersToProdClerk = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ total: number; created: number; skipped: number; failed: number; errors: string[] }> => {
    // Depuis le navigateur : réservé aux admins. Depuis la CLI (`npx convex
    // run`, sans identité) : autorisé (accès déploiement = de confiance).
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const access = await ctx.runQuery(api.permissions.myAccess, {});
      if (!access.isAdmin) throw new Error("Réservé aux administrateurs.");
    }

    const sourceSecret = process.env.CLERK_DEV_SECRET_KEY ?? process.env.CLERK_SECRET_KEY;
    const targetSecret = process.env.CLERK_PROD_SECRET_KEY ?? process.env.CLERK_SECRET_KEY;
    if (!sourceSecret) {
      throw new Error(
        "CLERK_DEV_SECRET_KEY manquante. Conserve l'ancienne clé DEV ou renseigne-la explicitement.",
      );
    }
    if (!targetSecret) {
      throw new Error(
        "Aucune clé Clerk PROD disponible. Renseigne CLERK_SECRET_KEY ou CLERK_PROD_SECRET_KEY côté prod.",
      );
    }

    const clerkUsers = await listClerkUsers(sourceSecret);
    const dbUsers = await ctx.runQuery(api.clerkMigration.usersForClerkExport, {});
    const byEmail = new Map<string, { email: string; firstName?: string; lastName?: string }>();
    for (const user of dbUsers) byEmail.set(user.email, user);
    for (const user of clerkUsers) {
      const existing = byEmail.get(user.email);
      byEmail.set(user.email, {
        email: user.email,
        firstName: user.firstName ?? existing?.firstName,
        lastName: user.lastName ?? existing?.lastName,
      });
    }
    const users = Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email));
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const user of users) {
      try {
        const response = await fetch("https://api.clerk.com/v1/users", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${targetSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email_address: [user.email],
            ...(user.firstName ? { first_name: user.firstName } : {}),
            ...(user.lastName ? { last_name: user.lastName } : {}),
            skip_password_requirement: true,
            skip_password_checks: true,
            legal_accepted_at: new Date().toISOString(),
          }),
        });
        if (response.ok) {
          created += 1;
        } else {
          const body = (await response.json().catch(() => ({}))) as ClerkErrorBody;
          // Email déjà présent côté prod : on considère l'utilisateur exporté.
          if (isClerkDuplicateError(response.status, body)) {
            skipped += 1;
          } else {
            failed += 1;
            if (errors.length < 25) {
              errors.push(`${user.email}: ${response.status} ${body.errors?.[0]?.message ?? ""}`.trim());
            }
          }
        }
      } catch (error) {
        failed += 1;
        if (errors.length < 25) {
          errors.push(`${user.email}: ${error instanceof Error ? error.message : "erreur réseau"}`);
        }
      }
      // Respect du rate limit Clerk (~20 req/s) : petite pause.
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    return { total: users.length, created, skipped, failed, errors };
  },
});

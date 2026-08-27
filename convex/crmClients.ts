/**
 * Création d'un compte client depuis le CRM (caisse).
 *
 * Un client rencontré au comptoir n'a pas de compte : on lui en crée un chez
 * Clerk avec ses seules coordonnées, SANS mot de passe. Il pourra se connecter
 * plus tard (code par email ou « mot de passe oublié ») et retrouvera son
 * historique d'achats, exactement comme un client de la boutique en ligne.
 *
 * ⚠️ L'instance Clerk est partagée par toutes les apps du groupement : un
 * compte créé ici existe partout. C'est sans conséquence pour un client
 * (l'annuaire interne ne retient que les adresses @eco-solidaire.fr), mais on
 * estampille `signupApp` pour savoir d'où il vient.
 */
import { ConvexError, v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { accessAllows, clerkPrimaryEmail, fetchAllClerkUsers } from "./lib";

/** Enregistre le client côté CRM pour qu'il apparaisse immédiatement. */
export const recordCrmCustomer = internalMutation({
  args: {
    firstName: v.string(),
    lastName: v.string(),
    email: v.string(),
    phone: v.string(),
    clerkId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const existing = await ctx.db
      .query("crmCustomers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        firstName: args.firstName,
        lastName: args.lastName,
        phone: args.phone || existing.phone,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("crmCustomers", {
      source: "caisse",
      sourceId: args.clerkId ?? `caisse:${email}`,
      firstName: args.firstName,
      lastName: args.lastName,
      email,
      phone: args.phone,
      raw: [],
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Crée le compte Clerk d'un client, ou retrouve celui qui existe déjà.
 *
 * Aucun mot de passe : le client n'en a pas choisi. Il pourra se connecter plus
 * tard par code email et retrouvera ses achats. Si l'adresse est déjà connue de
 * Clerk, on RÉUTILISE le compte — créer un doublon échouerait (Clerk refuse
 * deux comptes sur la même adresse) et couperait le client de son historique.
 *
 * Ne lève jamais : un compte est un confort, il ne doit pas faire échouer une
 * vente déjà payée. Le motif d'échec est renvoyé pour être journalisé.
 */
export async function ensureClerkCustomer(
  secret: string,
  customer: {
    email: string;
    firstName: string;
    lastName: string;
    signupPath: string;
  },
): Promise<{ clerkId: string | null; reused: boolean; warning?: string }> {
  try {
    const existing = await fetchAllClerkUsers(secret, { query: customer.email });
    const match = existing.find((user) => clerkPrimaryEmail(user) === customer.email);
    if (match && typeof match.id === "string") {
      return { clerkId: match.id, reused: true };
    }

    const response = await fetch("https://api.clerk.com/v1/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email_address: [customer.email],
        first_name: customer.firstName,
        last_name: customer.lastName,
        skip_password_requirement: true,
        skip_password_checks: true,
        unsafe_metadata: {
          signupApp: "recycapp",
          signupPath: customer.signupPath,
        },
      }),
    });
    const payload = (await response.json()) as {
      id?: string;
      errors?: Array<{ message?: string; long_message?: string }>;
    };
    if (!response.ok || !payload.id) {
      return {
        clerkId: null,
        reused: false,
        warning:
          payload.errors?.[0]?.long_message ||
          payload.errors?.[0]?.message ||
          `Clerk a répondu ${response.status}.`,
      };
    }
    return { clerkId: payload.id, reused: false };
  } catch (error) {
    return {
      clerkId: null,
      reused: false,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Crée (ou retrouve) le compte client et l'enregistre côté CRM.
 *
 * Si l'adresse est déjà connue de Clerk, on RÉUTILISE le compte : créer un
 * doublon échouerait de toute façon (Clerk refuse deux comptes sur la même
 * adresse) et couperait le client de son historique.
 */
export const createCustomerAccount = action({
  args: {
    firstName: v.string(),
    lastName: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    clerkId: string | null;
    email: string;
    firstName: string;
    lastName: string;
    reused: boolean;
    warning?: string;
  }> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (!accessAllows(access, "caisse", "checkout")) {
      throw new ConvexError("Accès CRM insuffisant.");
    }

    const email = args.email.trim().toLowerCase();
    const firstName = args.firstName.trim();
    const lastName = args.lastName.trim();
    const phone = args.phone?.trim() ?? "";
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw new ConvexError("Adresse email invalide.");
    }
    if (!firstName || !lastName) {
      throw new ConvexError("Le prénom et le nom sont requis.");
    }

    const secret = process.env.CLERK_SECRET_KEY;
    let clerkId: string | null = null;
    let reused = false;
    let warning: string | undefined;

    if (!secret) {
      // Sans clé Clerk, la vente doit quand même pouvoir se faire : le client
      // est enregistré côté CRM, simplement sans compte pour se connecter.
      warning =
        "Compte client non créé : CLERK_SECRET_KEY n'est pas configurée côté Convex.";
    } else {
      try {
        const existing = await fetchAllClerkUsers(secret, { query: email });
        const match = existing.find(
          (user) => clerkPrimaryEmail(user) === email,
        );
        if (match && typeof match.id === "string") {
          clerkId = match.id;
          reused = true;
        } else {
          const response = await fetch("https://api.clerk.com/v1/users", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${secret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              email_address: [email],
              first_name: firstName,
              last_name: lastName,
              // Le client n'a choisi aucun mot de passe : Clerk doit accepter
              // le compte sans, il en définira un s'il se connecte un jour.
              skip_password_requirement: true,
              skip_password_checks: true,
              unsafe_metadata: { signupApp: "recycapp", signupPath: "/crm/caisse" },
            }),
          });
          const payload = (await response.json()) as {
            id?: string;
            errors?: Array<{ message?: string; long_message?: string }>;
          };
          if (!response.ok || !payload.id) {
            const message =
              payload.errors?.[0]?.long_message ||
              payload.errors?.[0]?.message ||
              `Clerk a répondu ${response.status}.`;
            // La vente prime sur le compte : on n'interrompt pas l'encaissement.
            warning = `Compte client non créé : ${message}`;
          } else {
            clerkId = payload.id;
          }
        }
      } catch (error) {
        warning = `Compte client non créé : ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }

    await ctx.runMutation(internal.crmClients.recordCrmCustomer, {
      firstName,
      lastName,
      email,
      phone,
      clerkId: clerkId ?? undefined,
    });

    return { clerkId, email, firstName, lastName, reused, warning };
  },
});

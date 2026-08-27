import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import type { UserIdentity } from "convex/server";

/**
 * Met en forme un nom/prénom : première lettre de chaque mot en majuscule,
 * le reste en minuscules. Gère les composés ("jean-pierre" → "Jean-Pierre",
 * "marie dupont" → "Marie Dupont", "DE LA TOUR" → "De La Tour").
 */
export function titleCaseName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("fr-FR")
    .replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) =>
      sep + ch.toLocaleUpperCase("fr-FR"),
    );
}

/** Nom à afficher pour une identité Clerk, homogène dans toutes les apps. */
export function formatUserName(
  identity: { name?: string | null; givenName?: string | null; familyName?: string | null; email?: string | null },
  fallback = "Utilisateur",
): string {
  const fullName = [identity.givenName, identity.familyName].filter(Boolean).join(" ").trim();
  const value = fullName || identity.name?.trim();
  return value ? titleCaseName(value) : identity.email?.trim() || fallback;
}

/** Normalise une adresse email pour comparaison/rattachement (trim + minuscules). */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Normalise les prénom/nom et l'email d'un objet client. L'email est normalisé
 * (trim + minuscules) pour que le rattachement des demandes par email à
 * l'inscription fonctionne de façon fiable, y compris pour les demandes créées
 * en interne par un membre de l'équipe.
 */
export function normalizeCustomer<T extends { firstName: string; lastName: string }>(
  customer: T,
): T {
  const email = (customer as { email?: unknown }).email;
  return {
    ...customer,
    firstName: titleCaseName(customer.firstName),
    lastName: titleCaseName(customer.lastName),
    ...(typeof email === "string" ? { email: normalizeEmail(email) } : {}),
  };
}

/** Formate un nom complet client de manière homogène. */
export function customerFullName(customer: {
  firstName?: string;
  lastName?: string;
}): string {
  return [customer.firstName, customer.lastName]
    .filter(Boolean)
    .map((part) => titleCaseName(part!))
    .join(" ")
    .trim();
}

/** Toute identité Clerk authentifiée (client ou staff). */
export async function requireUser(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Non authentifié.");
  }
  return identity;
}

function allowedEmailsFromEnv(name: string) {
  return String(process.env[name] ?? "")
    .split(",")
    .map((entry: string) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function hasDb(ctx: QueryCtx | MutationCtx | ActionCtx): ctx is QueryCtx | MutationCtx {
  return "db" in ctx;
}

async function getActiveCrmPermissionRecord(
  ctx: QueryCtx | MutationCtx,
  email: string,
) {
  const record = await ctx.db
    .query("crmPermissions")
    .withIndex("by_email", (q) => q.eq("email", email))
    .unique();
  return record?.active ? record : null;
}

/**
 * Amorçage « break-glass » du staff. Les rôles et droits réels sont gérés
 * **côté Convex** (table `crmPermissions`, champ `role` + `grants`). Cette
 * allowlist d'environnement (STAFF_EMAILS) sert uniquement à éviter qu'on soit
 * verrouillé hors du CRM avant qu'un premier admin ne soit défini en base.
 */
export function isStaffIdentity(identity: UserIdentity): boolean {
  if (isAdminIdentity(identity)) return true;
  const allow = allowedEmailsFromEnv("STAFF_EMAILS");
  const email = identity.email?.toLowerCase();
  return Boolean(email && allow.includes(email));
}

/**
 * Amorçage « break-glass » de l'admin via ADMIN_EMAILS. Le rôle admin nominal
 * est porté par la table `crmPermissions` (`role === "admin"`) côté Convex.
 */
export function isAdminIdentity(identity: UserIdentity): boolean {
  const allow = allowedEmailsFromEnv("ADMIN_EMAILS");
  const email = identity.email?.toLowerCase();
  return Boolean(email && allow.includes(email));
}

/** Vérifie un accès *staff* (rôle/grants Convex, repli env hors db). */
export async function requireStaff(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const identity = await requireUser(ctx);
  if (hasDb(ctx)) {
    const access = await getCrmAccessForIdentity(ctx, identity);
    if (access.staff) return identity;
    throw new Error("Accès réservé au personnel.");
  }
  // Contexte action (sans db) : repli sur l'allowlist d'amorçage.
  if (isStaffIdentity(identity)) return identity;
  throw new Error("Accès réservé au personnel.");
}

/** Vérifie un accès *admin* (rôle Convex, repli env hors db). */
export async function requireAdmin(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const identity = await requireUser(ctx);
  if (hasDb(ctx)) {
    const access = await getCrmAccessForIdentity(ctx, identity);
    if (access.admin) return identity;
    throw new Error("Accès réservé aux administrateurs.");
  }
  if (isAdminIdentity(identity)) return identity;
  throw new Error("Accès réservé aux administrateurs.");
}

/**
 * Accès à l'application Pointeuse (données RH sensibles) : réservé aux admins et
 * aux utilisateurs disposant d'au moins un droit « pointeuse: » attribué depuis
 * la page Admin. Ne suffit pas d'être « staff ».
 */
export async function requirePointeuseAccess(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const identity = await requireUser(ctx);
  if (hasDb(ctx)) {
    const access = await getCrmAccessForIdentity(ctx, identity);
    if (access.admin) return identity;
    if (access.grants.some((grant) => grant.pageKey.startsWith("pointeuse:"))) return identity;
    throw new Error("Accès à la Pointeuse non autorisé.");
  }
  if (isAdminIdentity(identity)) return identity;
  throw new Error("Accès à la Pointeuse non autorisé.");
}

export type CrmPermissionAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "manage"
  | "reply"
  | "share"
  | "checkout"
  | "print"
  | "analyze"
  | "start";

export async function getCrmAccessForIdentity(
  ctx: QueryCtx | MutationCtx,
  identity: UserIdentity,
) {
  const email = identity.email?.trim().toLowerCase() ?? null;
  const record = email ? await getActiveCrmPermissionRecord(ctx, email) : null;

  // Source de vérité : la table Convex `crmPermissions`. L'allowlist
  // d'environnement ne sert que d'amorçage tant qu'aucun admin n'existe en base.
  const admin = isAdminIdentity(identity) || record?.role === "admin";
  if (admin) {
    return { staff: true, admin: true, email, bootstrapMode: false, grants: [] };
  }

  const staff =
    isStaffIdentity(identity) ||
    Boolean(record && (record.role === "staff" || record.grants.length > 0));
  if (!staff) {
    return { staff: false, admin: false, email, bootstrapMode: false, grants: [] };
  }

  return {
    staff: true,
    admin: false,
    email,
    bootstrapMode: false,
    grants: record?.grants ?? [],
  };
}

export async function hasCrmPermission(
  ctx: QueryCtx | MutationCtx,
  pageKey: string,
  action: CrmPermissionAction = "read",
) {
  const identity = await requireUser(ctx);
  const access = await getCrmAccessForIdentity(ctx, identity);
  if (access.admin || access.bootstrapMode) return true;
  if (!access.staff) return false;
  const grant = access.grants.find((entry) => entry.pageKey === pageKey);
  return Boolean(grant?.actions.includes(action));
}

export async function requireCrmPermission(
  ctx: QueryCtx | MutationCtx,
  pageKey: string,
  action: CrmPermissionAction = "read",
) {
  const allowed = await hasCrmPermission(ctx, pageKey, action);
  if (!allowed) {
    throw new Error("Accès CRM insuffisant.");
  }
}

/**
 * Une réservation « pour un collègue » concerne deux personnes : `clerkId`, qui
 * l'a créée, et `bookedForClerkId`, le bénéficiaire. Les deux doivent pouvoir
 * l'annuler et faire son retour — celui qui réserve reste responsable du
 * créneau qu'il a posé.
 */
export function isReservationParticipant(
  reservation: { clerkId: string; bookedForClerkId?: string },
  clerkId: string,
): boolean {
  return reservation.clerkId === clerkId || reservation.bookedForClerkId === clerkId;
}

/**
 * Vérification pure (sans ctx) à partir d'un objet d'accès — utile dans les
 * actions, qui n'ont pas accès à la base et passent par `permissions.myAccess`.
 */
export function accessAllows(
  access: {
    isAdmin?: boolean;
    bootstrapMode?: boolean;
    grants: Array<{ pageKey: string; actions: string[] }>;
  },
  pageKey: string,
  action: CrmPermissionAction = "read",
) {
  if (access.isAdmin || access.bootstrapMode) return true;
  return Boolean(
    access.grants.find((grant) => grant.pageKey === pageKey)?.actions.includes(action),
  );
}

/** Autorise si l'utilisateur détient au moins une des permissions listées. */
export async function requireAnyCrmPermission(
  ctx: QueryCtx | MutationCtx,
  checks: Array<[string, CrmPermissionAction]>,
) {
  for (const [pageKey, action] of checks) {
    if (await hasCrmPermission(ctx, pageKey, action)) return;
  }
  throw new Error("Accès CRM insuffisant.");
}

/**
 * Accès à une ressource rattachée à une demande (messagerie, documents…) :
 * autorisé si l'utilisateur a la permission CRM requise (= staff habilité)
 * OU s'il est le client propriétaire de la demande. Sinon, refus.
 */
export async function requireRequestParticipant(
  ctx: QueryCtx | MutationCtx,
  requestId: import("./_generated/dataModel").Id<"requests">,
  pageKey: string,
  action: CrmPermissionAction = "read",
) {
  const identity = await requireUser(ctx);
  const request = await ctx.db.get(requestId);
  if (!request) throw new Error("Demande introuvable.");
  const staff = await hasCrmPermission(ctx, pageKey, action);
  if (staff) return { identity, request, staff: true as const };
  if (request.userId && request.userId === identity.subject) {
    return { identity, request, staff: false as const };
  }
  throw new Error("Accès refusé à cette demande.");
}

/** Adresse email associée à un compte Clerk (renseignée à la connexion). */
export async function emailForClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkId: string | undefined,
): Promise<string | null> {
  if (!clerkId) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
    .unique();
  return user?.email ?? null;
}

/** Photo de profil (URL Clerk) enregistrée pour un utilisateur, ou `null`. */
export async function photoForClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkId: string | undefined,
): Promise<string | null> {
  if (!clerkId) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
    .unique();
  return user?.imageUrl ?? null;
}

/**
 * Photos de profil **vivantes** pour un lot de comptes, par `clerkId`.
 *
 * Les tables (posts, commentaires, likes, retours…) figent `authorImageUrl` au
 * moment de l'écriture. Sans résolution à la lecture, changer sa photo de
 * profil laisse l'ancienne sur tout l'historique. `users.imageUrl` est, lui,
 * remis à jour à chaque connexion (`users.syncProfile`) : c'est la source de
 * vérité.
 *
 * Une seule lecture par compte distinct, quel que soit le nombre de lignes à
 * décorer — d'où le lot plutôt qu'un appel par ligne.
 */
export async function livePhotosByClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = Array.from(
    new Set(clerkIds.filter((id): id is string => Boolean(id))),
  );
  const photos = new Map<string, string>();
  await Promise.all(
    unique.map(async (clerkId) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
        .unique();
      if (user?.imageUrl) photos.set(clerkId, user.imageUrl);
    }),
  );
  return photos;
}

/**
 * Photo à afficher : celle du profil si le compte existe encore, sinon le
 * snapshot figé à l'écriture (auteurs jamais connectés, imports historiques).
 */
export function livePhoto(
  photos: Map<string, string>,
  clerkId: string | null | undefined,
  fallback: string | undefined,
): string | undefined {
  return (clerkId ? photos.get(clerkId) : undefined) ?? fallback;
}

/** Compte Clerk associé à une adresse email (renseignée à la connexion). */
export async function clerkIdForEmail(
  ctx: QueryCtx | MutationCtx,
  email: string,
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", normalized))
    .first();
  return user?.clerkId ?? null;
}

type AerogommageItemInput = {
  objectType?: string;
  label?: string;
  height?: number;
  width?: number;
  depth?: number;
  quantity?: number;
  woodType?: string;
  stripping?: string;
  coating?: string;
  coatingOther?: string;
  delivery?: boolean;
  retrieval?: boolean;
  comment?: string;
};

type CollecteInput = {
  dismountable?: boolean;
  reusableGoodCondition?: boolean;
  sorted?: boolean;
  noWaste?: boolean;
  objectCategories?: string[];
  grosObjets?: string[];
  grosObjetsAutre?: string;
  petitsObjets?: string[];
  petitsObjetsAutre?: string;
  housingType?: string;
  floors?: number;
  dedicatedParking?: boolean;
  parkingDistance?: number;
  parkingUnknown?: boolean;
  largeItems?: string;
  furniture?: string;
  smallItems?: string;
  collectAddress?: {
    address?: string;
    postalCode?: string;
    city?: string;
  };
};

type CustomerInput = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address?: string;
  postalCode?: string;
  city?: string;
};

function customerComplete(c: CustomerInput): boolean {
  return Boolean(
    c.firstName?.trim() &&
      c.lastName?.trim() &&
      c.email?.trim() &&
      c.phone?.trim(),
  );
}

/**
 * Une demande est « complète » quand le client a renseigné tous les champs
 * requis selon son type. Calculé côté serveur au moment de l'envoi.
 */
export function isAerogommageComplete(
  customer: CustomerInput,
  items: AerogommageItemInput[],
): boolean {
  if (!customerComplete(customer)) return false;
  if (items.length === 0) return false;
  return items.every(
    (d) =>
      Boolean(d.objectType?.trim()) &&
      typeof d.height === "number" &&
      typeof d.width === "number" &&
      typeof d.depth === "number" &&
      Boolean(d.woodType?.trim()) &&
      Boolean(d.stripping?.trim()) &&
      Boolean(d.coating?.trim()),
  );
}

export function isCollecteComplete(
  customer: CustomerInput,
  d: CollecteInput,
): boolean {
  const hasItems = Boolean(
    (d.objectCategories && d.objectCategories.length > 0) ||
      (d.grosObjets && d.grosObjets.length > 0) ||
      (d.petitsObjets && d.petitsObjets.length > 0) ||
      d.grosObjetsAutre?.trim() ||
      d.petitsObjetsAutre?.trim() ||
      // compat anciennes demandes
      d.largeItems?.trim() ||
      d.furniture?.trim() ||
      d.smallItems?.trim(),
  );
  const ca = d.collectAddress;
  const hasCollectAddress = Boolean(
    ca?.address?.trim() && ca?.postalCode?.trim() && ca?.city?.trim(),
  );
  return (
    customerComplete(customer) &&
    Boolean(customer.address?.trim()) &&
    Boolean(customer.postalCode?.trim()) &&
    Boolean(customer.city?.trim()) &&
    hasCollectAddress &&
    hasItems
  );
}

export function isArticleComplete(customer: CustomerInput): boolean {
  return customerComplete(customer);
}

type VeloInput = {
  bikeType?: string;
  service?: string;
  brand?: string;
  condition?: string;
  description?: string;
};

export function isVeloComplete(customer: CustomerInput, d: VeloInput): boolean {
  return (
    customerComplete(customer) &&
    Boolean(d.bikeType?.trim()) &&
    Boolean(d.service?.trim())
  );
}

type LivraisonInput = {
  deliveryAddress?: {
    address?: string;
    postalCode?: string;
    city?: string;
  };
  articlePhoto?: string;
};

export function isLivraisonComplete(
  customer: CustomerInput,
  d: LivraisonInput,
): boolean {
  const da = d.deliveryAddress;
  const hasDeliveryAddress = Boolean(
    da?.address?.trim() && da?.postalCode?.trim() && da?.city?.trim(),
  );
  return (
    customerComplete(customer) && hasDeliveryAddress && Boolean(d.articlePhoto)
  );
}

/** Utilisateur tel que renvoyé par l'API Backend Clerk (`GET /v1/users`). */
export type ClerkApiUser = {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  image_url?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{ id?: string; email_address?: string }>;
  public_metadata?: unknown;
  created_at?: number | null;
  last_sign_in_at?: number | null;
};

/** Domaine des comptes internes (équipe) — seuls comptes « réservables pour ». */
export const INTERNAL_EMAIL_DOMAIN = "@eco-solidaire.fr";

/**
 * Réponses Clerk servies en HTTP/2 sans `content-length` : au-delà d'environ
 * 32 Ko, le corps nous parvient tronqué et `JSON.parse` échoue
 * ("Unterminated string in JSON at position 32764"), ce qui vidait l'annuaire
 * « Réserver pour » et la liste des utilisateurs de l'admin. On pagine donc par
 * petits lots (~1,8 Ko par utilisateur, soit ~18 Ko par page) pour rester
 * largement sous cette limite.
 */
const CLERK_PAGE_SIZE = 10;
const CLERK_MAX_PAGES = 200;

/** Email principal (minuscules) d'un utilisateur Clerk. */
export function clerkPrimaryEmail(user: ClerkApiUser): string {
  const emails = Array.isArray(user.email_addresses) ? user.email_addresses : [];
  const primary =
    emails.find((entry) => entry.id === user.primary_email_address_id) ?? emails[0];
  return (primary?.email_address ?? "").trim().toLowerCase();
}

function parseClerkPage(body: string): ClerkApiUser[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(
      `Réponse Clerk illisible (${body.length} octets, JSON tronqué ou invalide).`,
    );
  }
  if (Array.isArray(payload)) return payload as ClerkApiUser[];
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? (data as ClerkApiUser[]) : [];
}

/**
 * Liste **tous** les utilisateurs de l'instance Clerk pointée par
 * `CLERK_SECRET_KEY` (clé PROD côté déploiement de production). Source de vérité
 * pour les annuaires : la table `users` Convex ne contient que les comptes ayant
 * déjà ouvert l'app et peut garder d'anciens comptes dev.
 *
 * Lève une erreur explicite si Clerk répond en erreur : les appelants doivent la
 * remonter plutôt que d'afficher une liste vide silencieuse.
 */
export async function fetchAllClerkUsers(
  secret: string,
  options: { query?: string } = {},
): Promise<ClerkApiUser[]> {
  const users: ClerkApiUser[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < CLERK_MAX_PAGES; page++) {
    const url = new URL("https://api.clerk.com/v1/users");
    url.searchParams.set("limit", String(CLERK_PAGE_SIZE));
    url.searchParams.set("offset", String(page * CLERK_PAGE_SIZE));
    url.searchParams.set("order_by", "last_name");
    if (options.query?.trim()) url.searchParams.set("query", options.query.trim());

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Clerk a répondu ${response.status} lors de la lecture des comptes.`);
    }
    const batch = parseClerkPage(await response.text());

    for (const user of batch) {
      const id = typeof user.id === "string" ? user.id : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      users.push(user);
    }
    if (batch.length < CLERK_PAGE_SIZE) break;
  }

  return users;
}

/**
 * Annuaire des collègues internes : comptes Clerk `@eco-solidaire.fr`, hors
 * soi-même, triés par nom. Utilisé par les listes « Réserver pour ».
 */
export async function fetchInternalClerkDirectory(
  secret: string,
  selfEmail: string,
): Promise<Array<{ clerkId: string; name: string; imageUrl: string | null }>> {
  const self = selfEmail.trim().toLowerCase();
  const directory: Array<{ clerkId: string; name: string; imageUrl: string | null }> = [];

  for (const user of await fetchAllClerkUsers(secret)) {
    const clerkId = typeof user.id === "string" ? user.id : "";
    if (!clerkId) continue;
    const email = clerkPrimaryEmail(user);
    if (!email.endsWith(INTERNAL_EMAIL_DOMAIN)) continue;
    if (self && email === self) continue;
    directory.push({
      clerkId,
      name: formatUserName({
        givenName: user.first_name,
        familyName: user.last_name,
        name: user.username,
        email,
      }),
      imageUrl: typeof user.image_url === "string" ? user.image_url : null,
    });
  }

  return directory.sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

/**
 * Entrée en vigueur du retour obligatoire.
 *
 * Les réservations terminées avant cette date n'ont jamais eu de retour à
 * faire. Les compter rétroactivement bloquerait d'un coup 7 personnes et
 * marquerait 11 véhicules « non rendus » dans les 3 apps qui planifient la
 * flotte, pour une règle qui n'existait pas au moment de l'emprunt. La règle
 * ne vaut donc que pour les emprunts qui se terminent après sa mise en service.
 */
export const MANDATORY_RETURN_SINCE = Date.parse("2026-07-20T00:00:00.000Z");

/**
 * Fin effective d'une réservation de véhicule, pour tout calcul de
 * disponibilité. Trois cas, dans cet ordre :
 *
 * 1. **Retour enregistré** → le véhicule est physiquement revenu : il est libre
 *    à partir de l'heure du retour. Le retour peut être saisi après coup, donc
 *    on ne rallonge jamais au-delà de la fin prévue (fin à 11 h, formulaire
 *    envoyé à 14 h ⇒ libre depuis 11 h).
 * 2. **Créneau terminé sans retour** → la personne a toujours le véhicule :
 *    l'occupation devient **ouverte** (`Infinity`) et le véhicule n'est
 *    réservable par personne, à aucune date, tant que le retour n'est pas
 *    enregistré (par l'emprunteur ou manuellement par un gestionnaire).
 * 3. **Créneau en cours ou à venir** → la fin prévue fait foi ; on peut
 *    réserver après, comme n'importe quelle réservation planifiée.
 *
 * Le cas 2 ne vaut que pour les emprunts soumis au retour obligatoire
 * (cf. `MANDATORY_RETURN_SINCE`) : sans ce garde-fou, de vieilles réservations
 * d'avant la règle immobiliseraient définitivement la flotte.
 *
 * ⚠️ Peut renvoyer `Infinity` : réservé aux comparaisons de chevauchement,
 * jamais à stocker ni à renvoyer tel quel à un frontend.
 *
 * Règle unique pour les 7 apps : Mes Outils, recycapp et cycleenbray planifient
 * les mêmes véhicules physiques.
 */
export function vehicleReservationBusyEnd(
  reservation: { start: number; end: number; feedbackSubmittedAt?: number },
  now: number,
) {
  if (typeof reservation.feedbackSubmittedAt === "number") {
    return Math.min(
      reservation.end,
      Math.max(reservation.start, reservation.feedbackSubmittedAt),
    );
  }
  if (reservation.end <= now && reservation.end >= MANDATORY_RETURN_SINCE) {
    return Number.POSITIVE_INFINITY;
  }
  return reservation.end;
}

/** Réservation terminée dont le retour manque encore : véhicule non rendu. */
export function isVehicleReturnOverdue(
  reservation: { end: number; feedbackSubmittedAt?: number },
  now: number,
) {
  return (
    reservation.feedbackSubmittedAt === undefined &&
    reservation.end <= now &&
    reservation.end >= MANDATORY_RETURN_SINCE
  );
}

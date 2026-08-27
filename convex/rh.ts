import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  env,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  getCrmAccessForIdentity,
  requireCrmPermission,
  requireUser,
  titleCaseName,
} from "./lib";
import { bytesToBase64, type EmailAttachment } from "./emails";
import type { Doc, Id } from "./_generated/dataModel";

const RH_PAGE_KEY = "mesoutils:rh";
const CONTRACT_WEBHOOK_URL =
  "https://hook.eu2.make.com/huqlb8dif2n27j5bpnp5tycwniqrt1ow";

/** Structures dont les contrats générés sont notifiés par email à la direction. */
const CONTRACT_NOTICE_STRUCTURES = new Set(["MES", "LSDB"]);

/** Plafond de la pièce jointe (Resend refuse au-delà de ~40 Mo encodés). */
const MAX_CONTRACT_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const DOCUMENT_LABELS: Record<string, string> = {
  contrat_initial: "Contrat initial",
  avenant_prolong: "Avenant de prolongation",
};

const genderValidator = v.union(v.literal("Monsieur"), v.literal("Madame"));
const structureValidator = v.union(
  v.literal("Pays de Bray Services 60"),
  v.literal("Pays de Bray Services 76"),
  v.literal("Recyclerie 60"),
  v.literal("Recyclerie 76"),
  v.literal("Les Sens du Bray"),
  v.literal("Maison d'Economie Solidaire"),
  v.literal("Pays de Bray Emploi"),
);

const contractPayloadArgs = {
  employeeId: v.id("hrEmployees"),
  numero_contrat: v.string(),
  type_contrat: v.union(
    v.literal("CDDI"),
    v.literal("CDI-Inclusion"),
    v.literal("CDD-Pec"),
    v.literal("CDI"),
  ),
  type_document: v.union(
    v.literal("contrat_initial"),
    v.literal("avenant_prolong"),
  ),
  date_fin_contrat: v.string(),
  duree_contrat: v.string(),
  date_debut_contrat: v.string(),
  poste: v.string(),
  duree_periode_essai: v.optional(v.string()),
  date_debut_periode_essai: v.optional(v.string()),
  date_fin_periode_essai: v.optional(v.string()),
  remuneration_brute_horaire: v.string(),
  duree_mensuel_travail: v.string(),
  salaire_brut_mensuel: v.string(),
  PREMIER_CONTRAT: v.string(),
} as const;

function normalizeSocialSecurityNumber(value: string) {
  return value.replace(/\s+/g, "").trim();
}

function normalizeAddress(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeEmployeeInput(args: {
  firstName: string;
  lastName: string;
  gender: "Monsieur" | "Madame";
  address: string;
  structure:
    | "Pays de Bray Services 60"
    | "Pays de Bray Services 76"
    | "Recyclerie 60"
    | "Recyclerie 76"
    | "Les Sens du Bray"
    | "Maison d'Economie Solidaire"
    | "Pays de Bray Emploi";
  socialSecurityNumber: string;
  firstContractDate?: string;
}) {
  const firstName = titleCaseName(args.firstName);
  const lastName = titleCaseName(args.lastName);
  const address = normalizeAddress(args.address);
  const socialSecurityNumber = args.socialSecurityNumber.trim();
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    gender: args.gender,
    address,
    structure: args.structure,
    socialSecurityNumber,
    socialSecurityNumberNormalized: normalizeSocialSecurityNumber(socialSecurityNumber),
    firstContractDate: args.firstContractDate?.trim() || undefined,
  };
}

function structureFromLegacy(value: string) {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "recyclerie du pays de bray" ||
    normalized === "recyclerie60"
  ) {
    return "Recyclerie 60" as const;
  }
  if (normalized === "recyclerie 76" || normalized === "recyclerie76") {
    return "Recyclerie 76" as const;
  }
  if (normalized === "les sens du bray") {
    return "Les Sens du Bray" as const;
  }
  if (
    normalized === "maison d'economie solidaire" ||
    normalized === "maison d’economie solidaire" ||
    normalized === "mes"
  ) {
    return "Maison d'Economie Solidaire" as const;
  }
  if (normalized === "pays de bray emploi") {
    return "Pays de Bray Emploi" as const;
  }
  if (normalized === "pays de bray services 60") {
    return "Pays de Bray Services 60" as const;
  }
  if (normalized === "pays de bray services 76") {
    return "Pays de Bray Services 76" as const;
  }
  return null;
}

function structureForWebhook(
  structure: Doc<"hrEmployees">["structure"],
): "Recyclerie60" | "Recyclaide" | "Materiosol" | "LSDB" | "Recyclerie76" | "PBE" | "MES" {
  switch (structure) {
    case "Recyclerie 60":
      return "Recyclerie60";
    case "Pays de Bray Services 60":
      return "Recyclaide";
    case "Pays de Bray Services 76":
      return "Materiosol";
    case "Les Sens du Bray":
      return "LSDB";
    case "Recyclerie 76":
      return "Recyclerie76";
    case "Pays de Bray Emploi":
      return "PBE";
    case "Maison d'Economie Solidaire":
      return "MES";
  }
}

async function findEmployeeByIdentity(
  ctx: QueryCtx | MutationCtx,
  args: { socialSecurityNumberNormalized: string; firstName: string; lastName: string },
) {
  if (args.socialSecurityNumberNormalized) {
    const bySocial = await ctx.db
      .query("hrEmployees")
      .withIndex("by_socialSecurityNumberNormalized", (q) =>
        q.eq("socialSecurityNumberNormalized", args.socialSecurityNumberNormalized),
      )
      .collect();
    if (bySocial[0]) return bySocial[0];
  }
  return await ctx.db
    .query("hrEmployees")
    .withIndex("by_lastName_and_firstName", (q) =>
      q.eq("lastName", args.lastName).eq("firstName", args.firstName),
    )
    .first();
}

function contractPayloadFromEmployee(
  employee: Doc<"hrEmployees">,
  args: {
    employeeId: Id<"hrEmployees">;
    numero_contrat: string;
    type_contrat: "CDDI" | "CDI-Inclusion" | "CDD-Pec" | "CDI";
    type_document: "contrat_initial" | "avenant_prolong";
    date_fin_contrat: string;
    duree_contrat: string;
    date_debut_contrat: string;
    poste: string;
    duree_periode_essai?: string;
    date_debut_periode_essai?: string;
    date_fin_periode_essai?: string;
    remuneration_brute_horaire: string;
    duree_mensuel_travail: string;
    salaire_brut_mensuel: string;
    PREMIER_CONTRAT: string;
  },
) {
  return {
    genre_salarie: employee.gender,
    nom_prenom_salarie: employee.fullName,
    Nom_contrat: `${employee.lastName.replace(/\s+/g, "")}-${employee.firstName.replace(/\s+/g, "")}`,
    nom_contrat: `${employee.lastName.replace(/\s+/g, "")}-${employee.firstName.replace(/\s+/g, "")}-${args.type_document}-${todayInParis()}`,
    adresse_salarie: employee.address,
    num_sec_sociale: employee.socialSecurityNumber,
    structure: structureForWebhook(employee.structure),
    numero_contrat: args.numero_contrat.trim(),
    type_contrat: args.type_contrat,
    type_document: args.type_document,
    date_fin_contrat: args.date_fin_contrat.trim(),
    duree_contrat: args.duree_contrat.trim(),
    date_debut_contrat: args.date_debut_contrat.trim(),
    poste: args.poste.trim(),
    ...(args.duree_periode_essai?.trim()
      ? { duree_periode_essai: args.duree_periode_essai.trim() }
      : {}),
    ...(args.date_debut_periode_essai?.trim()
      ? { date_debut_periode_essai: args.date_debut_periode_essai.trim() }
      : {}),
    ...(args.date_fin_periode_essai?.trim()
      ? { date_fin_periode_essai: args.date_fin_periode_essai.trim() }
      : {}),
    remuneration_brute_horaire: args.remuneration_brute_horaire.trim(),
    duree_mensuel_travail: args.duree_mensuel_travail.trim(),
    salaire_brut_mensuel: args.salaire_brut_mensuel.trim(),
    PREMIER_CONTRAT:
      args.PREMIER_CONTRAT.trim() || employee.firstContractDate?.trim() || "",
  };
}

function todayInParis() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function sharePointUrlFromWebhookResponse(responseText: string) {
  const text = responseText.trim();
  const candidates = [text];
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    for (const key of ["url", "webUrl", "web_url", "link"]) {
      if (typeof body[key] === "string") candidates.push(body[key]);
    }
  } catch {
    // Le module Webhook response de Make renvoie généralement l'URL en texte brut.
  }

  return candidates.find((candidate) => {
    try {
      const url = new URL(candidate);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  }) ?? null;
}

/**
 * URL de téléchargement direct depuis le lien SharePoint renvoyé par Make.
 *
 * Make renvoie un lien de visualisation (`_layouts/15/Doc.aspx?sourcedoc=…`) :
 * `download.aspx` sur le même `sourcedoc` renvoie le fichier brut.
 */
function sharePointDownloadUrl(webUrl: string) {
  try {
    const url = new URL(webUrl);
    const sourcedoc = url.searchParams.get("sourcedoc");
    if (!sourcedoc) return null;
    const download = new URL(url.origin + url.pathname.replace(/Doc\.aspx$/i, "download.aspx"));
    download.searchParams.set("sourcedoc", sourcedoc);
    return download.toString();
  } catch {
    return null;
  }
}

/** Nom de fichier porté par le lien SharePoint, sinon un nom construit. */
function contractFileName(webUrl: string, fallback: string) {
  try {
    const fromUrl = new URL(webUrl).searchParams.get("file")?.trim();
    if (fromUrl) return fromUrl;
  } catch {
    // Lien inattendu : on retombe sur le nom construit.
  }
  return `${fallback}.docx`;
}

/**
 * Télécharge le contrat pour le joindre à l'email.
 *
 * Renvoie `null` (sans lever) si le document n'est pas accessible sans session
 * SharePoint : l'email doit partir malgré tout, et surtout la génération du
 * contrat ne doit pas échouer pour un problème de notification.
 */
async function fetchContractAttachment(
  webUrl: string,
  fallbackName: string,
): Promise<EmailAttachment | null> {
  const downloadUrl = sharePointDownloadUrl(webUrl);
  if (!downloadUrl) return null;
  try {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      console.warn(`Téléchargement du contrat refusé (${response.status}).`);
      return null;
    }
    // Une page de connexion SharePoint répond 200 avec du HTML : ce n'est pas
    // le document, il ne faut pas l'envoyer en pièce jointe.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      console.warn("Téléchargement du contrat : réponse HTML (session requise).");
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_CONTRACT_ATTACHMENT_BYTES) {
      console.warn(`Contrat non joint : taille inattendue (${bytes.length} octets).`);
      return null;
    }
    return {
      filename: contractFileName(webUrl, fallbackName),
      content: bytesToBase64(bytes),
    };
  } catch (error) {
    console.warn("Téléchargement du contrat impossible :", error);
    return null;
  }
}

export const listEmployees = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, RH_PAGE_KEY, "read");
    const employees = await ctx.db.query("hrEmployees").withIndex("by_fullName").collect();
    return employees.sort((a, b) => a.fullName.localeCompare(b.fullName, "fr"));
  },
});

export const listContracts = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, RH_PAGE_KEY, "read");
    const contracts = await ctx.db
      .query("hrContracts")
      .withIndex("by_requestedAt")
      .order("desc")
      .take(100);

    const employees = new Map<string, Doc<"hrEmployees">>();
    for (const contract of contracts) {
      if (!employees.has(contract.employeeId)) {
        const employee = await ctx.db.get(contract.employeeId);
        if (employee) employees.set(contract.employeeId, employee);
      }
    }

    return contracts.map((contract) => ({
      ...contract,
      employeeName: employees.get(contract.employeeId)?.fullName ?? contract.payload.nom_prenom_salarie,
    }));
  },
});

export const upsertEmployee = mutation({
  args: {
    employeeId: v.optional(v.id("hrEmployees")),
    firstName: v.string(),
    lastName: v.string(),
    socialSecurityNumber: v.string(),
    gender: genderValidator,
    address: v.string(),
    structure: structureValidator,
    firstContractDate: v.optional(v.string()),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const action = args.employeeId ? "update" : "create";
    await requireCrmPermission(ctx, RH_PAGE_KEY, action);
    const identity = await requireUser(ctx);
    const normalized = normalizeEmployeeInput(args);
    const now = Date.now();

    if (args.employeeId) {
      await ctx.db.patch(args.employeeId, {
        ...normalized,
        active: args.active ?? true,
        updatedAt: now,
        updatedBy: identity.email ?? identity.subject,
      });
      return args.employeeId;
    }

    const existing = await findEmployeeByIdentity(ctx, normalized);
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...normalized,
        active: args.active ?? existing.active,
        updatedAt: now,
        updatedBy: identity.email ?? identity.subject,
      });
      return existing._id;
    }

    return await ctx.db.insert("hrEmployees", {
      ...normalized,
      active: args.active ?? true,
      createdAt: now,
      updatedAt: now,
      createdBy: identity.email ?? identity.subject,
      updatedBy: identity.email ?? identity.subject,
    });
  },
});

export const importEmployees = mutation({
  args: {
    employees: v.array(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        socialSecurityNumber: v.string(),
        gender: genderValidator,
        address: v.string(),
        structure: structureValidator,
        firstContractDate: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, RH_PAGE_KEY, "manage");
    const identity = await requireUser(ctx);
    let created = 0;
    let updated = 0;

    for (const employee of args.employees) {
      const normalized = normalizeEmployeeInput(employee);
      const existing = await findEmployeeByIdentity(ctx, normalized);
      const patch = {
        ...normalized,
        active: true,
        importedFrom: "T Salariés Grid 4.csv",
        updatedAt: Date.now(),
        updatedBy: identity.email ?? identity.subject,
      };
      if (existing) {
        await ctx.db.patch(existing._id, patch);
        updated += 1;
      } else {
        await ctx.db.insert("hrEmployees", {
          ...patch,
          createdAt: Date.now(),
          createdBy: identity.email ?? identity.subject,
        });
        created += 1;
      }
    }

    return { created, updated, total: args.employees.length };
  },
});

export const canUseRh = internalQuery({
  args: {
    action: v.union(
      v.literal("read"),
      v.literal("create"),
      v.literal("update"),
      v.literal("manage"),
    ),
  },
  handler: async (ctx, { action }) => {
    const identity = await requireUser(ctx);
    const access = await getCrmAccessForIdentity(ctx, identity);
    if (
      !access.admin &&
      !access.bootstrapMode &&
      !access.grants.find((grant) => grant.pageKey === RH_PAGE_KEY)?.actions.includes(action)
    ) {
      throw new Error("Accès RH insuffisant.");
    }
    return identity.email ?? identity.subject;
  },
});

export const getEmployeeForContract = internalQuery({
  args: { employeeId: v.id("hrEmployees") },
  handler: async (ctx, { employeeId }) => {
    const employee = await ctx.db.get(employeeId);
    if (!employee) throw new Error("Salarié introuvable.");
    return employee;
  },
});

export const recordContractWebhook = internalMutation({
  args: {
    employeeId: v.id("hrEmployees"),
      payload: v.object({
        genre_salarie: v.string(),
        nom_prenom_salarie: v.string(),
        Nom_contrat: v.string(),
        nom_contrat: v.string(),
        adresse_salarie: v.string(),
        num_sec_sociale: v.string(),
        structure: v.string(),
        numero_contrat: v.string(),
        type_contrat: v.string(),
        type_document: v.string(),
        date_fin_contrat: v.string(),
        duree_contrat: v.string(),
        date_debut_contrat: v.string(),
      poste: v.string(),
      duree_periode_essai: v.optional(v.string()),
      date_debut_periode_essai: v.optional(v.string()),
      date_fin_periode_essai: v.optional(v.string()),
      remuneration_brute_horaire: v.string(),
      duree_mensuel_travail: v.string(),
      salaire_brut_mensuel: v.string(),
      PREMIER_CONTRAT: v.string(),
    }),
    requestedBy: v.string(),
    webhookStatus: v.union(v.literal("success"), v.literal("error")),
    webhookResponseCode: v.optional(v.number()),
    webhookResponseBody: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("hrContracts", {
      employeeId: args.employeeId,
      payload: args.payload,
      webhookUrl: CONTRACT_WEBHOOK_URL,
      webhookStatus: args.webhookStatus,
      webhookResponseCode: args.webhookResponseCode,
      webhookResponseBody: args.webhookResponseBody,
      requestedAt: Date.now(),
      requestedBy: args.requestedBy,
    });
  },
});

export const generateContract = action({
  args: contractPayloadArgs,
  handler: async (ctx, args) => {
    const requestedBy = await ctx.runQuery(internal.rh.canUseRh, { action: "create" });
    const employee = await ctx.runQuery(internal.rh.getEmployeeForContract, {
      employeeId: args.employeeId,
    });

    const payload = contractPayloadFromEmployee(employee, args);
    const response = await fetch(CONTRACT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const responseText = await response.text();

    await ctx.runMutation(internal.rh.recordContractWebhook, {
      employeeId: args.employeeId,
      payload,
      requestedBy,
      webhookStatus: response.ok ? "success" : "error",
      webhookResponseCode: response.status,
      webhookResponseBody: responseText.slice(0, 2000) || undefined,
    });

    if (!response.ok) {
      throw new Error(`Webhook Make en échec (${response.status}).`);
    }

    const contractUrl = sharePointUrlFromWebhookResponse(responseText);

    // Les structures MES et LSDB n'ont pas de RH sur place : la direction reçoit
    // le contrat par email dès qu'il est généré. Une notification en échec ne
    // doit jamais faire échouer la génération elle-même.
    if (CONTRACT_NOTICE_STRUCTURES.has(payload.structure)) {
      try {
        const attachment = contractUrl
          ? await fetchContractAttachment(contractUrl, payload.nom_contrat)
          : null;
        await ctx.runAction(internal.mesoutilsEmails.sendContractGeneratedEmail, {
          employeeName: payload.nom_prenom_salarie,
          structureLabel: employee.structure,
          documentLabel: DOCUMENT_LABELS[payload.type_document] ?? "Contrat",
          contractType: payload.type_contrat,
          numeroContrat: payload.numero_contrat,
          poste: payload.poste,
          dateDebut: payload.date_debut_contrat,
          dateFin: payload.date_fin_contrat,
          requestedBy,
          contractUrl: contractUrl ?? undefined,
          attachment: attachment ?? undefined,
        });
      } catch (error) {
        console.error("Notification du contrat par email impossible :", error);
      }
    }

    return { ok: true, contractUrl };
  },
});

export const searchAddresses = action({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    await ctx.runQuery(internal.rh.canUseRh, { action: "read" });
    const trimmed = query.trim();
    if (trimmed.length < 3) return [];
    if (!env.MAPBOX_ACCESS_TOKEN) return [];

    const url = new URL("https://api.mapbox.com/search/geocode/v6/forward");
    url.searchParams.set("q", trimmed);
    url.searchParams.set("access_token", env.MAPBOX_ACCESS_TOKEN);
    url.searchParams.set("autocomplete", "true");
    url.searchParams.set("country", "FR");
    url.searchParams.set("language", "fr");
    url.searchParams.set("limit", "5");

    const response = await fetch(url.toString());
    if (!response.ok) return [];

    const payload = (await response.json()) as {
      features?: Array<{
        properties?: { full_address?: string };
        place_formatted?: string;
        name?: string;
      }>;
    };

    return (payload.features ?? [])
      .map((feature) =>
        feature.properties?.full_address ??
        [feature.name, feature.place_formatted].filter(Boolean).join(", "),
      )
      .filter((value): value is string => Boolean(value?.trim()));
  },
});

export const importEmployeesFromLegacyCsv = mutation({
  args: {
    rows: v.array(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        socialSecurityNumber: v.string(),
        genderLabel: v.string(),
        address: v.string(),
        structureLabel: v.string(),
        firstContractDate: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    await requireCrmPermission(ctx, RH_PAGE_KEY, "manage");
    const employees = rows
      .map((row) => {
        const structure = structureFromLegacy(row.structureLabel);
        if (!structure) return null;
        if (!row.firstName.trim() || !row.lastName.trim()) return null;
        return {
          firstName: row.firstName,
          lastName: row.lastName,
          socialSecurityNumber: row.socialSecurityNumber,
          gender:
            (row.genderLabel.trim().toLowerCase() === "madame"
              ? "Madame"
              : "Monsieur") as "Monsieur" | "Madame",
          address: row.address.trim(),
          structure,
          firstContractDate: row.firstContractDate?.trim() || undefined,
        };
      })
      .filter((employee): employee is NonNullable<typeof employee> => Boolean(employee));

    let created = 0;
    let updated = 0;
    for (const employee of employees) {
      const normalized = normalizeEmployeeInput(employee);
      const existing = await findEmployeeByIdentity(ctx, normalized);
      const now = Date.now();
      if (existing) {
        await ctx.db.patch(existing._id, {
          ...normalized,
          active: true,
          importedFrom: "T Salariés Grid 4.csv",
          updatedAt: now,
        });
        updated += 1;
      } else {
        await ctx.db.insert("hrEmployees", {
          ...normalized,
          active: true,
          importedFrom: "T Salariés Grid 4.csv",
          createdAt: now,
          updatedAt: now,
        });
        created += 1;
      }
    }
    return { created, updated, total: employees.length };
  },
});

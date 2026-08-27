import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { formatUserName, requireCrmPermission, requireStaff, requireUser } from "./lib";

/**
 * Agents polyvalents (Recyclerie) — gestion des ouvriers polyvalents.
 *
 * Trois entités : les tâches (catalogue), les ouvriers (nom/prénom) et les
 * activités qui affectent un ouvrier à une tâche sur un créneau daté. Le tout
 * partage la même clé de permission `agents-polyvalents`.
 */
const PAGE_KEY = "agents-polyvalents";

/* ─── Tâches ──────────────────────────────────────────────────────────────── */

export const listTasks = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    return await ctx.db.query("polyvalentTasks").order("desc").collect();
  },
});

const taskSite = v.union(v.literal("60"), v.literal("76"));

/** Nom, site de traitement et main d'œuvre requise : la fiche d'une tâche. */
function taskProfile(args: { name: string; site?: "60" | "76"; requiredMonthlyHours?: number }) {
  const name = args.name.trim();
  if (!name) throw new Error("Le nom de la tâche est requis.");
  const hours = args.requiredMonthlyHours;
  if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0)) {
    throw new Error("Les heures requises doivent être un nombre positif.");
  }
  return { name, site: args.site, requiredMonthlyHours: hours };
}

export const createTask = mutation({
  args: {
    name: v.string(),
    site: v.optional(taskSite),
    requiredMonthlyHours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    return await ctx.db.insert("polyvalentTasks", {
      ...taskProfile(args),
      createdBy: formatUserName(identity),
      createdAt: Date.now(),
    });
  },
});

export const updateTask = mutation({
  args: {
    id: v.id("polyvalentTasks"),
    name: v.string(),
    site: v.optional(taskSite),
    requiredMonthlyHours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "update");
    await ctx.db.patch(args.id, taskProfile(args));
  },
});

export const deleteTask = mutation({
  args: { id: v.id("polyvalentTasks") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "delete");
    // On retire aussi les activités liées : une tâche supprimée ne doit pas
    // laisser d'affectations orphelines dans le planning.
    const activities = await ctx.db
      .query("polyvalentActivities")
      .withIndex("by_task", (q) => q.eq("taskId", args.id))
      .collect();
    const recurrences = await ctx.db
      .query("polyvalentTaskRecurrences")
      .withIndex("by_task", (q) => q.eq("taskId", args.id))
      .collect();
    await Promise.all(activities.map((activity) => ctx.db.delete(activity._id)));
    await Promise.all(recurrences.map((recurrence) => ctx.db.delete(recurrence._id)));
    await ctx.db.delete(args.id);
  },
});

/* ─── Ouvriers ────────────────────────────────────────────────────────────── */

export const listWorkers = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const workers = await ctx.db.query("polyvalentWorkers").take(1000);
    return workers.sort((a, b) =>
      `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`, "fr"),
    );
  },
});

/**
 * Reprise unique de l'ancienne équipe (`teamMembers`, « agents permanents ») :
 * rattache les demandes attribuées aux agents du planning portant les mêmes
 * nom et prénom, et complète leur fiche (email, recycleries, type de contrat).
 */
async function migrateLegacyTeam(ctx: MutationCtx) {
  const [workers, legacy, requests] = await Promise.all([
    ctx.db.query("polyvalentWorkers").take(500),
    ctx.db.query("teamMembers").take(500),
    ctx.db.query("requests").take(1000),
  ]);
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  /** Les deux ordres (« Jean Dupont » / « Dupont Jean ») pointent vers le même agent. */
  const workerByName = new Map<string, Doc<"polyvalentWorkers">>();
  for (const worker of workers) {
    workerByName.set(normalize(`${worker.firstName} ${worker.lastName}`), worker);
    workerByName.set(normalize(`${worker.lastName} ${worker.firstName}`), worker);
  }
  const legacySites = (member: Doc<"teamMembers">) =>
    member.sites?.length ? member.sites : member.site ? [member.site] : undefined;

  // 1. Les anciens salariés sans homonyme dans l'équipe y sont recréés : la
  //    bascule ne doit perdre personne.
  let created = 0;
  for (const member of legacy) {
    if (workerByName.has(normalize(member.name))) continue;
    const parts = member.name.trim().split(/\s+/);
    const firstName = parts.shift() ?? member.name.trim();
    const lastName = parts.join(" ");
    const id = await ctx.db.insert("polyvalentWorkers", {
      firstName,
      lastName,
      email: member.email,
      sites: legacySites(member),
      employmentType: member.employmentType ?? "permanent",
      active: member.active,
      createdBy: "Reprise agents permanents",
      createdAt: member.createdAt,
    });
    const worker = (await ctx.db.get(id))!;
    workerByName.set(normalize(`${firstName} ${lastName}`), worker);
    workerByName.set(normalize(`${lastName} ${firstName}`), worker);
    created++;
  }

  // 2. Les demandes attribuées à l'ancienne équipe pointent vers le nouvel agent.
  const legacyById = new Map(legacy.map((member) => [String(member._id), member]));
  let migrated = 0;
  for (const request of requests) {
    if (request.assignedWorkerId || !request.assignedTo) continue;
    const member = legacyById.get(String(request.assignedTo));
    const worker = member ? workerByName.get(normalize(member.name)) : undefined;
    if (worker) { await ctx.db.patch(request._id, { assignedWorkerId: worker._id }); migrated++; }
  }

  // 3. Reprise des fiches : on ne remplit que les champs encore vides côté agent.
  let enriched = 0;
  for (const member of legacy) {
    const worker = workerByName.get(normalize(member.name));
    if (!worker) continue;
    const patch: Record<string, unknown> = {};
    if (!worker.email && member.email) patch.email = member.email;
    if (!worker.sites?.length && legacySites(member)) patch.sites = legacySites(member);
    // Tout l'ancien annuaire était constitué d'agents permanents : à défaut de
    // type stocké côté legacy, c'est celui-là qu'on reprend.
    if (!worker.employmentType) patch.employmentType = member.employmentType ?? "permanent";
    if (worker.active === undefined) patch.active = member.active;
    if (Object.keys(patch).length) { await ctx.db.patch(worker._id, patch); enriched++; }
  }
  return { created, migrated, enriched };
}

export const migrateLegacyAssignments = mutation({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "update");
    return await migrateLegacyTeam(ctx);
  },
});

/**
 * Équipe attribuable, pour tout le staff.
 *
 * Attribuer une demande, filtrer par salarié ou désigner un chauffeur ne
 * relève pas de la gestion de l'équipe : ces écrans doivent fonctionner sans
 * le droit `agents-polyvalents`, sinon un salarié sans accès à Gestion perd
 * aussi l'accès aux Demandes. On n'expose que l'identité, le rattachement et
 * le statut — pas les horaires ni les affectations.
 */
export const listAssignable = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const workers = await ctx.db.query("polyvalentWorkers").take(1000);
    return workers
      .map((worker) => ({
        _id: worker._id,
        firstName: worker.firstName,
        lastName: worker.lastName,
        email: worker.email,
        sites: worker.sites,
        employmentType: worker.employmentType,
        active: worker.active,
      }))
      .sort((a, b) =>
        `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`, "fr"),
      );
  },
});

/**
 * Personas (équipe active) pour la sélection sur le compte partagé accueil.
 * Accessible à tout staff, sans droit `agents-polyvalents`.
 */
export const listPersonas = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const workers = await ctx.db.query("polyvalentWorkers").take(500);
    return workers
      .filter((worker) => worker.active !== false)
      .map((worker) => ({
        _id: worker._id,
        name: `${worker.firstName} ${worker.lastName}`.trim(),
        role:
          worker.employmentType === "permanent"
            ? "Ouvrier permanent"
            : worker.employmentType === "polyvalent"
              ? "Ouvrier polyvalent"
              : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  },
});

const workerSites = v.array(v.union(v.literal("60"), v.literal("76")));
const workerEmploymentType = v.union(v.literal("permanent"), v.literal("polyvalent"));

/** Champs de fiche partagés par la création et la modification d'un salarié. */
function workerProfile(args: {
  firstName: string;
  lastName: string;
  email?: string;
  sites?: ("60" | "76")[];
  employmentType?: "permanent" | "polyvalent";
}) {
  const firstName = args.firstName.trim();
  const lastName = args.lastName.trim();
  if (!firstName && !lastName) throw new Error("Le nom du salarié est requis.");
  const email = args.email?.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("L'adresse email est invalide.");
  return {
    firstName,
    lastName,
    email: email || undefined,
    sites: args.sites?.length ? args.sites : undefined,
    employmentType: args.employmentType,
  };
}

export const createWorker = mutation({
  args: {
    firstName: v.string(),
    lastName: v.string(),
    email: v.optional(v.string()),
    sites: v.optional(workerSites),
    employmentType: v.optional(workerEmploymentType),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    return await ctx.db.insert("polyvalentWorkers", {
      ...workerProfile(args),
      active: true,
      createdBy: formatUserName(identity),
      createdAt: Date.now(),
    });
  },
});

export const updateWorker = mutation({
  args: {
    id: v.id("polyvalentWorkers"),
    firstName: v.string(),
    lastName: v.string(),
    email: v.optional(v.string()),
    sites: v.optional(workerSites),
    employmentType: v.optional(workerEmploymentType),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "update");
    await ctx.db.patch(args.id, {
      ...workerProfile(args),
      active: args.active ?? true,
    });
  },
});

export const deleteWorker = mutation({
  args: { id: v.id("polyvalentWorkers") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "delete");
    const activities = await ctx.db
      .query("polyvalentActivities")
      .withIndex("by_worker", (q) => q.eq("workerId", args.id))
      .collect();
    const schedule = await ctx.db
      .query("polyvalentWorkerSchedules")
      .withIndex("by_worker", (q) => q.eq("workerId", args.id))
      .unique();
    const recurrences = await ctx.db
      .query("polyvalentTaskRecurrences")
      .withIndex("by_worker", (q) => q.eq("workerId", args.id))
      .collect();
    await Promise.all(activities.map((activity) => ctx.db.delete(activity._id)));
    await Promise.all(recurrences.map((recurrence) => ctx.db.delete(recurrence._id)));
    if (schedule) await ctx.db.delete(schedule._id);
    await ctx.db.delete(args.id);
  },
});

const availabilityValidator = v.array(v.object({
  weekday: v.number(),
  start: v.string(),
  end: v.string(),
}));

export const listWorkerSchedules = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    return await ctx.db.query("polyvalentWorkerSchedules").take(500);
  },
});

export const setWorkerSchedule = mutation({
  args: { workerId: v.id("polyvalentWorkers"), availability: availabilityValidator },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "update");
    if (args.availability.length > 7) throw new Error("Un planning contient au maximum 7 jours.");
    const days = new Set<number>();
    for (const slot of args.availability) {
      if (!Number.isInteger(slot.weekday) || slot.weekday < 1 || slot.weekday > 7 || days.has(slot.weekday)) throw new Error("Les jours de disponibilité sont invalides.");
      if (!/^\d{2}:\d{2}$/.test(slot.start) || !/^\d{2}:\d{2}$/.test(slot.end) || slot.end <= slot.start) throw new Error("Les horaires de disponibilité sont invalides.");
      days.add(slot.weekday);
    }
    if (!await ctx.db.get(args.workerId)) throw new Error("Ouvrier introuvable.");
    const schedule = await ctx.db.query("polyvalentWorkerSchedules").withIndex("by_worker", (q) => q.eq("workerId", args.workerId)).unique();
    if (schedule) await ctx.db.patch(schedule._id, { availability: args.availability });
    else await ctx.db.insert("polyvalentWorkerSchedules", args);
  },
});

const recurrenceSlotsValidator = v.array(v.object({ weekday: v.number(), start: v.string(), end: v.string() }));

export const listRecurrences = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const [recurrences, tasks, workers] = await Promise.all([
      ctx.db.query("polyvalentTaskRecurrences").take(500),
      ctx.db.query("polyvalentTasks").take(500),
      ctx.db.query("polyvalentWorkers").take(500),
    ]);
    const taskById = new Map(tasks.map((task) => [String(task._id), task]));
    const workerById = new Map(workers.map((worker) => [String(worker._id), worker]));
    return recurrences.map((recurrence) => ({
      ...recurrence,
      taskName: taskById.get(String(recurrence.taskId))?.name ?? "Tâche supprimée",
      taskSite: taskById.get(String(recurrence.taskId))?.site ?? null,
      workerName: recurrence.workerId ? `${workerById.get(String(recurrence.workerId))?.firstName ?? ""} ${workerById.get(String(recurrence.workerId))?.lastName ?? ""}`.trim() || "Salarié supprimé" : "Aucun salarié affecté",
    }));
  },
});

export const createRecurrence = mutation({
  args: {
    taskId: v.id("polyvalentTasks"),
    workerId: v.optional(v.id("polyvalentWorkers")),
    slots: recurrenceSlotsValidator,
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    if (args.slots.length === 0 || args.slots.length > 7) throw new Error("Choisissez entre un et sept créneaux hebdomadaires.");
    const days = new Set<number>();
    for (const slot of args.slots) {
      if (!Number.isInteger(slot.weekday) || slot.weekday < 1 || slot.weekday > 7 || days.has(slot.weekday) || !/^\d{2}:\d{2}$/.test(slot.start) || !/^\d{2}:\d{2}$/.test(slot.end) || slot.end <= slot.start) throw new Error("Les créneaux récurrents sont invalides.");
      days.add(slot.weekday);
    }
    const [task, worker] = await Promise.all([ctx.db.get(args.taskId), args.workerId ? ctx.db.get(args.workerId) : null]);
    if (!task) throw new Error("Tâche introuvable.");
    if (args.workerId && !worker) throw new Error("Salarié introuvable.");
    return await ctx.db.insert("polyvalentTaskRecurrences", {
      ...args,
      createdBy: formatUserName(identity),
      createdAt: Date.now(),
    });
  },
});

export const deleteRecurrence = mutation({
  args: { id: v.id("polyvalentTaskRecurrences") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "delete");
    await ctx.db.delete(args.id);
  },
});

/* ─── Activités (affectations) ────────────────────────────────────────────── */

export const listActivities = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const activities = await ctx.db
      .query("polyvalentActivities")
      .withIndex("by_startAt")
      .order("desc")
      .collect();
    const [tasks, workers] = await Promise.all([
      ctx.db.query("polyvalentTasks").collect(),
      ctx.db.query("polyvalentWorkers").collect(),
    ]);
    const taskById = new Map(tasks.map((task) => [String(task._id), task]));
    const workerById = new Map(workers.map((worker) => [String(worker._id), worker]));
    return activities.map((activity) => {
      const task = taskById.get(String(activity.taskId)) ?? null;
      const worker = activity.workerId ? workerById.get(String(activity.workerId)) ?? null : null;
      return {
        ...activity,
        taskName: task?.name ?? "Tâche supprimée",
        taskSite: task?.site ?? null,
        workerName: worker
          ? `${worker.firstName} ${worker.lastName}`.trim()
          : "Aucun salarié affecté",
      };
    });
  },
});

export const createActivity = mutation({
  args: {
    taskId: v.id("polyvalentTasks"),
    workerId: v.optional(v.id("polyvalentWorkers")),
    startAt: v.number(),
    endAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    if (!Number.isFinite(args.startAt) || !Number.isFinite(args.endAt)) {
      throw new Error("Dates de début et de fin requises.");
    }
    if (args.endAt < args.startAt) {
      throw new Error("La fin doit être après le début.");
    }
    const [task, worker] = await Promise.all([ctx.db.get(args.taskId), args.workerId ? ctx.db.get(args.workerId) : null]);
    if (!task) throw new Error("Tâche introuvable.");
    if (args.workerId && !worker) throw new Error("Ouvrier introuvable.");
    return await ctx.db.insert("polyvalentActivities", {
      taskId: args.taskId,
      workerId: args.workerId,
      startAt: args.startAt,
      endAt: args.endAt,
      createdBy: formatUserName(identity),
      createdAt: Date.now(),
    });
  },
});

/**
 * Crée plusieurs créneaux indépendants en une seule opération.
 */
export const createActivities = mutation({
  args: {
    taskId: v.id("polyvalentTasks"),
    workerId: v.optional(v.id("polyvalentWorkers")),
    slots: v.array(v.object({ startAt: v.number(), endAt: v.number() })),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "create");
    const identity = await requireUser(ctx);
    if (args.slots.length === 0) throw new Error("Ajoutez au moins un créneau.");
    if (args.slots.length > 100) throw new Error("Une création est limitée à 100 créneaux.");
    for (const slot of args.slots) {
      if (!Number.isFinite(slot.startAt) || !Number.isFinite(slot.endAt) || slot.endAt <= slot.startAt) {
        throw new Error("Chaque créneau doit avoir une fin après son début.");
      }
    }
    const [task, worker] = await Promise.all([ctx.db.get(args.taskId), args.workerId ? ctx.db.get(args.workerId) : null]);
    if (!task) throw new Error("Tâche introuvable.");
    if (args.workerId && !worker) throw new Error("Ouvrier introuvable.");
    const createdBy = formatUserName(identity);
    const createdAt = Date.now();
    return await Promise.all(
      args.slots.map((slot) =>
        ctx.db.insert("polyvalentActivities", {
          taskId: args.taskId,
          workerId: args.workerId,
          ...slot,
          createdBy,
          createdAt,
        }),
      ),
    );
  },
});

export const updateActivity = mutation({
  args: {
    id: v.id("polyvalentActivities"),
    taskId: v.id("polyvalentTasks"),
    workerId: v.optional(v.id("polyvalentWorkers")),
    startAt: v.number(),
    endAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "update");
    if (!Number.isFinite(args.startAt) || !Number.isFinite(args.endAt)) {
      throw new Error("Dates de début et de fin requises.");
    }
    if (args.endAt < args.startAt) {
      throw new Error("La fin doit être après le début.");
    }
    const [task, worker] = await Promise.all([ctx.db.get(args.taskId), args.workerId ? ctx.db.get(args.workerId) : null]);
    if (!task) throw new Error("Tâche introuvable.");
    if (args.workerId && !worker) throw new Error("Ouvrier introuvable.");
    await ctx.db.patch(args.id, {
      taskId: args.taskId,
      workerId: args.workerId,
      startAt: args.startAt,
      endAt: args.endAt,
    });
  },
});

export const deleteActivity = mutation({
  args: { id: v.id("polyvalentActivities") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "delete");
    await ctx.db.delete(args.id);
  },
});

/* ─── Synchronisation avec les salariés RH ────────────────────────────────── */

/**
 * L'équipe de la Recyclerie est le miroir des salariés RH rattachés aux
 * structures « Recyclerie 60 » et « Recyclerie 76 ».
 *
 * La fiche RH fait foi pour l'identité (nom, prénom, recyclerie) et pour le
 * statut : un salarié dont le dernier contrat est arrivé à échéance passe
 * inactif. Restent saisis à la main dans l'app, faute d'exister côté RH :
 * l'adresse email et le type de contrat (ouvrier permanent / polyvalent).
 */
const RECYCLERIE_STRUCTURES = ["Recyclerie 60", "Recyclerie 76"] as const;

/** Les CDI n'ont pas d'échéance : leur `date_fin_contrat` ne désactive personne. */
const OPEN_ENDED_CONTRACT_TYPES = new Set(["CDI", "CDI-Inclusion"]);

/** Date du jour (`YYYY-MM-DD`) en heure de Paris. */
function parisToday(): string {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
}

/** Les contrats importés portent parfois du `JJ/MM/AAAA` au lieu de l'ISO. */
function normalizeContractDate(value: string): string | null {
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const french = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return french ? `${french[3]}-${french[2]}-${french[1]}` : null;
}

function normalizeName(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Durée mensuelle de travail du contrat, en heures.
 *
 * La saisie RH est libre (« 151,67 », « 104 h », « 35h/semaine ») : on retient
 * le premier nombre, virgule décimale comprise.
 */
function parseMonthlyHours(value: string | undefined) {
  const match = value?.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return undefined;
  const hours = Number(match[1].replace(",", "."));
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

/** Échéance et durée mensuelle issues du dernier contrat généré du salarié. */
async function contractDataFor(ctx: MutationCtx, employeeId: Id<"hrEmployees">) {
  const lastContract = await ctx.db
    .query("hrContracts")
    .withIndex("by_employee_and_requestedAt", (q) => q.eq("employeeId", employeeId))
    .order("desc")
    .filter((q) => q.eq(q.field("webhookStatus"), "success"))
    .first();
  if (!lastContract) return { contractEndAt: undefined, monthlyHours: undefined };
  return {
    // Un CDI n'a pas d'échéance : sa `date_fin_contrat` ne désactive personne.
    contractEndAt: OPEN_ENDED_CONTRACT_TYPES.has(lastContract.payload.type_contrat)
      ? undefined
      : normalizeContractDate(lastContract.payload.date_fin_contrat) ?? undefined,
    monthlyHours: parseMonthlyHours(lastContract.payload.duree_mensuel_travail),
  };
}

async function syncTeamFromHr(ctx: MutationCtx) {
  const today = parisToday();
  const employees = (
    await Promise.all(
      RECYCLERIE_STRUCTURES.map((structure) =>
        ctx.db
          .query("hrEmployees")
          .withIndex("by_structure", (q) => q.eq("structure", structure))
          .collect(),
      ),
    )
  ).flat();
  const workers = await ctx.db.query("polyvalentWorkers").take(1000);

  const byHrId = new Map(
    workers.filter((worker) => worker.hrEmployeeId).map((worker) => [String(worker.hrEmployeeId), worker]),
  );
  // Les salariés créés avant la bascule sont rattachés sur le nom, dans les
  // deux ordres (« Jean Dupont » / « Dupont Jean »).
  const byName = new Map<string, Doc<"polyvalentWorkers">>();
  for (const worker of workers) {
    if (worker.hrEmployeeId) continue;
    byName.set(normalizeName(`${worker.firstName} ${worker.lastName}`), worker);
    byName.set(normalizeName(`${worker.lastName} ${worker.firstName}`), worker);
  }

  let created = 0;
  let updated = 0;
  for (const employee of employees) {
    const site = employee.structure === "Recyclerie 76" ? "76" : "60";
    const { contractEndAt, monthlyHours } = await contractDataFor(ctx, employee._id);
    const contractOver = contractEndAt !== undefined && contractEndAt < today;
    const activeInHr = employee.active && !contractOver;

    const worker =
      byHrId.get(String(employee._id)) ??
      byName.get(normalizeName(`${employee.firstName} ${employee.lastName}`));

    if (!worker) {
      await ctx.db.insert("polyvalentWorkers", {
        firstName: employee.firstName,
        lastName: employee.lastName,
        sites: [site],
        active: activeInHr,
        hrEmployeeId: employee._id,
        contractEndAt,
        monthlyHours,
        createdBy: "Synchronisation RH",
        createdAt: employee.createdAt,
      });
      created++;
      continue;
    }

    // Un statut forcé à la main (activé comme désactivé) l'emporte sur la
    // seule désactivation automatique — la fin de contrat — mais pas sur une
    // sortie d'effectif côté RH. `reactivatedAt` couvre les réactivations
    // enregistrées avant l'ajout de `activeOverride`.
    const override =
      worker.activeOverride ?? (worker.reactivatedAt !== undefined ? true : undefined);
    const active = employee.active ? override ?? !contractOver : false;
    const patch: Record<string, unknown> = {};
    if (worker.hrEmployeeId !== employee._id) patch.hrEmployeeId = employee._id;
    if (worker.firstName !== employee.firstName) patch.firstName = employee.firstName;
    if (worker.lastName !== employee.lastName) patch.lastName = employee.lastName;
    if (!worker.sites?.includes(site)) patch.sites = [...(worker.sites ?? []), site];
    if (worker.contractEndAt !== contractEndAt) patch.contractEndAt = contractEndAt;
    if (worker.monthlyHours !== monthlyHours) patch.monthlyHours = monthlyHours;
    if (worker.active !== active) patch.active = active;
    if (Object.keys(patch).length) {
      await ctx.db.patch(worker._id, patch);
      updated++;
    }
  }
  return { created, updated };
}

/**
 * Alignement sur l'annuaire RH, déclenché à l'ouverture de la page Tâches.
 * Idempotent : sans écart avec les fiches RH, aucune écriture.
 */
export const syncFromHr = mutation({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    return await syncTeamFromHr(ctx);
  },
});

/** Repasse quotidienne : c'est l'échéance des contrats qui bouge, pas les fiches. */
export const syncFromHrDaily = internalMutation({
  args: {},
  handler: async (ctx) => await syncTeamFromHr(ctx),
});

/**
 * Réactive (ou désactive) un salarié à la main. Une réactivation survit aux
 * synchronisations RH suivantes tant que le salarié reste dans l'effectif.
 */
export const setWorkerActive = mutation({
  args: { id: v.id("polyvalentWorkers"), active: v.boolean() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "update");
    await ctx.db.patch(args.id, {
      active: args.active,
      activeOverride: args.active,
      reactivatedAt: args.active ? Date.now() : undefined,
    });
  },
});

/** Type de contrat, saisi à la main : la donnée n'existe pas côté RH. */
export const setWorkerEmploymentType = mutation({
  args: {
    id: v.id("polyvalentWorkers"),
    employmentType: v.optional(workerEmploymentType),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "update");
    await ctx.db.patch(args.id, { employmentType: args.employmentType });
  },
});


import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { api } from "./_generated/api";
import {
  accessAllows,
  requireAdmin,
  requireAnyCrmPermission,
  requireCrmPermission,
} from "./lib";
import {
  buildAddressString,
  drivingDistanceKm,
  geocode,
} from "./livraison";

/**
 * App « Pointeuse LSDB » — suivi des salariés et des chantiers.
 *
 * Toutes les fonctions sont réservées au personnel (`requirePointeuseAccess`). Les tables
 * sont préfixées `pt` (cf. `schema.ts`). Les montants sont en euros, les dates
 * en millisecondes.
 *
 * Règles de calcul (figées en snapshot au moment du pointage) :
 *  - coût d'un salarié   = heures × taux horaire environné ;
 *  - coût des déplacements = nb d'aller-retours × distance aller (km) × 2 × coût kilométrique du projet.
 */

const DEFAULT_TRAVEL_RATE_PER_KM = 1; // 1 € / km
const POINTEUSE_DEPOT_ADDRESS = "4 rue de la prairie 60650 Lachapelle-aux-Pots";
const DASHBOARD_PAGE_KEY = "pointeuse:dashboard";
const TIME_ENTRIES_PAGE_KEY = "pointeuse:pointages";
const TASKS_PAGE_KEY = "pointeuse:taches";
const PROJECTS_PAGE_KEY = "pointeuse:projets";
const CLIENTS_PAGE_KEY = "pointeuse:clients";
const EMPLOYEES_PAGE_KEY = "pointeuse:salaries";
const SUPPLIERS_PAGE_KEY = "pointeuse:fournisseurs";
const EXPENSES_PAGE_KEY = "pointeuse:depenses";
const INVOICES_PAGE_KEY = "pointeuse:factures";

/* ─── Salariés ────────────────────────────────────────────────────────────── */

const employeeStatus = v.union(
  v.literal("MAD"),
  v.literal("Compagnon permanent"),
  v.literal("Compagnon insertion"),
  v.literal("Renfort ponctuel"),
  v.literal("Encadrant"),
);

export const listEmployees = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, EMPLOYEES_PAGE_KEY, "read");
    const employees = await ctx.db.query("ptEmployees").order("desc").collect();
    return employees.sort((a, b) =>
      `${a.lastName} ${a.firstName}`.localeCompare(
        `${b.lastName} ${b.firstName}`,
        "fr",
      ),
    );
  },
});

export const createEmployee = mutation({
  args: {
    firstName: v.string(),
    lastName: v.string(),
    status: employeeStatus,
    hourlyRate: v.number(),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, EMPLOYEES_PAGE_KEY, "create");
    return await ctx.db.insert("ptEmployees", {
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      status: args.status,
      hourlyRate: args.hourlyRate,
      active: args.active ?? true,
      createdAt: Date.now(),
    });
  },
});

export const updateEmployee = mutation({
  args: {
    employeeId: v.id("ptEmployees"),
    firstName: v.string(),
    lastName: v.string(),
    status: employeeStatus,
    hourlyRate: v.number(),
    active: v.boolean(),
  },
  handler: async (ctx, { employeeId, ...patch }) => {
    await requireCrmPermission(ctx, EMPLOYEES_PAGE_KEY, "update");
    await ctx.db.patch(employeeId, {
      firstName: patch.firstName.trim(),
      lastName: patch.lastName.trim(),
      status: patch.status,
      hourlyRate: patch.hourlyRate,
      active: patch.active,
    });
  },
});

export const deleteEmployee = mutation({
  args: { employeeId: v.id("ptEmployees") },
  handler: async (ctx, { employeeId }) => {
    await requireCrmPermission(ctx, EMPLOYEES_PAGE_KEY, "delete");
    await ctx.db.delete(employeeId);
  },
});

/* ─── Clients ─────────────────────────────────────────────────────────────── */

const clientFields = {
  name: v.string(),
  clientType: v.optional(v.union(v.literal("interne"), v.literal("externe"))),
  contactName: v.optional(v.string()),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  address: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  city: v.optional(v.string()),
  notes: v.optional(v.string()),
};

export const listClients = query({
  args: {},
  handler: async (ctx) => {
    await requireAnyCrmPermission(ctx, [
      [CLIENTS_PAGE_KEY, "read"],
      [PROJECTS_PAGE_KEY, "create"],
      [PROJECTS_PAGE_KEY, "update"],
    ]);
    const clients = await ctx.db.query("ptClients").order("desc").collect();
    return clients.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  },
});

export const createClient = mutation({
  args: clientFields,
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, CLIENTS_PAGE_KEY, "create");
    return await ctx.db.insert("ptClients", {
      ...args,
      name: args.name.trim(),
      createdAt: Date.now(),
    });
  },
});

export const updateClient = mutation({
  args: { clientId: v.id("ptClients"), ...clientFields },
  handler: async (ctx, { clientId, ...patch }) => {
    await requireCrmPermission(ctx, CLIENTS_PAGE_KEY, "update");
    await ctx.db.patch(clientId, { ...patch, name: patch.name.trim() });
  },
});

export const deleteClient = mutation({
  args: { clientId: v.id("ptClients") },
  handler: async (ctx, { clientId }) => {
    await requireCrmPermission(ctx, CLIENTS_PAGE_KEY, "delete");
    const projects = await ctx.db
      .query("ptProjects")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    if (projects.length > 0) {
      throw new Error(
        "Impossible de supprimer : des projets sont rattachés à ce client.",
      );
    }
    await ctx.db.delete(clientId);
  },
});

/* ─── Projets ─────────────────────────────────────────────────────────────── */

const projectStatus = v.union(
  v.literal("en_cours"),
  v.literal("termine"),
  v.literal("en_pause"),
);

const projectFields = {
  name: v.string(),
  clientId: v.id("ptClients"),
  address: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  city: v.optional(v.string()),
  lat: v.optional(v.number()),
  lon: v.optional(v.number()),
  distanceKm: v.number(),
  travelRatePerKm: v.optional(v.number()),
  status: projectStatus,
  notes: v.optional(v.string()),
};

export const listProjects = query({
  args: {},
  handler: async (ctx) => {
    await requireAnyCrmPermission(ctx, [
      [PROJECTS_PAGE_KEY, "read"],
      [TIME_ENTRIES_PAGE_KEY, "read"],
      [TIME_ENTRIES_PAGE_KEY, "create"],
      [EXPENSES_PAGE_KEY, "read"],
      [EXPENSES_PAGE_KEY, "create"],
      [INVOICES_PAGE_KEY, "read"],
      [INVOICES_PAGE_KEY, "create"],
    ]);
    const [projects, clients, entries, expenses] = await Promise.all([
      ctx.db.query("ptProjects").order("desc").collect(),
      ctx.db.query("ptClients").collect(),
      ctx.db.query("ptTimeEntries").collect(),
      ctx.db.query("ptExpenses").collect(),
    ]);
    const clientById = new Map(clients.map((c) => [c._id, c]));
    const totalsByProject = new Map<
      string,
      {
        entriesCount: number;
        laborCost: number;
        travelCost: number;
        totalPointed: number;
        billedPointed: number;
        toBillPointed: number;
      }
    >();
    const emptyTotals = () => ({
      entriesCount: 0,
      laborCost: 0,
      travelCost: 0,
      totalPointed: 0,
      billedPointed: 0,
      toBillPointed: 0,
    });
    for (const entry of entries) {
      const current = totalsByProject.get(entry.projectId) ?? emptyTotals();
      current.entriesCount += 1;
      current.laborCost += entry.laborCost;
      current.travelCost += entry.travelCost;
      current.totalPointed += entry.totalCost;
      if ((entry.billingStatus ?? "a_facturer") === "facture") {
        current.billedPointed += entry.totalCost;
      } else {
        current.toBillPointed += entry.totalCost;
      }
      totalsByProject.set(entry.projectId, current);
    }

    // Les dépenses peuvent exister sans projet rattaché : on n'agrège que
    // celles qui en ont un.
    const expensesByProject = new Map<string, { count: number; total: number }>();
    for (const expense of expenses) {
      if (!expense.projectId) continue;
      const current = expensesByProject.get(expense.projectId) ?? { count: 0, total: 0 };
      current.count += 1;
      current.total += expense.amount;
      expensesByProject.set(expense.projectId, current);
    }

    return projects
      .map((p) => {
        const totals = totalsByProject.get(p._id) ?? emptyTotals();
        const projectExpenses = expensesByProject.get(p._id) ?? { count: 0, total: 0 };
        return {
          ...p,
          clientName: clientById.get(p.clientId)?.name ?? "—",
          clientType: clientById.get(p.clientId)?.clientType,
          travelRatePerKm: p.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM,
          entriesCount: totals.entriesCount,
          laborCost: round2(totals.laborCost),
          travelCost: round2(totals.travelCost),
          /** Main-d'œuvre + déplacements (ce qui est pointé). */
          totalPointed: round2(totals.totalPointed),
          billedPointed: round2(totals.billedPointed),
          toBillPointed: round2(totals.toBillPointed),
          expensesCount: projectExpenses.count,
          totalExpenses: round2(projectExpenses.total),
          /** Coût complet du projet : pointages + déplacements + dépenses. */
          totalCost: round2(totals.totalPointed + projectExpenses.total),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  },
});

export const createProject = mutation({
  args: projectFields,
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PROJECTS_PAGE_KEY, "create");
    const client = await ctx.db.get(args.clientId);
    if (!client) throw new Error("Client introuvable.");
    return await ctx.db.insert("ptProjects", {
      ...args,
      name: args.name.trim(),
      travelRatePerKm: args.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM,
      createdAt: Date.now(),
    });
  },
});

export const updateProject = mutation({
  args: { projectId: v.id("ptProjects"), ...projectFields },
  handler: async (ctx, { projectId, ...patch }) => {
    await requireCrmPermission(ctx, PROJECTS_PAGE_KEY, "update");
    await ctx.db.patch(projectId, {
      ...patch,
      name: patch.name.trim(),
      travelRatePerKm: patch.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM,
    });
  },
});

export const deleteProject = mutation({
  args: { projectId: v.id("ptProjects") },
  handler: async (ctx, { projectId }) => {
    await requireCrmPermission(ctx, PROJECTS_PAGE_KEY, "delete");
    const entries = await ctx.db
      .query("ptTimeEntries")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    if (entries.length > 0) {
      throw new Error(
        "Impossible de supprimer : des pointages sont rattachés à ce projet.",
      );
    }
    await ctx.db.delete(projectId);
  },
});

/**
 * Fiche projet agrégée : coûts de main-d'œuvre (pointages), dépenses, factures
 * (facturé / payé / en attente) et documents rattachés.
 */
export const projectSummary = query({
  args: { projectId: v.id("ptProjects") },
  handler: async (ctx, { projectId }) => {
    await requireCrmPermission(ctx, PROJECTS_PAGE_KEY, "read");
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    const client = await ctx.db.get(project.clientId);

    const [entries, expenses, invoices, documents, employees, suppliers] =
      await Promise.all([
      ctx.db
        .query("ptTimeEntries")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .order("desc")
        .collect(),
      ctx.db
        .query("ptExpenses")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .order("desc")
        .collect(),
      ctx.db
        .query("ptInvoices")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .order("desc")
        .collect(),
      ctx.db
        .query("ptDocuments")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .order("desc")
        .collect(),
      ctx.db.query("ptEmployees").collect(),
      ctx.db.query("ptSuppliers").collect(),
    ]);

    const employeeName = new Map(
      employees.map((employee) => [
        employee._id,
        `${employee.firstName} ${employee.lastName}`,
      ]),
    );
    const supplierName = new Map(
      suppliers.map((supplier) => [supplier._id, supplier.name]),
    );

    const laborCost = entries.reduce((s, e) => s + e.laborCost, 0);
    const travelCost = entries.reduce((s, e) => s + e.travelCost, 0);
    const totalPointed = entries.reduce((s, e) => s + e.totalCost, 0);
    const billedPointed = entries
      .filter((e) => e.billingStatus === "facture")
      .reduce((s, e) => s + e.totalCost, 0);
    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
    const invoiced = invoices.reduce((s, i) => s + i.amount, 0);
    const paid = invoices
      .filter((i) => i.status === "payee")
      .reduce((s, i) => s + i.amount, 0);
    const pending = invoiced - paid;

    const docsWithUrl = await Promise.all(
      documents.map(async (d) => ({
        ...d,
        kind: d.kind ?? "other",
        url: await ctx.storage.getUrl(d.storageId),
      })),
    );

    return {
      project: {
        ...project,
        clientName: client?.name ?? "—",
        travelRatePerKm: project.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM,
      },
      client,
      entries: entries.map((entry) => ({
        ...entry,
        billingStatus: entry.billingStatus ?? "a_facturer",
        lines: entry.lines.map((line) => ({
          ...line,
          employeeName: employeeName.get(line.employeeId) ?? "—",
        })),
      })),
      expenses: expenses.map((expense) => ({
        ...expense,
        supplierName: expense.supplierId
          ? supplierName.get(expense.supplierId) ?? "—"
          : null,
      })),
      invoices,
      documents: docsWithUrl,
      totals: {
        laborCost,
        travelCost,
        totalPointed,
        billedPointed,
        toBillPointed: round2(totalPointed - billedPointed),
        totalExpenses,
        /** Coût complet du projet : pointages + déplacements + dépenses. */
        totalCost: round2(totalPointed + totalExpenses),
        invoiced,
        paid,
        pending,
      },
    };
  },
});

/* ─── Fournisseurs ────────────────────────────────────────────────────────── */

const supplierFields = {
  name: v.string(),
  supplierType: v.optional(v.string()),
  contactName: v.optional(v.string()),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  address: v.optional(v.string()),
  notes: v.optional(v.string()),
};

export const listSuppliers = query({
  args: {},
  handler: async (ctx) => {
    await requireAnyCrmPermission(ctx, [
      [SUPPLIERS_PAGE_KEY, "read"],
      [EXPENSES_PAGE_KEY, "create"],
      [EXPENSES_PAGE_KEY, "update"],
    ]);
    const suppliers = await ctx.db.query("ptSuppliers").order("desc").collect();
    return suppliers.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  },
});

export const createSupplier = mutation({
  args: supplierFields,
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, SUPPLIERS_PAGE_KEY, "create");
    return await ctx.db.insert("ptSuppliers", {
      ...args,
      name: args.name.trim(),
      supplierType: args.supplierType?.trim() || undefined,
      createdAt: Date.now(),
    });
  },
});

export const updateSupplier = mutation({
  args: { supplierId: v.id("ptSuppliers"), ...supplierFields },
  handler: async (ctx, { supplierId, ...patch }) => {
    await requireCrmPermission(ctx, SUPPLIERS_PAGE_KEY, "update");
    await ctx.db.patch(supplierId, {
      ...patch,
      name: patch.name.trim(),
      supplierType: patch.supplierType?.trim() || undefined,
    });
  },
});

export const deleteSupplier = mutation({
  args: { supplierId: v.id("ptSuppliers") },
  handler: async (ctx, { supplierId }) => {
    await requireCrmPermission(ctx, SUPPLIERS_PAGE_KEY, "delete");
    await ctx.db.delete(supplierId);
  },
});

/* ─── Pointages ───────────────────────────────────────────────────────────── */

export const listTimeEntries = query({
  args: { projectId: v.optional(v.id("ptProjects")) },
  handler: async (ctx, { projectId }) => {
    await requireCrmPermission(ctx, TIME_ENTRIES_PAGE_KEY, "read");
    const entries = projectId
      ? await ctx.db
          .query("ptTimeEntries")
          .withIndex("by_project", (q) => q.eq("projectId", projectId))
          .order("desc")
          .collect()
      : await ctx.db.query("ptTimeEntries").order("desc").collect();

    const [projects, clients, employees] = await Promise.all([
      ctx.db.query("ptProjects").collect(),
      ctx.db.query("ptClients").collect(),
      ctx.db.query("ptEmployees").collect(),
    ]);
    const projectName = new Map(projects.map((p) => [p._id, p.name]));
    const clientName = new Map(clients.map((c) => [c._id, c.name]));
    const empName = new Map(
      employees.map((e) => [e._id, `${e.firstName} ${e.lastName}`]),
    );

    return entries.map((e) => ({
      ...e,
      billingStatus: e.billingStatus ?? "a_facturer",
      projectName: projectName.get(e.projectId) ?? "—",
      clientName: clientName.get(e.clientId) ?? "—",
      lines: e.lines.map((l) => ({
        ...l,
        employeeName: empName.get(l.employeeId) ?? "—",
      })),
    }));
  },
});

export const createTimeEntry = mutation({
  args: {
    projectId: v.id("ptProjects"),
    date: v.number(),
    lines: v.array(
      v.object({ employeeId: v.id("ptEmployees"), hours: v.number() }),
    ),
    roundTrips: v.optional(v.number()),
    notes: v.optional(v.string()),
    documentIds: v.optional(v.array(v.id("ptDocuments"))),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, TIME_ENTRIES_PAGE_KEY, "create");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Non authentifié.");
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Projet introuvable.");

    // Coûts main-d'œuvre : snapshot du taux horaire courant de chaque salarié.
    const lines = [];
    for (const line of args.lines) {
      if (line.hours <= 0) continue;
      const employee = await ctx.db.get(line.employeeId);
      if (!employee) throw new Error("Salarié introuvable.");
      const cost = round2(line.hours * employee.hourlyRate);
      lines.push({
        employeeId: line.employeeId,
        hours: line.hours,
        hourlyRate: employee.hourlyRate,
        cost,
      });
    }
    if (lines.length === 0) {
      throw new Error("Renseignez au moins un salarié avec des heures.");
    }
    const laborCost = round2(lines.reduce((s, l) => s + l.cost, 0));

    // Coût déplacements : AR × distance aller × 2 × coût kilométrique du projet.
    const roundTrips = args.roundTrips ?? 0;
    const ratePerKm = project.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM;
    const travelCost =
      roundTrips > 0
        ? round2(roundTrips * project.distanceKm * 2 * ratePerKm)
        : 0;
    const travel =
      roundTrips > 0
        ? {
            roundTrips,
            distanceKm: project.distanceKm,
            ratePerKm,
            cost: travelCost,
          }
        : undefined;

    const entryId = await ctx.db.insert("ptTimeEntries", {
      projectId: args.projectId,
      clientId: project.clientId,
      date: args.date,
      lines,
      travel,
      laborCost,
      travelCost,
      totalCost: round2(laborCost + travelCost),
      billingStatus: "a_facturer",
      notes: args.notes,
      documentIds: args.documentIds ?? [],
      createdAt: Date.now(),
      createdBy: identity.email ?? undefined,
    });

    // Rattache les documents au pointage (ils portent déjà le projet).
    for (const docId of args.documentIds ?? []) {
      await ctx.db.patch(docId, { timeEntryId: entryId });
    }
    return entryId;
  },
});

/**
 * Modification d'un pointage existant : date, projet, salariés (ajout/retrait),
 * heures, déplacements et remarques. Les taux horaires déjà figés sur une ligne
 * sont conservés ; un salarié ajouté prend son taux horaire courant.
 */
export const updateTimeEntry = mutation({
  args: {
    entryId: v.id("ptTimeEntries"),
    projectId: v.optional(v.id("ptProjects")),
    date: v.optional(v.number()),
    lines: v.optional(
      v.array(
        v.object({ employeeId: v.id("ptEmployees"), hours: v.number() }),
      ),
    ),
    roundTrips: v.optional(v.number()),
    notes: v.optional(v.string()),
    /** Liste complète des pièces jointes après modification (pas un ajout). */
    documentIds: v.optional(v.array(v.id("ptDocuments"))),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, TIME_ENTRIES_PAGE_KEY, "update");
    const entry = await ctx.db.get(args.entryId);
    if (!entry) throw new Error("Pointage introuvable.");

    const projectId = args.projectId ?? entry.projectId;
    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("Projet introuvable.");

    // Taux horaires déjà figés, pour ne pas rejouer l'historique de paie.
    const knownRate = new Map(entry.lines.map((l) => [l.employeeId, l.hourlyRate]));
    const inputLines = args.lines ?? entry.lines.map((l) => ({
      employeeId: l.employeeId,
      hours: l.hours,
    }));

    const lines = [];
    for (const line of inputLines) {
      if (line.hours <= 0) continue;
      let hourlyRate = knownRate.get(line.employeeId);
      if (hourlyRate === undefined) {
        const employee = await ctx.db.get(line.employeeId);
        if (!employee) throw new Error("Salarié introuvable.");
        hourlyRate = employee.hourlyRate;
      }
      lines.push({
        employeeId: line.employeeId,
        hours: line.hours,
        hourlyRate,
        cost: round2(line.hours * hourlyRate),
      });
    }
    if (lines.length === 0) {
      throw new Error("Renseignez au moins un salarié avec des heures.");
    }
    const laborCost = round2(lines.reduce((s, l) => s + l.cost, 0));

    const roundTrips = args.roundTrips ?? entry.travel?.roundTrips ?? 0;
    // Distance figée si le projet ne change pas, sinon celle du nouveau projet.
    const sameProject = projectId === entry.projectId;
    const distanceKm = sameProject
      ? entry.travel?.distanceKm ?? project.distanceKm
      : project.distanceKm;
    const ratePerKm = sameProject
      ? entry.travel?.ratePerKm ?? project.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM
      : project.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM;
    const travelCost =
      roundTrips > 0 ? round2(roundTrips * distanceKm * 2 * ratePerKm) : 0;
    const travel =
      roundTrips > 0
        ? { roundTrips, distanceKm, ratePerKm, cost: travelCost }
        : undefined;

    // Pièces jointes : `documentIds` est la liste finale voulue. Le rattachement
    // inverse (`timeEntryId`) suit, sinon un document retiré resterait affiché
    // comme appartenant au pointage.
    const documentIds = args.documentIds ?? entry.documentIds;
    if (args.documentIds) {
      const before = new Set(entry.documentIds.map((id) => id as string));
      const after = new Set(args.documentIds.map((id) => id as string));
      for (const documentId of args.documentIds) {
        if (!before.has(documentId as string)) {
          await ctx.db.patch(documentId, { timeEntryId: args.entryId });
        }
      }
      for (const documentId of entry.documentIds) {
        if (!after.has(documentId as string)) {
          await ctx.db.patch(documentId, { timeEntryId: undefined });
        }
      }
    }

    await ctx.db.patch(args.entryId, {
      projectId,
      clientId: project.clientId,
      date: args.date ?? entry.date,
      lines,
      travel,
      laborCost,
      travelCost,
      totalCost: round2(laborCost + travelCost),
      notes: args.notes === undefined ? entry.notes : args.notes || undefined,
      documentIds,
    });
  },
});

export const deleteTimeEntry = mutation({
  args: { entryId: v.id("ptTimeEntries") },
  handler: async (ctx, { entryId }) => {
    await requireCrmPermission(ctx, TIME_ENTRIES_PAGE_KEY, "delete");
    await ctx.db.delete(entryId);
  },
});

/* ─── Tâches (nouveau flux : estimé à la création, réel confirmé) ─────────── */

export const listTasks = query({
  args: { projectId: v.optional(v.id("ptProjects")) },
  handler: async (ctx, { projectId }) => {
    // Lisible depuis la page Tâches ET depuis Pointages (confirmation).
    await requireAnyCrmPermission(ctx, [
      [TASKS_PAGE_KEY, "read"],
      [TIME_ENTRIES_PAGE_KEY, "read"],
    ]);
    const tasks = projectId
      ? await ctx.db
          .query("ptTasks")
          .withIndex("by_project", (q) => q.eq("projectId", projectId))
          .order("desc")
          .collect()
      : await ctx.db.query("ptTasks").order("desc").collect();

    const [projects, clients, employees] = await Promise.all([
      ctx.db.query("ptProjects").collect(),
      ctx.db.query("ptClients").collect(),
      ctx.db.query("ptEmployees").collect(),
    ]);
    const projectName = new Map(projects.map((p) => [p._id, p.name]));
    const clientName = new Map(clients.map((c) => [c._id, c.name]));
    const empName = new Map(
      employees.map((e) => [e._id, `${e.firstName} ${e.lastName}`]),
    );

    return tasks.map((task) => {
      const assignments = task.assignments.map((a) => {
        const confirmed = typeof a.confirmedHours === "number";
        return {
          ...a,
          employeeName: empName.get(a.employeeId) ?? "—",
          confirmed,
          estimatedCost: round2(a.estimatedHours * a.hourlyRate),
          confirmedCost: confirmed ? round2((a.confirmedHours ?? 0) * a.hourlyRate) : 0,
        };
      });
      const travelCost = task.travel?.cost ?? 0;
      const estimatedLabor = round2(
        assignments.reduce((s, a) => s + a.estimatedCost, 0),
      );
      const confirmedLabor = round2(
        assignments.reduce((s, a) => s + a.confirmedCost, 0),
      );
      return {
        ...task,
        projectName: projectName.get(task.projectId) ?? "—",
        clientName: clientName.get(task.clientId) ?? "—",
        assignments,
        travelCost,
        estimatedTotal: round2(estimatedLabor + travelCost),
        // Coût réel = temps confirmés + déplacement (le déplacement est acté à la création).
        confirmedTotal: round2(confirmedLabor + travelCost),
      };
    });
  },
});

export const createTask = mutation({
  args: {
    projectId: v.id("ptProjects"),
    date: v.number(),
    assignments: v.array(
      v.object({ employeeId: v.id("ptEmployees"), estimatedHours: v.number() }),
    ),
    roundTrips: v.optional(v.number()),
    notes: v.optional(v.string()),
    documentIds: v.optional(v.array(v.id("ptDocuments"))),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, TASKS_PAGE_KEY, "create");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Non authentifié.");
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Projet introuvable.");

    const assignments = [];
    for (const assignment of args.assignments) {
      if (assignment.estimatedHours <= 0) continue;
      const employee = await ctx.db.get(assignment.employeeId);
      if (!employee) throw new Error("Salarié introuvable.");
      assignments.push({
        employeeId: assignment.employeeId,
        hourlyRate: employee.hourlyRate,
        estimatedHours: assignment.estimatedHours,
      });
    }
    if (assignments.length === 0) {
      throw new Error("Affectez au moins un salarié avec un temps estimé.");
    }

    const roundTrips = args.roundTrips ?? 0;
    const ratePerKm = project.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM;
    const travel =
      roundTrips > 0
        ? {
            roundTrips,
            distanceKm: project.distanceKm,
            ratePerKm,
            cost: round2(roundTrips * project.distanceKm * 2 * ratePerKm),
          }
        : undefined;

    const taskId = await ctx.db.insert("ptTasks", {
      projectId: args.projectId,
      clientId: project.clientId,
      date: args.date,
      travel,
      notes: args.notes,
      documentIds: args.documentIds ?? [],
      assignments,
      status: "pending",
      createdAt: Date.now(),
      createdBy: identity.email ?? undefined,
    });
    // Les documents portent déjà le projet ; on les laisse rattachés à la tâche
    // via `documentIds` sans toucher à `timeEntryId` (réservé aux pointages).
    return taskId;
  },
});

/**
 * Modification d'une tâche : projet, date, déplacement, remarques et surtout
 * salariés affectés (ajout, retrait, temps estimé, temps réel). Les affectations
 * transmises décrivent l'état voulu : un salarié absent du tableau est retiré,
 * un `confirmedHours` omis efface la confirmation existante.
 */
export const updateTask = mutation({
  args: {
    taskId: v.id("ptTasks"),
    projectId: v.optional(v.id("ptProjects")),
    date: v.optional(v.number()),
    assignments: v.optional(
      v.array(
        v.object({
          employeeId: v.id("ptEmployees"),
          estimatedHours: v.number(),
          confirmedHours: v.optional(v.number()),
        }),
      ),
    ),
    roundTrips: v.optional(v.number()),
    notes: v.optional(v.string()),
    /** Liste complète des pièces jointes après modification (pas un ajout). */
    documentIds: v.optional(v.array(v.id("ptDocuments"))),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, TASKS_PAGE_KEY, "update");
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Tâche introuvable.");

    const projectId = args.projectId ?? task.projectId;
    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("Projet introuvable.");

    const previous = new Map(task.assignments.map((a) => [a.employeeId, a]));
    const inputAssignments =
      args.assignments ??
      task.assignments.map((a) => ({
        employeeId: a.employeeId,
        estimatedHours: a.estimatedHours,
        confirmedHours: a.confirmedHours,
      }));

    const now = Date.now();
    const assignments = [];
    for (const input of inputAssignments) {
      if (input.estimatedHours <= 0) continue;
      if (input.confirmedHours !== undefined && input.confirmedHours < 0) {
        throw new Error("Heures invalides.");
      }
      const before = previous.get(input.employeeId);
      let hourlyRate = before?.hourlyRate;
      if (hourlyRate === undefined) {
        const employee = await ctx.db.get(input.employeeId);
        if (!employee) throw new Error("Salarié introuvable.");
        hourlyRate = employee.hourlyRate;
      }
      const confirmedHours = input.confirmedHours;
      const unchanged = before?.confirmedHours === confirmedHours;
      assignments.push({
        employeeId: input.employeeId,
        hourlyRate,
        estimatedHours: input.estimatedHours,
        confirmedHours,
        confirmedAt:
          confirmedHours === undefined
            ? undefined
            : unchanged
              ? before?.confirmedAt ?? now
              : now,
      });
    }
    if (assignments.length === 0) {
      throw new Error("Affectez au moins un salarié avec un temps estimé.");
    }

    const roundTrips = args.roundTrips ?? task.travel?.roundTrips ?? 0;
    const sameProject = projectId === task.projectId;
    const distanceKm = sameProject
      ? task.travel?.distanceKm ?? project.distanceKm
      : project.distanceKm;
    const ratePerKm = sameProject
      ? task.travel?.ratePerKm ?? project.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM
      : project.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM;
    const travel =
      roundTrips > 0
        ? {
            roundTrips,
            distanceKm,
            ratePerKm,
            cost: round2(roundTrips * distanceKm * 2 * ratePerKm),
          }
        : undefined;

    await ctx.db.patch(args.taskId, {
      projectId,
      clientId: project.clientId,
      date: args.date ?? task.date,
      assignments,
      travel,
      notes: args.notes === undefined ? task.notes : args.notes || undefined,
      // `timeEntryId` reste réservé aux pointages : une tâche ne porte ses
      // documents que par sa propre liste.
      documentIds: args.documentIds ?? task.documentIds,
      status: assignments.every((a) => typeof a.confirmedHours === "number")
        ? "confirmed"
        : "pending",
    });
  },
});

/**
 * Pièces jointes d'une tâche, depuis l'écran de confirmation des heures.
 *
 * Un salarié qui pointe depuis le chantier a les droits « pointages », pas
 * « tâches » : sans cette mutation dédiée, il ne pourrait joindre ni photo ni
 * bon de livraison au moment où il les a sous la main.
 */
export const updateTaskDocuments = mutation({
  args: {
    taskId: v.id("ptTasks"),
    documentIds: v.array(v.id("ptDocuments")),
  },
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [
      [TIME_ENTRIES_PAGE_KEY, "update"],
      [TASKS_PAGE_KEY, "update"],
    ]);
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Tâche introuvable.");
    await ctx.db.patch(args.taskId, { documentIds: args.documentIds });
  },
});

/** Confirmation du temps réel d'un salarié affecté (depuis « Pointages »). */
export const confirmTaskHours = mutation({
  args: {
    taskId: v.id("ptTasks"),
    employeeId: v.id("ptEmployees"),
    confirmedHours: v.number(),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, TIME_ENTRIES_PAGE_KEY, "update");
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Tâche introuvable.");
    if (args.confirmedHours < 0) throw new Error("Heures invalides.");
    const now = Date.now();
    let found = false;
    const assignments = task.assignments.map((a) => {
      if (a.employeeId !== args.employeeId) return a;
      found = true;
      return { ...a, confirmedHours: args.confirmedHours, confirmedAt: now };
    });
    if (!found) throw new Error("Ce salarié n'est pas affecté à cette tâche.");
    const status = assignments.every((a) => typeof a.confirmedHours === "number")
      ? "confirmed"
      : "pending";
    await ctx.db.patch(args.taskId, { assignments, status });
  },
});

export const deleteTask = mutation({
  args: { taskId: v.id("ptTasks") },
  handler: async (ctx, { taskId }) => {
    await requireCrmPermission(ctx, TASKS_PAGE_KEY, "delete");
    await ctx.db.delete(taskId);
  },
});

/* ─── Dépenses ────────────────────────────────────────────────────────────── */

export const listExpenses = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, EXPENSES_PAGE_KEY, "read");
    const expenses = await ctx.db.query("ptExpenses").order("desc").collect();
    const [projects, suppliers] = await Promise.all([
      ctx.db.query("ptProjects").collect(),
      ctx.db.query("ptSuppliers").collect(),
    ]);
    const projectName = new Map(projects.map((p) => [p._id, p.name]));
    const supplierName = new Map(suppliers.map((s) => [s._id, s.name]));
    return expenses.map((e) => ({
      ...e,
      projectName: e.projectId ? projectName.get(e.projectId) ?? "—" : null,
      supplierName: e.supplierId ? supplierName.get(e.supplierId) ?? "—" : null,
    }));
  },
});

export const createExpense = mutation({
  args: {
    label: v.string(),
    amount: v.number(),
    date: v.number(),
    projectId: v.optional(v.id("ptProjects")),
    supplierId: v.optional(v.id("ptSuppliers")),
    category: v.optional(v.string()),
    documentIds: v.optional(v.array(v.id("ptDocuments"))),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, EXPENSES_PAGE_KEY, "create");
    const expenseId = await ctx.db.insert("ptExpenses", {
      label: args.label.trim(),
      amount: args.amount,
      date: args.date,
      projectId: args.projectId,
      supplierId: args.supplierId,
      category: args.category,
      documentIds: args.documentIds ?? [],
      createdAt: Date.now(),
    });
    for (const docId of args.documentIds ?? []) {
      await ctx.db.patch(docId, { expenseId });
    }
    return expenseId;
  },
});

export const deleteExpense = mutation({
  args: { expenseId: v.id("ptExpenses") },
  handler: async (ctx, { expenseId }) => {
    await requireCrmPermission(ctx, EXPENSES_PAGE_KEY, "delete");
    await ctx.db.delete(expenseId);
  },
});

/* ─── Factures ────────────────────────────────────────────────────────────── */

const invoiceStatus = v.union(
  v.literal("brouillon"),
  v.literal("envoyee"),
  v.literal("payee"),
  v.literal("en_retard"),
);

export const listInvoices = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, INVOICES_PAGE_KEY, "read");
    const invoices = await ctx.db.query("ptInvoices").order("desc").collect();
    const [projects, clients] = await Promise.all([
      ctx.db.query("ptProjects").collect(),
      ctx.db.query("ptClients").collect(),
    ]);
    const projectName = new Map(projects.map((p) => [p._id, p.name]));
    const clientName = new Map(clients.map((c) => [c._id, c.name]));
    return invoices.map((i) => ({
      ...i,
      projectName: projectName.get(i.projectId) ?? "—",
      clientName: clientName.get(i.clientId) ?? "—",
    }));
  },
});

export const createInvoice = mutation({
  args: {
    projectId: v.id("ptProjects"),
    number: v.string(),
    amount: v.number(),
    status: invoiceStatus,
    issuedAt: v.number(),
    dueAt: v.optional(v.number()),
    paidAt: v.optional(v.number()),
    notes: v.optional(v.string()),
    documentIds: v.optional(v.array(v.id("ptDocuments"))),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, INVOICES_PAGE_KEY, "create");
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Projet introuvable.");
    const invoiceId = await ctx.db.insert("ptInvoices", {
      projectId: args.projectId,
      clientId: project.clientId,
      number: args.number.trim(),
      amount: args.amount,
      status: args.status,
      issuedAt: args.issuedAt,
      dueAt: args.dueAt,
      paidAt: args.paidAt,
      notes: args.notes,
      documentIds: args.documentIds ?? [],
      createdAt: Date.now(),
    });
    for (const docId of args.documentIds ?? []) {
      await ctx.db.patch(docId, { invoiceId });
    }
    return invoiceId;
  },
});

export const updateInvoiceStatus = mutation({
  args: {
    invoiceId: v.id("ptInvoices"),
    status: invoiceStatus,
    paidAt: v.optional(v.number()),
  },
  handler: async (ctx, { invoiceId, status, paidAt }) => {
    await requireCrmPermission(ctx, INVOICES_PAGE_KEY, "update");
    await ctx.db.patch(invoiceId, {
      status,
      paidAt: status === "payee" ? paidAt ?? Date.now() : undefined,
    });
  },
});

export const deleteInvoice = mutation({
  args: { invoiceId: v.id("ptInvoices") },
  handler: async (ctx, { invoiceId }) => {
    await requireCrmPermission(ctx, INVOICES_PAGE_KEY, "delete");
    await ctx.db.delete(invoiceId);
  },
});

/* ─── Documents ───────────────────────────────────────────────────────────── */

/**
 * Enregistre un document déjà uploadé (via `files.generateUploadUrl`) et le
 * rattache à un projet. S'il provient d'un pointage, `timeEntryId` sera posé au
 * moment de la création du pointage.
 */
/**
 * Détail des pièces jointes d'une tâche ou d'un pointage (nom, type, lien).
 * Les listes ne renvoient que les identifiants : les recharger ici évite de
 * signer une URL de stockage pour chaque document de chaque ligne affichée.
 */
export const documentsByIds = query({
  args: { documentIds: v.array(v.id("ptDocuments")) },
  handler: async (ctx, { documentIds }) => {
    await requireAnyCrmPermission(ctx, [
      [TASKS_PAGE_KEY, "read"],
      [TIME_ENTRIES_PAGE_KEY, "read"],
      [PROJECTS_PAGE_KEY, "read"],
    ]);
    const documents = await Promise.all(
      documentIds.map(async (documentId) => {
        const document = await ctx.db.get(documentId);
        if (!document) return null;
        return {
          _id: document._id,
          name: document.name,
          mimeType: document.mimeType,
          kind: document.kind ?? "other",
          url: await ctx.storage.getUrl(document.storageId),
        };
      }),
    );
    return documents.filter(
      (document): document is NonNullable<typeof document> => Boolean(document),
    );
  },
});

export const registerDocument = mutation({
  args: {
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.optional(v.string()),
    kind: v.optional(
      v.union(
        v.literal("chantier_photo"),
        v.literal("expense_quote"),
        v.literal("expense_delivery_note"),
        v.literal("expense_invoice"),
        v.literal("invoice_pdf"),
        v.literal("other"),
      ),
    ),
    projectId: v.id("ptProjects"),
    supplierId: v.optional(v.id("ptSuppliers")),
  },
  handler: async (ctx, args) => {
    await requireAnyCrmPermission(ctx, [
      [PROJECTS_PAGE_KEY, "create"],
      [PROJECTS_PAGE_KEY, "update"],
      [TIME_ENTRIES_PAGE_KEY, "create"],
      [TIME_ENTRIES_PAGE_KEY, "update"],
      [TASKS_PAGE_KEY, "create"],
      [TASKS_PAGE_KEY, "update"],
      [EXPENSES_PAGE_KEY, "create"],
      [INVOICES_PAGE_KEY, "create"],
    ]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Non authentifié.");
    return await ctx.db.insert("ptDocuments", {
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      kind: args.kind ?? "other",
      projectId: args.projectId,
      supplierId: args.supplierId,
      uploadedAt: Date.now(),
      uploadedBy: identity.email ?? undefined,
    });
  },
});

export const deleteDocument = mutation({
  args: { documentId: v.id("ptDocuments") },
  handler: async (ctx, { documentId }) => {
    await requireAnyCrmPermission(ctx, [
      [PROJECTS_PAGE_KEY, "update"],
      [TIME_ENTRIES_PAGE_KEY, "update"],
      [TASKS_PAGE_KEY, "update"],
      [EXPENSES_PAGE_KEY, "update"],
      [INVOICES_PAGE_KEY, "update"],
      [PROJECTS_PAGE_KEY, "delete"],
      [TIME_ENTRIES_PAGE_KEY, "delete"],
      [EXPENSES_PAGE_KEY, "delete"],
      [INVOICES_PAGE_KEY, "delete"],
    ]);
    const doc = await ctx.db.get(documentId);
    if (doc) await ctx.storage.delete(doc.storageId);
    await ctx.db.delete(documentId);
  },
});

export const updateTimeEntryBillingStatus = mutation({
  args: {
    entryId: v.id("ptTimeEntries"),
    billingStatus: v.union(v.literal("a_facturer"), v.literal("facture")),
  },
  handler: async (ctx, { entryId, billingStatus }) => {
    await requireCrmPermission(ctx, TIME_ENTRIES_PAGE_KEY, "update");
    await ctx.db.patch(entryId, { billingStatus });
  },
});

export const getTimeEntry = query({
  args: { entryId: v.id("ptTimeEntries") },
  handler: async (ctx, { entryId }) => {
    await requireCrmPermission(ctx, TIME_ENTRIES_PAGE_KEY, "read");
    const entry = await ctx.db.get(entryId);
    if (!entry) return null;

    const [project, client, employees, documents] = await Promise.all([
      ctx.db.get(entry.projectId),
      ctx.db.get(entry.clientId),
      ctx.db.query("ptEmployees").collect(),
      Promise.all(
        entry.documentIds.map(async (documentId) => {
          const document = await ctx.db.get(documentId);
          if (!document) return null;
          return {
            ...document,
            kind: document.kind ?? "other",
            url: await ctx.storage.getUrl(document.storageId),
          };
        }),
      ),
    ]);

    const employeeName = new Map(
      employees.map((employee) => [
        employee._id,
        `${employee.firstName} ${employee.lastName}`,
      ]),
    );

    return {
      ...entry,
      billingStatus: entry.billingStatus ?? "a_facturer",
      projectName: project?.name ?? "—",
      clientName: client?.name ?? "—",
      lines: entry.lines.map((line) => ({
        ...line,
        employeeName: employeeName.get(line.employeeId) ?? "—",
      })),
      documents: documents.filter(
        (document): document is NonNullable<typeof document> => Boolean(document),
      ),
    };
  },
});

export const clientSummary = query({
  args: { clientId: v.id("ptClients") },
  handler: async (ctx, { clientId }) => {
    await requireCrmPermission(ctx, CLIENTS_PAGE_KEY, "read");
    const client = await ctx.db.get(clientId);
    if (!client) return null;

    const [projects, entries, invoices] = await Promise.all([
      ctx.db
        .query("ptProjects")
        .withIndex("by_client", (q) => q.eq("clientId", clientId))
        .collect(),
      ctx.db.query("ptTimeEntries").collect(),
      ctx.db.query("ptInvoices").collect(),
    ]);

    const projectIds = new Set(projects.map((project) => project._id));
    const projectSummaries = projects.map((project) => {
      const projectEntries = entries.filter((entry) => entry.projectId === project._id);
      const projectInvoices = invoices.filter((invoice) => invoice.projectId === project._id);
      return {
        ...project,
        travelRatePerKm: project.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM,
        entriesCount: projectEntries.length,
        totalPointed: round2(
          projectEntries.reduce((sum, entry) => sum + entry.totalCost, 0),
        ),
        billedPointed: round2(
          projectEntries
            .filter((entry) => (entry.billingStatus ?? "a_facturer") === "facture")
            .reduce((sum, entry) => sum + entry.totalCost, 0),
        ),
        toBillPointed: round2(
          projectEntries
            .filter((entry) => (entry.billingStatus ?? "a_facturer") !== "facture")
            .reduce((sum, entry) => sum + entry.totalCost, 0),
        ),
        invoiced: round2(
          projectInvoices.reduce((sum, invoice) => sum + invoice.amount, 0),
        ),
      };
    });

    const clientEntries = entries.filter((entry) => projectIds.has(entry.projectId));
    const clientInvoices = invoices
      .filter((invoice) => invoice.clientId === clientId)
      .map((invoice) => {
        const project = projects.find((item) => item._id === invoice.projectId);
        return {
          ...invoice,
          projectName: project?.name ?? "—",
        };
      });

    const totalPointed = round2(
      clientEntries.reduce((sum, entry) => sum + entry.totalCost, 0),
    );
    const billedPointed = round2(
      clientEntries
        .filter((entry) => entry.billingStatus === "facture")
        .reduce((sum, entry) => sum + entry.totalCost, 0),
    );
    const totalExpenses = 0;
    const invoicedTotal = round2(
      clientInvoices.reduce((sum, invoice) => sum + invoice.amount, 0),
    );
    const pending = round2(
      clientInvoices
        .filter((invoice) => invoice.status !== "payee")
        .reduce((sum, invoice) => sum + invoice.amount, 0),
    );

    return {
      client,
      projects: projectSummaries.sort((a, b) => a.name.localeCompare(b.name, "fr")),
      invoices: clientInvoices.sort((a, b) => b.issuedAt - a.issuedAt),
      counts: {
        projects: projectSummaries.length,
        entries: clientEntries.length,
        invoices: clientInvoices.length,
      },
      totals: {
        totalPointed,
        billedPointed,
        toBillPointed: round2(totalPointed - billedPointed),
        totalExpenses,
        invoiced: invoicedTotal,
        pending,
      },
    };
  },
});

export const computeProjectDistance = action({
  args: {
    address: v.string(),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ distanceKm: number }> => {
    const access = await ctx.runQuery(api.permissions.myAccess, {});
    if (
      !accessAllows(access, PROJECTS_PAGE_KEY, "create") &&
      !accessAllows(access, PROJECTS_PAGE_KEY, "update")
    ) {
      throw new Error("Accès CRM insuffisant.");
    }
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error("MAPBOX_ACCESS_TOKEN n'est pas configurée côté Convex.");
    }
    const destination = buildAddressString(args);
    if (!destination) {
      throw new Error("Adresse du chantier manquante.");
    }

    const [depot, target] = await Promise.all([
      geocode(POINTEUSE_DEPOT_ADDRESS, accessToken),
      geocode(destination, accessToken),
    ]);
    const oneWayKm = await drivingDistanceKm(depot, target, accessToken);
    return { distanceKm: Math.round(oneWayKm * 10) / 10 };
  },
});

/* ─── Tableau de bord ─────────────────────────────────────────────────────── */

export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, DASHBOARD_PAGE_KEY, "read");
    const [projects, entries, invoices, employees] = await Promise.all([
      ctx.db.query("ptProjects").collect(),
      ctx.db.query("ptTimeEntries").order("desc").collect(),
      ctx.db.query("ptInvoices").collect(),
      ctx.db.query("ptEmployees").collect(),
    ]);
    const totalPointed = entries.reduce((s, e) => s + e.totalCost, 0);
    const billedPointed = entries
      .filter((e) => e.billingStatus === "facture")
      .reduce((s, e) => s + e.totalCost, 0);
    const toBillCount = entries.filter(
      (e) => (e.billingStatus ?? "a_facturer") !== "facture",
    ).length;
    const invoiced = invoices.reduce((s, i) => s + i.amount, 0);
    const paid = invoices
      .filter((i) => i.status === "payee")
      .reduce((s, i) => s + i.amount, 0);
    return {
      projectsInProgress: projects.filter((p) => p.status === "en_cours").length,
      projectsTotal: projects.length,
      activeEmployees: employees.filter((e) => e.active).length,
      entriesCount: entries.length,
      totalPointed: round2(totalPointed),
      billedPointed: round2(billedPointed),
      toBillPointed: round2(totalPointed - billedPointed),
      toBillCount,
      invoiced: round2(invoiced),
      pending: round2(invoiced - paid),
      recentEntries: entries.slice(0, 5),
    };
  },
});

/* ─── Import historique Pointeuse ────────────────────────────────────────── */

const legacyEmployee = v.object({
  ref: v.optional(v.string()),
  firstName: v.string(),
  lastName: v.string(),
  status: v.string(),
  hourlyRate: v.number(),
  active: v.optional(v.boolean()),
  createdAt: v.optional(v.number()),
});

const legacyClient = v.object({
  name: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  address: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  city: v.optional(v.string()),
  status: v.optional(v.string()),
  createdAt: v.optional(v.number()),
});

const legacyProject = v.object({
  name: v.string(),
  clientName: v.optional(v.string()),
  address: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  city: v.optional(v.string()),
  distanceKm: v.optional(v.number()),
  travelRatePerKm: v.optional(v.number()),
  status: v.optional(v.string()),
  notes: v.optional(v.string()),
  createdAt: v.optional(v.number()),
  lastModifiedAt: v.optional(v.number()),
  pointageRefs: v.optional(v.array(v.string())),
});

const legacySupplier = v.object({
  name: v.string(),
  address: v.optional(v.string()),
  supplierType: v.optional(v.string()),
});

const legacyTimeGroup = v.object({
  pointageRef: v.string(),
  projectName: v.optional(v.string()),
  clientName: v.optional(v.string()),
  date: v.optional(v.number()),
  travelRoundTrips: v.optional(v.number()),
  notes: v.optional(v.string()),
  lines: v.array(
    v.object({
      employeeName: v.string(),
      hours: v.number(),
      cost: v.optional(v.number()),
    }),
  ),
});

export const adminImportLegacyPointeuse = mutation({
  args: {
    employees: v.array(legacyEmployee),
    clients: v.array(legacyClient),
    projects: v.array(legacyProject),
    suppliers: v.array(legacySupplier),
    timeGroups: v.array(legacyTimeGroup),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const now = Date.now();
    const fallbackClientName = "Import historique";
    const fallbackProjectName = "Pointage sans projet (import historique)";

    const existingClients = await ctx.db.query("ptClients").collect();
    const clientByName = new Map(
      existingClients.map((client) => [normalizeKey(client.name), client]),
    );
    const existingEmployees = await ctx.db.query("ptEmployees").collect();
    const employeeByName = new Map(
      existingEmployees.map((employee) => [
        normalizeKey(`${employee.firstName} ${employee.lastName}`),
        employee,
      ]),
    );
    const employeeByFirstName = new Map<string, Doc<"ptEmployees">>();
    for (const employee of existingEmployees) {
      const key = normalizeKey(employee.firstName);
      if (!key || employeeByFirstName.has(key)) continue;
      employeeByFirstName.set(key, employee);
    }
    const existingProjects = await ctx.db.query("ptProjects").collect();
    const projectByName = new Map(
      existingProjects.map((project) => [normalizeKey(project.name), project]),
    );
    const existingSuppliers = await ctx.db.query("ptSuppliers").collect();
    const supplierByName = new Map(
      existingSuppliers.map((supplier) => [normalizeKey(supplier.name), supplier]),
    );

    let clientsCreated = 0;
    let clientsUpdated = 0;
    const ensureClient = async (legacy: {
      name: string;
      email?: string;
      phone?: string;
      address?: string;
      postalCode?: string;
      city?: string;
      status?: string;
      createdAt?: number;
    }) => {
      const key = normalizeKey(legacy.name);
      const existing = clientByName.get(key);
      const patch = buildClientPatch(existing, legacy);
      if (existing) {
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, patch);
          const next = { ...existing, ...patch } as Doc<"ptClients">;
          clientByName.set(key, next);
          clientsUpdated += 1;
          return next;
        }
        return existing;
      }
      const clientId = await ctx.db.insert("ptClients", {
        name: legacy.name.trim(),
        ...(legacy.email ? { email: legacy.email.trim() } : {}),
        ...(legacy.phone ? { phone: legacy.phone.trim() } : {}),
        ...(legacy.address ? { address: legacy.address.trim() } : {}),
        ...(legacy.postalCode ? { postalCode: legacy.postalCode.trim() } : {}),
        ...(legacy.city ? { city: legacy.city.trim() } : {}),
        ...(legacy.status ? { notes: `Statut historique: ${legacy.status.trim()}` } : {}),
        createdAt: legacy.createdAt ?? now,
      });
      const created = (await ctx.db.get(clientId)) as Doc<"ptClients">;
      clientByName.set(key, created);
      clientsCreated += 1;
      return created;
    };

    for (const client of args.clients) {
      await ensureClient(client);
    }
    const fallbackClient = await ensureClient({ name: fallbackClientName });

    let employeesCreated = 0;
    let employeesUpdated = 0;
    for (const employee of args.employees) {
      const key = normalizeKey(`${employee.firstName} ${employee.lastName}`);
      const existing = employeeByName.get(key);
      const nextStatus = mapLegacyEmployeeStatus(employee.status);
      const nextRate = employee.hourlyRate;
      const nextActive = employee.active ?? true;
      if (existing) {
        const patch: Partial<Doc<"ptEmployees">> = {};
        if (existing.firstName !== employee.firstName.trim()) {
          patch.firstName = employee.firstName.trim();
        }
        if (existing.lastName !== employee.lastName.trim()) {
          patch.lastName = employee.lastName.trim();
        }
        if (existing.status !== nextStatus) patch.status = nextStatus;
        if (existing.hourlyRate !== nextRate) patch.hourlyRate = nextRate;
        if (existing.active !== nextActive) patch.active = nextActive;
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, patch);
          const next = { ...existing, ...patch } as Doc<"ptEmployees">;
          employeeByName.set(key, next);
          if (!employeeByFirstName.has(normalizeKey(next.firstName))) {
            employeeByFirstName.set(normalizeKey(next.firstName), next);
          }
          employeesUpdated += 1;
        }
      } else {
        const employeeId = await ctx.db.insert("ptEmployees", {
          firstName: employee.firstName.trim(),
          lastName: employee.lastName.trim(),
          status: nextStatus,
          hourlyRate: nextRate,
          active: nextActive,
          createdAt: employee.createdAt ?? now,
        });
        const created = (await ctx.db.get(employeeId)) as Doc<"ptEmployees">;
        employeeByName.set(key, created);
        if (!employeeByFirstName.has(normalizeKey(created.firstName))) {
          employeeByFirstName.set(normalizeKey(created.firstName), created);
        }
        employeesCreated += 1;
      }
    }

    let projectsCreated = 0;
    let projectsUpdated = 0;
    const ensureProject = async (legacy: {
      name: string;
      clientName?: string;
      address?: string;
      postalCode?: string;
      city?: string;
      distanceKm?: number;
      travelRatePerKm?: number;
      status?: string;
      notes?: string;
      createdAt?: number;
    }) => {
      const key = normalizeKey(legacy.name);
      const existing = projectByName.get(key);
      const client =
        legacy.clientName && clientByName.get(normalizeKey(legacy.clientName))
          ? clientByName.get(normalizeKey(legacy.clientName))!
          : fallbackClient;
      const nextStatus = mapLegacyProjectStatus(legacy.status);
      const nextRate = legacy.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM;
      const nextDistance = legacy.distanceKm ?? 0;
      if (existing) {
        const patch: Partial<Doc<"ptProjects">> = {};
        if (existing.name !== legacy.name.trim()) patch.name = legacy.name.trim();
        if (existing.clientId !== client._id) patch.clientId = client._id;
        if ((existing.address ?? "") !== (legacy.address?.trim() ?? "")) {
          patch.address = legacy.address?.trim() || undefined;
        }
        if ((existing.postalCode ?? "") !== (legacy.postalCode?.trim() ?? "")) {
          patch.postalCode = legacy.postalCode?.trim() || undefined;
        }
        if ((existing.city ?? "") !== (legacy.city?.trim() ?? "")) {
          patch.city = legacy.city?.trim() || undefined;
        }
        if (existing.distanceKm !== nextDistance) patch.distanceKm = nextDistance;
        if ((existing.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM) !== nextRate) {
          patch.travelRatePerKm = nextRate;
        }
        if (existing.status !== nextStatus) patch.status = nextStatus;
        if ((existing.notes ?? "") !== (legacy.notes?.trim() ?? "")) {
          patch.notes = legacy.notes?.trim() || undefined;
        }
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, patch);
          projectByName.set(key, { ...existing, ...patch } as Doc<"ptProjects">);
          projectsUpdated += 1;
          return { ...existing, ...patch } as Doc<"ptProjects">;
        }
        return existing;
      }
      const projectId = await ctx.db.insert("ptProjects", {
        name: legacy.name.trim(),
        clientId: client._id,
        ...(legacy.address ? { address: legacy.address.trim() } : {}),
        ...(legacy.postalCode ? { postalCode: legacy.postalCode.trim() } : {}),
        ...(legacy.city ? { city: legacy.city.trim() } : {}),
        distanceKm: nextDistance,
        travelRatePerKm: nextRate,
        status: nextStatus,
        ...(legacy.notes ? { notes: legacy.notes.trim() } : {}),
        createdAt: legacy.createdAt ?? now,
      });
      const created = (await ctx.db.get(projectId)) as Doc<"ptProjects">;
      projectByName.set(key, created);
      projectsCreated += 1;
      return created;
    };

    for (const project of args.projects) {
      await ensureProject(project);
    }
    const fallbackProject = await ensureProject({
      name: fallbackProjectName,
      clientName: fallbackClient.name,
      notes: "Projet de secours pour les pointages historiques sans référence projet.",
      createdAt: now,
    });

    let suppliersCreated = 0;
    let suppliersUpdated = 0;
    for (const supplier of args.suppliers) {
      const key = normalizeKey(supplier.name);
      const existing = supplierByName.get(key);
      if (existing) {
        const patch: Partial<Doc<"ptSuppliers">> = {};
        if ((existing.address ?? "") !== (supplier.address?.trim() ?? "")) {
          patch.address = supplier.address?.trim() || undefined;
        }
        if ((existing.supplierType ?? "") !== (supplier.supplierType?.trim() ?? "")) {
          patch.supplierType = supplier.supplierType?.trim() || undefined;
        }
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, patch);
          supplierByName.set(key, { ...existing, ...patch } as Doc<"ptSuppliers">);
          suppliersUpdated += 1;
        }
      } else {
        const supplierId = await ctx.db.insert("ptSuppliers", {
          name: supplier.name.trim(),
          ...(supplier.address ? { address: supplier.address.trim() } : {}),
          ...(supplier.supplierType ? { supplierType: supplier.supplierType.trim() } : {}),
          createdAt: now,
        });
        supplierByName.set(key, (await ctx.db.get(supplierId)) as Doc<"ptSuppliers">);
        suppliersCreated += 1;
      }
    }

    let timeEntriesCreated = 0;
    let timeEntriesUpdated = 0;
    for (const group of args.timeGroups) {
      const project =
        group.projectName && projectByName.get(normalizeKey(group.projectName))
          ? projectByName.get(normalizeKey(group.projectName))!
          : fallbackProject;

      const lines = group.lines
        .map((line) => {
          const employee =
            employeeByName.get(normalizeKey(line.employeeName)) ??
            employeeByFirstName.get(normalizeKey(line.employeeName));
          if (!employee || line.hours <= 0) return null;
          const hourlyRate = employee.hourlyRate;
          const cost = round2(line.cost ?? line.hours * hourlyRate);
          return {
            employeeId: employee._id,
            hours: line.hours,
            hourlyRate,
            cost,
          };
        })
        .filter((line): line is NonNullable<typeof line> => Boolean(line));
      if (lines.length === 0) continue;

      const laborCost = round2(lines.reduce((sum, line) => sum + line.cost, 0));
      const ratePerKm = project.travelRatePerKm ?? DEFAULT_TRAVEL_RATE_PER_KM;
      const roundTrips = group.travelRoundTrips ?? 0;
      const travelCost =
        roundTrips > 0
          ? round2(roundTrips * project.distanceKm * 2 * ratePerKm)
          : 0;
      const travel =
        roundTrips > 0
          ? {
              roundTrips,
              distanceKm: project.distanceKm,
              ratePerKm,
              cost: travelCost,
            }
          : undefined;
      const notes = buildImportedTimeEntryNotes(group.pointageRef, group.notes);
      const date = group.date ?? project.createdAt ?? now;

      const existing = (await ctx.db
        .query("ptTimeEntries")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect()).find((entry) => entry.notes === notes);

      const payload = {
        projectId: project._id,
        clientId: project.clientId,
        date,
        lines,
        travel,
        laborCost,
        travelCost,
        totalCost: round2(laborCost + travelCost),
        notes,
        documentIds: existing?.documentIds ?? [],
        createdAt: existing?.createdAt ?? date,
        createdBy: "import historique",
      };

      if (existing) {
        await ctx.db.patch(existing._id, payload);
        timeEntriesUpdated += 1;
      } else {
        await ctx.db.insert("ptTimeEntries", payload);
        timeEntriesCreated += 1;
      }
    }

    return {
      clientsCreated,
      clientsUpdated,
      employeesCreated,
      employeesUpdated,
      projectsCreated,
      projectsUpdated,
      suppliersCreated,
      suppliersUpdated,
      timeEntriesCreated,
      timeEntriesUpdated,
    };
  },
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalizeKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function mapLegacyEmployeeStatus(status: string): Doc<"ptEmployees">["status"] {
  const normalized = normalizeKey(status);
  if (normalized === "mad (mise a disposition)" || normalized === "mad") {
    return "MAD";
  }
  if (
    normalized === "compagnon permanent" ||
    normalized === "compagnon insertion" ||
    normalized === "renfort ponctuel" ||
    normalized === "encadrant"
  ) {
    return status === "MAD (Mise à disposition)"
      ? "MAD"
      : (status as Doc<"ptEmployees">["status"]);
  }
  return "Compagnon permanent";
}

function mapLegacyProjectStatus(status?: string): Doc<"ptProjects">["status"] {
  const normalized = normalizeKey(status ?? "");
  if (normalized === "termine") return "termine";
  if (normalized === "en pause") return "en_pause";
  return "en_cours";
}

function buildClientPatch(
  existing: Doc<"ptClients"> | undefined,
  legacy: {
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    postalCode?: string;
    city?: string;
    status?: string;
  },
) {
  if (!existing) return {};
  const patch: Partial<Doc<"ptClients">> = {};
  if (existing.name !== legacy.name.trim()) patch.name = legacy.name.trim();
  if (!existing.email && legacy.email?.trim()) patch.email = legacy.email.trim();
  if (!existing.phone && legacy.phone?.trim()) patch.phone = legacy.phone.trim();
  if (!existing.address && legacy.address?.trim()) patch.address = legacy.address.trim();
  if (!existing.postalCode && legacy.postalCode?.trim()) {
    patch.postalCode = legacy.postalCode.trim();
  }
  if (!existing.city && legacy.city?.trim()) patch.city = legacy.city.trim();
  if (legacy.status?.trim()) {
    const statusNote = `Statut historique: ${legacy.status.trim()}`;
    if (!existing.notes?.includes(statusNote)) {
      patch.notes = existing.notes ? `${existing.notes}\n${statusNote}` : statusNote;
    }
  }
  return patch;
}

function buildImportedTimeEntryNotes(pointageRef: string, notes?: string) {
  const base = `Import historique Bubble · ${pointageRef}`;
  return notes?.trim() ? `${base}\n${notes.trim()}` : base;
}

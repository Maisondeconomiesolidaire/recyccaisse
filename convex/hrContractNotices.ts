import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Prévenance de fin de contrat (cron quotidien).
 *
 * On regarde, pour chaque salarié actif, la date de fin de son DERNIER contrat
 * généré, et on prévient les responsables RH de sa structure à J-22, J-15 et
 * J-3 de l'échéance.
 *
 * Deux écarts volontaires avec le script Airtable d'origine, qui comparait
 * l'égalité stricte « aujourd'hui === fin - 22 jours » :
 *
 * 1. Un palier est déclenché dès qu'il reste ce nombre de jours **ou moins**
 *    (et que l'échéance n'est pas passée). Avec l'égalité stricte, un cron en
 *    échec ce jour-là faisait perdre la prévenance pour de bon — pour une
 *    échéance de contrat, mieux vaut prévenir en retard que pas du tout.
 * 2. Les paliers déjà envoyés sont mémorisés sur la ligne de contrat
 *    (`endNoticeSentThresholds`) : un seul email par palier, même si le cron
 *    repasse tous les jours. Un palier sauté (cron en panne plusieurs jours)
 *    est absorbé par le palier suivant plutôt que de générer deux emails le
 *    même jour.
 */

/** Paliers de prévenance, en jours avant la fin du contrat (du plus lointain au plus proche). */
const NOTICE_THRESHOLDS = [22, 15, 3];

/**
 * Responsables prévenus, par structure du salarié.
 *
 * Les noms commerciaux utilisés en interne se lisent ainsi : Recyclaide =
 * Pays de Bray Services 60, Materiosol = Pays de Bray Services 76, MES =
 * Maison d'Economie Solidaire, LSDB = Les Sens du Bray, PBE = Pays de Bray
 * Emploi.
 *
 * NB : « Alicias » ne correspond à aucune structure du référentiel RH, donc
 * a.mutlu n'est pour l'instant destinataire que pour Recyclaide (PBS 60).
 */
const RECIPIENTS_BY_STRUCTURE: Record<Doc<"hrEmployees">["structure"], string[]> = {
  "Maison d'Economie Solidaire": ["y.prata@eco-solidaire.fr", "m.lahmer@eco-solidaire.fr"],
  "Les Sens du Bray": ["y.prata@eco-solidaire.fr", "m.lahmer@eco-solidaire.fr"],
  "Recyclerie 60": ["s.benard@eco-solidaire.fr"],
  "Recyclerie 76": ["s.benard@eco-solidaire.fr"],
  "Pays de Bray Emploi": ["s.benard@eco-solidaire.fr"],
  // PBS 60 = Recyclaide : suivi à la fois par le service RH et par a.mutlu.
  "Pays de Bray Services 60": ["s.benard@eco-solidaire.fr", "a.mutlu@eco-solidaire.fr"],
  "Pays de Bray Services 76": ["s.benard@eco-solidaire.fr"],
};

/** Les contrats sans échéance n'ont pas de prévenance à envoyer. */
const OPEN_ENDED_CONTRACT_TYPES = new Set(["CDI", "CDI-Inclusion"]);

/** Date du jour (YYYY-MM-DD) en heure de Paris. */
function parisToday(): string {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
}

/**
 * Normalise une date de contrat en `YYYY-MM-DD`.
 *
 * Les dates sont saisies via le formulaire RH (donc en ISO), mais les contrats
 * importés portent parfois du `JJ/MM/AAAA` : on accepte les deux plutôt que
 * d'ignorer silencieusement une échéance.
 */
function normalizeDate(value: string): string | null {
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const french = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (french) return `${french[3]}-${french[2]}-${french[1]}`;
  return null;
}

/** Nombre de jours entre aujourd'hui et une date `YYYY-MM-DD` (négatif si passée). */
function daysUntil(dateStr: string, today: string): number | null {
  const target = Date.parse(dateStr);
  const now = Date.parse(today);
  if (!Number.isFinite(target) || !Number.isFinite(now)) return null;
  return Math.round((target - now) / 86_400_000);
}

function formatDateFr(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

type PendingNotice = {
  contractId: Id<"hrContracts">;
  recipients: string[];
  /** Palier déclenché (22, 15 ou 3) et paliers à marquer comme couverts. */
  threshold: number;
  coveredThresholds: number[];
  employeeName: string;
  structureLabel: string;
  contractType: string;
  numeroContrat: string;
  poste: string;
  dateDebut: string;
  dateFin: string;
  dateFinLabel: string;
  daysLeft: number;
};

/**
 * Contrats arrivant à échéance et pas encore signalés.
 *
 * Un seul contrat par salarié : le dernier généré avec succès. Un échec de
 * webhook n'a produit aucun document, donc ne compte pas comme contrat.
 */
export const listContractsNeedingEndNotice = internalQuery({
  args: {},
  handler: async (ctx): Promise<PendingNotice[]> => {
    const today = parisToday();
    const employees = await ctx.db.query("hrEmployees").collect();
    const notices: PendingNotice[] = [];

    for (const employee of employees) {
      if (!employee.active) continue;

      const lastContract = await ctx.db
        .query("hrContracts")
        .withIndex("by_employee_and_requestedAt", (q) => q.eq("employeeId", employee._id))
        .order("desc")
        .filter((q) => q.eq(q.field("webhookStatus"), "success"))
        .first();

      if (!lastContract) continue;
      if (OPEN_ENDED_CONTRACT_TYPES.has(lastContract.payload.type_contrat)) continue;

      const dateFin = normalizeDate(lastContract.payload.date_fin_contrat);
      if (!dateFin) continue;

      const daysLeft = daysUntil(dateFin, today);
      if (daysLeft === null || daysLeft < 0) continue;

      // Paliers atteints aujourd'hui, dont ceux qu'un cron en panne aurait sautés.
      const reached = NOTICE_THRESHOLDS.filter((threshold) => daysLeft <= threshold);
      if (reached.length === 0) continue;

      const alreadySent = lastContract.endNoticeSentThresholds ?? [];
      const pending = reached.filter((threshold) => !alreadySent.includes(threshold));
      if (pending.length === 0) continue;

      const recipients = RECIPIENTS_BY_STRUCTURE[employee.structure] ?? [];
      if (recipients.length === 0) continue;

      notices.push({
        contractId: lastContract._id,
        recipients,
        // Le palier le plus urgent atteint : c'est lui qui décrit la situation.
        threshold: Math.min(...pending),
        coveredThresholds: reached,
        employeeName: employee.fullName,
        structureLabel: employee.structure,
        contractType: lastContract.payload.type_contrat,
        numeroContrat: lastContract.payload.numero_contrat ?? "",
        poste: lastContract.payload.poste,
        dateDebut: lastContract.payload.date_debut_contrat,
        dateFin,
        dateFinLabel: formatDateFr(dateFin),
        daysLeft,
      });
    }

    // Le plus urgent d'abord : si un envoi casse, les échéances proches sont parties.
    return notices.sort((a, b) => a.daysLeft - b.daysLeft);
  },
});

export const markEndNoticeSent = internalMutation({
  args: { contractId: v.id("hrContracts"), thresholds: v.array(v.number()) },
  handler: async (ctx, args) => {
    const contract = await ctx.db.get(args.contractId);
    if (!contract) return;
    const merged = Array.from(
      new Set([...(contract.endNoticeSentThresholds ?? []), ...args.thresholds]),
    ).sort((a, b) => b - a);
    await ctx.db.patch(args.contractId, {
      endNoticeSentAt: Date.now(),
      endNoticeSentThresholds: merged,
    });
  },
});

/**
 * Cron quotidien : un email de prévenance par contrat arrivant à échéance,
 * aux responsables de la structure du salarié.
 */
export const sendContractEndNotices = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sent: number }> => {
    const notices: PendingNotice[] = await ctx.runQuery(
      internal.hrContractNotices.listContractsNeedingEndNotice,
      {},
    );

    let sent = 0;
    for (const notice of notices) {
      try {
        await ctx.runAction(internal.mesoutilsEmails.sendContractEndNoticeEmail, {
          to: notice.recipients,
          employeeName: notice.employeeName,
          structureLabel: notice.structureLabel,
          contractType: notice.contractType,
          numeroContrat: notice.numeroContrat,
          poste: notice.poste,
          dateDebut: notice.dateDebut,
          dateFin: notice.dateFin,
          dateFinLabel: notice.dateFinLabel,
          daysLeft: notice.daysLeft,
          threshold: notice.threshold,
        });
        // Marqué seulement après un envoi réussi : un échec sera retenté demain.
        await ctx.runMutation(internal.hrContractNotices.markEndNoticeSent, {
          contractId: notice.contractId,
          thresholds: notice.coveredThresholds,
        });
        sent += 1;
      } catch (error) {
        console.error(
          `Prévenance de fin de contrat impossible pour ${notice.employeeName} :`,
          error,
        );
      }
      // Limite Resend : 2 requêtes/seconde.
      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    return { sent };
  },
});

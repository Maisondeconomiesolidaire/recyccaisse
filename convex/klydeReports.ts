/**
 * Rapports de ventes Klyd.
 *
 * Le chiffre d'affaires se lit sur le stock, pas sur les emails Vinted ni sur
 * les commandes boutique : toute vente, quel que soit son canal, finit par un
 * article en « gagné » avec son prix réellement encaissé. Compter les autres
 * sources en plus reviendrait à compter deux fois la même vente.
 */
import { action, internalQuery, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { requireCrmPermission } from "./lib";
import { bytesToBase64, esc, resendSend } from "./emails";
import { buildPdf, CONTENT_WIDTH, type PdfColor, type PdfElement } from "./pdf";

const PAGE_KEY = "klyde:rapports";
/** Expéditeur : domaine vérifié sur Resend, nom de l'enseigne du rapport. */
function emailFrom(outlet: ReportOutlet) {
  return `${outletName(outlet)} <no-reply@mesoutils.eco-solidaire.fr>`;
}

const INK: PdfColor = [0.11, 0.12, 0.14];
const MUTED: PdfColor = [0.45, 0.47, 0.5];
const HAIRLINE: PdfColor = [0.85, 0.86, 0.88];
const BAND: PdfColor = [0.95, 0.96, 0.97];

export const MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

/** Article vendu, ramené à ce dont un rapport a besoin. */
export type ReportSale = {
  id: string;
  title: string;
  sku?: string;
  outlet: "klyd" | "mobifrip";
  amount: number;
  soldAt: number;
};

/** Enseigne du rapport, ou « toutes » quand les deux sont additionnées. */
export type ReportOutlet = "klyd" | "mobifrip" | null;

const OUTLET_NAMES: Record<"klyd" | "mobifrip", string> = {
  klyd: "Klyd",
  mobifrip: "Mobifrip",
};

/** Coordonnées portées par l'enseigne, quand elles sont connues. */
const OUTLET_ADDRESS: Partial<Record<"klyd" | "mobifrip", string[]>> = {
  mobifrip: ["4 rue de la Prairie", "60650 Lachapelle-aux-Pots"],
};

export function outletName(outlet: ReportOutlet) {
  return outlet ? OUTLET_NAMES[outlet] : "Klyd & Mobifrip";
}

export type SalesReport = {
  year: number;
  /** Enseigne retenue, `null` si le rapport couvre les deux. */
  outlet: ReportOutlet;
  /** 0-11, ou null pour l'année entière. */
  month: number | null;
  label: string;
  revenue: number;
  salesCount: number;
  averageBasket: number;
  /** CA par enseigne. */
  byOutlet: { klyd: number; mobifrip: number };
  /** CA de chaque mois de l'année, index 0 = janvier (toujours 12 entrées). */
  monthly: number[];
  /** Ventes en attente d'encaissement (expédiées, pas encore gagnées). */
  pendingRevenue: number;
  pendingCount: number;
  sales: ReportSale[];
  generatedAt: number;
};

/** Prix encaissé : le prix réel prime sur le prix affiché. */
function saleAmount(item: Doc<"klydeItems">) {
  return item.actualSalePrice ?? item.price ?? 0;
}

/**
 * Date de vente. `soldAt` n'existe que depuis la mise en place des rapports :
 * pour les ventes antérieures, `updatedAt` reste la meilleure approximation
 * disponible.
 */
function saleDate(item: Doc<"klydeItems">) {
  return item.soldAt ?? item.updatedAt;
}

function inParis(ms: number) {
  // Un article vendu le 1er du mois à 00h30 à Paris appartient à ce mois-là,
  // pas au précédent : le découpage suit le fuseau local, pas UTC.
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(ms));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month") - 1, day: value("day") };
}

function formatEuro(amount: number) {
  return `${amount.toFixed(2).replace(".", ",")} €`;
}

function formatDay(ms: number) {
  const { day, month, year } = inParis(ms);
  return `${String(day).padStart(2, "0")}/${String(month + 1).padStart(2, "0")}/${year}`;
}

export function periodLabel(year: number, month: number | null) {
  return month === null ? `Année ${year}` : `${MONTHS[month]} ${year}`;
}

/** Cœur du rapport, partagé par la lecture à l'écran et par l'envoi PDF. */
async function buildReport(
  ctx: QueryCtx,
  year: number,
  month: number | null,
  outlet: ReportOutlet,
): Promise<SalesReport> {
  const won = await ctx.db
    .query("klydeItems")
    .withIndex("by_status", (q) => q.eq("status", "gagne"))
    .collect();

  const monthly = new Array(12).fill(0) as number[];
  const sales: ReportSale[] = [];
  const byOutlet = { klyd: 0, mobifrip: 0 };
  let revenue = 0;

  for (const item of won) {
    const itemOutlet = item.outlet === "mobifrip" ? "mobifrip" : "klyd";
    // Le filtre s'applique aussi a la serie mensuelle : sans cela, les barres
    // et le total du rapport raconteraient deux perimetres differents.
    if (outlet && itemOutlet !== outlet) continue;
    const soldAt = saleDate(item);
    const when = inParis(soldAt);
    if (when.year !== year) continue;
    const amount = saleAmount(item);
    monthly[when.month] += amount;
    if (month !== null && when.month !== month) continue;

    revenue += amount;
    byOutlet[itemOutlet] += amount;
    sales.push({
      id: item._id,
      title: item.title,
      sku: item.sku,
      outlet: itemOutlet,
      amount,
      soldAt,
    });
  }

  // Expédié mais pas encore confirmé : vendu, pas encore encaissé. Distinguer
  // les deux évite de gonfler le chiffre d'affaires d'une période.
  const shipped = await ctx.db
    .query("klydeItems")
    .withIndex("by_status", (q) => q.eq("status", "envoye"))
    .collect();
  const pending = shipped.filter((item) => {
    const itemOutlet = item.outlet === "mobifrip" ? "mobifrip" : "klyd";
    if (outlet && itemOutlet !== outlet) return false;
    const when = inParis(saleDate(item));
    return when.year === year && (month === null || when.month === month);
  });

  sales.sort((a, b) => b.soldAt - a.soldAt);
  return {
    year,
    outlet,
    month,
    label: periodLabel(year, month),
    revenue: Math.round(revenue * 100) / 100,
    salesCount: sales.length,
    averageBasket: sales.length ? Math.round((revenue / sales.length) * 100) / 100 : 0,
    byOutlet: {
      klyd: Math.round(byOutlet.klyd * 100) / 100,
      mobifrip: Math.round(byOutlet.mobifrip * 100) / 100,
    },
    monthly: monthly.map((value) => Math.round(value * 100) / 100),
    pendingRevenue:
      Math.round(pending.reduce((sum, item) => sum + saleAmount(item), 0) * 100) / 100,
    pendingCount: pending.length,
    sales,
    generatedAt: Date.now(),
  };
}

const outletArg = v.optional(
  v.union(v.literal("klyd"), v.literal("mobifrip"), v.null()),
);

export const salesReport = query({
  args: {
    year: v.number(),
    month: v.optional(v.union(v.number(), v.null())),
    outlet: outletArg,
  },
  handler: async (ctx, args): Promise<SalesReport> => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    return buildReport(ctx, args.year, args.month ?? null, args.outlet ?? null);
  },
});

export const reportForEmail = internalQuery({
  args: {
    year: v.number(),
    month: v.union(v.number(), v.null()),
    outlet: v.union(v.literal("klyd"), v.literal("mobifrip"), v.null()),
  },
  handler: async (ctx, args): Promise<SalesReport> =>
    buildReport(ctx, args.year, args.month, args.outlet),
});

/** Années où au moins une vente a été encaissée, la plus récente d'abord. */
export const availableYears = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const won = await ctx.db
      .query("klydeItems")
      .withIndex("by_status", (q) => q.eq("status", "gagne"))
      .collect();
    const years = new Set(won.map((item) => inParis(saleDate(item)).year));
    years.add(inParis(Date.now()).year);
    return [...years].sort((a, b) => b - a);
  },
});

/* ─────────────────────────────── Le PDF ────────────────────────────────── */

/** Nombre de ventes détaillées : au-delà, la page déborde. */
const MAX_DETAIL_ROWS = 16;

export function reportDocument(report: SalesReport): PdfElement[] {
  const rightHalf = CONTENT_WIDTH * 0.5;
  const elements: PdfElement[] = [
    { kind: "text", text: "RAPPORT DE VENTES", size: 22, bold: true, color: INK },
    {
      kind: "text",
      text: outletName(report.outlet),
      size: 13,
      bold: true,
      color: INK,
      x: rightHalf,
      width: rightHalf,
      align: "right",
      inline: true,
    },
    { kind: "text", text: report.label, size: 12, color: MUTED, spaceBefore: 2 },
    // Colonne de droite : coordonnées de l'enseigne puis date d'édition. La
    // première ligne se pose à côté de la période, les suivantes descendent —
    // sinon elles s'écriraient toutes sur la même ligne de base.
    ...([
      ...(report.outlet ? OUTLET_ADDRESS[report.outlet] ?? [] : []),
      `Édité le ${formatDay(report.generatedAt)}`,
    ].map((text, index) => ({
      kind: "text" as const,
      text,
      size: 9,
      color: MUTED,
      x: rightHalf,
      width: rightHalf,
      align: "right" as const,
      inline: index === 0,
    }))),
    { kind: "rule", spaceBefore: 16, color: HAIRLINE },
  ];

  // Trois chiffres clés, en colonnes.
  const kpis: Array<[string, string]> = [
    ["Chiffre d'affaires", formatEuro(report.revenue)],
    ["Ventes", String(report.salesCount)],
    ["Panier moyen", formatEuro(report.averageBasket)],
  ];
  const columnWidth = CONTENT_WIDTH / 3;
  kpis.forEach(([label], index) => {
    elements.push({
      kind: "text",
      text: label.toUpperCase(),
      size: 8,
      bold: true,
      color: MUTED,
      x: index * columnWidth,
      width: columnWidth,
      spaceBefore: index === 0 ? 18 : 0,
      inline: index > 0,
    });
  });
  kpis.forEach(([, value], index) => {
    elements.push({
      kind: "text",
      text: value,
      size: 17,
      bold: true,
      color: INK,
      x: index * columnWidth,
      width: columnWidth,
      spaceBefore: index === 0 ? 6 : 0,
      inline: index > 0,
    });
  });

  const outletLine = [
    report.outlet === null && report.byOutlet.klyd > 0
      ? `Klyd ${formatEuro(report.byOutlet.klyd)}`
      : null,
    report.outlet === null && report.byOutlet.mobifrip > 0
      ? `Mobifrip ${formatEuro(report.byOutlet.mobifrip)}`
      : null,
    report.pendingCount > 0
      ? `En cours d'encaissement : ${formatEuro(report.pendingRevenue)} (${report.pendingCount})`
      : null,
  ].filter((value): value is string => Boolean(value));
  if (outletLine.length > 0) {
    elements.push({
      kind: "text",
      text: outletLine.join("  ·  "),
      size: 9.5,
      color: MUTED,
      spaceBefore: 14,
    });
  }

  // Vue annuelle : le détail mois par mois. Vue mensuelle : les ventes.
  if (report.month === null) {
    elements.push(
      { kind: "band", height: 24, color: BAND, spaceBefore: 26 },
      { kind: "text", text: "MOIS", size: 8.5, bold: true, color: MUTED, x: 10, spaceBefore: 4 },
      {
        kind: "text",
        text: "CHIFFRE D'AFFAIRES",
        size: 8.5,
        bold: true,
        color: MUTED,
        width: CONTENT_WIDTH - 10,
        align: "right",
        inline: true,
      },
    );
    report.monthly.forEach((amount, index) => {
      elements.push(
        {
          kind: "text",
          text: MONTHS[index],
          size: 10,
          color: amount > 0 ? INK : MUTED,
          x: 10,
          spaceBefore: index === 0 ? 12 : 3,
        },
        {
          kind: "text",
          text: formatEuro(amount),
          size: 10,
          bold: amount > 0,
          color: amount > 0 ? INK : MUTED,
          width: CONTENT_WIDTH - 10,
          align: "right",
          inline: true,
        },
      );
    });
  } else {
    elements.push(
      { kind: "band", height: 24, color: BAND, spaceBefore: 26 },
      { kind: "text", text: "ARTICLE", size: 8.5, bold: true, color: MUTED, x: 10, spaceBefore: 4 },
      {
        kind: "text",
        text: "MONTANT",
        size: 8.5,
        bold: true,
        color: MUTED,
        width: CONTENT_WIDTH - 10,
        align: "right",
        inline: true,
      },
    );
    if (report.sales.length === 0) {
      elements.push({
        kind: "text",
        text: "Aucune vente sur la période.",
        size: 10,
        color: MUTED,
        x: 10,
        spaceBefore: 14,
      });
    }
    report.sales.slice(0, MAX_DETAIL_ROWS).forEach((sale, index) => {
      const title = sale.title.length > 52 ? `${sale.title.slice(0, 51)}…` : sale.title;
      elements.push(
        {
          kind: "text",
          text: `${formatDay(sale.soldAt)}   ${title}`,
          size: 9.5,
          color: INK,
          x: 10,
          width: CONTENT_WIDTH * 0.75,
          spaceBefore: index === 0 ? 12 : 3,
        },
        {
          kind: "text",
          text: formatEuro(sale.amount),
          size: 9.5,
          color: INK,
          width: CONTENT_WIDTH - 10,
          align: "right",
          inline: true,
        },
      );
    });
    if (report.sales.length > MAX_DETAIL_ROWS) {
      elements.push({
        kind: "text",
        text: `… et ${report.sales.length - MAX_DETAIL_ROWS} autres ventes.`,
        size: 9,
        color: MUTED,
        x: 10,
        spaceBefore: 8,
      });
    }
  }

  elements.push(
    { kind: "rule", spaceBefore: 14, color: HAIRLINE },
    { kind: "text", text: "Total", size: 12, bold: true, color: INK, x: 10, spaceBefore: 8 },
    {
      kind: "text",
      text: formatEuro(report.revenue),
      size: 14,
      bold: true,
      color: INK,
      width: CONTENT_WIDTH - 10,
      align: "right",
      inline: true,
    },
  );
  return elements;
}

/* ───────────────────────────── Partage par email ───────────────────────── */

function reportEmailHtml(report: SalesReport, message: string) {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:7px 0;font-size:13px;color:#6b7280">${esc(label)}</td>` +
    `<td style="padding:7px 0;font-size:13px;color:#111827;text-align:right;font-weight:600">${esc(value)}</td></tr>`;

  const body = message
    .split(/\n{2,}/)
    .map((block) => esc(block.trim()).replace(/\n/g, "<br>"))
    .filter(Boolean)
    .map(
      (block) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1f2937">${block}</p>`,
    )
    .join("");

  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
    <div style="padding:22px 26px;border-bottom:1px solid #e5e7eb">
      <p style="margin:0;font-size:17px;font-weight:700;color:#111827">Rapport de ventes ${esc(outletName(report.outlet))}</p>
      <p style="margin:4px 0 0;font-size:12px;color:#6b7280">${esc(report.label)}</p>
    </div>
    <div style="padding:24px 26px">
      ${body}
      <table style="width:100%;border-collapse:collapse;margin-top:18px;border-top:1px solid #e5e7eb">
        ${row("Chiffre d'affaires", formatEuro(report.revenue))}
        ${row("Ventes", String(report.salesCount))}
        ${row("Panier moyen", formatEuro(report.averageBasket))}
      </table>
      <p style="margin:18px 0 0;font-size:12px;color:#6b7280">Le rapport détaillé est joint à cet email au format PDF.</p>
    </div>
  </div>
</body></html>`;
}

/** Message d'accompagnement par défaut, modifiable avant l'envoi. */
export function defaultReportMessage(report: SalesReport) {
  const name = outletName(report.outlet);
  return [
    "Bonjour,",
    "",
    `Vous trouverez en pièce jointe le rapport de ventes ${name} pour ${report.label.toLowerCase()}.`,
    "",
    "Bien cordialement,",
    name,
  ].join("\n");
}

export const emailDraft = query({
  args: {
    year: v.number(),
    month: v.optional(v.union(v.number(), v.null())),
    outlet: outletArg,
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const report = await buildReport(ctx, args.year, args.month ?? null, args.outlet ?? null);
    return {
      subject: `Rapport de ventes ${outletName(report.outlet)} — ${report.label}`,
      message: defaultReportMessage(report),
      label: report.label,
      revenue: report.revenue,
      salesCount: report.salesCount,
    };
  },
});

/**
 * Envoie le rapport de la période affichée, en pièce jointe PDF. Le rapport est
 * recalculé ici : le destinataire reçoit l'état réel des ventes au moment de
 * l'envoi, pas ce qu'affichait un écran resté ouvert.
 */
export const sendByEmail = action({
  args: {
    to: v.string(),
    year: v.number(),
    month: v.optional(v.union(v.number(), v.null())),
    outlet: outletArg,
    subject: v.optional(v.string()),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ sentTo: string; label: string }> => {
    await ctx.runQuery(internal.klydeReports.assertCanShare, {});
    const to = args.to.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      throw new Error("Adresse email invalide.");
    }

    const report: SalesReport = await ctx.runQuery(internal.klydeReports.reportForEmail, {
      year: args.year,
      month: args.month ?? null,
      outlet: args.outlet ?? null,
    });
    const pdf = buildPdf(reportDocument(report));
    const subject =
      args.subject?.trim() || `Rapport de ventes ${outletName(report.outlet)} — ${report.label}`;
    const message = args.message?.trim() || defaultReportMessage(report);

    const sent = await resendSend(
      to,
      subject,
      reportEmailHtml(report, message),
      emailFrom(report.outlet),
      [
        {
          filename: `Rapport-${outletName(report.outlet).replace(/\s+/g, "")}-${report.label.replace(/\s+/g, "-")}.pdf`,
          content: bytesToBase64(pdf),
        },
      ],
    );
    if (!sent) throw new Error("L'envoi a échoué. Réessayez dans un instant.");
    return { sentTo: to, label: report.label };
  },
});

export const assertCanShare = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "share");
    return true;
  },
});

/**
 * Factures des ventes Vinted (enseigne Mobifrip).
 *
 * Un vendeur Pro doit joindre une facture au colis. Toutes les données
 * nécessaires sont déjà dans l'email de vente — article, montant, coordonnées
 * de l'acheteur — d'où une génération en un clic depuis la boîte Vinted plutôt
 * qu'une ressaisie dans un tableur.
 */
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCrmPermission } from "./lib";
import { buildPdf, CONTENT_WIDTH, type PdfColor, type PdfElement } from "./pdf";
import { bytesToBase64, esc, resendSend } from "./emails";

const PAGE_KEY = "klyde:vinted";

/**
 * Émetteur des factures — source unique de ses coordonnées.
 *
 * Ces mentions valent identification légale du vendeur : une correction se
 * fait ici et se répercute sur la facture PDF comme sur l'email au client.
 * Volontairement sans logo.
 */
const SELLER = {
  /** Personne morale qui facture. */
  name: "Recyclerie du Pays de Bray",
  /** Enseigne connue de l'acheteur sur Vinted. */
  tradeName: "Mobifrip",
  legalForm: "Association déclarée",
  address: "4 rue de la Prairie",
  city: "60650 Lachapelle-aux-Pots",
  siren: "503 123 044",
  siret: "503 123 044 00011",
  /** Les associations ne sont pas au RCS : l'identifiant RNA en tient lieu. */
  rna: "W601001874",
  rnaDeclaredOn: "21/06/2007",
  vatNumber: "FR62503123044",
  email: "s.maccioni@eco-solidaire.fr",
  phone: "06 52 24 83 39",
};

/** Délai de rétractation retenu : le délai légal, comme sur Vinted. */
const WITHDRAWAL_DAYS = 14;

/**
 * Taux de TVA applicable. Les prix Vinted sont toujours affichés et encaissés
 * toutes taxes comprises : le montant hors taxes se déduit du prix payé, et
 * jamais l'inverse.
 */
const VAT_RATE = 0.2;

/**
 * Ventilation d'un montant TTC. La TVA se calcule par différence pour que
 * `ht + vat` retombe exactement sur le montant encaissé, sans centime perdu
 * dans les arrondis.
 */
export function vatBreakdown(ttc: number) {
  const ht = Math.round((ttc / (1 + VAT_RATE)) * 100) / 100;
  return { ht, vat: Math.round((ttc - ht) * 100) / 100, ttc };
}

/** Plateforme européenne de règlement en ligne des litiges. */
const ODR_URL = "https://ec.europa.eu/consumers/odr";

/** Identification légale, telle qu'elle doit figurer sur une facture. */
function sellerIdentityLines(): string[] {
  return [
    `${SELLER.name} (nom commercial ${SELLER.tradeName}) — ${SELLER.legalForm} · SIREN ${SELLER.siren} · SIRET (siège) ${SELLER.siret}`,
    `RNA ${SELLER.rna} (déclarée le ${SELLER.rnaDeclaredOn}) · TVA ${SELLER.vatNumber}`,
    `${SELLER.address}, ${SELLER.city} · ${SELLER.email} · ${SELLER.phone}`,
  ];
}

/** Expéditeur des emails : domaine vérifié sur Resend, nom d'enseigne. */
const EMAIL_FROM = "Mobifrip <no-reply@mesoutils.eco-solidaire.fr>";

const INK: PdfColor = [0.11, 0.12, 0.14];
const MUTED: PdfColor = [0.45, 0.47, 0.5];
const HAIRLINE: PdfColor = [0.85, 0.86, 0.88];
const BAND: PdfColor = [0.95, 0.96, 0.97];

/** Préfixe de numérotation : « MF-2026-004 ». */
const INVOICE_PREFIX = "MF";

function formatEuro(amount: number) {
  return `${amount.toFixed(2).replace(".", ",")} €`;
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
}

export const getEmail = internalQuery({
  args: { emailId: v.id("klydeVintedEmails") },
  handler: async (ctx, args) => ctx.db.get(args.emailId),
});

/**
 * Réserve (ou renvoie) le numéro de facture d'une vente. Une numérotation
 * continue est une obligation légale : le numéro est donc attribué en base, et
 * jamais recalculé — regénérer le PDF d'une facture existante en conserve le
 * numéro.
 */
export const reserveInvoiceNumber = internalMutation({
  args: { emailId: v.id("klydeVintedEmails") },
  handler: async (ctx, args): Promise<string> => {
    const email = await ctx.db.get(args.emailId);
    if (!email) throw new Error("Email introuvable.");
    if (email.invoiceNumber) return email.invoiceNumber;

    const year = new Date(email.sentAt).getFullYear();
    const prefix = `${INVOICE_PREFIX}-${year}-`;
    const rows = await ctx.db.query("klydeVintedEmails").collect();
    const used = rows
      .map((row) => row.invoiceNumber)
      .filter((number): number is string => Boolean(number?.startsWith(prefix)))
      .map((number) => Number(number.slice(prefix.length)))
      .filter((value) => Number.isFinite(value));
    const next = (used.length ? Math.max(...used) : 0) + 1;

    const invoiceNumber = `${prefix}${String(next).padStart(3, "0")}`;
    await ctx.db.patch(args.emailId, { invoiceNumber });
    return invoiceNumber;
  },
});

export const attachInvoice = internalMutation({
  args: {
    emailId: v.id("klydeVintedEmails"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) throw new Error("Email introuvable.");
    // Une regénération remplace le PDF : l'ancien n'a plus de référence.
    if (email.invoiceStorageId) await ctx.storage.delete(email.invoiceStorageId);
    await ctx.db.patch(args.emailId, {
      invoiceStorageId: args.storageId,
      invoiceGeneratedAt: Date.now(),
    });
  },
});

/**
 * Composition de la facture. Deux colonnes en tête (émetteur à gauche, repères
 * de la facture à droite), un tableau à bandeau, un total détaché : la lecture
 * d'une facture est une convention, la respecter vaut mieux qu'inventer.
 */
export function invoiceDocument(
  email: Doc<"klydeVintedEmails">,
  invoiceNumber: string,
): PdfElement[] {
  const amount = email.amount ?? 0;
  // Le prix Vinted est TTC : c'est de lui que se déduisent le HT et la TVA.
  const totals = vatBreakdown(amount);
  const rightColumnX = CONTENT_WIDTH * 0.52;
  const rightColumnWidth = CONTENT_WIDTH - rightColumnX;

  const elements: PdfElement[] = [
    { kind: "text", text: "FACTURE", size: 26, bold: true, color: INK },
    {
      kind: "text",
      text: SELLER.name,
      size: 13,
      bold: true,
      color: INK,
      x: rightColumnX,
      width: rightColumnWidth,
      align: "right",
      inline: true,
    },
    {
      kind: "text",
      text: `Nom commercial : ${SELLER.tradeName}`,
      size: 9.5,
      color: MUTED,
      x: rightColumnX,
      width: rightColumnWidth,
      align: "right",
      spaceBefore: 4,
    },
    {
      kind: "text",
      text: SELLER.address,
      size: 9.5,
      color: MUTED,
      x: rightColumnX,
      width: rightColumnWidth,
      align: "right",
    },
    {
      kind: "text",
      text: SELLER.city,
      size: 9.5,
      color: MUTED,
      x: rightColumnX,
      width: rightColumnWidth,
      align: "right",
    },
    {
      kind: "text",
      text: `${SELLER.email} · ${SELLER.phone}`,
      size: 9.5,
      color: MUTED,
      x: rightColumnX,
      width: rightColumnWidth,
      align: "right",
    },
    { kind: "rule", spaceBefore: 18, color: HAIRLINE },
  ];

  // Bloc gauche : repères de la facture. Bloc droit : le client.
  const meta: Array<[string, string]> = [
    ["Facture n°", invoiceNumber],
    ["Date", formatDate(email.sentAt)],
  ];
  if (email.orderRef) meta.push(["Commande Vinted", email.orderRef]);

  const buyerLines = [
    email.buyerName,
    email.buyerName && email.buyerAddress
      ? email.buyerAddress.replace(`${email.buyerName},`, "").trim()
      : email.buyerAddress,
    email.buyerEmail,
    !email.buyerName && !email.buyerAddress && email.buyer
      ? `Acheteur Vinted : ${email.buyer}`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  elements.push(
    { kind: "text", text: "FACTURÉ À", size: 8, bold: true, color: MUTED, spaceBefore: 16 },
    {
      kind: "text",
      text: "RÉFÉRENCES",
      size: 8,
      bold: true,
      color: MUTED,
      x: rightColumnX,
      inline: true,
    },
  );

  // Les deux colonnes avancent ligne à ligne : la plus courte se contente
  // d'une ligne vide, pour que le curseur reste commun aux deux.
  const rows = Math.max(buyerLines.length, meta.length);
  for (let index = 0; index < rows; index += 1) {
    const buyerLine = buyerLines[index];
    const metaLine = meta[index];
    elements.push({
      kind: "text",
      text: buyerLine ?? "",
      size: 10,
      bold: index === 0,
      color: index === 0 ? INK : MUTED,
      width: rightColumnX - 12,
      spaceBefore: index === 0 ? 6 : 0,
    });
    if (metaLine) {
      elements.push(
        {
          kind: "text",
          text: metaLine[0],
          size: 9.5,
          color: MUTED,
          x: rightColumnX,
          inline: true,
        },
        {
          kind: "text",
          text: metaLine[1],
          size: 9.5,
          bold: true,
          color: INK,
          x: rightColumnX,
          width: rightColumnWidth,
          align: "right",
          inline: true,
        },
      );
    }
  }

  // Tableau des postes : bandeau d'en-tête, puis la ligne de l'article.
  elements.push(
    // Le bandeau ne déplace pas le curseur : l'en-tête du tableau se pose
    // dedans, à 15 points sous son bord supérieur.
    { kind: "band", height: 24, color: BAND, spaceBefore: 34 },
    {
      kind: "text",
      text: "DÉSIGNATION",
      size: 8.5,
      bold: true,
      color: MUTED,
      x: 10,
      spaceBefore: 4,
    },
    {
      kind: "text",
      text: "MONTANT HT",
      size: 8.5,
      bold: true,
      color: MUTED,
      width: CONTENT_WIDTH - 10,
      align: "right",
      inline: true,
    },
    {
      kind: "text",
      text: email.itemTitle ?? "Article d'occasion",
      size: 10,
      color: INK,
      x: 10,
      width: CONTENT_WIDTH * 0.7,
      spaceBefore: 14,
    },
    {
      kind: "text",
      text: formatEuro(totals.ht),
      size: 10,
      color: INK,
      width: CONTENT_WIDTH - 10,
      align: "right",
      inline: true,
    },
    { kind: "rule", spaceBefore: 12, color: HAIRLINE },
    { kind: "text", text: "Total HT", size: 10, color: MUTED, x: 10, spaceBefore: 8 },
    {
      kind: "text",
      text: formatEuro(totals.ht),
      size: 10,
      color: INK,
      width: CONTENT_WIDTH - 10,
      align: "right",
      inline: true,
    },
    {
      kind: "text",
      text: `TVA ${Math.round(VAT_RATE * 100)} %`,
      size: 10,
      color: MUTED,
      x: 10,
      spaceBefore: 2,
    },
    {
      kind: "text",
      text: formatEuro(totals.vat),
      size: 10,
      color: INK,
      width: CONTENT_WIDTH - 10,
      align: "right",
      inline: true,
    },
    {
      kind: "text",
      text: "Total TTC",
      size: 12,
      bold: true,
      color: INK,
      x: 10,
      spaceBefore: 10,
    },
    {
      kind: "text",
      text: formatEuro(totals.ttc),
      size: 14,
      bold: true,
      color: INK,
      width: CONTENT_WIDTH - 10,
      align: "right",
      inline: true,
    },
    { kind: "rule", spaceBefore: 12, color: HAIRLINE },
  );

  const context = [
    "Vente réalisée sur Vinted.",
    email.buyer ? `Acheteur : ${email.buyer}` : null,
    email.trackingNumber ? `Suivi : ${email.trackingNumber}` : null,
  ].filter((value): value is string => Boolean(value));
  elements.push({
    kind: "text",
    text: context.join(" · "),
    size: 8.5,
    color: MUTED,
    spaceBefore: 20,
  });
  elements.push({
    kind: "text",
    text: `Droit de rétractation : ${WITHDRAWAL_DAYS} jours à compter de la réception, dans les conditions prévues par Vinted.`,
    size: 8,
    color: MUTED,
    spaceBefore: 2,
  });

  // Identification légale du vendeur, en pied de page.
  elements.push({ kind: "rule", spaceBefore: 18, color: HAIRLINE });
  sellerIdentityLines().forEach((line, index) => {
    elements.push({
      kind: "text",
      text: line,
      size: 7.5,
      color: MUTED,
      spaceBefore: index === 0 ? 4 : -2,
    });
  });

  return elements;
}

/** Corps par défaut du message d'accompagnement, modifiable avant envoi. */
export function defaultInvoiceMessage(
  email: Doc<"klydeVintedEmails">,
  invoiceNumber: string,
): string {
  const buyer = email.buyerName ?? email.buyer ?? "";
  const item = email.itemTitle ?? "votre article";
  return [
    buyer ? `Bonjour ${buyer},` : "Bonjour,",
    "",
    `Merci pour votre achat sur Vinted. Vous trouverez en pièce jointe la facture ${invoiceNumber} correspondant à votre commande « ${item} ».`,
    "",
    "Votre colis part dans les meilleurs délais. N'hésitez pas à répondre à ce message pour toute question.",
    "",
    "Bien cordialement,",
    SELLER.name,
  ].join("\n");
}

/** Objet par défaut du message. */
export function defaultInvoiceSubject(invoiceNumber: string): string {
  return `Votre facture ${invoiceNumber} — ${SELLER.name}`;
}

/**
 * Habillage HTML du message. Le vendeur ne modifie que le texte : l'ossature
 * (en-tête, récapitulatif, pied) reste posée ici, donc un email envoyé après
 * modification est toujours lisible et complet.
 */
/**
 * Mentions légales du pied d'email : identification du vendeur, rétractation,
 * garanties, réclamations et lien ODR. En petit et en retrait — ce sont des
 * informations obligatoires, pas le propos du message.
 */
function legalFooterHtml(): string {
  const lines = [
    ...sellerIdentityLines(),
    `Droit de rétractation : ${WITHDRAWAL_DAYS} jours à compter de la réception de l'article, dans les conditions prévues par Vinted. Les frais de retour suivent la politique Vinted applicable à la commande.`,
    `Garanties légales de conformité et contre les vices cachés : pour les exercer, écrivez à ${SELLER.email} ou appelez le ${SELLER.phone}.`,
    `Réclamations : ${SELLER.email}. Plateforme européenne de règlement en ligne des litiges : ${ODR_URL}`,
  ];
  return `<div style="padding:16px 26px 20px;border-top:1px solid #e5e7eb;background:#fbfbfc">
      ${lines
        .map(
          (line) =>
            `<p style="margin:0 0 5px;font-size:10px;line-height:1.5;font-style:italic;color:#9ca3af">${esc(line)}</p>`,
        )
        .join("")}
    </div>`;
}

function invoiceEmailHtml(
  email: Doc<"klydeVintedEmails">,
  invoiceNumber: string,
  message: string,
): string {
  const paragraphs = message
    .split(/\n{2,}/)
    .map((block) => esc(block.trim()).replace(/\n/g, "<br>"))
    .filter(Boolean)
    .map(
      (block) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1f2937">${block}</p>`,
    )
    .join("");

  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;font-size:13px;color:#6b7280">${esc(label)}</td>` +
    `<td style="padding:6px 0;font-size:13px;color:#111827;text-align:right;font-weight:600">${esc(value)}</td></tr>`;

  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
    <div style="padding:22px 26px;border-bottom:1px solid #e5e7eb">
      <p style="margin:0;font-size:17px;font-weight:700;color:#111827">${esc(SELLER.name)}</p>
      <p style="margin:4px 0 0;font-size:12px;color:#6b7280">${esc(SELLER.address)} · ${esc(SELLER.city)}</p>
    </div>
    <div style="padding:24px 26px">
      ${paragraphs}
      <table style="width:100%;border-collapse:collapse;margin-top:18px;border-top:1px solid #e5e7eb">
        ${row("Facture", invoiceNumber)}
        ${row("Article", email.itemTitle ?? "Article d'occasion")}
        ${row("Total HT", formatEuro(vatBreakdown(email.amount ?? 0).ht))}
        ${row(`TVA ${Math.round(VAT_RATE * 100)} %`, formatEuro(vatBreakdown(email.amount ?? 0).vat))}
        ${row("Total TTC", formatEuro(email.amount ?? 0))}
      </table>
      <p style="margin:18px 0 0;font-size:12px;color:#6b7280">La facture est jointe à cet email au format PDF.</p>
    </div>
    ${legalFooterHtml()}
  </div>
</body></html>`;
}

/**
 * Génère la facture PDF d'une vente et la range dans le stockage Convex.
 *
 * Déclenchée à l'import de l'email, jamais à la main : une vente Vinted donne
 * toujours lieu à une facture, et la produire d'office évite qu'une commande
 * parte sans son justificatif parce que personne n'a cliqué.
 */
export const generateForEmail = internalAction({
  args: { emailId: v.id("klydeVintedEmails") },
  handler: async (ctx, args): Promise<{ invoiceNumber: string } | null> => {
    const email: Doc<"klydeVintedEmails"> | null = await ctx.runQuery(
      internal.klydeInvoices.getEmail,
      { emailId: args.emailId },
    );
    if (!email || email.kind !== "vente") return null;

    const invoiceNumber: string = await ctx.runMutation(
      internal.klydeInvoices.reserveInvoiceNumber,
      { emailId: args.emailId },
    );
    const pdf = buildPdf(invoiceDocument(email, invoiceNumber));
    const storageId: Id<"_storage"> = await ctx.storage.store(
      new Blob([pdf as unknown as BlobPart], { type: "application/pdf" }),
    );
    await ctx.runMutation(internal.klydeInvoices.attachInvoice, {
      emailId: args.emailId,
      storageId,
    });
    return { invoiceNumber };
  },
});

export const assertCanGenerate = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "update");
    return true;
  },
});

/**
 * Brouillon du message d'accompagnement : destinataire, objet et texte
 * pré-remplis. Le vendeur relit et corrige avant l'envoi — l'email au client
 * est le seul geste de cette page qui sorte de l'entreprise.
 */
export const emailDraft = query({
  args: { emailId: v.id("klydeVintedEmails") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const email = await ctx.db.get(args.emailId);
    if (!email) return null;
    const invoiceNumber = email.invoiceNumber ?? "";
    return {
      to: email.buyerEmail ?? "",
      subject: defaultInvoiceSubject(invoiceNumber),
      message: defaultInvoiceMessage(email, invoiceNumber),
      invoiceNumber,
      hasInvoice: Boolean(email.invoiceStorageId),
      sentAt: email.invoiceSentAt ?? null,
      sentTo: email.invoiceSentTo ?? null,
    };
  },
});

export const markInvoiceSent = internalMutation({
  args: { emailId: v.id("klydeVintedEmails"), to: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.emailId, {
      invoiceSentAt: Date.now(),
      invoiceSentTo: args.to,
    });
  },
});

/**
 * Envoie la facture au client, en pièce jointe d'un message d'accompagnement.
 * Le texte vient du formulaire ; l'ossature HTML et le récapitulatif sont
 * ajoutés ici, pour qu'un message raccourci reste un email complet.
 */
export const sendByEmail = action({
  args: {
    emailId: v.id("klydeVintedEmails"),
    to: v.string(),
    subject: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args): Promise<{ sentTo: string }> => {
    await ctx.runQuery(internal.klydeInvoices.assertCanGenerate, {});
    const email: Doc<"klydeVintedEmails"> | null = await ctx.runQuery(
      internal.klydeInvoices.getEmail,
      { emailId: args.emailId },
    );
    if (!email) throw new Error("Email introuvable.");
    if (!email.invoiceStorageId || !email.invoiceNumber) {
      throw new Error("Générez d'abord la facture.");
    }

    const to = args.to.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      throw new Error("Adresse email du client invalide.");
    }
    const subject = args.subject.trim() || defaultInvoiceSubject(email.invoiceNumber);
    // Un message vidé par mégarde repart sur le texte type : mieux vaut un
    // message convenu qu'un email sans un mot d'explication.
    const message = args.message.trim() || defaultInvoiceMessage(email, email.invoiceNumber);

    const blob = await ctx.storage.get(email.invoiceStorageId);
    if (!blob) throw new Error("Facture introuvable dans le stockage.");
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const sent = await resendSend(
      to,
      subject,
      invoiceEmailHtml(email, email.invoiceNumber, message),
      EMAIL_FROM,
      [
        {
          filename: `Facture-${email.invoiceNumber}.pdf`,
          content: bytesToBase64(bytes),
        },
      ],
    );
    if (!sent) throw new Error("L'envoi a échoué. Réessayez dans un instant.");

    await ctx.runMutation(internal.klydeInvoices.markInvoiceSent, {
      emailId: args.emailId,
      to,
    });
    return { sentTo: to };
  },
});

/** Lien de consultation d'une facture déjà générée. */
export const invoiceUrl = query({
  args: { emailId: v.id("klydeVintedEmails") },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const email = await ctx.db.get(args.emailId);
    if (!email?.invoiceStorageId) return null;
    return {
      invoiceNumber: email.invoiceNumber ?? null,
      generatedAt: email.invoiceGeneratedAt ?? null,
      url: await ctx.storage.getUrl(email.invoiceStorageId),
    };
  },
});

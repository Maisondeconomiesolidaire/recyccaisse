import { internalAction } from "./_generated/server";
import { v } from "convex/values";

// Adresse d'expédition. Domaine `mesoutils.groupemes.fr` vérifié sur Resend
// (partagé par toutes les apps de l'écosystème) — meilleure délivrabilité que
// l'ancienne adresse de test onboarding@resend.dev.
const FROM = "Recyclerie <no-reply@mesoutils.eco-solidaire.fr>";

/** URL publique de l'app (liens des emails). À régler via `npx convex env set APP_URL`. */
function appUrl() {
  return (process.env.APP_URL ?? "https://recycapp.groupemes.fr").replace(/\/$/, "");
}

/** URL du déploiement Convex (HTTP actions), pour servir les images d'emails. */
function siteUrl() {
  return (
    process.env.CONVEX_SITE_URL ??
    "https://hip-marten-394.eu-west-1.convex.site"
  ).replace(/\/$/, "");
}

/** URL directe (octets, sans redirection) d'un fichier du stockage Convex. */
export function storageImageUrl(storageId: string) {
  return `${siteUrl()}/email/image?id=${encodeURIComponent(storageId)}`;
}

/** URL du logo (servi depuis le stockage Convex via EMAIL_LOGO_ID). */
function logoUrl() {
  const id = process.env.EMAIL_LOGO_ID;
  return id ? storageImageUrl(id) : `${appUrl()}/recyclerie-logo.png`;
}

const BRAND = "#f1104f";

const TYPE_LABELS: Record<string, string> = {
  aerogommage: "Aérogommage",
  collecte: "Collecte",
  article: "Boutique",
  velo: "Recyclerie",
  livraison: "Livraison",
  depot: "Dépôt en recyclerie",
};

function typeLabel(type: string) {
  return TYPE_LABELS[type] ?? "Demande";
}

export function esc(value: string) {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

function euro(n: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(n);
}

function formatDay(timestamp: number) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  }).format(new Date(timestamp));
}

// ─── Briques de mise en page (bulletproof email HTML) ────────────────────────

/** Bouton « à toute épreuve » (table + lien). */
function button(href: string, label: string, primary = true) {
  const bg = primary ? BRAND : "#ffffff";
  const color = primary ? "#ffffff" : BRAND;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;">
    <tr><td style="border-radius:12px;background:${bg};border:1.5px solid ${BRAND};">
      <a href="${href}" target="_blank" style="display:inline-block;padding:13px 24px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;line-height:1;color:${color};text-decoration:none;border-radius:12px;">${esc(label)}</a>
    </td></tr>
  </table>`;
}

/** Rangée de liens raccourcis vers l'espace client. */
function quickLinks() {
  const base = appUrl();
  const links: Array<[string, string]> = [
    ["Mon compte", `${base}/compte`],
    ["Mes commandes", `${base}/compte/commandes`],
    ["Messagerie", `${base}/compte/messagerie`],
  ];
  const cells = links
    .map(
      ([label, href]) =>
        `<td style="padding:0 6px 8px 0;">${button(href, label, false)}</td>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`;
}

type ArticlePreview = {
  title: string;
  price?: number;
  condition?: string;
  imageUrl?: string;
  href?: string;
};

/** Carte d'aperçu d'un article (image + titre + prix + lien). */
function articleCard(article: ArticlePreview) {
  const img = article.imageUrl
    ? `<td width="120" valign="top" style="width:120px;">
         <img src="${article.imageUrl}" width="120" height="120" alt="" style="display:block;width:120px;height:120px;object-fit:cover;border-radius:14px 0 0 14px;" />
       </td>`
    : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #ece9e4;border-radius:16px;overflow:hidden;background:#fffdfb;">
    <tr>
      ${img}
      <td valign="top" style="padding:16px 18px;">
        <p style="margin:0 0 4px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#18181b;">${esc(article.title)}</p>
        ${article.condition ? `<p style="margin:0 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#a1a1aa;">${esc(article.condition)}</p>` : ""}
        ${article.price != null ? `<p style="margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:17px;font-weight:800;color:${BRAND};">${euro(article.price)}</p>` : ""}
        ${article.href ? button(article.href, "Voir l'article", false) : ""}
      </td>
    </tr>
  </table>`;
}

/**
 * Encart « ne pas répondre » affiché en bas des emails clients.
 * Volontairement large et contrasté : l'adresse d'envoi ne reçoit rien, tout
 * doit passer par l'espace client (photos, réponses, documents).
 */
function noReplyNotice() {
  const base = appUrl();
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:26px 0 0;border:2px solid ${BRAND};border-radius:16px;background:#fff5f7;">
    <tr>
      <td class="px" style="padding:22px 24px;">
        <p style="margin:0 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;line-height:1.35;color:${BRAND};">
          ⚠️ Merci de ne pas répondre à cet email
        </p>
        <p style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;line-height:1.6;color:#3f3f46;">
          Cette adresse d'envoi ne reçoit aucun message : une réponse ici ne sera
          jamais lue par notre équipe.
        </p>
        <p style="margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3f3f46;">
          <strong>Tout se passe depuis votre espace client</strong> : répondre à
          nos messages, ajouter des photos ou des documents, suivre l'avancement
          de votre demande. Vous y retrouvez l'historique complet de vos échanges
          avec la Recyclerie, au même endroit.
        </p>
        ${button(`${base}/compte/messagerie`, "Accéder à mon espace client")}
      </td>
    </tr>
  </table>`;
}

/** Horaires de la recyclerie, du lundi au dimanche. */
const SHOP_HOURS: Array<[string, string | null]> = [
  ["Lundi", null],
  ["Mardi", "14h00 – 17h00"],
  ["Mercredi", "14h00 – 17h00"],
  ["Jeudi", "14h00 – 17h00"],
  ["Vendredi", "14h00 – 17h00"],
  ["Samedi", "14h00 – 17h00"],
  ["Dimanche", null],
];

const SHOP_ADDRESS = "4 Rue de la Prairie, 60650 Lachapelle-aux-Pots";
const SHOP_PHONE = "03 75 15 04 78";

/**
 * Rappel « click & collect » : l'achat en ligne se retire sur place, donc le
 * client a besoin de l'adresse et des horaires dans l'email de confirmation.
 */
function clickAndCollectNotice() {
  const rows = SHOP_HOURS.map(([day, hours]) => {
    const closed = hours === null;
    return `<tr>
      <td style="padding:5px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:${closed ? "#a1a1aa" : "#3f3f46"};">${day}</td>
      <td align="right" style="padding:5px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:${closed ? "400" : "700"};line-height:1.5;color:${closed ? "#a1a1aa" : "#18181b"};">${closed ? "Fermé" : hours}</td>
    </tr>`;
  }).join("");

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:26px 0 0;border:1px solid #e4e4e7;border-radius:16px;background:#fafafa;">
    <tr>
      <td class="px" style="padding:22px 24px;">
        <p style="margin:0 0 6px;font-family:Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;line-height:1.35;color:#18181b;">
          🛍️ Retrait en click &amp; collect
        </p>
        <p style="margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3f3f46;">
          Votre commande est payée : il ne reste plus qu'à venir la chercher à la
          recyclerie. Il n'y a pas de livraison, et rien à régler sur place.
        </p>
        <p style="margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3f3f46;">
          <strong>La Recyclerie du Pays de Bray</strong><br/>
          ${esc(SHOP_ADDRESS)}<br/>
          ${esc(SHOP_PHONE)}
        </p>
        <p style="margin:0 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#71717a;">
          Horaires d'ouverture
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          ${rows}
        </table>
      </td>
    </tr>
  </table>`;
}

/** Délai laissé au client pour venir chercher un article payé en ligne. */
export const PICKUP_DEADLINE_DAYS = 5;

/**
 * Rappel du délai de retrait, affiché uniquement sur les commandes payées en
 * ligne : passé ce délai l'article est remboursé et remis en vente.
 */
function pickupDeadlineNotice(deadline?: number) {
  const dateLine = deadline
    ? `<p style="margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;line-height:1.6;color:#3f3f46;">
        À retirer avant le ${formatDay(deadline)}.
      </p>`
    : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:26px 0 0;border:2px solid #f59e0b;border-radius:16px;background:#fffbeb;">
    <tr>
      <td class="px" style="padding:22px 24px;">
        <p style="margin:0 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;line-height:1.35;color:#b45309;">
          ⏳ Vous avez ${PICKUP_DEADLINE_DAYS} jours pour retirer votre article
        </p>
        ${dateLine}
        <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3f3f46;">
          Passé ce délai, votre commande sera <strong>remboursée</strong> et
          l'article <strong>remis en vente</strong> en boutique et en ligne.
          Si vous ne pouvez pas venir à temps, prévenez-nous depuis votre espace
          client : nous trouverons une solution.
        </p>
      </td>
    </tr>
  </table>`;
}

/** Gabarit complet : préheader, en-tête (logo), contenu, pied de page. */
function shell(opts: {
  preheader: string;
  heading: string;
  intro: string;
  contentHtml?: string;
  /** "staff" retire l'encart « ne pas répondre » (interne, pas d'espace client). */
  audience?: "client" | "staff";
}) {
  const base = appUrl();
  const notice = opts.audience === "staff" ? "" : noReplyNotice();
  return `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <style>
      @media (max-width:600px){
        .container{width:100% !important;}
        .px{padding-left:20px !important;padding-right:20px !important;}
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f4f1ec;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(opts.preheader)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f1ec;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" class="container" style="width:600px;max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #ece9e4;box-shadow:0 10px 40px rgba(24,24,27,0.06);">
          <!-- En-tête -->
          <tr>
            <td style="background:linear-gradient(135deg,#ffffff,#fff7ef,#ffe9d6);padding:22px 28px;border-bottom:1px solid #f1ece5;">
              <a href="${base}/boutique" target="_blank" style="text-decoration:none;">
                <img src="${logoUrl()}" height="40" alt="Recyclerie" style="display:block;height:40px;" />
              </a>
            </td>
          </tr>
          <!-- Contenu -->
          <tr>
            <td class="px" style="padding:30px 32px;">
              <h1 style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:22px;line-height:1.25;color:#18181b;">${esc(opts.heading)}</h1>
              <p style="margin:0 0 18px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#3f3f46;">${opts.intro}</p>
              ${opts.contentHtml ?? ""}
              ${notice}
            </td>
          </tr>
          <!-- Pied de page -->
          <tr>
            <td class="px" style="padding:22px 32px;background:#faf8f5;border-top:1px solid #f1ece5;">
              <p style="margin:0 0 6px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#52525b;">Recyclerie</p>
              <p style="margin:0 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#a1a1aa;">
                4 rue de la prairie, 60650 Lachapelle-aux-Pots<br/>
                Réemploi, collecte, aérogommage &amp; atelier vélo
              </p>
              <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#c4c0b8;">
                Message automatique envoyé par la Recyclerie.
              </p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** Pièce jointe Resend : contenu en base64. */
export type EmailAttachment = { filename: string; content: string };

/** Encode des octets en base64 (par blocs, pour rester léger en mémoire). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
type ResendSendOptions = { bcc?: string[] };

export async function resendSend(
  to: string | string[],
  subject: string,
  html: string,
  from: string = FROM,
  attachments?: EmailAttachment[],
  options?: ResendSendOptions,
) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("RESEND_API_KEY non configurée — email ignoré.");
    return false;
  }
  // Un SEUL appel Resend, même pour plusieurs destinataires (évite de dépasser
  // la limite de 2 requêtes/seconde de Resend qui faisait silencieusement
  // échouer une partie des emails managers).
  const recipients = (Array.isArray(to) ? to : [to])
    .map((email) => email.trim())
    .filter(Boolean);
  if (recipients.length === 0) return false;
  const bcc = (options?.bcc ?? [])
    .map((email) => email.trim())
    .filter(Boolean);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: recipients,
      subject,
      html,
      ...(bcc.length > 0 ? { bcc } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    }),
  });

  if (!response.ok) {
    console.error(
      `Resend (${response.status}) :`,
      (await response.text()).slice(0, 300),
    );
    return false;
  }

  return true;
}

const articleArg = v.optional(
  v.object({
    title: v.string(),
    price: v.optional(v.number()),
    condition: v.optional(v.string()),
    imageStorageId: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    articleId: v.optional(v.string()),
  }),
);

function buildArticleCard(
  article:
    | {
        title: string;
        price?: number;
        condition?: string;
        imageStorageId?: string;
        imageUrl?: string;
        articleId?: string;
      }
    | undefined,
) {
  if (!article) return "";
  const href = article.articleId
    ? `${appUrl()}/boutique/${article.articleId}`
    : undefined;
  const imageUrl = article.imageStorageId
    ? storageImageUrl(article.imageStorageId)
    : article.imageUrl;
  return `<div style="margin:0 0 22px;">${articleCard({
    title: article.title,
    price: article.price,
    condition: article.condition,
    imageUrl,
    href,
  })}</div>`;
}

// ─── Emails transactionnels ──────────────────────────────────────────────────

/** Confirmation à la réception d'une nouvelle demande. */
export const sendRequestConfirmation = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    reference: v.string(),
    type: v.string(),
    requestId: v.string(),
    article: articleArg,
    /** Commande réglée en ligne : le message parle d'achat, pas de demande. */
    paid: v.optional(v.boolean()),
    /** Date limite de retrait (ms), pour les commandes payées. */
    pickupDeadline: v.optional(v.number()),
  },
  handler: async (
    _ctx,
    { email, name, reference, type, requestId, article, paid, pickupDeadline },
  ) => {
    const label = typeLabel(type);
    const orderUrl = `${appUrl()}/compte/commandes/${requestId}`;
    const html = shell({
      preheader: paid
        ? `Commande #${reference} confirmée — à retirer en click & collect sous ${PICKUP_DEADLINE_DAYS} jours.`
        : `Votre demande ${label} #${reference} est bien enregistrée.`,
      heading: paid
        ? "Votre commande est confirmée 🎉"
        : "Votre demande est bien enregistrée 🎉",
      intro: paid
        ? `Bonjour ${esc(name)},<br/><br/>Votre paiement est bien reçu et votre commande <strong>#${esc(reference)}</strong> est confirmée. C'est une commande en <strong>click &amp; collect</strong> : votre article vous attend à la recyclerie, aux horaires d'ouverture indiqués plus bas.`
        : `Bonjour ${esc(name)},<br/><br/>Nous avons bien reçu votre demande <strong>${esc(label)}</strong> (référence <strong>#${esc(reference)}</strong>). Notre équipe la traite et revient vers vous très prochainement.`,
      contentHtml: `
        ${buildArticleCard(article)}
        <div style="margin:0 0 22px;">${button(orderUrl, paid ? "Voir ma commande" : "Suivre ma demande")}</div>
        ${paid ? clickAndCollectNotice() : ""}
        ${paid ? pickupDeadlineNotice(pickupDeadline) : ""}
        <p style="margin:22px 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#71717a;">Accès rapides :</p>
        ${quickLinks()}
      `,
    });
    await resendSend(
      email,
      paid
        ? `Commande confirmée · #${reference} · à retirer sous ${PICKUP_DEADLINE_DAYS} jours`
        : `Demande bien reçue · ${label} #${reference}`,
      html,
    );
  },
});

/** Staff prévenu à chaque nouvelle demande (collecte, article, vélo, etc.). */
const NEW_REQUEST_STAFF_EMAILS = [
  "accueil.recyclerie@eco-solidaire.fr",
  "v.horcholle@eco-solidaire.fr",
  "o.dalencourt@eco-solidaire.fr",
];

const AEROGOMMAGE_STAFF_EMAILS = [
  ...NEW_REQUEST_STAFF_EMAILS,
  "e.carette@eco-solidaire.fr",
];

/** Lien de paiement envoyé au client depuis le CRM. */
export const sendPaymentLink = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    amount: v.number(),
    url: v.string(),
    articleTitles: v.array(v.string()),
  },
  handler: async (_ctx, { email, name, amount, url, articleTitles }) => {
    const list = articleTitles.length
      ? `<ul style="margin:0 0 22px;padding-left:20px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#3f3f46;">
          ${articleTitles.map((title) => `<li>${esc(title)}</li>`).join("")}
        </ul>`
      : "";
    const html = shell({
      preheader: `Réglez votre commande en ligne : ${euro(amount)}.`,
      heading: "Votre lien de paiement",
      intro: `Bonjour ${esc(name || "")},<br/><br/>Voici le lien pour régler votre commande en ligne, d'un montant de <strong>${euro(amount)}</strong>. Le paiement est sécurisé et ne prend qu'une minute.`,
      contentHtml: `
        ${list}
        <div style="margin:0 0 22px;">${button(url, `Payer ${euro(amount)}`)}</div>
        <p style="margin:0 0 18px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#71717a;">
          Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br/>
          <span style="word-break:break-all;color:${BRAND};">${esc(url)}</span>
        </p>
        ${pickupDeadlineNotice()}
      `,
    });
    await resendSend(email, `Votre lien de paiement · ${euro(amount)}`, html);
  },
});

export const sendNewRequestToStaff = internalAction({
  args: {
    type: v.string(),
    reference: v.string(),
    customerName: v.string(),
    article: articleArg,
  },
  handler: async (_ctx, { type, reference, customerName, article }) => {
    const label = typeLabel(type);
    const html = shell({
      preheader: `Nouvelle demande ${label} de ${customerName} (#${reference}).`,
      audience: "staff",
      heading: "Nouvelle demande reçue",
      intro: `Une nouvelle demande <strong>${esc(label)}</strong> vient d'être créée par <strong>${esc(customerName)}</strong> (référence <strong>#${esc(reference)}</strong>).`,
      contentHtml: `
        ${buildArticleCard(article)}
        <div style="margin:0 0 22px;">${button(`${appUrl()}/crm/notifications`, "Voir la demande")}</div>
      `,
    });
    const recipients =
      type === "aerogommage" ? AEROGOMMAGE_STAFF_EMAILS : NEW_REQUEST_STAFF_EMAILS;
    await resendSend(recipients, `Nouvelle demande · ${label} #${reference}`, html);
  },
});

/** Notification au client d'un nouveau message du staff. */
export const sendNewMessage = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    reference: v.string(),
    type: v.string(),
    requestId: v.string(),
    snippet: v.string(),
  },
  handler: async (_ctx, { email, name, reference, type, requestId, snippet }) => {
    const label = typeLabel(type);
    const conversationUrl = `${appUrl()}/compte/messagerie`;
    void requestId;
    const html = shell({
      preheader: `Nouveau message concernant votre demande ${label} #${reference}.`,
      heading: "Vous avez reçu un nouveau message 💬",
      intro: `Bonjour ${esc(name)},<br/><br/>L'équipe Recyclerie vous a écrit au sujet de votre demande <strong>${esc(label)}</strong> (référence <strong>#${esc(reference)}</strong>).`,
      contentHtml: `
        <blockquote style="margin:0 0 22px;padding:14px 18px;background:#faf8f5;border-left:3px solid ${BRAND};border-radius:10px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3f3f46;">${esc(snippet)}</blockquote>
        <div style="margin:0 0 22px;">${button(conversationUrl, "Répondre au message")}</div>
        <p style="margin:0 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#71717a;">Accès rapides :</p>
        ${quickLinks()}
      `,
    });
    await resendSend(email, `Nouveau message · ${label} #${reference}`, html);
  },
});

/** Demande de photos au client (déclenchée par le staff depuis le CRM). */
export const sendPhotoRequest = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    reference: v.string(),
    type: v.string(),
    requestId: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (_ctx, { email, name, reference, type, requestId, note }) => {
    const label = typeLabel(type);
    const url = `${appUrl()}/compte/commandes/${requestId}`;
    const html = shell({
      preheader: `Nous avons besoin de photos pour votre demande ${label} #${reference}.`,
      heading: "Pouvez-vous nous envoyer des photos ? 📸",
      intro: `Bonjour ${esc(name)},<br/><br/>Pour avancer sur votre demande <strong>${esc(label)}</strong> (référence <strong>#${esc(reference)}</strong>), notre équipe a besoin de quelques photos.`,
      contentHtml: `
        ${note ? `<blockquote style="margin:0 0 20px;padding:14px 18px;background:#faf8f5;border-left:3px solid ${BRAND};border-radius:10px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3f3f46;">${esc(note)}</blockquote>` : ""}
        <p style="margin:0 0 18px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3f3f46;">Cliquez ci-dessous pour importer vos photos directement dans votre demande, dans l'onglet <strong>Documents</strong> :</p>
        <div style="margin:0 0 22px;">${button(url, "Ajouter mes photos")}</div>
        <p style="margin:0 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#71717a;">Accès rapides :</p>
        ${quickLinks()}
      `,
    });
    await resendSend(email, `Photos demandées · ${label} #${reference}`, html);
  },
});

/** Notification au client qu'un document a été ajouté à sa demande. */
export const sendNewDocument = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    reference: v.string(),
    type: v.string(),
    requestId: v.string(),
    docName: v.string(),
  },
  handler: async (_ctx, { email, name, reference, type, requestId, docName }) => {
    const label = typeLabel(type);
    const url = `${appUrl()}/compte/commandes/${requestId}`;
    const html = shell({
      preheader: `Un nouveau document est disponible pour votre demande ${label} #${reference}.`,
      heading: "Un nouveau document est disponible 📄",
      intro: `Bonjour ${esc(name)},<br/><br/>L'équipe Recyclerie a ajouté un document à votre demande <strong>${esc(label)}</strong> (référence <strong>#${esc(reference)}</strong>).`,
      contentHtml: `
        <div style="margin:0 0 20px;padding:14px 18px;background:#faf8f5;border:1px solid #ece9e4;border-radius:12px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#3f3f46;">📎 ${esc(docName)}</div>
        <div style="margin:0 0 22px;">${button(url, "Voir mes documents")}</div>
        <p style="margin:0 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#71717a;">Accès rapides :</p>
        ${quickLinks()}
      `,
    });
    await resendSend(email, `Nouveau document · ${label} #${reference}`, html);
  },
});

/** Notification au client que sa demande a été programmée à une date. */
export const sendScheduled = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    reference: v.string(),
    type: v.string(),
    requestId: v.string(),
    date: v.number(),
    article: articleArg,
  },
  handler: async (
    _ctx,
    { email, name, reference, type, requestId, date, article },
  ) => {
    const label = typeLabel(type);
    const day = formatDay(date);
    const orderUrl = `${appUrl()}/compte/commandes/${requestId}`;
    const html = shell({
      preheader: `Votre demande ${label} #${reference} est programmée pour le ${day}.`,
      heading: "Votre demande est programmée 📅",
      intro: `Bonjour ${esc(name)},<br/><br/>Bonne nouvelle : votre demande <strong>${esc(label)}</strong> (référence <strong>#${esc(reference)}</strong>) est programmée.`,
      contentHtml: `
        <div style="margin:0 0 22px;padding:16px 18px;background:linear-gradient(135deg,#fff7ef,#ffe9d6);border:1px solid #ffe0c4;border-radius:14px;text-align:center;">
          <p style="margin:0 0 4px;font-family:Helvetica,Arial,sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#b45309;">Date d'intervention</p>
          <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;color:${BRAND};text-transform:capitalize;">${esc(day)}</p>
        </div>
        ${buildArticleCard(article)}
        <div style="margin:0 0 22px;">${button(orderUrl, "Voir ma demande")}</div>
        <p style="margin:0 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#71717a;">Accès rapides :</p>
        ${quickLinks()}
      `,
    });
    await resendSend(email, `Intervention programmée · ${label} #${reference}`, html);
  },
});

// ─── Dépôt en recyclerie ─────────────────────────────────────────────────────

/**
 * Rappel envoyé la veille d'un dépôt : mémo de préparation et lien d'annulation
 * pour libérer le créneau si le client a un empêchement.
 */
export const sendDepotReminder = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    requestId: v.string(),
    siteLabel: v.string(),
    slotStart: v.number(),
  },
  handler: async (_ctx, { email, name, requestId, siteLabel, slotStart }) => {
    const day = formatDay(slotStart);
    const hour = new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Paris",
    }).format(new Date(slotStart));
    const orderUrl = `${appUrl()}/compte/commandes/${requestId}`;
    const memo = [
      "Vérifiez que vos objets sont propres, complets et réutilisables.",
      'Pensez à prendre des "gros bras" avec vous si vous avez des meubles lourds à décharger.',
      "Merci d'arriver à l'heure pour garantir la fluidité de notre accueil.",
    ]
      .map(
        (line) =>
          `<tr><td style="padding:4px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:#3f3f46;">• ${esc(line)}</td></tr>`,
      )
      .join("");

    const html = shell({
      preheader: `Rappel : votre dépôt est prévu demain à ${hour}.`,
      heading: "Petit rappel : c'est demain !",
      intro: `Bonjour ${esc(name)},<br/><br/>Petit rappel ! Nous vous attendons demain pour votre dépôt d'objets.`,
      contentHtml: `
        <div style="margin:0 0 22px;padding:16px 18px;background:linear-gradient(135deg,#fff7ef,#ffe9d6);border:1px solid #ffe0c4;border-radius:14px;text-align:center;">
          <p style="margin:0 0 4px;font-family:Helvetica,Arial,sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#b45309;">Votre créneau</p>
          <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;color:${BRAND};text-transform:capitalize;">${esc(day)} à ${esc(hour)}</p>
          <p style="margin:6px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#3f3f46;">${esc(siteLabel)}</p>
        </div>
        <p style="margin:0 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#18181b;">Un rapide mémo avant votre venue :</p>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;">${memo}</table>
        <p style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:#3f3f46;">
          Un empêchement ? Merci d'annuler votre créneau, pour libérer la place.
        </p>
        <div style="margin:0 0 22px;">${button(orderUrl, "Annuler mon créneau", false)}</div>
        <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:#3f3f46;">
          À demain, et merci pour votre engagement en faveur du réemploi !<br/>
          L'équipe de la Recyclerie.
        </p>
      `,
    });
    await resendSend(email, `Rappel · votre dépôt demain à ${hour}`, html);
  },
});

// ─── Facturation ─────────────────────────────────────────────────────────────

/** Compta prévenue quand une facture éditée attend son règlement. */
const INVOICE_STAFF_EMAILS = ["l.delepine@eco-solidaire.fr"];

/** Ligne « demande » d'un tableau récapitulatif de factures en attente. */
function invoiceRow(r: {
  reference: string;
  type: string;
  customerName: string;
  amount?: number;
  requestId: string;
}) {
  const amount = r.amount ? euro(r.amount) : "—";
  return `<tr>
    <td style="padding:10px 12px;border-top:1px solid #f1ece5;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#18181b;">#${esc(r.reference)}</td>
    <td style="padding:10px 12px;border-top:1px solid #f1ece5;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#3f3f46;">${esc(typeLabel(r.type))}</td>
    <td style="padding:10px 12px;border-top:1px solid #f1ece5;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#3f3f46;">${esc(r.customerName)}</td>
    <td style="padding:10px 12px;border-top:1px solid #f1ece5;font-family:Helvetica,Arial,sans-serif;font-size:14px;text-align:right;color:#18181b;">${esc(amount)}</td>
  </tr>`;
}

const invoiceRequestArg = v.object({
  reference: v.string(),
  type: v.string(),
  customerName: v.string(),
  amount: v.optional(v.number()),
  requestId: v.string(),
});

/** Une facture vient de passer en « éditée » : règlement en attente. */
export const sendInvoicePendingPayment = internalAction({
  args: invoiceRequestArg,
  handler: async (_ctx, request) => {
    const { reference, type, customerName, amount } = request;
    const label = typeLabel(type);
    const html = shell({
      preheader: `Facture éditée pour ${customerName} (#${reference}) — en attente de règlement.`,
      audience: "staff",
      heading: "Une facture attend son règlement 🧾",
      intro: `La facture de la demande <strong>${esc(label)}</strong> de <strong>${esc(customerName)}</strong> (référence <strong>#${esc(reference)}</strong>) vient d'être éditée.<br/><br/>Dès que le règlement est encaissé, pense à <strong>cocher l'étape « Facture réglée »</strong> dans le CRM pour clôturer la demande.`,
      contentHtml: `
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;border:1px solid #ece9e4;border-radius:14px;overflow:hidden;background:#fffdfb;">
          <tr><td style="padding:14px 16px;">
            <p style="margin:0 0 6px;font-family:Helvetica,Arial,sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#a1a1aa;">Montant</p>
            <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;color:${BRAND};">${esc(amount ? euro(amount) : "Non renseigné")}</p>
          </td></tr>
        </table>
        <div style="margin:0 0 22px;">${button(`${appUrl()}/crm/demandes`, "Ouvrir le CRM")}</div>
      `,
    });
    await resendSend(
      INVOICE_STAFF_EMAILS,
      `Facture à régler · ${label} #${reference}`,
      html,
    );
  },
});

/** Récapitulatif de toutes les factures éditées en attente de règlement. */
export const sendInvoicePendingDigest = internalAction({
  args: { requests: v.array(invoiceRequestArg) },
  handler: async (_ctx, { requests }) => {
    if (requests.length === 0) return;
    const total = requests.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    const count = requests.length;
    const html = shell({
      preheader: `${count} facture${count > 1 ? "s" : ""} éditée${count > 1 ? "s" : ""} en attente de règlement.`,
      audience: "staff",
      heading: "Factures en attente de règlement 🧾",
      intro: `Voici les demandes dont la facture est éditée mais <strong>pas encore marquée comme réglée</strong> dans le CRM.<br/><br/>Pour chacune, une fois le règlement encaissé, coche l'étape <strong>« Facture réglée »</strong> pour clôturer la demande.`,
      contentHtml: `
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px;border:1px solid #ece9e4;border-radius:14px;overflow:hidden;background:#fffdfb;">
          <tr style="background:#faf8f5;">
            <th align="left" style="padding:10px 12px;font-family:Helvetica,Arial,sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#a1a1aa;">Réf.</th>
            <th align="left" style="padding:10px 12px;font-family:Helvetica,Arial,sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#a1a1aa;">Type</th>
            <th align="left" style="padding:10px 12px;font-family:Helvetica,Arial,sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#a1a1aa;">Client</th>
            <th align="right" style="padding:10px 12px;font-family:Helvetica,Arial,sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#a1a1aa;">Montant</th>
          </tr>
          ${requests.map(invoiceRow).join("")}
        </table>
        <p style="margin:0 0 22px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#3f3f46;">
          <strong>${count}</strong> facture${count > 1 ? "s" : ""} en attente · total <strong>${esc(euro(total))}</strong>
        </p>
        <div style="margin:0 0 22px;">${button(`${appUrl()}/crm/demandes`, "Ouvrir le CRM")}</div>
      `,
    });
    await resendSend(
      INVOICE_STAFF_EMAILS,
      `${count} facture${count > 1 ? "s" : ""} en attente de règlement`,
      html,
    );
  },
});

// ─── Avis Google ─────────────────────────────────────────────────────────────

/**
 * Fiche Google à noter, par site de traitement. Une demande sans site part sur
 * la Recyclerie 60 : c'est le site principal, et un lien vaut mieux qu'aucun.
 */
const GOOGLE_REVIEW_LINKS: Record<string, { url: string; label: string }> = {
  // Liens « /review » de la fiche Google : ils ouvrent directement le
  // formulaire de notation, là où un lien de partage impose un détour par la
  // fiche puis un second clic.
  "60": { url: "https://g.page/r/Ca7-zpJ4l8p2EBM/review", label: "Recyclerie du Pays de Bray (60)" },
  "76": { url: "https://g.page/r/Cc5Sx_tZfUvBEBM/review", label: "Recyclerie de Gournay en Bray (76)" },
};

/** Invitation à laisser un avis Google, envoyée une fois la demande gagnée. */
export const sendReviewInvite = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    reference: v.string(),
    type: v.string(),
    site: v.optional(v.string()),
  },
  handler: async (_ctx, { email, name, reference, type, site }) => {
    const label = typeLabel(type);
    const review = GOOGLE_REVIEW_LINKS[site ?? "60"] ?? GOOGLE_REVIEW_LINKS["60"];
    const stars = "★★★★★";
    const html = shell({
      preheader: `Votre demande ${label} #${reference} est terminée : donnez-nous votre avis en une minute.`,
      heading: "Merci de votre confiance 🙌",
      intro: `Bonjour ${esc(name)},<br/><br/>Votre demande <strong>${esc(label)}</strong> (référence <strong>#${esc(reference)}</strong>) est terminée. Nous espérons que tout s'est bien passé !`,
      contentHtml: `
        <div style="margin:0 0 22px;padding:18px;background:linear-gradient(135deg,#fff7ef,#ffe9d6);border:1px solid #ffe0c4;border-radius:14px;text-align:center;">
          <p style="margin:0 0 6px;font-family:Helvetica,Arial,sans-serif;font-size:26px;letter-spacing:3px;color:#f59e0b;">${stars}</p>
          <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;color:#3f3f46;">
            Votre avis nous aide à faire connaître la ${esc(review.label)} et à nous améliorer. Cela prend moins d'une minute.
          </p>
        </div>
        <div style="margin:0 0 22px;">${button(review.url, "Laisser un avis Google")}</div>
        <p style="margin:0 0 22px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:21px;color:#71717a;">
          Un souci à nous signaler plutôt qu'un avis ? Répondez-nous depuis votre messagerie : nous reprenons contact avec vous.
        </p>
        <p style="margin:0 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#71717a;">Accès rapides :</p>
        ${quickLinks()}
      `,
    });
    await resendSend(email, `Votre avis compte · ${label} #${reference}`, html);
  },
});

/**
 * Emails Bâtire.
 *
 * Gabarit et expéditeur propres à Bâtire : un donateur qui reçoit la réponse à
 * son don ne doit pas lire une lettre de la Recyclerie.
 */
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { esc, resendSend, storageImageUrl } from "./emails";

const FROM = "Bâtire <no-reply@mesoutils.eco-solidaire.fr>";

/** Ocre de marque Bâtire (`brand-500` / `brand-700` de l'app). */
const BRAND = "#c9741f";
const BRAND_DARK = "#834717";

function appUrl() {
  return (process.env.BATIRE_APP_URL ?? "https://batire.groupemes.fr").replace(/\/$/, "");
}

function button(href: string, label: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:4px 0 22px;">
    <tr><td style="border-radius:12px;background:${BRAND_DARK};">
      <a href="${href}" target="_blank" style="display:inline-block;padding:13px 24px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;border-radius:12px;">${esc(label)}</a>
    </td></tr>
  </table>`;
}

/**
 * Visuel d'un produit, servi par l'action HTTP de Convex : une URL signée
 * expire, et un client qui rouvre son email six mois plus tard n'aurait plus
 * qu'un cadre vide.
 */
function productImage(storageId: string | undefined) {
  if (!storageId) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;border-collapse:collapse;">
    <tr><td align="center" style="background:#faf7f2;border:1px solid #efe6d9;border-radius:14px;padding:12px;">
      <img src="${storageImageUrl(storageId)}" alt="" width="480" style="display:block;width:100%;max-width:480px;height:auto;border:0;border-radius:8px;outline:none;text-decoration:none;" />
    </td></tr>
  </table>`;
}

/** Encart de citation : motif de refus, consignes de dépôt. */
function note(title: string, body: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;background:#faf7f2;border:1px solid #efe6d9;border-left:4px solid ${BRAND};border-radius:12px;">
    <tr><td style="padding:14px 18px;font-family:Helvetica,Arial,sans-serif;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#8a7259;">${esc(title)}</p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#3f3f46;white-space:pre-line;">${esc(body)}</p>
    </td></tr>
  </table>`;
}

function shell(opts: { preheader: string; heading: string; intro: string; contentHtml?: string }) {
  return `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <style>@media (max-width:600px){.container{width:100% !important;}.px{padding-left:20px !important;padding-right:20px !important;}}</style>
  </head>
  <body style="margin:0;padding:0;background:#f6f2ec;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(opts.preheader)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f2ec;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" class="container" style="width:600px;max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #ece4d8;box-shadow:0 10px 40px rgba(24,24,27,0.06);">
          <tr>
            <td class="px" style="padding:22px 32px;border-bottom:1px solid #f1e9dd;border-top:4px solid ${BRAND};">
              <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;letter-spacing:-.02em;color:#18181b;">BâtiRe<span style="color:${BRAND};">.</span></p>
              <p style="margin:2px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#a1a1aa;">Matériaux de réemploi</p>
            </td>
          </tr>
          <tr>
            <td class="px" style="padding:30px 32px;">
              <h1 style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:22px;line-height:1.25;color:#18181b;">${esc(opts.heading)}</h1>
              <p style="margin:0 0 20px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#3f3f46;">${opts.intro}</p>
              ${opts.contentHtml ?? ""}
            </td>
          </tr>
          <tr>
            <td class="px" style="padding:20px 32px;background:#faf7f2;border-top:1px solid #f1e9dd;">
              <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:#b8b0a4;">
                Message automatique — merci de ne pas y répondre. Écrivez-nous depuis la messagerie de votre espace client.
              </p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** Réponse de l'équipe à un don proposé depuis la boutique. */
export const sendDonationDecision = internalAction({
  args: {
    to: v.string(),
    firstName: v.string(),
    reference: v.string(),
    title: v.string(),
    accepted: v.boolean(),
    /** Le donateur a demandé un enlèvement : on ne lui parle pas de dépôt. */
    pickup: v.optional(v.boolean()),
    /** Consignes de dépôt si accepté, motif si refusé. */
    message: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const lot = `<strong>${esc(args.title)}</strong> (${esc(args.reference)})`;
    const html = args.accepted
      ? shell({
          preheader: `Votre don ${args.reference} est accepté.`,
          heading: "Don accepté",
          intro:
            `Bonjour ${esc(args.firstName)},<br/><br/>` +
            (args.pickup
              ? `Votre don ${lot} est accepté. Nous vous recontactons pour convenir de l'enlèvement à l'adresse indiquée.`
              : `Votre don ${lot} est accepté. Vous pouvez le déposer au dépôt pendant les horaires d'ouverture.`),
          contentHtml:
            (args.message
              ? note(args.pickup ? "Conditions d'enlèvement" : "Conditions de dépôt", args.message)
              : "") +
            button(`${appUrl()}/mon-compte`, "Suivre mon don") +
            `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#71717a;">Gardez la référence ${esc(args.reference)} sous la main : elle nous sert à retrouver votre don.</p>`,
        })
      : shell({
          preheader: `Votre don ${args.reference} n'a pas été retenu.`,
          heading: "Don non retenu",
          intro:
            `Bonjour ${esc(args.firstName)},<br/><br/>` +
            `Malheureusement, votre don ${lot} n'a pas été accepté.`,
          contentHtml:
            (args.message ? note("Motif", args.message) : "") +
            button(`${appUrl()}/don/nouveau`, "Proposer un autre don"),
        });

    await resendSend(
      args.to,
      args.accepted
        ? `Don accepté — ${args.title}`
        : `Don non retenu — ${args.title}`,
      html,
      FROM,
    );
  },
});

/** Un lot recherché vient d'arriver en boutique. */
export const sendSearchAlert = internalAction({
  args: {
    materialId: v.string(),
    title: v.string(),
    category: v.string(),
    family: v.optional(v.string()),
    subcategory: v.optional(v.string()),
    price: v.number(),
    unit: v.string(),
    /** Ouverture à la vente, si le lot n'est pas encore disponible. */
    availableFrom: v.optional(v.number()),
    /** Première photo du lot : un matériau se reconnaît à l'œil. */
    imageStorageId: v.optional(v.string()),
    recipients: v.array(
      v.object({
        email: v.string(),
        name: v.optional(v.string()),
        /** La branche demandée, rappelée au client : il a pu en poser plusieurs. */
        wanted: v.string(),
      }),
    ),
  },
  handler: async (_ctx, args) => {
    const path = [args.category, args.family, args.subcategory].filter(Boolean).join(" › ");
    const price = `${args.price.toLocaleString("fr-FR", {
      style: "currency",
      currency: "EUR",
    })} / ${args.unit}`;
    // Deux situations, deux lettres : le lot est là, ou il arrive à une date
    // connue. Annoncer « c'est en ligne » pour un lot pas encore ouvert à la
    // vente ferait venir le client devant une étagère vide.
    const upcoming =
      typeof args.availableFrom === "number" && args.availableFrom > Date.now();
    const availableOn = args.availableFrom
      ? new Date(args.availableFrom).toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : null;

    // Un email par destinataire : la recherche rappelée est la sienne, et
    // personne ne découvre l'adresse des autres.
    for (const recipient of args.recipients) {
      const html = shell({
        preheader: upcoming
          ? `${args.title} arrive au dépôt${availableOn ? ` le ${availableOn}` : ""}.`
          : `${args.title} vient d'arriver au dépôt.`,
        heading: upcoming ? "Bientôt disponible" : "Ce que vous cherchez vient d'arriver",
        intro:
          `${recipient.name ? `Bonjour ${esc(recipient.name)},<br/><br/>` : ""}` +
          (upcoming
            ? `Nous aurons bientôt <strong>${esc(args.title)}</strong>, qui correspond à votre recherche.`
            : `<strong>${esc(args.title)}</strong> est en ligne dans la boutique.`),
        contentHtml:
          productImage(args.imageStorageId) +
          (upcoming && availableOn
            ? note("Disponible à partir du", availableOn)
            : "") +
          note("Votre recherche", recipient.wanted) +
          `<p style="margin:0 0 20px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#3f3f46;">${esc(path)}<br/><strong>${esc(price)}</strong></p>` +
          button(
            `${appUrl()}/materiau/${args.materialId}`,
            upcoming ? "Voir la fiche du produit" : "Voir le produit",
          ) +
          `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#71717a;">${
            upcoming
              ? "La fiche est déjà en ligne : vous pouvez la consulter dès maintenant et venir à partir de cette date."
              : "Les lots de réemploi partent vite et ne reviennent pas : premier arrivé, premier servi."
          }</p>`,
      });
      await resendSend(
        recipient.email,
        upcoming
          ? `Bientôt disponible — ${args.title}`
          : `Trouvé pour vous — ${args.title}`,
        html,
        FROM,
      );
    }
  },
});

/** Reçu d'une commande payée en ligne. */
export const sendOrderReceipt = internalAction({
  args: {
    to: v.string(),
    firstName: v.string(),
    reference: v.string(),
    title: v.string(),
    quantity: v.number(),
    unit: v.string(),
    amountCents: v.number(),
    depot: v.optional(v.string()),
    pickupLocation: v.optional(v.object({ name: v.string(), address: v.string() })),
  },
  handler: async (_ctx, args) => {
    const total = (args.amountCents / 100).toLocaleString("fr-FR", {
      style: "currency",
      currency: "EUR",
    });
    const html = shell({
      preheader: `Commande ${args.reference} confirmée.`,
      heading: "Merci pour votre commande",
      intro:
        `Bonjour ${esc(args.firstName)},<br/><br/>` +
        `Votre paiement est confirmé. Votre commande <strong>${esc(args.reference)}</strong> vous attend au dépôt.`,
      contentHtml:
        `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;border-collapse:collapse;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#3f3f46;">
          <tr><td style="padding:10px 0;border-bottom:1px solid #f1e9dd;">${esc(args.title)}</td>
              <td align="right" style="padding:10px 0;border-bottom:1px solid #f1e9dd;">${esc(`${args.quantity} ${args.unit}`)}</td></tr>
          <tr><td style="padding:10px 0;font-weight:700;color:#18181b;">Total payé</td>
              <td align="right" style="padding:10px 0;font-weight:700;color:#18181b;">${esc(total)}</td></tr>
        </table>` +
        note(
          "Retrait",
          args.pickupLocation
            ? `${args.pickupLocation.name} — ${args.pickupLocation.address}. Présentez la référence ${args.reference} à l'équipe, aux horaires d'ouverture.`
            : args.depot
              ? `Dépôt : ${args.depot}. Présentez la référence ${args.reference} à l'équipe, aux horaires d'ouverture.`
            : `Présentez la référence ${args.reference} à l'équipe, aux horaires d'ouverture du dépôt.`,
        ) +
        button(`${appUrl()}/mon-compte`, "Mon espace client"),
    });
    await resendSend(args.to, `Commande ${args.reference} confirmée`, html, FROM);
  },
});

/** L'équipe a répondu dans la messagerie : le client n'a pas à surveiller l'app. */
export const sendNewMessage = internalAction({
  args: {
    to: v.string(),
    name: v.optional(v.string()),
    materialTitle: v.string(),
    body: v.string(),
  },
  handler: async (_ctx, args) => {
    const html = shell({
      preheader: `Réponse de l'équipe à propos de ${args.materialTitle}.`,
      heading: "L'équipe vous a répondu",
      intro:
        `${args.name ? `Bonjour ${esc(args.name)},<br/><br/>` : ""}` +
        `À propos de <strong>${esc(args.materialTitle)}</strong> :`,
      contentHtml:
        note("Message de l'équipe", args.body) +
        button(`${appUrl()}/messagerie`, "Répondre dans ma messagerie"),
    });
    await resendSend(args.to, `Réponse de Bâtire — ${args.materialTitle}`, html, FROM);
  },
});

/** Accusé de réception d'une proposition de don. */
export const sendDonationReceived = internalAction({
  args: {
    to: v.string(),
    firstName: v.string(),
    reference: v.string(),
    title: v.string(),
    pickup: v.boolean(),
  },
  handler: async (_ctx, args) => {
    const html = shell({
      preheader: `Proposition ${args.reference} bien reçue.`,
      heading: "Votre proposition est bien arrivée",
      intro:
        `Bonjour ${esc(args.firstName)},<br/><br/>` +
        `Nous avons bien reçu <strong>${esc(args.title)}</strong> (${esc(args.reference)}). ` +
        `L'équipe l'étudie et vous répond par email.`,
      contentHtml:
        note(
          "Ce qui se passe ensuite",
          args.pickup
            ? "Si le don est accepté, nous vous recontactons pour convenir de l'enlèvement à l'adresse indiquée."
            : "Si le don est accepté, vous pourrez le déposer au dépôt pendant les horaires d'ouverture.",
        ) + button(`${appUrl()}/mon-compte?onglet=dons`, "Suivre mon don"),
    });
    await resendSend(args.to, `Proposition de don reçue — ${args.title}`, html, FROM);
  },
});

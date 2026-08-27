import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { esc, resendSend, storageImageUrl, type EmailAttachment } from "./emails";

// Emails internes de l'application Mes Outils (équipe), distincts des emails
// clients de la recyclerie (cf. `emails.ts`). Expéditeur et gabarit dédiés.
const FROM = "Mes Outils <no-reply@mesoutils.eco-solidaire.fr>";
// Vert de marque Mes Outils (identique au `brand-500` de l'app).
const BRAND = "#47c667";
const BRAND_DARK = "#2fa855";

/**
 * L'intendance suit l'ensemble des réservations (véhicules, salles,
 * équipements) : demandes, acceptations, refus et annulations. Elle est donc
 * ajoutée aux listes de responsables et mise en copie cachée des emails
 * envoyés aux demandeurs.
 */
export const INTENDANCE_EMAIL = "intendance@eco-solidaire.fr";

/** Adresses des responsables notifiés des demandes de réservation de véhicule. */
export const VEHICLE_REQUEST_MANAGER_EMAILS = [
  "f.henry@eco-solidaire.fr",
  INTENDANCE_EMAIL,
];

/** URL publique de l'app Mes Outils, pour les liens et le logo des emails. */
function appUrl() {
  return (process.env.MESOUTILS_APP_URL ?? "https://mesoutils.groupemes.fr").replace(/\/$/, "");
}

/** URL absolue du logo Mes Outils (version détourée pour email, servie par l'app). */
function logoUrl() {
  return `${appUrl()}/mesoutils-email-logo.png`;
}

/** Lien absolu vers une route de l'app. */
function appLink(path: string) {
  return `${appUrl()}${path}`;
}

/** Bouton « à toute épreuve » (table + lien). Rien si `href` est nul. */
function button(href: string | null, label: string) {
  if (!href) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:0 0 22px;">
    <tr><td style="border-radius:12px;background:${BRAND_DARK};">
      <a href="${href}" target="_blank" style="display:inline-block;padding:13px 24px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;border-radius:12px;">${esc(label)}</a>
    </td></tr>
  </table>`;
}

/** Gabarit complet : préheader, titre, intro, contenu, pied de page neutre. */
function shell(opts: {
  preheader: string;
  heading: string;
  intro: string;
  contentHtml?: string;
  heroUrl?: string;
}) {
  return `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
  </head>
  <body style="margin:0;padding:0;background:#eef4f1;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(opts.preheader)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#eef4f1;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e6efe9;box-shadow:0 10px 40px rgba(24,24,27,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,#ffffff,#f0faf3,#e6f6ec);padding:20px 28px;border-bottom:1px solid #e6efe9;border-top:4px solid ${BRAND};">
              <img src="${logoUrl()}" alt="Mes Outils" width="150" height="62" style="width:150px;height:auto;display:block;border:0;outline:none;text-decoration:none;" />
            </td>
          </tr>
          <tr>
            <td style="padding:30px 32px;">
              ${heroImage(opts.heroUrl)}
              <h1 style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:22px;line-height:1.25;color:#18181b;">${esc(opts.heading)}</h1>
              <p style="margin:0 0 18px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#3f3f46;">${opts.intro}</p>
              ${opts.contentHtml ?? ""}
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px;background:#f4faf6;border-top:1px solid #e2ede7;">
              <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#9fb0a6;">
                Message automatique de l'espace Mes Outils — merci de ne pas répondre à cet email.
              </p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** URL d'image utilisable en email, depuis une URL directe ou un id de stockage. */
function resolveImageUrl(opts: { imageUrl?: string; imageStorageId?: string }) {
  if (opts.imageUrl) return opts.imageUrl;
  if (opts.imageStorageId) return storageImageUrl(opts.imageStorageId);
  return undefined;
}

/** Grande image d'illustration (photo du véhicule / de la salle / de l'annonce). */
function heroImage(url: string | undefined) {
  if (!url) return "";
  return `<img src="${url}" alt="" style="display:block;width:100%;max-width:536px;height:auto;max-height:260px;object-fit:cover;border-radius:14px;border:1px solid #e6efe9;margin:0 0 22px;" />`;
}

function initials(name: string) {
  const clean = name.trim();
  return (clean ? clean.slice(0, 2) : "?").toUpperCase();
}

/** Ligne « avatar + nom » pour présenter un utilisateur (avec photo de profil). */
function userChip(name: string, photoUrl?: string, sublabel?: string) {
  const avatar = photoUrl
    ? `<img src="${photoUrl}" alt="" width="44" height="44" style="width:44px;height:44px;border-radius:50%;object-fit:cover;display:block;border:0;" />`
    : `<div style="width:44px;height:44px;border-radius:50%;background:${BRAND};color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;text-align:center;line-height:44px;">${esc(initials(name))}</div>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr>
    <td style="vertical-align:middle;padding-right:12px;">${avatar}</td>
    <td style="vertical-align:middle;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#18181b;">${esc(name)}</div>
      ${sublabel ? `<div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#a1a1aa;">${esc(sublabel)}</div>` : ""}
    </td>
  </tr></table>`;
}

/** Encart mettant en avant le détail d'une réservation (créneau). */
function detailCard(rows: Array<[string, string]>) {
  const cells = rows
    .map(
      ([label, value]) =>
        `<tr>
          <td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#a1a1aa;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
          <td style="padding:6px 0 6px 16px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#3f3f46;">${esc(value)}</td>
        </tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;padding:16px 18px;background:#f4faf6;border:1px solid #e2ede7;border-radius:14px;">${cells}</table>`;
}

/** Rappel envoyé à l'acceptation d'une réservation véhicule, avant le retour. */
function vehicleReturnWarning() {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;padding:16px 18px;background:#fff8e8;border:1px solid #f5d99a;border-radius:14px;">
    <tr><td>
      <p style="margin:0 0 7px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#8a5a00;">À prévoir pour le retour du véhicule</p>
      <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#6b562c;">Au moment de restituer le véhicule, prenez une photo du kilométrage ou notez-le avant de le quitter. Un court retour vous sera demandé : vous pourrez ainsi le compléter sans devoir retourner au véhicule.</p>
    </td></tr>
  </table>`;
}

const dayFmt = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "Europe/Paris",
});
const timeFmt = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});

/** Créneau lisible : « lundi 30 juin, 09:00 – 11:00 » (ou sur deux jours). */
function formatRange(start: number, end: number) {
  const startDay = dayFmt.format(new Date(start));
  const endDay = dayFmt.format(new Date(end));
  if (startDay === endDay) {
    return `${startDay}, ${timeFmt.format(new Date(start))} – ${timeFmt.format(new Date(end))}`;
  }
  return `${startDay} ${timeFmt.format(new Date(start))} → ${endDay} ${timeFmt.format(new Date(end))}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendToEachRecipient(
  recipients: readonly string[],
  subject: string,
  html: string,
) {
  for (const [index, email] of recipients.entries()) {
    if (index > 0) await sleep(700);
    await resendSend(email, subject, html, FROM);
  }
}

// ─── Réservations (salles & véhicules) ───────────────────────────────────────

type ReservationState =
  | "submitted"
  | "confirmed"
  | "approved"
  | "rejected"
  | "cancelled";

const STATE_COPY: Record<
  ReservationState,
  { heading: string; subject: string; intro: (asset: string) => string }
> = {
  submitted: {
    heading: "Votre réservation a bien été soumise",
    subject: "Réservation soumise",
    intro: (asset) =>
      `Votre demande de réservation de ${asset} a bien été enregistrée. Elle est en attente de validation par un responsable — vous serez prévenu·e dès qu'une décision est prise.`,
  },
  confirmed: {
    heading: "Votre réservation est confirmée",
    subject: "Réservation confirmée",
    intro: (asset) =>
      `Votre réservation de ${asset} est confirmée. Voici le récapitulatif du créneau réservé.`,
  },
  approved: {
    heading: "Votre réservation a été validée",
    subject: "Réservation validée",
    intro: (asset) =>
      `Bonne nouvelle : votre réservation de ${asset} a été validée par un responsable.`,
  },
  rejected: {
    heading: "Votre réservation a été refusée",
    subject: "Réservation refusée",
    intro: (asset) =>
      `Votre réservation de ${asset} n'a pas pu être validée. N'hésitez pas à proposer un autre créneau.`,
  },
  cancelled: {
    heading: "Votre réservation a été annulée",
    subject: "Réservation annulée",
    intro: (asset) => `Votre réservation de ${asset} a été annulée.`,
  },
};

export const sendReservationEmail = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    assetKind: v.union(v.literal("room"), v.literal("vehicle"), v.literal("equipment")),
    assetName: v.string(),
    label: v.string(),
    start: v.number(),
    end: v.number(),
    state: v.union(
      v.literal("submitted"),
      v.literal("confirmed"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("cancelled"),
    ),
    note: v.optional(v.string()),
    // Photo de profil du demandeur + photo de l'actif (véhicule / salle).
    photoUrl: v.optional(v.string()),
    assetImageUrl: v.optional(v.string()),
    assetImageStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const assetWord =
      args.assetKind === "room" ? "salle" : args.assetKind === "equipment" ? "équipement" : "véhicule";
    const assetLabel =
      args.assetKind === "room" ? "Salle" : args.assetKind === "equipment" ? "Équipement" : "Véhicule";
    const copy = STATE_COPY[args.state];
    const rows: Array<[string, string]> = [
      [assetLabel, args.assetName],
      [args.assetKind === "vehicle" ? "Motif" : "Objet", args.label],
      ["Créneau", formatRange(args.start, args.end)],
    ];
    if (args.note) rows.push(["Note", args.note]);

    const heroUrl = resolveImageUrl({
      imageUrl: args.assetImageUrl,
      imageStorageId: args.assetImageStorageId,
    });

    const myReservationsPath =
      args.assetKind === "equipment" ? "/equipements?v=mine" : "/reservations?v=mine";
    const html = shell({
      preheader: copy.intro(`${assetWord} « ${args.assetName} »`),
      heading: copy.heading,
      heroUrl,
      intro: esc(copy.intro(`${assetWord} « ${args.assetName} »`)),
      contentHtml: `
        ${userChip(args.name, args.photoUrl, "Demandeur")}
        ${detailCard(rows)}
        ${args.assetKind === "vehicle" && args.state === "approved" ? vehicleReturnWarning() : ""}
        ${button(appLink(myReservationsPath), "Voir mes réservations")}
      `,
    });
    await resendSend(
      args.email,
      `${copy.subject} · ${args.assetName}`,
      html,
      FROM,
      undefined,
      { bcc: [INTENDANCE_EMAIL] },
    );
  },
});

export const sendVehicleFeedbackRequestEmail = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    vehicleName: v.string(),
    label: v.string(),
    start: v.number(),
    end: v.number(),
    vehicleImageUrl: v.optional(v.string()),
    vehicleImageStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const heroUrl = resolveImageUrl({
      imageUrl: args.vehicleImageUrl,
      imageStorageId: args.vehicleImageStorageId,
    });
    const rows: Array<[string, string]> = [
      ["Véhicule", args.vehicleName],
      ["Motif", args.label],
      ["Créneau terminé", formatRange(args.start, args.end)],
    ];

    const html = shell({
      preheader: `Merci de compléter le retour de votre réservation du véhicule « ${args.vehicleName} ».`,
      heading: "Retour de réservation véhicule",
      heroUrl,
      intro: `Bonjour ${esc(args.name)}, votre réservation de véhicule est terminée. Merci de compléter le court formulaire de retour : kilométrage relevé, carburant, objets laissés, propreté du véhicule et éventuels incidents ou remarques.`,
      contentHtml: `
        ${detailCard(rows)}
        ${button(appLink("/reservations?v=mine"), "Faire le retour")}
      `,
    });

    await resendSend(
      args.email,
      `Retour de réservation · ${args.vehicleName}`,
      html,
      FROM,
    );
  },
});

/** Demande de retour (remarques) après une réservation de salle terminée. */
export const sendRoomFeedbackRequestEmail = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    roomName: v.string(),
    label: v.string(),
    start: v.number(),
    end: v.number(),
    roomImageUrl: v.optional(v.string()),
    roomImageStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const heroUrl = resolveImageUrl({
      imageUrl: args.roomImageUrl,
      imageStorageId: args.roomImageStorageId,
    });
    const rows: Array<[string, string]> = [
      ["Salle", args.roomName],
      ["Objet", args.label],
      ["Créneau terminé", formatRange(args.start, args.end)],
    ];

    const html = shell({
      preheader: `Merci de compléter le retour de votre réservation de la salle « ${args.roomName} ».`,
      heading: "Retour de réservation salle",
      heroUrl,
      intro: `Bonjour ${esc(args.name)}, votre réservation de salle est terminée. Merci de compléter le court formulaire de retour : propreté, rangement et éventuels incidents ou remarques.`,
      contentHtml: `
        ${detailCard(rows)}
        ${button(appLink("/reservations?v=mine"), "Faire le retour")}
      `,
    });

    await resendSend(args.email, `Retour de réservation · ${args.roomName}`, html, FROM);
  },
});

/**
 * Notifie les responsables d'une nouvelle demande de réservation de véhicule,
 * avec un lien direct vers la validation.
 */
export const sendVehicleRequestToManagers = internalAction({
  args: {
    requesterName: v.string(),
    vehicleName: v.string(),
    label: v.string(),
    start: v.number(),
    end: v.number(),
    note: v.optional(v.string()),
    requesterPhotoUrl: v.optional(v.string()),
    vehicleImageUrl: v.optional(v.string()),
    vehicleImageStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const rows: Array<[string, string]> = [
      ["Véhicule", args.vehicleName],
      ["Motif", args.label],
      ["Créneau", formatRange(args.start, args.end)],
    ];
    if (args.note) rows.push(["Note", args.note]);

    const heroUrl = resolveImageUrl({
      imageUrl: args.vehicleImageUrl,
      imageStorageId: args.vehicleImageStorageId,
    });

    const html = shell({
      preheader: `${args.requesterName} demande le véhicule « ${args.vehicleName} ».`,
      heading: "Nouvelle demande de réservation de véhicule",
      heroUrl,
      intro: `Une nouvelle demande de réservation de véhicule vient d'être soumise. Merci de la valider ou de la refuser.`,
      contentHtml: `
        ${userChip(args.requesterName, args.requesterPhotoUrl, "Demandeur")}
        ${detailCard(rows)}
        ${button(appLink("/gotravaux?v=reservations"), "Valider la demande")}
      `,
    });

    await resendSend(
      VEHICLE_REQUEST_MANAGER_EMAILS,
      `Demande de réservation · ${args.vehicleName} (${args.requesterName})`,
      html,
      FROM,
    );
  },
});

export const sendVehicleReservationManagerUpdate = internalAction({
  args: {
    state: v.union(
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("cancelled"),
    ),
    requesterName: v.string(),
    vehicleName: v.string(),
    label: v.string(),
    start: v.number(),
    end: v.number(),
    note: v.optional(v.string()),
    requesterPhotoUrl: v.optional(v.string()),
    vehicleImageUrl: v.optional(v.string()),
    vehicleImageStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const heading =
      args.state === "approved"
        ? "Réservation véhicule acceptée"
        : args.state === "rejected"
          ? "Réservation véhicule refusée"
          : "Réservation véhicule annulée";
    const intro =
      args.state === "approved"
        ? "Une demande de réservation véhicule a été acceptée."
        : args.state === "rejected"
          ? "Une demande de réservation véhicule a été refusée."
          : "Une demande de réservation véhicule a été annulée.";

    const rows: Array<[string, string]> = [
      ["Véhicule", args.vehicleName],
      ["Motif", args.label],
      ["Créneau", formatRange(args.start, args.end)],
    ];
    if (args.note) rows.push(["Note", args.note]);

    const heroUrl = resolveImageUrl({
      imageUrl: args.vehicleImageUrl,
      imageStorageId: args.vehicleImageStorageId,
    });

    const html = shell({
      preheader: `${args.requesterName} · ${args.vehicleName} · ${heading}`,
      heading,
      heroUrl,
      intro,
      contentHtml: `
        ${userChip(args.requesterName, args.requesterPhotoUrl, "Demandeur")}
        ${detailCard(rows)}
        ${button(appLink("/gotravaux?v=reservations"), "Voir les réservations")}
      `,
    });

    const subject =
      args.state === "approved"
        ? `Réservation acceptée · ${args.vehicleName} (${args.requesterName})`
        : args.state === "rejected"
          ? `Réservation refusée · ${args.vehicleName} (${args.requesterName})`
          : `Réservation annulée · ${args.vehicleName} (${args.requesterName})`;

    await resendSend(VEHICLE_REQUEST_MANAGER_EMAILS, subject, html, FROM);
  },
});

/** Adresses des responsables notifiés des réservations de salle. */
export const ROOM_RESERVATION_MANAGER_EMAILS = [
  "a.still@eco-solidaire.fr",
  INTENDANCE_EMAIL,
];

/**
 * Équipe Recyclerie prévenue quand un véhicule mis à sa disposition est
 * réservé (demande soumise) puis acceptée. Sans lien : pas d'accès à Gotravaux.
 */
export const RECYCLERIE_VEHICLE_NOTICE_EMAILS = [
  "a.dargent@eco-solidaire.fr",
  "s.tiennot@eco-solidaire.fr",
];

export const sendRecyclerieVehicleNotice = internalAction({
  args: {
    state: v.union(v.literal("submitted"), v.literal("approved")),
    requesterName: v.string(),
    vehicleName: v.string(),
    label: v.string(),
    start: v.number(),
    end: v.number(),
    note: v.optional(v.string()),
    requesterPhotoUrl: v.optional(v.string()),
    vehicleImageUrl: v.optional(v.string()),
    vehicleImageStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const approved = args.state === "approved";
    const intro = approved
      ? "Une réservation vient d'être acceptée pour un véhicule de la Recyclerie."
      : "Une demande de réservation vient d'être effectuée pour un véhicule de la Recyclerie.";
    const heading = approved
      ? "Réservation acceptée pour un véhicule de la Recyclerie"
      : "Demande de réservation pour un véhicule de la Recyclerie";

    const rows: Array<[string, string]> = [
      ["Véhicule", args.vehicleName],
      ["Motif", args.label],
      ["Créneau", formatRange(args.start, args.end)],
    ];
    if (args.note) rows.push(["Note", args.note]);

    const heroUrl = resolveImageUrl({
      imageUrl: args.vehicleImageUrl,
      imageStorageId: args.vehicleImageStorageId,
    });

    const html = shell({
      preheader: intro,
      heading,
      heroUrl,
      intro,
      // Pas de bouton : ces destinataires n'ont pas accès à Gotravaux.
      contentHtml: `
        ${userChip(args.requesterName, args.requesterPhotoUrl, "Demandeur")}
        ${detailCard(rows)}
      `,
    });

    const subject = approved
      ? `Réservation acceptée · ${args.vehicleName} (Recyclerie)`
      : `Demande de réservation · ${args.vehicleName} (Recyclerie)`;
    await resendSend(RECYCLERIE_VEHICLE_NOTICE_EMAILS, subject, html, FROM, undefined, {
      bcc: [INTENDANCE_EMAIL],
    });
  },
});

/** Notifie les responsables d'une réservation de salle. */
export const sendRoomReservationToManagers = internalAction({
  args: {
    requesterName: v.string(),
    roomName: v.string(),
    label: v.string(),
    start: v.number(),
    end: v.number(),
    note: v.optional(v.string()),
    requesterPhotoUrl: v.optional(v.string()),
    roomImageUrl: v.optional(v.string()),
    roomImageStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const rows: Array<[string, string]> = [
      ["Salle", args.roomName],
      ["Objet", args.label],
      ["Créneau", formatRange(args.start, args.end)],
    ];
    if (args.note) rows.push(["Note", args.note]);

    const heroUrl = resolveImageUrl({
      imageUrl: args.roomImageUrl,
      imageStorageId: args.roomImageStorageId,
    });

    const html = shell({
      preheader: `${args.requesterName} a réservé la salle « ${args.roomName} ».`,
      heading: "Nouvelle réservation de salle",
      heroUrl,
      intro: `Une nouvelle réservation de salle vient d'être enregistrée.`,
      contentHtml: `
        ${userChip(args.requesterName, args.requesterPhotoUrl, "Demandeur")}
        ${detailCard(rows)}
        ${button(appLink("/salles"), "Voir les réservations")}
      `,
    });

    await sendToEachRecipient(
      ROOM_RESERVATION_MANAGER_EMAILS,
      `Réservation de salle · ${args.roomName} (${args.requesterName})`,
      html,
    );
  },
});

/**
 * Notifie les responsables « gestion » d'une nouvelle réservation d'équipement.
 * Les destinataires sont fournis par l'appelant (comptes autorisés à gérer les
 * équipements), et non une liste fixe.
 */
export const sendEquipmentReservationToManagers = internalAction({
  args: {
    recipients: v.array(v.string()),
    requesterName: v.string(),
    equipmentName: v.string(),
    label: v.string(),
    start: v.number(),
    end: v.number(),
    note: v.optional(v.string()),
    requesterPhotoUrl: v.optional(v.string()),
    equipmentImageUrl: v.optional(v.string()),
    equipmentImageStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    // L'intendance suit aussi les réservations d'équipement, même si l'objet
    // n'a pas de référent déclaré.
    const recipients = Array.from(
      new Set([...args.recipients, INTENDANCE_EMAIL].map((email) => email.trim()).filter(Boolean)),
    );
    if (recipients.length === 0) return;
    const rows: Array<[string, string]> = [
      ["Équipement", args.equipmentName],
      ["Objet", args.label],
      ["Créneau", formatRange(args.start, args.end)],
    ];
    if (args.note) rows.push(["Note", args.note]);

    const heroUrl = resolveImageUrl({
      imageUrl: args.equipmentImageUrl,
      imageStorageId: args.equipmentImageStorageId,
    });

    const html = shell({
      preheader: `${args.requesterName} a réservé l'équipement « ${args.equipmentName} ».`,
      heading: "Nouvelle réservation d'équipement",
      heroUrl,
      intro: `Une nouvelle réservation d'équipement vient d'être enregistrée.`,
      contentHtml: `
        ${userChip(args.requesterName, args.requesterPhotoUrl, "Demandeur")}
        ${detailCard(rows)}
        ${button(appLink("/equipements"), "Voir les réservations")}
      `,
    });

    await sendToEachRecipient(
      recipients,
      `Réservation d'équipement · ${args.equipmentName} (${args.requesterName})`,
      html,
    );
  },
});

// ─── Bons plans ──────────────────────────────────────────────────────────────

export const sendDealInterestEmail = internalAction({
  args: {
    email: v.string(),
    authorName: v.string(),
    interestedName: v.string(),
    dealTitle: v.string(),
    interestedPhotoUrl: v.optional(v.string()),
    dealImageUrl: v.optional(v.string()),
    dealImageStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const { email, authorName, interestedName, dealTitle } = args;
    const heroUrl = resolveImageUrl({
      imageUrl: args.dealImageUrl,
      imageStorageId: args.dealImageStorageId,
    });
    const html = shell({
      preheader: `${interestedName} est intéressé·e par votre annonce « ${dealTitle} ».`,
      heading: `${esc(interestedName)} est intéressé·e par votre annonce`,
      heroUrl,
      intro: `Bonjour ${esc(authorName)},<br/><br/>Une personne s'intéresse à votre bon plan <strong>« ${esc(dealTitle)} »</strong>. Vous pouvez lui répondre directement depuis la messagerie de l'équipe.`,
      contentHtml: `
        ${userChip(interestedName, args.interestedPhotoUrl, "Intéressé·e")}
        ${button(appLink("/messagerie"), "Ouvrir la messagerie")}
      `,
    });
    await resendSend(
      email,
      `${interestedName} est intéressé·e par « ${dealTitle} »`,
      html,
      FROM,
    );
  },
});

/** URL publique de l'app Feedback (les retours ne vivent pas dans Mes Outils). */
function feedbackAppUrl() {
  return (process.env.FEEDBACK_APP_URL ?? "https://feedback.groupemes.fr").replace(/\/$/, "");
}

const FEEDBACK_TYPE_LABELS: Record<string, string> = {
  fonctionnalite: "Nouvelle fonctionnalité",
  probleme: "Problème",
  amelioration: "Amélioration",
  question: "Question",
  nouvelle_application: "Nouvelle application",
};

/**
 * Prévient l'auteur d'un retour que sa demande vient d'être traitée.
 *
 * Le retour est marqué « Terminée » depuis le kanban : sans email, l'auteur n'a
 * aucune raison de retourner voir, et les demandes traitées passent inaperçues.
 * On rappelle sa demande dans le message — plusieurs jours peuvent s'écouler
 * entre le dépôt et la clôture.
 */
export const sendFeedbackResolvedEmail = internalAction({
  args: {
    email: v.string(),
    authorName: v.optional(v.string()),
    resolvedByName: v.string(),
    resolvedByPhotoUrl: v.optional(v.string()),
    feedbackType: v.string(),
    description: v.string(),
  },
  handler: async (_ctx, args) => {
    const greeting = args.authorName?.trim() ? `Bonjour ${esc(args.authorName.trim())},` : "Bonjour,";
    const typeLabel = FEEDBACK_TYPE_LABELS[args.feedbackType] ?? "Retour";
    // Extrait borné : la description peut être longue, l'email n'est qu'un
    // rappel, le détail complet reste dans l'app.
    const excerpt =
      args.description.length > 240 ? `${args.description.slice(0, 240).trimEnd()}…` : args.description;

    const html = shell({
      preheader: `${args.resolvedByName} a traité votre retour — venez vérifier que tout est bon.`,
      heading: "Votre retour a été traité",
      intro: `${greeting}<br/><br/><strong>${esc(args.resolvedByName)}</strong> vient de marquer votre retour comme terminé. Prenez un instant pour vérifier que le résultat correspond bien à ce que vous attendiez — si ce n'est pas le cas, répondez directement dans la conversation, nous rouvrirons la demande.`,
      contentHtml: `
        ${userChip(args.resolvedByName, args.resolvedByPhotoUrl, "A traité votre retour")}
        ${detailCard([
          ["Type", typeLabel],
          ["Votre demande", excerpt],
        ])}
        ${button(feedbackAppUrl(), "Voir mon retour")}
      `,
    });

    await resendSend(args.email, "Votre retour a été traité", html, FROM);
  },
});

/** Destinataire des créations de maintenance (responsable de la flotte). */
export const MAINTENANCE_NOTICE_EMAILS = ["f.henry@eco-solidaire.fr"];

const MAINTENANCE_PRIORITY_LABELS: Record<string, string> = {
  low: "Basse",
  medium: "Moyenne",
  high: "Haute",
};

/**
 * Prévient le responsable de la flotte qu'une maintenance vient d'être créée.
 *
 * Une maintenance planifiée immobilise le véhicule pour les 3 apps qui gèrent
 * la flotte : sans notification, l'information n'existe que pour qui pense à
 * ouvrir Gotravaux.
 */
export const sendMaintenanceCreatedEmail = internalAction({
  args: {
    vehicleName: v.string(),
    vehiclePlate: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.string(),
    dueDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
    odometerKm: v.optional(v.number()),
    createdByName: v.string(),
    vehicleImageUrl: v.optional(v.string()),
    vehicleImageStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const rows: Array<[string, string]> = [
      ["Véhicule", [args.vehicleName, args.vehiclePlate].filter(Boolean).join(" · ")],
      ["Intervention", args.title],
      ["Priorité", MAINTENANCE_PRIORITY_LABELS[args.priority] ?? args.priority],
    ];
    // La date est facultative sur une maintenance : on ne montre la ligne que
    // si elle existe, plutôt qu'un « — » qui laisse croire à un oubli.
    if (typeof args.dueDate === "number") {
      rows.push([
        "Période",
        typeof args.endDate === "number" && args.endDate !== args.dueDate
          ? formatRange(args.dueDate, args.endDate)
          : new Date(args.dueDate).toLocaleDateString("fr-FR", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            }),
      ]);
    }
    if (typeof args.odometerKm === "number") {
      rows.push(["Kilométrage", `${args.odometerKm.toLocaleString("fr-FR")} km`]);
    }
    if (args.description) rows.push(["Détail", args.description]);

    const heroUrl = resolveImageUrl({
      imageUrl: args.vehicleImageUrl,
      imageStorageId: args.vehicleImageStorageId,
    });

    const html = shell({
      preheader: `${args.createdByName} a créé une maintenance sur « ${args.vehicleName} ».`,
      heading: "Nouvelle maintenance planifiée",
      heroUrl,
      intro: `Une maintenance vient d'être créée sur <strong>${esc(args.vehicleName)}</strong>. Le véhicule sera indisponible sur la période concernée.`,
      contentHtml: `
        ${userChip(args.createdByName, undefined, "A créé la maintenance")}
        ${detailCard(rows)}
        ${button(appLink("/gotravaux?v=tasks"), "Ouvrir la maintenance")}
      `,
    });

    await resendSend(
      MAINTENANCE_NOTICE_EMAILS,
      `Nouvelle maintenance · ${args.vehicleName}`,
      html,
      FROM,
    );
  },
});

// ─── RH : contrats générés ───────────────────────────────────────────────────

/**
 * Destinataires prévenus des contrats générés pour les structures MES et LSDB
 * (direction : ces deux structures n'ont pas de service RH sur place).
 */
export const CONTRACT_NOTICE_EMAILS = ["m.lahmer@eco-solidaire.fr"];

/**
 * Prévient la direction qu'un contrat MES / LSDB vient d'être généré, avec le
 * document en pièce jointe.
 *
 * La pièce jointe peut manquer : le document vit sur le SharePoint du tenant et
 * n'est pas toujours téléchargeable sans session (cf. `rh.ts`). Dans ce cas
 * l'email part quand même, avec le lien SharePoint et une mention explicite —
 * mieux vaut une notification sans fichier qu'aucune notification.
 */
export const sendContractGeneratedEmail = internalAction({
  args: {
    employeeName: v.string(),
    structureLabel: v.string(),
    documentLabel: v.string(),
    contractType: v.string(),
    numeroContrat: v.string(),
    poste: v.string(),
    dateDebut: v.string(),
    dateFin: v.string(),
    requestedBy: v.string(),
    contractUrl: v.optional(v.string()),
    attachment: v.optional(
      v.object({ filename: v.string(), content: v.string() }),
    ),
  },
  handler: async (_ctx, args) => {
    const attachments: EmailAttachment[] = args.attachment ? [args.attachment] : [];
    const missingNotice = args.attachment
      ? ""
      : `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;padding:16px 18px;background:#fff8e8;border:1px solid #f5d99a;border-radius:14px;">
          <tr><td>
            <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#6b562c;">Le document n'a pas pu être joint automatiquement (accès SharePoint requis). Utilisez le lien ci-dessous pour l'ouvrir.</p>
          </td></tr>
        </table>`;

    const html = shell({
      preheader: `${args.documentLabel} généré pour ${args.employeeName} (${args.structureLabel}).`,
      heading: `${args.documentLabel} — ${args.employeeName}`,
      intro: `Un ${args.documentLabel.toLowerCase()} vient d'être généré pour <strong>${esc(args.employeeName)}</strong> (${esc(args.structureLabel)})${args.attachment ? ", il est joint à cet email" : ""}.`,
      contentHtml: `
        ${detailCard([
          ["Salarié", args.employeeName],
          ["Structure", args.structureLabel],
          ["Document", args.documentLabel],
          ["Type de contrat", args.contractType],
          ["N° de contrat", args.numeroContrat || "—"],
          ["Poste", args.poste || "—"],
          ["Début", args.dateDebut || "—"],
          ["Fin", args.dateFin || "—"],
          ["Généré par", args.requestedBy],
        ])}
        ${missingNotice}
        ${button(args.contractUrl ?? null, "Ouvrir le contrat")}
      `,
    });

    await resendSend(
      CONTRACT_NOTICE_EMAILS,
      `${args.documentLabel} · ${args.employeeName} (${args.structureLabel})`,
      html,
      FROM,
      attachments,
    );
  },
});

/**
 * Prévenance de fin de contrat (J-22, J-15, J-3) : prévient les responsables RH
 * de la structure qu'un contrat arrive à échéance, pour renouveler ou notifier
 * à temps.
 *
 * Les destinataires sont calculés en amont (`hrContractNotices.ts`) selon la
 * structure du salarié : ils ne sont pas les mêmes d'une structure à l'autre.
 */
export const sendContractEndNoticeEmail = internalAction({
  args: {
    to: v.array(v.string()),
    employeeName: v.string(),
    structureLabel: v.string(),
    contractType: v.string(),
    numeroContrat: v.string(),
    poste: v.string(),
    dateDebut: v.string(),
    dateFin: v.string(),
    dateFinLabel: v.string(),
    daysLeft: v.number(),
    /** Palier de prévenance atteint : 22, 15 ou 3 jours. */
    threshold: v.number(),
  },
  handler: async (_ctx, args) => {
    const when =
      args.daysLeft === 0
        ? "aujourd'hui"
        : args.daysLeft === 1
          ? "demain"
          : `dans ${args.daysLeft} jours`;
    const urgency = args.threshold <= 3 ? "#dc2626" : args.threshold <= 15 ? "#d97706" : "#166534";

    const html = shell({
      preheader: `Le contrat de ${args.employeeName} se termine ${when} (${args.dateFinLabel}).`,
      heading: `Fin de contrat — ${args.employeeName}`,
      intro: `Le contrat de <strong>${esc(args.employeeName)}</strong> (${esc(args.structureLabel)}) arrive à échéance <strong>${esc(when)}</strong>, le <strong>${esc(args.dateFinLabel)}</strong>. Pensez à préparer le renouvellement ou la notification de fin de contrat.`,
      contentHtml: `
        <p style="margin:0 0 18px;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${urgency};">
          Prévenance J-${args.threshold} ·
          ${args.daysLeft === 0 ? "échéance aujourd'hui" : args.daysLeft === 1 ? "échéance demain" : `échéance dans ${args.daysLeft} jours`}
        </p>
        ${detailCard([
          ["Salarié", args.employeeName],
          ["Structure", args.structureLabel],
          ["Type de contrat", args.contractType],
          ["N° de contrat", args.numeroContrat || "—"],
          ["Poste", args.poste || "—"],
          ["Début", args.dateDebut || "—"],
          ["Fin", args.dateFinLabel],
        ])}
        <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#6b7a72;">
          Rappel : la prévenance est envoyée à J-22, J-15 et J-3 de l'échéance,
          d'après le dernier contrat généré pour ce salarié dans Mes Outils → RH.
        </p>
      `,
    });

    await resendSend(
      args.to,
      `⏰ Fin de contrat J-${args.threshold} · ${args.employeeName} (${args.structureLabel}) — ${args.dateFinLabel}`,
      html,
      FROM,
    );
  },
});

/** Boîte de réception des nouveaux retours (équipe produit). */
export const FEEDBACK_INBOX_EMAILS = ["s.lahmer@eco-solidaire.fr"];

const FEEDBACK_APP_LABELS: Record<string, string> = {
  mesoutils: "Mes Outils",
  recycapp: "Recycapp",
  klyde: "Klyde",
  cycleenbray: "Cycle en Bray",
  bennespro: "Bennes & Pro",
  pointeuse: "Pointeuse",
  feedback: "Feedback",
};

/** Bloc citation pour reprendre un message tel qu'il a été écrit. */
function quoteBlock(body: string) {
  return `<div style="margin:0 0 22px;padding:14px 16px;border-left:3px solid ${BRAND};background:#f4f8f6;border-radius:0 12px 12px 0;">
    <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:#243b30;white-space:pre-wrap;">${esc(body)}</p>
  </div>`;
}

/**
 * Prévient l'auteur d'un retour qu'on lui a répondu, avec le message.
 *
 * Le contenu est repris dans l'email : sans lui, la notification force à
 * rouvrir l'app pour savoir s'il s'agit d'une vraie réponse ou d'un accusé de
 * réception, et les échanges s'enlisent.
 */
export const sendFeedbackCommentEmail = internalAction({
  args: {
    email: v.string(),
    authorName: v.optional(v.string()),
    commenterName: v.string(),
    commenterPhotoUrl: v.optional(v.string()),
    body: v.string(),
    feedbackType: v.string(),
    description: v.string(),
  },
  handler: async (_ctx, args) => {
    const greeting = args.authorName?.trim() ? `Bonjour ${esc(args.authorName.trim())},` : "Bonjour,";
    const excerpt =
      args.description.length > 160 ? `${args.description.slice(0, 160).trimEnd()}…` : args.description;

    const html = shell({
      preheader: `${args.commenterName} a répondu à votre retour.`,
      heading: "Réponse à votre retour",
      intro: `${greeting}<br/><br/><strong>${esc(args.commenterName)}</strong> vous a répondu à propos de votre retour « ${esc(excerpt)} ».`,
      contentHtml: `
        ${userChip(args.commenterName, args.commenterPhotoUrl, "A répondu")}
        ${quoteBlock(args.body)}
        ${button(feedbackAppUrl(), "Répondre dans l'app")}
      `,
    });

    await resendSend(args.email, `Réponse à votre retour · ${FEEDBACK_TYPE_LABELS[args.feedbackType] ?? "Retour"}`, html, FROM);
  },
});

/** Prévient l'équipe produit qu'un nouveau retour vient d'être déposé. */
export const sendFeedbackCreatedEmail = internalAction({
  args: {
    /** Absente pour une idée de « nouvelle application » (aucune app visée). */
    app: v.optional(v.string()),
    feedbackType: v.string(),
    description: v.string(),
    authorName: v.optional(v.string()),
    authorEmail: v.string(),
    authorPhotoUrl: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const appLabel = args.app
      ? FEEDBACK_APP_LABELS[args.app] ?? args.app
      : "Nouvelle application";
    const typeLabel = FEEDBACK_TYPE_LABELS[args.feedbackType] ?? "Retour";
    const authorLabel = args.authorName?.trim() || args.authorEmail;

    const html = shell({
      preheader: args.app
        ? `${authorLabel} a déposé un retour sur ${appLabel}.`
        : `${authorLabel} propose une idée de nouvelle application.`,
      heading: args.app ? "Nouveau retour utilisateur" : "Idée de nouvelle application",
      intro: args.app
        ? `Un nouveau retour vient d'être déposé sur <strong>${esc(appLabel)}</strong>.`
        : `Une idée d'application vient d'être proposée.`,
      contentHtml: `
        ${userChip(authorLabel, args.authorPhotoUrl, args.authorEmail)}
        ${detailCard([
          ...(args.app ? ([["Application", appLabel]] as Array<[string, string]>) : []),
          ["Type", typeLabel],
        ])}
        ${quoteBlock(args.description)}
        ${button(feedbackAppUrl(), "Traiter le retour")}
      `,
    });

    await resendSend(
      FEEDBACK_INBOX_EMAILS,
      args.app ? `Nouveau retour · ${appLabel} (${typeLabel})` : `Nouveau retour · ${typeLabel}`,
      html,
      FROM,
    );
  },
});

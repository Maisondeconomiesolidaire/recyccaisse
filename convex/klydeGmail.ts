/**
 * Klyd — lecture de la boîte Gmail Vinted.
 *
 * Vinted n'expose aucune API publique : tout ce qui compte pour le suivi des
 * ventes (article vendu, bordereau d'expédition, numéro de suivi, virement)
 * n'arrive que par email. Ce module connecte une boîte Gmail en OAuth Google
 * (scope `gmail.readonly` — lecture seule, jamais d'envoi ni de suppression),
 * importe les emails Vinted, en extrait les informations utiles et les
 * rapproche des articles du stock Klyd.
 *
 * Variables d'environnement du déploiement Convex (`npx convex env set … --prod`) :
 *   GOOGLE_CLIENT_ID       — identifiant OAuth « Application Web » Google Cloud
 *   GOOGLE_CLIENT_SECRET   — secret associé
 *   KLYDE_APP_URL          — URL publique de Klyd (retour après consentement)
 *
 * URI de redirection à déclarer côté Google Cloud (exactement) :
 *   https://hip-marten-394.eu-west-1.convex.site/klyde/gmail/oauth/callback
 */
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCrmPermission } from "./lib";

/** Clé de permission CRM de la boîte Vinted (administrée depuis Mes Outils). */
const PAGE_KEY = "klyde:vinted";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Scopes demandés. `gmail.readonly` est volontairement le seul accès Gmail :
 * l'app ne doit jamais pouvoir écrire, envoyer ou supprimer dans la boîte.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
].join(" ");

/**
 * Natures d'emails effectivement importées. Les notifications de messagerie et
 * les emails purement transactionnels (virements, promos) ne servent pas au
 * suivi du stock : on les laisse dans la boîte plutôt que d'encombrer la file.
 */
const KEPT_KINDS = new Set<VintedKind>(["vente", "bordereau", "expedition", "offre"]);

/**
 * Adresses qui transfèrent les emails Vinted vers la boîte scrutée. En
 * pratique les notifications n'arrivent pas de Vinted mais d'un collègue qui
 * les fait suivre depuis son compte : sans ces adresses, la requête Gmail ne
 * ramène rien.
 */
const FORWARDERS = ["s.maccioni@eco-solidaire.fr"];

/**
 * Expéditeurs des emails de suivi : les notifications d'expédition ne viennent
 * pas de Vinted mais du transporteur qui achemine le colis.
 */
const CARRIER_SENDERS = [
  "chronopost.fr",
  "chronopost.com",
  "mondialrelay.fr",
  "mondialrelay.com",
];

/** Requête Gmail par défaut : Vinted, les transporteurs et les transferts. */
const DEFAULT_QUERY = `(from:(vinted.fr OR vinted.com OR vinted.co.uk OR ${CARRIER_SENDERS.join(" OR ")}) OR from:(${FORWARDERS.join(" OR ")}))`;

/**
 * Requêtes posées par une version antérieure du module : elles ne ramenaient
 * que les emails envoyés par Vinted, donc rien depuis que les notifications
 * arrivent par transfert. On les remplace à la volée par la requête courante.
 */
const LEGACY_QUERIES = new Set([
  "from:(vinted.fr OR vinted.com OR vinted.co.uk)",
  `(from:(vinted.fr OR vinted.com OR vinted.co.uk) OR from:(${FORWARDERS.join(" OR ")}))`,
]);

/**
 * Enseigne d'appartenance d'une boîte. Le stock Klyd est partagé entre deux
 * enseignes : sans ce rattachement, rien ne distingue une vente Mobifrip d'une
 * vente Klyd dans la file des emails.
 */
const ACCOUNT_OUTLETS: Record<string, "klyd" | "mobifrip"> = {
  "mobifrip42@gmail.com": "mobifrip",
};

/** Nombre maximal de messages traités par exécution (limites d'action Convex). */
const MAX_MESSAGES_PER_SYNC = 60;

/** Un état OAuth non consommé expire au bout de 15 minutes. */
const STATE_TTL_MS = 15 * 60 * 1000;

/* ────────────────────────── Utilitaires bas niveau ─────────────────────── */

function siteUrl() {
  return (
    process.env.CONVEX_SITE_URL ?? "https://hip-marten-394.eu-west-1.convex.site"
  ).replace(/\/$/, "");
}

function redirectUri() {
  return `${siteUrl()}/klyde/gmail/oauth/callback`;
}

function klydeAppUrl() {
  return (process.env.KLYDE_APP_URL ?? "https://klyd.groupemes.fr").replace(/\/$/, "");
}

function googleCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET manquants sur le déploiement Convex.",
    );
  }
  return { clientId, clientSecret };
}

/** Gmail encode les corps en base64url (`-` et `_`, sans padding). */
function decodeBase64Url(data: string): Uint8Array {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeBase64UrlToText(data: string): string {
  try {
    return new TextDecoder("utf-8").decode(decodeBase64Url(data));
  } catch {
    return "";
  }
}

/**
 * Aplatit un corps HTML en texte lisible : les emails Vinted n'ont pas toujours
 * de partie `text/plain`, et une extraction sur du HTML brut casse les regex.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|td|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&euro;/gi, "€")
    .replace(/[ \t\u00a0\u202f]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

type GmailMessage = {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
};

function header(message: GmailMessage, name: string): string {
  const found = message.payload?.headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

/** Parcourt récursivement l'arbre MIME et renvoie toutes les feuilles. */
function flattenParts(part: GmailPart | undefined): GmailPart[] {
  if (!part) return [];
  if (!part.parts?.length) return [part];
  return part.parts.flatMap((child) => flattenParts(child));
}

/** Corps du message en texte : `text/plain` en priorité, sinon HTML aplati. */
export function messageBodyText(message: GmailMessage): string {
  const parts = flattenParts(message.payload);
  const plain = parts
    .filter((p) => p.mimeType === "text/plain" && p.body?.data)
    .map((p) => decodeBase64UrlToText(p.body!.data!))
    .join("\n")
    .trim();
  if (plain) return plain.slice(0, 20000);
  const html = parts
    .filter((p) => p.mimeType === "text/html" && p.body?.data)
    .map((p) => decodeBase64UrlToText(p.body!.data!))
    .join("\n");
  return htmlToText(html).slice(0, 20000);
}

/** Concatène texte et HTML : les liens (bordereau) ne vivent que dans le HTML. */
function messageRawHtml(message: GmailMessage): string {
  return flattenParts(message.payload)
    .filter((p) => p.mimeType === "text/html" && p.body?.data)
    .map((p) => decodeBase64UrlToText(p.body!.data!))
    .join("\n");
}

/* ─────────────────────────── Analyse des emails ────────────────────────── */

export type VintedKind =
  | "vente"
  | "bordereau"
  | "expedition"
  | "paiement"
  | "offre"
  | "message"
  | "autre";

/**
 * Nature du message, déduite du sujet puis du corps. L'ordre des tests compte :
 * un email de vente contient souvent aussi le mot « bordereau », mais c'est
 * bien la vente qui est l'événement à retenir.
 */
export function classifyEmail(subject: string, body: string): VintedKind {
  const text = `${subject}\n${body}`.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => text.includes(n));

  if (has("est vendu", "a été vendu", "vendu !", "bonne nouvelle", "tu as vendu", "article vendu"))
    return "vente";
  if (has("bordereau", "étiquette d'expédition", "etiquette d'expedition", "imprime ton", "imprimer l'étiquette"))
    return "bordereau";
  if (has("colis", "numéro de suivi", "numero de suivi", "expédi", "expedi", "livraison", "point relais"))
    return "expedition";
  if (has("virement", "paiement", "porte-monnaie", "solde", "tu as reçu", "transfert d'argent"))
    return "paiement";
  if (has("offre", "propose", "négoci", "negoci")) return "offre";
  if (has("message", "t'a écrit", "nouvelle discussion")) return "message";
  return "autre";
}

/** Montant en euros : « 12,50 € », « € 12.50 », « 12 € ». Prend le plus élevé. */
export function extractAmount(text: string): number | undefined {
  const matches = [
    ...text.matchAll(/(?:€\s*)?(\d{1,4}(?:[\s\u202f\u00a0]?\d{3})*(?:[.,]\d{1,2})?)\s*(?:€|eur\b|euros?\b)/gi),
  ];
  const values = matches
    .map((m) => Number(m[1].replace(/[\s\u202f\u00a0]/g, "").replace(",", ".")))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100000);
  if (!values.length) return undefined;
  return Math.max(...values);
}

/** Numéro de commande Vinted (« Commande n° 1234567890 », « #1234567 »). */
export function extractOrderRef(text: string): string | undefined {
  // Vinted écrit « N° de transaction : 21703139614 » — le n° précède le mot.
  const prefixed = text.match(
    /n[°ºo]\s*de\s*(?:transaction|commande|vente)\s*:?\s*([A-Z0-9-]{5,25})/i,
  );
  if (prefixed) return prefixed[1];
  const labelled = text.match(
    /(?:commande|transaction|vente)\s*(?:n[°ºo]\s*|num[ée]ro\s*:?\s*|#)\s*([A-Z0-9-]{5,25})/i,
  );
  if (labelled) return labelled[1];
  const hash = text.match(/#\s?(\d{6,15})\b/);
  return hash?.[1];
}

const CARRIERS = [
  "Mondial Relay",
  "Colissimo",
  "Chronopost",
  "Relais Colis",
  "Shop2Shop",
  "UPS",
  "DHL",
  "DPD",
  "GLS",
  "La Poste",
  "InPost",
  "Vinted Go",
];

export function extractCarrier(text: string): string | undefined {
  const lower = text.toLowerCase();
  return CARRIERS.find((carrier) => lower.includes(carrier.toLowerCase()));
}

/**
 * Numéro de suivi : d'abord une mention explicite, sinon un identifiant au
 * format transporteur. On évite délibérément les suites de chiffres nues, qui
 * attrapent surtout des montants et des numéros de commande.
 */
export function extractTrackingNumber(text: string): string | undefined {
  const labelled = text.match(
    /(?:num[ée]ro de suivi|n[°ºo] de suivi|suivi|tracking(?: number)?)\s*:?\s*([A-Z0-9]{8,25})/i,
  );
  if (labelled) return labelled[1].toUpperCase();
  const postal = text.match(/\b([A-Z]{2}\d{9}[A-Z]{2})\b/);
  if (postal) return postal[1];
  const mondialRelay = text.match(/\b(\d{8}|\d{11,13})\b(?=[^\n]{0,40}(?:mondial relay|relais|colis))/i);
  return mondialRelay?.[1];
}

/** Lien de téléchargement/impression du bordereau, cherché dans le HTML. */
export function extractLabelUrl(html: string, text: string): string | undefined {
  const found = allUrls(html, text).find((url) =>
    /label|shipping|bordereau|etiquette|étiquette|\.pdf/i.test(url),
  );
  return found?.slice(0, 1500);
}

/** Préfixes de transfert/réponse, français et anglais. */
const FORWARD_PREFIX = /^\s*(?:(?:tr|fwd?|re|rép)\s*:\s*)+/i;

const FRENCH_MONTHS: Record<string, number> = {
  janvier: 0, "février": 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
  juillet: 6, "août": 7, aout: 7, septembre: 8, octobre: 9, novembre: 10,
  "décembre": 11, decembre: 11,
};

/**
 * Décalage de Paris par rapport à UTC, en heures, pour un instant donné :
 * +2 entre le dernier dimanche de mars et le dernier dimanche d'octobre, +1
 * sinon. Les en-têtes français ne portent pas de fuseau ; sans cette
 * correction, une notification datée 10:03 à Paris se range à 10:03 UTC,
 * c'est-à-dire après le transfert qui l'a apportée.
 */
function parisOffsetHours(year: number, month: number, day: number): number {
  const lastSunday = (m: number) => {
    const last = new Date(Date.UTC(year, m + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const afterMarch = month > 2 || (month === 2 && day >= lastSunday(2));
  const beforeOctober = month < 9 || (month === 9 && day < lastSunday(9));
  return afterMarch && beforeOctober ? 2 : 1;
}

/**
 * Date d'un en-tête de transfert. Outlook et Gmail l'écrivent dans la langue
 * de l'expéditeur (« mardi 25 août 2026 10:03 ») : `Date.parse` renvoie NaN
 * sur le français, d'où la lecture manuelle avant de tenter le format anglais.
 */
export function parseHeaderDate(value: string): number | undefined {
  const french = value.match(
    /(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})(?:\s+(?:à\s+)?(\d{1,2})[:h](\d{2}))?/u,
  );
  if (french) {
    const month = FRENCH_MONTHS[french[2].toLowerCase()];
    if (month !== undefined) {
      const year = Number(french[3]);
      const day = Number(french[1]);
      return Date.UTC(
        year,
        month,
        day,
        Number(french[4] ?? 0) - parisOffsetHours(year, month, day),
        Number(french[5] ?? 0),
      );
    }
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type ForwardedOrigin = {
  /** Sujet d'origine, une fois les préfixes « TR : » retirés. */
  subject: string;
  /** Expéditeur d'origine (Vinted), s'il a pu être relu. */
  from?: string;
  /** Date d'origine du message Vinted, si elle est exploitable. */
  sentAt?: number;
};

/**
 * Un email transféré porte le sujet et la date du transfert, pas ceux de la
 * notification Vinted. Gmail recopie l'en-tête d'origine en tête du corps
 * (« ---------- Forwarded message --------- », puis De / Date / Objet) : on
 * le relit pour rattacher la vente à sa vraie date et à son vrai sujet.
 */
export function readForwardedOrigin(subject: string, body: string): ForwardedOrigin {
  const stripped = subject.replace(FORWARD_PREFIX, "").trim();
  const origin: ForwardedOrigin = { subject: stripped || subject };

  const innerSubject = body.match(/^\s*(?:Objet|Subject)\s*:\s*(.+)$/mu);
  if (innerSubject) {
    const value = innerSubject[1].replace(FORWARD_PREFIX, "").trim();
    if (value) origin.subject = value.slice(0, 300);
  }

  const innerFrom = body.match(/^\s*(?:De|From)\s*:\s*(.+)$/mu);
  if (innerFrom) origin.from = innerFrom[1].trim().slice(0, 200);

  const innerDate = body.match(/^\s*(?:Date|Envoy[ée]|Sent)\s*:\s*(.+)$/mu);
  if (innerDate) {
    const parsedDate = parseHeaderDate(innerDate[1].trim());
    if (parsedDate !== undefined) origin.sentAt = parsedDate;
  }
  return origin;
}

/**
 * Un transfert peut aussi bien porter une notification exploitable qu'un
 * message sans rapport. On exige une trace de Vinted ou d'un transporteur —
 * les emails d'expédition ne mentionnent pas toujours Vinted.
 */
export function isRelevantForward(...parts: string[]): boolean {
  return parts.some((part) => /vinted|chronopost|mondial\s?relay/i.test(part));
}

/**
 * Les liens des emails Vinted passent par un traceur (`click.vinted.fr/…?url=…`).
 * On récupère la cible réelle, sinon le bouton renvoie vers une page de
 * redirection qui expire.
 */
function unwrapVintedUrl(url: string): string {
  const cleaned = url.replace(/&amp;/g, "&");

  // `links.vinted.com/t/<base64>` encode « url|identifiant|signature » : sans
  // ce décodage, tous les liens d'un email se ressemblent et aucun filtre
  // (conversation, annonce, bordereau) ne peut les distinguer.
  const tracker = cleaned.match(/links\.vinted\.[a-z.]+\/t\/([A-Za-z0-9_-]+=*)/i);
  if (tracker) {
    try {
      const target = decodeBase64UrlToText(tracker[1]).split("|")[0];
      if (/^https?:\/\//i.test(target)) return target;
    } catch {
      // Charge utile illisible : le lien traceur reste fonctionnel.
    }
  }
  const wrapped = cleaned.match(/[?&](?:url|u|redirect|target)=([^&]+)/i);
  if (wrapped) {
    try {
      const decoded = decodeURIComponent(wrapped[1]);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      // Cible illisible : on garde le lien traceur, il fonctionne aussi.
    }
  }
  return cleaned;
}

/** Tous les liens d'un email, HTML et texte confondus, cibles démasquées. */
function allUrls(html: string, text: string): string[] {
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
  const inline = [...text.matchAll(/https?:\/\/[^\s<>")]+/gi)].map((m) => m[0]);
  return [...hrefs, ...inline].map(unwrapVintedUrl);
}

/**
 * Lien vers la conversation Vinted avec l'acheteur. C'est le geste le plus
 * fréquent après une vente (répondre, envoyer le suivi) : sans ce lien il faut
 * rouvrir la boîte mail pour retrouver le fil.
 */
export function extractConversationUrl(html: string, text: string): string | undefined {
  const found = allUrls(html, text).find((url) =>
    /vinted\.[a-z.]+\/(?:inbox|conversations?|messages)\b|\/msg\/|conversation_id=/i.test(url),
  );
  return found?.slice(0, 1500);
}

/** Lien vers l'annonce concernée (`vinted.fr/items/123…`). */
export function extractItemUrl(html: string, text: string): string | undefined {
  const found = allUrls(html, text).find((url) =>
    /vinted\.[a-z.]+\/(?:items|articles)\/\d+/i.test(url),
  );
  return found?.slice(0, 1500);
}

/**
 * Titre de l'article. Vinted le met sur une ligne isolée après une accroche du
 * type « Ton article … a été vendu » ; à défaut on prend le sujet nettoyé.
 */
export function extractItemTitle(subject: string, body: string): string | undefined {
  // Email de vente : « <pseudo> a acheté » puis le titre, d'abord entre
  // crochets (texte alternatif de la vignette) puis en clair.
  const bought = body.match(/a\s+achet[ée]\s*\n+\s*\[?([^\n\]]{3,120})\]?/u);
  if (bought) return bought[1].trim().slice(0, 120);

  // Email de bordereau : bloc « Informations d'envoi », ligne « Article : ».
  const labelled = body.match(/^\s*Article\s*:?\s*(.+)$/mu);
  if (labelled) {
    const value = labelled[1].trim();
    if (value && !/^https?:/i.test(value)) return value.slice(0, 120);
  }

  // Sujet du bordereau : « … à utiliser avant le … pour <titre> ».
  const inSubject = subject.match(/\bpour\s+(.{3,120})$/u);
  if (inSubject) return inSubject[1].trim();

  const quoted = body.match(/[«"“]\s*([^»"”\n]{3,80})\s*[»"”]/);
  if (quoted) return quoted[1].trim();

  // Repli : le sujet nettoyé. Volontairement en dernier — c'est souvent une
  // accroche (« Ton article s'est vendu ! ») et non le nom de l'article.
  const fromSubject = subject
    .replace(/^(re|fwd)\s*:\s*/i, "")
    .replace(/vinted/gi, "")
    .replace(/[!🎉✅📦💶💰]/gu, "")
    .trim();
  return fromSubject.length >= 3 ? fromSubject.slice(0, 120) : undefined;
}

/** Pseudo de l'acheteur (« @pseudo », « acheté par pseudo »). */
export function extractBuyer(text: string): string | undefined {
  // Formulation systématique des emails de vente : « hamad88 a acheté ».
  const bought = text.match(/^\s*([A-Za-z0-9._-]{2,30})\s+a\s+achet[ée]/mu);
  if (bought) return bought[1];
  const contact = text.match(/contacter\s+@?([A-Za-z0-9._-]{2,30})\b/i);
  if (contact) return contact[1];
  const labelled = text.match(/(?:achet[ée] par|vendu [àa])\s*:?\s*@?([A-Za-z0-9._-]{3,30})/i);
  if (labelled) return labelled[1];
  const at = text.match(/(?:^|\s)@([A-Za-z0-9._-]{3,30})\b/);
  return at?.[1];
}

/**
 * Coordonnées de facturation de l'acheteur. Vinted les donne en clair dans
 * l'email de vente (« Coordonnées de l'acheteur »), puisque le vendeur Pro doit
 * joindre une facture au colis — c'est la seule source pour l'établir.
 */
export function extractBuyerContact(body: string): {
  buyerName?: string;
  buyerAddress?: string;
  buyerEmail?: string;
} {
  // « Adresse e-mail : » ne doit pas être confondue avec « Adresse : ».
  const address = body.match(/^\s*Adresse\s*:\s*(.+)$/mu)?.[1]?.trim();
  const email = body
    .match(/^\s*Adresse\s+e-?mail\s*:\s*(\S+@\S+)$/mu)?.[1]
    ?.trim();
  // Vinted écrit « Nom Prénom, rue, ville, code postal, pays » : le nom est le
  // premier segment, l'adresse postale est le reste.
  const [first, ...rest] = (address ?? "").split(",");
  const name = first?.trim();
  return {
    buyerName: name && rest.length > 0 ? name.slice(0, 120) : undefined,
    buyerAddress: address ? address.slice(0, 300) : undefined,
    buyerEmail: email?.slice(0, 200),
  };
}

export type ParsedEmail = {
  kind: VintedKind;
  itemTitle?: string;
  amount?: number;
  buyer?: string;
  orderRef?: string;
  trackingNumber?: string;
  carrier?: string;
  labelUrl?: string;
  conversationUrl?: string;
  itemUrl?: string;
  buyerName?: string;
  buyerAddress?: string;
  buyerEmail?: string;
};

/** Extraction complète, purement locale (aucun appel réseau). */
export function parseVintedEmail(subject: string, body: string, html: string): ParsedEmail {
  const kind = classifyEmail(subject, body);
  const haystack = `${subject}\n${body}`;
  return {
    kind,
    itemTitle: extractItemTitle(subject, body),
    amount: extractAmount(haystack),
    buyer: extractBuyer(haystack),
    orderRef: extractOrderRef(haystack),
    trackingNumber: extractTrackingNumber(haystack),
    carrier: extractCarrier(haystack),
    labelUrl: kind === "bordereau" || kind === "expedition" ? extractLabelUrl(html, body) : undefined,
    conversationUrl: extractConversationUrl(html, body),
    itemUrl: extractItemUrl(html, body),
    ...(kind === "vente" ? extractBuyerContact(body) : {}),
  };
}

/* ───────────────────────────── Accès Google ───────────────────────────── */

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function exchangeCode(code: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = googleCredentials();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(
      `Échange du code Google refusé : ${data.error_description ?? data.error ?? response.status}`,
    );
  }
  return data;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = googleCredentials();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(
      `Rafraîchissement du jeton Google refusé : ${data.error_description ?? data.error ?? response.status}`,
    );
  }
  return data;
}

/**
 * Jeton d'accès valide pour un compte : réutilise celui en base tant qu'il
 * reste plus d'une minute de validité, sinon le rafraîchit et le persiste.
 */
async function accessTokenFor(
  ctx: ActionCtx,
  account: Doc<"klydeGmailAccounts">,
): Promise<string> {
  if (
    account.accessToken &&
    account.accessTokenExpiresAt &&
    account.accessTokenExpiresAt - Date.now() > 60_000
  ) {
    return account.accessToken;
  }
  const refreshed = await refreshAccessToken(account.refreshToken);
  const expiresAt = Date.now() + (refreshed.expires_in ?? 3600) * 1000;
  await ctx.runMutation(internal.klydeGmail.storeAccessToken, {
    accountId: account._id,
    accessToken: refreshed.access_token!,
    accessTokenExpiresAt: expiresAt,
  });
  return refreshed.access_token!;
}

async function gmailGet<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Gmail ${path} → ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

/* ──────────────────────── Étape 1 : consentement ───────────────────────── */

/**
 * Prépare la redirection vers Google. On enregistre un `state` aléatoire lié à
 * l'utilisateur connecté : au retour, un `code` présenté sans état connu est
 * rejeté (protection CSRF).
 */
export const connectUrl = action({
  args: { returnUrl: v.optional(v.string()) },
  handler: async (ctx, args): Promise<string> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Connexion requise.");
    await ctx.runQuery(internal.klydeGmail.assertCanManage, {});
    const { clientId } = googleCredentials();

    const state = crypto.randomUUID().replace(/-/g, "");
    await ctx.runMutation(internal.klydeGmail.createOAuthState, {
      state,
      clerkId: identity.subject,
      clerkName: identity.name,
      returnUrl: args.returnUrl ?? `${klydeAppUrl()}/`,
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPES,
      // `offline` + `consent` : indispensables pour obtenir (et ré-obtenir) le
      // refresh token, sans lequel la synchronisation s'arrête au bout d'une heure.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  },
});

export const assertCanManage = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    return true;
  },
});

export const createOAuthState = internalMutation({
  args: {
    state: v.string(),
    clerkId: v.string(),
    clerkName: v.optional(v.string()),
    returnUrl: v.string(),
  },
  handler: async (ctx, args) => {
    // Ménage opportuniste : les états non consommés n'ont plus d'intérêt.
    const stale = await ctx.db.query("klydeGmailOAuthStates").collect();
    for (const entry of stale) {
      if (Date.now() - entry.createdAt > STATE_TTL_MS) await ctx.db.delete(entry._id);
    }
    await ctx.db.insert("klydeGmailOAuthStates", { ...args, createdAt: Date.now() });
  },
});

export const consumeOAuthState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("klydeGmailOAuthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();
    if (!entry) return null;
    await ctx.db.delete(entry._id);
    if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
    return { clerkId: entry.clerkId, clerkName: entry.clerkName, returnUrl: entry.returnUrl };
  },
});

/* ──────────────── Étape 2 : retour de Google (HTTP action) ─────────────── */

/**
 * Appelée par la route HTTP `/klyde/gmail/oauth/callback`. Renvoie l'URL de
 * redirection finale (avec `?gmail=ok` ou `?gmail=error&message=…`) pour que
 * l'utilisateur retombe dans Klyd avec un message clair.
 */
export const completeOAuth = internalAction({
  args: { code: v.string(), state: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const pending = await ctx.runMutation(internal.klydeGmail.consumeOAuthState, {
      state: args.state,
    });
    if (!pending) {
      return `${klydeAppUrl()}/?gmail=error&message=${encodeURIComponent(
        "Demande de connexion expirée ou inconnue. Relance la connexion depuis Klyd.",
      )}`;
    }

    try {
      const tokens = await exchangeCode(args.code);
      const profile = (await (
        await fetch(GOOGLE_USERINFO_URL, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
      ).json()) as { email?: string };
      const email = profile.email;
      if (!email) throw new Error("Google n'a pas renvoyé l'adresse du compte.");
      if (!tokens.refresh_token) {
        throw new Error(
          "Google n'a pas renvoyé de refresh token. Retire l'accès de l'app dans myaccount.google.com/permissions puis recommence.",
        );
      }

      const accountId: Id<"klydeGmailAccounts"> = await ctx.runMutation(
        internal.klydeGmail.upsertAccount,
        {
          email,
          connectedByClerkId: pending.clerkId,
          connectedByName: pending.clerkName,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          accessTokenExpiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        },
      );

      // Première synchronisation immédiate : la boîte est utile tout de suite.
      await ctx.scheduler.runAfter(0, internal.klydeGmail.syncAccount, { accountId });
      return `${pending.returnUrl}${pending.returnUrl.includes("?") ? "&" : "?"}gmail=ok&email=${encodeURIComponent(email)}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${pending.returnUrl}${pending.returnUrl.includes("?") ? "&" : "?"}gmail=error&message=${encodeURIComponent(message)}`;
    }
  },
});

export const upsertAccount = internalMutation({
  args: {
    email: v.string(),
    connectedByClerkId: v.string(),
    connectedByName: v.optional(v.string()),
    refreshToken: v.string(),
    accessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"klydeGmailAccounts">> => {
    const existing = await ctx.db
      .query("klydeGmailAccounts")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        connectedByClerkId: args.connectedByClerkId,
        connectedByName: args.connectedByName,
        refreshToken: args.refreshToken,
        accessToken: args.accessToken,
        accessTokenExpiresAt: args.accessTokenExpiresAt,
        active: true,
        lastSyncError: undefined,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("klydeGmailAccounts", {
      ...args,
      query: DEFAULT_QUERY,
      active: true,
      importedCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const storeAccessToken = internalMutation({
  args: {
    accountId: v.id("klydeGmailAccounts"),
    accessToken: v.string(),
    accessTokenExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      accessToken: args.accessToken,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      updatedAt: Date.now(),
    });
  },
});

/* ───────────────────────── Étape 3 : synchronisation ───────────────────── */

export const getAccount = internalQuery({
  args: { accountId: v.id("klydeGmailAccounts") },
  handler: async (ctx, args) => ctx.db.get(args.accountId),
});

export const activeAccountIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db
      .query("klydeGmailAccounts")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return accounts.map((account) => account._id);
  },
});

export const knownGmailIds = internalQuery({
  args: { gmailIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const known: string[] = [];
    for (const gmailId of args.gmailIds) {
      const existing = await ctx.db
        .query("klydeVintedEmails")
        .withIndex("by_gmailId", (q) => q.eq("gmailId", gmailId))
        .unique();
      if (existing) known.push(gmailId);
    }
    return known;
  },
});

/**
 * Rapprochement email → article : d'abord la référence (SKU) citée dans le
 * corps, sinon le meilleur recouvrement de mots avec le titre de l'article.
 * Volontairement conservateur : un mauvais rattachement fausse le CA.
 */
function matchScore(itemTitle: string, emailTitle: string): number {
  const words = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2);
  const a = new Set(words(itemTitle));
  const b = words(emailTitle);
  if (!a.size || !b.length) return 0;
  const hits = b.filter((word) => a.has(word)).length;
  return hits / Math.max(a.size, b.length);
}

export const saveEmail = internalMutation({
  args: {
    accountId: v.id("klydeGmailAccounts"),
    gmailId: v.string(),
    threadId: v.optional(v.string()),
    sentAt: v.number(),
    subject: v.string(),
    from: v.string(),
    snippet: v.optional(v.string()),
    bodyText: v.optional(v.string()),
    kind: v.union(
      v.literal("vente"),
      v.literal("bordereau"),
      v.literal("expedition"),
      v.literal("paiement"),
      v.literal("offre"),
      v.literal("message"),
      v.literal("autre"),
    ),
    itemTitle: v.optional(v.string()),
    amount: v.optional(v.number()),
    buyer: v.optional(v.string()),
    orderRef: v.optional(v.string()),
    trackingNumber: v.optional(v.string()),
    carrier: v.optional(v.string()),
    labelUrl: v.optional(v.string()),
    conversationUrl: v.optional(v.string()),
    itemUrl: v.optional(v.string()),
    forwardedBy: v.optional(v.string()),
    forwardedAt: v.optional(v.number()),
    outlet: v.optional(v.union(v.literal("klyd"), v.literal("mobifrip"))),
    buyerName: v.optional(v.string()),
    buyerAddress: v.optional(v.string()),
    buyerEmail: v.optional(v.string()),
    attachments: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          filename: v.string(),
          mimeType: v.string(),
          size: v.optional(v.number()),
        }),
      ),
    ),
    aiParsed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("klydeVintedEmails")
      .withIndex("by_gmailId", (q) => q.eq("gmailId", args.gmailId))
      .unique();
    if (existing) return { created: false as const, id: existing._id };

    // Rapprochement automatique avec un article du stock.
    let matchedItemId: Id<"klydeItems"> | undefined;
    let matchConfidence: number | undefined;
    const haystack = `${args.subject}\n${args.bodyText ?? ""}`;
    const items = await ctx.db.query("klydeItems").order("desc").take(600);
    const bySku = items.find(
      (item) => item.sku && haystack.toLowerCase().includes(item.sku.toLowerCase()),
    );
    if (bySku) {
      matchedItemId = bySku._id;
      matchConfidence = 1;
    } else if (args.itemTitle) {
      let best: { id: Id<"klydeItems">; score: number } | null = null;
      for (const item of items) {
        const score = matchScore(item.title, args.itemTitle);
        if (!best || score > best.score) best = { id: item._id, score };
      }
      if (best && best.score >= 0.5) {
        matchedItemId = best.id;
        matchConfidence = Number(best.score.toFixed(2));
      }
    }

    const id = await ctx.db.insert("klydeVintedEmails", {
      ...args,
      matchedItemId,
      matchConfidence,
      handled: false,
      createdAt: Date.now(),
    });
    return { created: true as const, id };
  },
});

export const finishSync = internalMutation({
  args: {
    accountId: v.id("klydeGmailAccounts"),
    lastMessageDate: v.optional(v.number()),
    imported: v.number(),
    error: v.optional(v.string()),
    /** Requête réellement utilisée, quand elle vient de remplacer une ancienne. */
    query: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;
    await ctx.db.patch(args.accountId, {
      lastSyncAt: Date.now(),
      lastSyncError: args.error,
      ...(args.query ? { query: args.query } : {}),
      lastMessageDate: Math.max(args.lastMessageDate ?? 0, account.lastMessageDate ?? 0) || undefined,
      importedCount: (account.importedCount ?? 0) + args.imported,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Importe les emails Vinted d'un compte. Incrémental : on repart de la date du
 * dernier message déjà importé (moins un jour de marge, Gmail filtrant par
 * jour), et on ignore les identifiants déjà connus.
 */
export const syncAccount = internalAction({
  args: {
    accountId: v.id("klydeGmailAccounts"),
    /** Ignore la borne incrémentale (première importation, rattrapage). */
    full: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ imported: number; scanned: number }> => {
    const account: Doc<"klydeGmailAccounts"> | null = await ctx.runQuery(
      internal.klydeGmail.getAccount,
      { accountId: args.accountId },
    );
    if (!account || !account.active) return { imported: 0, scanned: 0 };

    let imported = 0;
    let scanned = 0;
    let newestDate = account.lastMessageDate ?? 0;
    try {
      const token = await accessTokenFor(ctx, account);
      const storedQuery = account.query;
      const effectiveQuery =
        !storedQuery || LEGACY_QUERIES.has(storedQuery) ? DEFAULT_QUERY : storedQuery;
      const queryParts = [effectiveQuery];
      if (!args.full && account.lastMessageDate) {
        const afterSeconds = Math.floor((account.lastMessageDate - 24 * 3600 * 1000) / 1000);
        queryParts.push(`after:${afterSeconds}`);
      }
      const listing = await gmailGet<{ messages?: Array<{ id: string }> }>(
        token,
        `/messages?maxResults=${MAX_MESSAGES_PER_SYNC}&q=${encodeURIComponent(queryParts.join(" "))}`,
      );
      const ids = (listing.messages ?? []).map((m) => m.id);
      const known = new Set<string>(
        await ctx.runQuery(internal.klydeGmail.knownGmailIds, { gmailIds: ids }),
      );

      for (const gmailId of ids) {
        if (known.has(gmailId)) continue;
        scanned += 1;
        const message = await gmailGet<GmailMessage>(token, `/messages/${gmailId}?format=full`);
        const receivedAt = Number(message.internalDate ?? Date.now());
        const rawSubject = header(message, "Subject");
        const rawFrom = header(message, "From");
        const body = messageBodyText(message);
        const html = messageRawHtml(message);

        // Les notifications arrivent transférées par un collègue : on remonte
        // au sujet, à l'expéditeur et à la date d'origine avant d'analyser.
        const forwarded = FORWARDERS.some((address) =>
          rawFrom.toLowerCase().includes(address.toLowerCase()),
        );
        const origin = forwarded
          ? readForwardedOrigin(rawSubject, body)
          : { subject: rawSubject, from: rawFrom, sentAt: undefined };
        const subject = origin.subject;
        const from = origin.from ?? rawFrom;
        // Un message ne peut pas avoir été émis après avoir été transféré :
        // une date d'origine postérieure trahit une lecture ratée.
        const sentAt =
          origin.sentAt !== undefined && origin.sentAt <= receivedAt
            ? origin.sentAt
            : receivedAt;

        // Un transfert sans rapport avec Vinted n'a rien à faire ici.
        if (forwarded && !isRelevantForward(rawSubject, subject, from, body)) continue;

        const parsed = parseVintedEmail(subject, body, html);
        // Messages, virements et emails divers : lus, jamais stockés.
        if (!KEPT_KINDS.has(parsed.kind)) continue;

        // Pièces jointes (bordereaux PDF) rapatriées dans le stockage Convex :
        // elles restent consultables même si le lien Vinted expire.
        const attachments: Array<{
          storageId: Id<"_storage">;
          filename: string;
          mimeType: string;
          size?: number;
        }> = [];
        for (const part of flattenParts(message.payload)) {
          if (!part.filename || !part.body?.attachmentId) continue;
          // PDF uniquement : les images inline des emails Vinted ne sont que
          // des logos de signature, inutiles et coûteux à stocker.
          if (!/pdf/i.test(part.mimeType ?? "")) continue;
          if ((part.body.size ?? 0) > 8 * 1024 * 1024) continue;
          const attachment = await gmailGet<{ data?: string; size?: number }>(
            token,
            `/messages/${gmailId}/attachments/${part.body.attachmentId}`,
          );
          if (!attachment.data) continue;
          const bytes = decodeBase64Url(attachment.data);
          const storageId = await ctx.storage.store(
            new Blob([bytes as unknown as BlobPart], {
              type: part.mimeType ?? "application/octet-stream",
            }),
          );
          attachments.push({
            storageId,
            filename: part.filename,
            mimeType: part.mimeType ?? "application/octet-stream",
            size: attachment.size ?? part.body.size,
          });
        }

        const result = await ctx.runMutation(internal.klydeGmail.saveEmail, {
          accountId: account._id,
          gmailId,
          threadId: message.threadId,
          sentAt,
          subject,
          from,
          snippet: message.snippet?.slice(0, 500),
          bodyText: body || undefined,
          forwardedBy: forwarded ? rawFrom.slice(0, 200) : undefined,
          forwardedAt: forwarded ? receivedAt : undefined,
          outlet: ACCOUNT_OUTLETS[account.email.toLowerCase()],
          ...parsed,
          attachments: attachments.length ? attachments : undefined,
        });
        if (result.created) {
          imported += 1;
          // Une vente donne toujours lieu à une facture : elle est préparée
          // dès l'import. Planifiée plutôt qu'attendue, pour qu'un échec de
          // génération n'interrompe pas l'import des autres messages.
          if (parsed.kind === "vente") {
            await ctx.scheduler.runAfter(0, internal.klydeInvoices.generateForEmail, {
              emailId: result.id,
            });
          }
        }
        // `after:` filtre sur la date Gmail : la borne suit la réception, pas
        // la date d'origine d'un message transféré (souvent bien antérieure).
        if (receivedAt > newestDate) newestDate = receivedAt;
      }

      await ctx.runMutation(internal.klydeGmail.finishSync, {
        accountId: account._id,
        lastMessageDate: newestDate || undefined,
        imported,
        query: effectiveQuery !== storedQuery ? effectiveQuery : undefined,
      });
      return { imported, scanned };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.klydeGmail.finishSync, {
        accountId: account._id,
        lastMessageDate: newestDate || undefined,
        imported,
        error: message.slice(0, 500),
      });
      throw error;
    }
  },
});

/** Cron : passe sur toutes les boîtes connectées. */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const ids: Id<"klydeGmailAccounts">[] = await ctx.runQuery(
      internal.klydeGmail.activeAccountIds,
      {},
    );
    for (const accountId of ids) {
      try {
        await ctx.runAction(internal.klydeGmail.syncAccount, { accountId });
      } catch (error) {
        // Une boîte en échec (consentement révoqué) ne doit pas bloquer les autres.
        console.error(
          `Sync Gmail Vinted ${accountId} : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  },
});

/** Synchronisation déclenchée depuis Klyd. */
export const syncNow = action({
  args: {
    accountId: v.optional(v.id("klydeGmailAccounts")),
    full: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ imported: number; scanned: number }> => {
    await ctx.runQuery(internal.klydeGmail.assertCanUpdate, {});
    const ids: Id<"klydeGmailAccounts">[] = args.accountId
      ? [args.accountId]
      : await ctx.runQuery(internal.klydeGmail.activeAccountIds, {});
    let imported = 0;
    let scanned = 0;
    for (const accountId of ids) {
      const result = await ctx.runAction(internal.klydeGmail.syncAccount, {
        accountId,
        full: args.full,
      });
      imported += result.imported;
      scanned += result.scanned;
    }
    return { imported, scanned };
  },
});

export const assertCanUpdate = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "update");
    return true;
  },
});

/* ────────────────────────── Lecture depuis Klyd ────────────────────────── */

export const listAccounts = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const accounts = await ctx.db.query("klydeGmailAccounts").collect();
    return Promise.all(
      accounts.map(async (account) => {
        // `importedCount` cumule les imports successifs : après un réimport,
        // il compte plusieurs fois les mêmes messages. Le nombre affiché est
        // donc celui des emails réellement présents en base.
        const stored = await ctx.db
          .query("klydeVintedEmails")
          .withIndex("by_account", (q) => q.eq("accountId", account._id))
          .collect();
        // Les jetons ne sortent jamais du backend.
        return {
          _id: account._id,
          email: account.email,
          active: account.active,
          connectedByName: account.connectedByName,
          query: account.query ?? DEFAULT_QUERY,
          lastSyncAt: account.lastSyncAt,
          lastSyncError: account.lastSyncError,
          lastMessageDate: account.lastMessageDate,
          importedCount: stored.length,
          createdAt: account.createdAt,
        };
      }),
    );
  },
});

export const listEmails = query({
  args: {
    kind: v.optional(
      v.union(
        v.literal("vente"),
        v.literal("bordereau"),
        v.literal("expedition"),
        v.literal("paiement"),
        v.literal("offre"),
        v.literal("message"),
        v.literal("autre"),
      ),
    ),
    onlyPending: v.optional(v.boolean()),
    searchText: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const limit = Math.min(args.limit ?? 100, 300);
    const rows = args.kind
      ? await ctx.db
          .query("klydeVintedEmails")
          .withIndex("by_kind", (q) => q.eq("kind", args.kind!))
          .order("desc")
          .take(600)
      : await ctx.db.query("klydeVintedEmails").withIndex("by_sentAt").order("desc").take(600);

    const search = args.searchText?.trim().toLowerCase();
    const filtered = rows
      .filter((row) => (args.onlyPending ? !row.handled : true))
      .filter((row) =>
        search
          ? [row.subject, row.itemTitle, row.buyer, row.orderRef, row.trackingNumber, row.snippet]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(search)
          : true,
      )
      .sort((a, b) => b.sentAt - a.sentAt)
      .slice(0, limit);

    return Promise.all(
      filtered.map(async (row) => {
        const item = row.matchedItemId ? await ctx.db.get(row.matchedItemId) : null;
        const attachments = await Promise.all(
          (row.attachments ?? []).map(async (attachment) => ({
            ...attachment,
            url: await ctx.storage.getUrl(attachment.storageId),
          })),
        );
        return {
          ...row,
          // Le corps complet n'est pas utile en liste : il alourdit la souscription.
          bodyText: row.bodyText?.slice(0, 1200),
          invoiceUrl: row.invoiceStorageId
            ? await ctx.storage.getUrl(row.invoiceStorageId)
            : null,
          attachments,
          matchedItem: item
            ? {
                _id: item._id,
                title: item.title,
                sku: item.sku,
                status: item.status,
                price: item.price,
                // Vignette : reconnaître l'article d'un coup d'œil vaut mieux
                // que relire son titre pour vérifier le rapprochement.
                photoUrl: item.photos[0] ? await ctx.storage.getUrl(item.photos[0]) : null,
              }
            : null,
        };
      }),
    );
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    await requireCrmPermission(ctx, PAGE_KEY, "read");
    const rows = await ctx.db.query("klydeVintedEmails").withIndex("by_sentAt").order("desc").take(600);
    const byKind: Record<string, number> = {};
    let matched = 0;
    let revenue = 0;
    for (const row of rows) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      if (row.matchedItemId) matched += 1;
      if (row.kind === "vente" && row.amount) revenue += row.amount;
    }
    return { total: rows.length, matched, byKind, revenue };
  },
});

/* ───────────────────────── Actions sur les emails ──────────────────────── */

export const linkItem = mutation({
  args: {
    emailId: v.id("klydeVintedEmails"),
    itemId: v.optional(v.id("klydeItems")),
  },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "update");
    await ctx.db.patch(args.emailId, {
      matchedItemId: args.itemId,
      // Rattachement humain : confiance maximale, il ne sera plus recalculé.
      matchConfidence: args.itemId ? 1 : undefined,
    });
  },
});

export const setAccountActive = mutation({
  args: { accountId: v.id("klydeGmailAccounts"), active: v.boolean() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    await ctx.db.patch(args.accountId, { active: args.active, updatedAt: Date.now() });
  },
});

export const setAccountQuery = mutation({
  args: { accountId: v.id("klydeGmailAccounts"), query: v.string() },
  handler: async (ctx, args) => {
    await requireCrmPermission(ctx, PAGE_KEY, "manage");
    const cleaned = args.query.trim() || DEFAULT_QUERY;
    await ctx.db.patch(args.accountId, { query: cleaned, updatedAt: Date.now() });
  },
});

/**
 * Déconnecte une boîte : les jetons sont effacés côté Convex et l'autorisation
 * est révoquée côté Google. Les emails déjà importés sont conservés (ils font
 * partie de l'historique des ventes).
 */
export const disconnect = action({
  args: { accountId: v.id("klydeGmailAccounts") },
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.klydeGmail.assertCanManage, {});
    const account: Doc<"klydeGmailAccounts"> | null = await ctx.runQuery(
      internal.klydeGmail.getAccount,
      { accountId: args.accountId },
    );
    if (!account) return;
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: account.refreshToken }),
      });
    } catch {
      // Révocation best-effort : la suppression locale prime.
    }
    await ctx.runMutation(internal.klydeGmail.deleteAccount, { accountId: args.accountId });
  },
});

/**
 * Vide les emails importés d'une boîte et remet la borne incrémentale à zéro,
 * pour réimporter depuis Gmail. Utile quand l'extraction évolue : les champs
 * analysés sont recalculés à l'import, jamais rétroactivement.
 */
export const resetAccountEmails = internalMutation({
  args: { accountId: v.id("klydeGmailAccounts") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("klydeVintedEmails")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    for (const row of rows) {
      for (const attachment of row.attachments ?? []) {
        await ctx.storage.delete(attachment.storageId);
      }
      await ctx.db.delete(row._id);
    }
    await ctx.db.patch(args.accountId, { lastMessageDate: undefined, updatedAt: Date.now() });
    return { deleted: rows.length };
  },
});

export const deleteAccount = internalMutation({
  args: { accountId: v.id("klydeGmailAccounts") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.accountId);
  },
});

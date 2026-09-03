import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Type de demande géré par la recyclerie. */
export const requestType = v.union(
  v.literal("aerogommage"),
  v.literal("collecte"),
  v.literal("article"),
  v.literal("velo"),
  v.literal("livraison"),
  v.literal("depot"),
);

/** Recyclerie où le client vient déposer ses objets. */
export const depotSite = v.union(v.literal("60"), v.literal("76"));

/** Véhicule annoncé pour le dépôt : conditionne le temps de déchargement. */
export const depotVehicleType = v.union(
  v.literal("voiture"),
  v.literal("camionnette"),
  v.literal("remorque"),
);

/**
 * Rendez-vous de dépôt : une recyclerie, un créneau du lundi et le véhicule
 * annoncé. `slotStart` est l'horodatage du début de créneau (unique par site).
 */
export const depotDetails = v.object({
  site: depotSite,
  slotStart: v.number(),
  slotEnd: v.number(),
  vehicleType: depotVehicleType,
  description: v.optional(v.string()),
  /** Rappel J-1 envoyé au client (évite le doublon si le cron repasse). */
  reminderSentAt: v.optional(v.number()),
});

/** App « Feedback » — application visée par un retour utilisateur. */
export const feedbackApp = v.union(
  v.literal("mesoutils"),
  v.literal("recycapp"),
  v.literal("klyde"),
  v.literal("cycleenbray"),
  v.literal("bennespro"),
  v.literal("pointeuse"),
  v.literal("feedback"),
  v.literal("batire"),
);

/**
 * App « Feedback » — nature du retour.
 *
 * `nouvelle_application` est le seul type qui ne vise **aucune** app existante
 * (idée d'outil à créer) : les retours de ce type sont enregistrés sans champ
 * `app`, d'où son caractère optionnel dans la table `feedback`.
 */
export const feedbackType = v.union(
  v.literal("fonctionnalite"),
  v.literal("probleme"),
  v.literal("amelioration"),
  v.literal("question"),
  v.literal("nouvelle_application"),
);

/**
 * App « Feedback » — colonne du kanban : « En attente », « En cours »,
 * « Terminée ». Les valeurs stockées restent celles d'origine (aucune
 * migration de données) ; seuls les libellés changent côté frontend.
 */
export const feedbackStatus = v.union(
  v.literal("nouveau"),
  v.literal("en_cours"),
  v.literal("termine"),
);

/**
 * App « Feedback » — urgence déclarée par l'auteur du retour. Optionnelle en
 * base : les retours déposés avant cette fonctionnalité n'en ont pas, et le
 * frontend les affiche alors en « Normale ».
 */
export const feedbackPriority = v.union(
  v.literal("basse"),
  v.literal("normale"),
  v.literal("haute"),
  v.literal("urgente"),
);

/** App « Bennes & Pro » — matériaux déposables. */
export const bpMaterial = v.union(
  v.literal("Réemploi"),
  v.literal("Bois"),
  v.literal("CSR"),
  v.literal("DEEE"),
  v.literal("ECODDS - Pateux"),
  v.literal("ECODDS - Aerosols"),
  v.literal("ECODDS - Bases"),
  v.literal("ECODDS - Pateux acrylique"),
  v.literal("ECODDS - Phytosanitaire"),
  v.literal("ECODDS - Acides"),
  v.literal("ECODDS - Outillage du peintre"),
  v.literal("ECODDS - Peinture"),
  v.literal("Inertes/Gravats"),
  v.literal("Laine de roche"),
  v.literal("Laine de verre"),
  v.literal("Menuiseries Vitrées"),
  v.literal("Métaux"),
  v.literal("Plastiques d'emballages et cartons"),
  v.literal("Plastiques rigide"),
  v.literal("Plâtres"),
  v.literal("Tout venant/DIB non triés"),
);

/** App « Bennes & Pro » — profil d'entreprise cliente. */
export const bpCompanyType = v.union(
  v.literal("artisan"),
  v.literal("btp"),
  v.literal("distributeur"),
  v.literal("industrie"),
  v.literal("autre"),
);

/** App « Bennes & Pro » — unités de mesure. */
export const bpUnit = v.union(
  v.literal("kg"),
  v.literal("m3"),
  v.literal("tonne"),
  v.literal("unite"),
);

/** Une ligne de matière facturée sur une facture Stripe Bennes & Pro. */
export const bpBillingLine = v.object({
  material: bpMaterial,
  weightKg: v.number(),
  priceCentsPerKg: v.number(),
  amountCents: v.number(),
});

/** App « Bennes & Pro » — facturation Stripe des matières payantes d'un dépôt. */
export const bpBilling = v.object({
  /** Poids total facturable en kg (lignes kg + tonnes converties). */
  weightKg: v.number(),
  /** Prix appliqué, en centimes d'euro par kg (HT). */
  priceCentsPerKg: v.number(),
  /** Montant HT en centimes d'euro (la TVA est ajoutée sur la facture Stripe). */
  amountCents: v.number(),
  /** Détail par matière, conservé pour éditer exactement les lignes Stripe. */
  items: v.optional(v.array(bpBillingLine)),
  /** Taux de TVA appliqué (ex. 20). Les anciens dépôts sans valeur sont affichés au taux courant. */
  vatRate: v.optional(v.number()),
  status: v.union(
    v.literal("pending"),
    v.literal("invoiced"),
    v.literal("error"),
  ),
  stripeInvoiceId: v.optional(v.string()),
  stripeInvoiceUrl: v.optional(v.string()),
  /** Statut de règlement Stripe (open = en attente, paid = payée…). */
  paymentStatus: v.optional(
    v.union(
      v.literal("open"),
      v.literal("paid"),
      v.literal("draft"),
      v.literal("void"),
      v.literal("uncollectible"),
    ),
  ),
  paidAt: v.optional(v.number()),
  /** Horodatage de la dernière relance de règlement envoyée par email. */
  lastReminderAt: v.optional(v.number()),
  error: v.optional(v.string()),
  invoicedAt: v.optional(v.number()),
});

/** Étape du pipeline (uniquement pour les demandes ouvertes). */
export const requestStage = v.union(
  v.literal("nouveau"),
  v.literal("validation"),
  v.literal("planifie"),
);

/** Sous-type de collecte (défini dans le CRM après réception). */
export const collecteType = v.union(
  v.literal("indefini"),
  v.literal("C1"),
  v.literal("C2"),
  v.literal("C3"),
);

/** Résultat d'une demande. `open` = encore dans le pipeline. */
export const requestOutcome = v.union(
  v.literal("open"),
  v.literal("gagnee"),
  v.literal("perdue"),
);

export const requestLostReason = v.union(
  v.literal("devis_refuse"),
  v.literal("pas_de_retour_client"),
  v.literal("annulation_client"),
  v.literal("autre"),
);

export const requestOrigin = v.union(
  v.literal("internal"),
  v.literal("external"),
);


/* ─── Bâtire : matériaux du bâtiment ─────────────────────────────────────── */

/**
 * Unité de vente d'un matériau. Elle gouverne le prix, le stock et le devis :
 * du sable se vend à la tonne, un isolant au m², une poutre au mètre linéaire.
 */
export const btUnit = v.union(
  v.literal("unité"),
  v.literal("m²"),
  v.literal("m³"),
  v.literal("ml"),
  v.literal("kg"),
  v.literal("tonne"),
  v.literal("palette"),
  v.literal("sac"),
  v.literal("lot"),
);

export const btCondition = v.union(
  v.literal("Neuf"),
  v.literal("Très bon"),
  v.literal("Bon"),
  v.literal("Usagé"),
  /** @deprecated Référentiel d'états d'avant la simplification en quatre
   *  valeurs. Conservé pour les fiches créées avant le changement : retirer
   *  ces valeurs les rendrait invalides. */
  v.literal("Déstockage"),
  v.literal("Reconditionné"),
  v.literal("Très bon état"),
  v.literal("Bon état"),
  v.literal("À reconditionner"),
  v.literal("À rénover"),
);

export const btMaterialStatus = v.union(
  v.literal("brouillon"),
  v.literal("disponible"),
  v.literal("reserve"),
  v.literal("vendu"),
);

export const btRequestType = v.union(
  v.literal("devis"),
  v.literal("reservation"),
  v.literal("reprise"),
  v.literal("question"),
);

export const btDonationStatus = v.union(
  v.literal("nouveau"),
  v.literal("accepte"),
  v.literal("refuse"),
);

export const btRequestOutcome = v.union(
  v.literal("nouveau"),
  v.literal("en_cours"),
  v.literal("gagnee"),
  v.literal("perdue"),
);

export const hrEmployeeGender = v.union(v.literal("Monsieur"), v.literal("Madame"));

export const hrEmployeeStructure = v.union(
  v.literal("Pays de Bray Services 60"),
  v.literal("Pays de Bray Services 76"),
  v.literal("Recyclerie 60"),
  v.literal("Recyclerie 76"),
  v.literal("Les Sens du Bray"),
  v.literal("Maison d'Economie Solidaire"),
  v.literal("Pays de Bray Emploi"),
);

export const hrContractWebhookPayload = v.object({
  genre_salarie: v.string(),
  nom_prenom_salarie: v.string(),
  adresse_salarie: v.string(),
  num_sec_sociale: v.string(),
  structure: v.string(),
  Nom_contrat: v.optional(v.string()),
  nom_contrat: v.optional(v.string()),
  numero_contrat: v.optional(v.string()),
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
});

const customer = v.object({
  firstName: v.string(),
  lastName: v.string(),
  email: v.string(),
  phone: v.string(),
  address: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  city: v.optional(v.string()),
});

/** Un objet à aérogommer (une demande peut en contenir plusieurs). */
export const aerogommageItem = v.object({
  objectType: v.optional(v.string()),
  label: v.optional(v.string()), // précision si « Autre »
  height: v.optional(v.number()),
  width: v.optional(v.number()),
  depth: v.optional(v.number()),
  quantity: v.optional(v.number()),
  woodType: v.optional(v.string()),
  stripping: v.optional(v.string()),
  coating: v.optional(v.string()),
  coatingOther: v.optional(v.string()), // précision si « Autre »
  delivery: v.optional(v.boolean()),
  retrieval: v.optional(v.boolean()),
  comment: v.optional(v.string()),
  // Photos rattachées à cet objet précis.
  photos: v.optional(v.array(v.id("_storage"))),
  // Photos de suivi rattachées à cet objet précis.
  beforePhotos: v.optional(v.array(v.id("_storage"))),
  afterPhotos: v.optional(v.array(v.id("_storage"))),
});

const address = v.object({
  address: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  city: v.optional(v.string()),
});

const aerogommageOptions = v.object({
  pickupAtHome: v.optional(v.boolean()),
  deliveryAtHome: v.optional(v.boolean()),
  pickupAddress: v.optional(address),
  deliveryAddress: v.optional(address),
});

const collecteDetails = v.object({
  // Forfaits / conditions (Oui/Non).
  dismountable: v.optional(v.boolean()),
  reusableGoodCondition: v.optional(v.boolean()),
  sorted: v.optional(v.boolean()),
  noWaste: v.optional(v.boolean()),
  // Catégories d'objets sélectionnées (pictogrammes). Clés de COLLECTE_CATEGORIES.
  objectCategories: v.optional(v.array(v.string())),
  // Photos rattachées à chaque catégorie sélectionnée.
  categoryPhotos: v.optional(
    v.array(
      v.object({
        category: v.string(),
        photos: v.array(v.id("_storage")),
      }),
    ),
  ),
  // Champs hérités (multi-sélection par famille, anciennes demandes).
  grosObjets: v.optional(v.array(v.string())),
  grosObjetsAutre: v.optional(v.string()),
  petitsObjets: v.optional(v.array(v.string())),
  petitsObjetsAutre: v.optional(v.string()),
  // Logement.
  housingType: v.optional(v.string()),
  floors: v.optional(v.number()),
  // Stationnement.
  dedicatedParking: v.optional(v.boolean()),
  parkingDistance: v.optional(v.number()),
  parkingUnknown: v.optional(v.boolean()),
  // Champs hérités (anciennes demandes).
  parkingNearby: v.optional(v.boolean()),
  largeItems: v.optional(v.string()),
  furniture: v.optional(v.string()),
  smallItems: v.optional(v.string()),
  // L'adresse de collecte peut différer de l'adresse de facturation (client).
  collectAddress: v.optional(address),
});

const articleDetails = v.object({
  articleId: v.id("articles"),
  articleTitle: v.string(),
});

const reservedArticleDetails = v.object({
  articleId: v.id("articles"),
  articleTitle: v.string(),
});

const requestPayment = v.object({
  method: v.union(v.literal("cb"), v.literal("especes")),
  status: v.union(v.literal("pending"), v.literal("paid")),
  validated: v.boolean(),
  captured: v.boolean(),
  provider: v.optional(v.literal("stripe")),
  stripeSessionId: v.optional(v.string()),
  stripePaymentIntentId: v.optional(v.string()),
  paidAt: v.optional(v.number()),
  /** Remboursement Stripe déclenché depuis le CRM (montant en euros). */
  stripeRefundId: v.optional(v.string()),
  refundedAmount: v.optional(v.number()),
  refundedAt: v.optional(v.number()),
  refundedBy: v.optional(v.string()),
  /** Bon de réduction utilisé au paiement (code, remise, montant déduit). */
  discountCode: v.optional(v.string()),
  discountPercent: v.optional(v.number()),
  discountAmount: v.optional(v.number()),
  subtotal: v.optional(v.number()),
});

const veloDetails = v.object({
  bikeType: v.optional(v.string()),
  service: v.optional(v.string()),
  brand: v.optional(v.string()),
  condition: v.optional(v.string()),
  description: v.optional(v.string()),
});

/** Demande de livraison d'un article (créée depuis le CRM). */
const livraisonDetails = v.object({
  // Adresse de livraison (peut être identique à l'adresse de facturation).
  deliveryAddress: v.optional(address),
  sameAsBilling: v.optional(v.boolean()),
  // Photo de l'article (catégorisation IA) et photo de la référence / code-barres.
  articlePhoto: v.optional(v.id("_storage")),
  referencePhoto: v.optional(v.id("_storage")),
  // Résultats de l'analyse IA de la photo article.
  articleTitle: v.optional(v.string()),
  category: v.optional(v.string()),
  subcategory: v.optional(v.string()),
  condition: v.optional(v.string()),
  // Référence interne de l'article : reprise du code-barres scanné si présent,
  // sinon générée automatiquement.
  reference: v.optional(v.string()),
  referenceFromBarcode: v.optional(v.boolean()),
  // Prix de l'article (issu du code-barres scanné) et acompte de 20 %.
  articlePrice: v.optional(v.number()),
  acompte: v.optional(v.number()),
  // Calcul des frais de livraison (Mapbox : dépôt → adresse de livraison).
  distanceKm: v.optional(v.number()),
  deliveryFee: v.optional(v.number()),
  // Créneau avantageux retenu (livraison groupée avec une collecte proche).
  suggestedSlot: v.optional(
    v.object({
      requestReference: v.optional(v.string()),
      scheduledDate: v.optional(v.number()),
      distanceKm: v.optional(v.number()),
      city: v.optional(v.string()),
      discount: v.optional(v.number()),
      // Frais réduits : 1 €/km entre l'adresse de collecte et le client.
      reducedDeliveryFee: v.optional(v.number()),
    }),
  ),
});

export default defineSchema(
  {
  articles: defineTable({
    title: v.string(),
    description: v.string(),
    price: v.number(),
    weightKg: v.optional(v.number()),
    // Emplacement physique de l'article en boutique / réserve.
    location: v.optional(v.string()),
    // Caisse physique (bac étiqueté d'un QR code) qui contient l'article.
    // Remplace progressivement le champ texte `location`.
    caisseId: v.optional(v.id("caisses")),
    originalPrice: v.optional(v.number()),
    internalReference: v.optional(v.string()),
    /**
     * Recyclerie qui détient physiquement l'article : le client vient le
     * retirer sur ce site, et la boutique en ligne permet de filtrer dessus.
     */
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    category: v.string(),
    subcategory: v.optional(v.string()),
    condition: v.string(),
    keywords: v.optional(v.array(v.string())),
    themeKey: v.optional(v.string()),
    images: v.array(v.id("_storage")),
    status: v.union(
      v.literal("disponible"),
      v.literal("reserve"),
      v.literal("vendu"),
      v.literal("attente"),
      // Ancien statut conservé pour compatibilité avec les articles déjà créés.
      v.literal("lot"),
    ),
    /**
     * Article créé par simple photo depuis le stock boutique : il attend encore
     * la génération d'annonce IA et le détourage (cf. « Nouveau run »).
     */
    draft: v.optional(v.boolean()),
    isLot: v.optional(v.boolean()),
    bundledArticleIds: v.optional(v.array(v.id("articles"))),
    bundleKey: v.optional(v.string()),
    bundleReason: v.optional(v.string()),
    // Article mis en avant "Produit du jour" (un seul à la fois).
    productOfDay: v.optional(v.boolean()),
    /**
     * Miroir de l'article dans le catalogue Stripe.
     *
     * Recycapp est la source de vérité : la synchronisation ne va que dans ce
     * sens. Le montant et l'état déjà poussés sont mémorisés pour que la
     * réconciliation nocturne n'appelle Stripe que lorsque quelque chose a
     * réellement changé.
     */
    stripeProductId: v.optional(v.string()),
    stripePriceId: v.optional(v.string()),
    /** Montant du prix Stripe en vigueur, en centimes. */
    stripePriceAmount: v.optional(v.number()),
    stripeActive: v.optional(v.boolean()),
    stripeSyncedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_internalReference", ["internalReference"])
    .index("by_productOfDay", ["productOfDay"])
    .index("by_caisse", ["caisseId"])
    .index("by_site", ["site"])
    .index("by_stripeProduct", ["stripeProductId"]),

  /**
   * Pool de QR codes d'articles imprimés À L'AVANCE.
   *
   * L'équipe imprime une planche d'étiquettes vierges, les colle sur les objets
   * au fil de la collecte, puis crée les fiches en scannant le code déjà posé.
   * Cela évite l'aller-retour « créer la fiche → imprimer → retrouver l'objet →
   * coller ». La référence a le même format que `articles.internalReference`
   * (6 chiffres), donc un code scanné se comporte exactement comme aujourd'hui.
   */
  articleQrCodes: defineTable({
    reference: v.string(),
    /** Renseigné dès que le code est attribué à un article. */
    articleId: v.optional(v.id("articles")),
    assignedAt: v.optional(v.number()),
    /** Horodatage de la planche d'impression, pour regrouper un lot de codes. */
    batchAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_reference", ["reference"])
    .index("by_article", ["articleId"])
    .index("by_batch", ["batchAt"]),

  /**
   * Caisses de rangement de la recyclerie : chaque caisse porte un QR code
   * collé dessus. On scanne la caisse à l'ajout d'un article pour l'y ranger,
   * et on la rescanne pour voir tout ce qu'elle contient.
   */
  caisses: defineTable({
    /** Code imprimé sur le QR code, ex. « CA-0007 ». Unique. */
    code: v.string(),
    /** Nom libre donné par l'équipe, ex. « Vaisselle réserve ». */
    label: v.optional(v.string()),
    /** Zone / lieu où se trouve la caisse, ex. « Réserve », « Boutique ». */
    zone: v.optional(v.string()),
    notes: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    createdAt: v.number(),
  }).index("by_code", ["code"]),

  /** Articles sauvegardés (wishlist) par les clients connectés. */
  wishlists: defineTable({
    userId: v.string(),
    articleId: v.id("articles"),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_article", ["userId", "articleId"])
    .index("by_article", ["articleId"]),

  requests: defineTable({
    type: requestType,
    stage: requestStage,
    outcome: requestOutcome,
    lostReason: v.optional(requestLostReason),
    lostReasonDetails: v.optional(v.string()),
    requestOrigin: v.optional(requestOrigin),
    complete: v.boolean(),
    // Process séquentiel : liste ordonnée des étapes + nombre d'étapes cochées.
    processSteps: v.array(v.string()),
    completedSteps: v.number(),
    // Journal : qui a coché chaque étape et quand.
    processLog: v.optional(
      v.array(
        v.object({ step: v.number(), by: v.string(), at: v.number() }),
      ),
    ),
    processNotes: v.optional(
      v.array(
        v.object({
          step: v.number(),
          by: v.string(),
          at: v.number(),
          body: v.string(),
        }),
      ),
    ),
    collecteType: v.optional(collecteType),
    // Dernier modificateur par champ (clé = nom du champ) — affiché « Modifié
    // par … » sous chaque champ du CRM. `by` = persona ou nom du compte.
    fieldEdits: v.optional(
      v.record(v.string(), v.object({ by: v.string(), at: v.number() })),
    ),
    // --- Gestion interne (onglet Gestion du CRM) ---
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    assignedTo: v.optional(v.id("teamMembers")),
    /** Équipe opérationnelle Recyclerie (remplace progressivement assignedTo). */
    assignedWorkerId: v.optional(v.id("polyvalentWorkers")),
    estimatedHours: v.optional(v.number()),
    actualHours: v.optional(v.number()),
    quoteAmount: v.optional(v.number()),
    quoteDetails: v.optional(v.string()),
    scheduledDate: v.optional(v.number()),
    customer,
    // Compte client Clerk rattaché (subject = clerkId), si la demande a été
    // créée par un utilisateur connecté ou liée a posteriori via son email.
    userId: v.optional(v.string()),
    comment: v.optional(v.string()),
    photos: v.array(v.id("_storage")),
    beforePhotos: v.optional(v.array(v.id("_storage"))),
    afterPhotos: v.optional(v.array(v.id("_storage"))),
    aerogommage: v.optional(v.array(aerogommageItem)),
    aerogommageOptions: v.optional(aerogommageOptions),
    collecte: v.optional(collecteDetails),
    article: v.optional(articleDetails),
    articles: v.optional(v.array(reservedArticleDetails)),
    payment: v.optional(requestPayment),
    velo: v.optional(veloDetails),
    livraison: v.optional(livraisonDetails),
    depot: v.optional(depotDetails),
    // Véhicule de la flotte affecté (collecte / livraison planifiée).
    assignedVehicle: v.optional(v.id("vehicles")),
    createdAt: v.number(),
    updatedAt: v.number(),
    reference: v.optional(v.string()),
    /** Envoi de l'invitation à noter la Recyclerie sur Google (une seule fois). */
    reviewInviteSentAt: v.optional(v.number()),
    visitNeeded: v.optional(v.boolean()),
    legacyImport: v.optional(
      v.object({
        source: v.string(),
        sourceIds: v.array(v.string()),
        raw: v.array(
          v.object({
            sourceId: v.string(),
            fields: v.array(v.object({ key: v.string(), value: v.string() })),
          }),
        ),
      }),
    ),
  })
    .index("by_type", ["type"])
    .index("by_outcome", ["outcome"])
    .index("by_userId", ["userId"])
    .index("by_scheduledDate", ["scheduledDate"])
    .index("by_assignedVehicle", ["assignedVehicle"])
    .index("by_assignedWorkerId", ["assignedWorkerId"])
    .index("by_reference", ["reference"]),

  /**
   * Créneaux de dépôt rendus indisponibles par l'équipe (fermeture, absence).
   *
   * Sans `slotStart`, c'est la journée entière qui est fermée pour ce site.
   */
  depotBlockedSlots: defineTable({
    site: depotSite,
    /** Jour concerné, `YYYY-MM-DD` en heure de Paris. */
    date: v.string(),
    slotStart: v.optional(v.number()),
    createdAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_site", ["site"])
    .index("by_site_and_date", ["site", "date"]),

  /** Prospects/clients importés hors demandes (Bubble, etc.). */
  crmCustomers: defineTable({
    source: v.string(),
    sourceId: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    email: v.string(),
    phone: v.string(),
    address: v.optional(v.string()),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
    customerType: v.optional(v.string()),
    streetNumber: v.optional(v.string()),
    street: v.optional(v.string()),
    legacyCreatedAt: v.optional(v.number()),
    legacyModifiedAt: v.optional(v.number()),
    raw: v.array(v.object({ key: v.string(), value: v.string() })),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sourceId", ["sourceId"])
    .index("by_email", ["email"]),

  /** Flotte : véhicules utilitaires de la recyclerie. */
  vehicles: defineTable({
    name: v.string(),
    plate: v.optional(v.string()),
    kind: v.union(
      v.literal("utilitaire"),
      v.literal("voiture"),
    ),
    photo: v.optional(v.id("_storage")),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    active: v.boolean(),
    recycappEnabled: v.optional(v.boolean()),
    sourceKey: v.optional(v.string()),
    model: v.optional(v.string()),
    statusLabel: v.optional(v.string()),
    vehicleFamily: v.optional(v.string()),
    vehicleSubfamily: v.optional(v.string()),
    siteLabel: v.optional(v.string()),
    seats: v.optional(v.number()),
    reservablePro: v.optional(v.boolean()),
    reservablePersonal: v.optional(v.boolean()),
    structure: v.optional(v.string()),
    acronym: v.optional(v.string()),
    brand: v.optional(v.string()),
    monthlyCost: v.optional(v.number()),
    insuranceCompany: v.optional(v.string()),
    insurancePolicy: v.optional(v.string()),
    odometerKm: v.optional(v.number()),
    odometerUpdatedAt: v.optional(v.string()),
    purchaseDate: v.optional(v.string()),
    saleDate: v.optional(v.string()),
    allocation: v.optional(v.string()),
    year: v.optional(v.number()),
    assignedTo: v.optional(v.string()),
    technicalControlDate: v.optional(v.string()),
    pollutionControlDate: v.optional(v.string()),
    sourceCreatedAt: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    documentationUrl: v.optional(v.string()),
    // Champs hérités (conservés pour compatibilité des anciens véhicules).
    capacityM3: v.optional(v.number()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_active", ["active"]),

  /** Comptes clients (boutique). Le clerkId est le `subject` de l'identité Clerk. */
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    // Photo de profil Clerk (URL publique), pour l'afficher dans les emails.
    imageUrl: v.optional(v.string()),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
    // Migration Clerk dev -> prod : anciens ids Clerk remplacés à la première
    // reconnexion via l'adresse email.
    previousClerkIds: v.optional(v.array(v.string())),
    lastClerkMigrationAt: v.optional(v.number()),
    // Traçabilité de l'inscription : app (recycapp, mesoutils…) et chemin/
    // formulaire d'origine (/collecte, /boutique/panier…). Fixé à la création.
    signupApp: v.optional(v.string()),
    signupPath: v.optional(v.string()),
    /**
     * Origine détaillée, capturée AVANT la redirection vers Clerk : `signupPath`
     * seul est relevé au retour de connexion, souvent sur l'accueil, ce qui
     * perdait l'écran réellement à l'origine de l'inscription.
     */
    // Dernier écran vu en étant déconnecté : le formulaire ou la fiche d'où
    // part l'inscription.
    signupEntryPath: v.optional(v.string()),
    // Première page de la visite : la porte d'entrée sur le site.
    signupLandingPath: v.optional(v.string()),
    // Site qui a amené la visite (hors navigation interne).
    signupReferrer: v.optional(v.string()),
    // Paramètres de campagne (utm_*) présents à l'arrivée, tels quels.
    signupUtm: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"]),

  /** Solde d'engagement partagé par toutes les applications. */
  userPoints: defineTable({
    clerkId: v.string(),
    displayName: v.string(),
    profileImageUrl: v.optional(v.string()),
    points: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_points", ["points"]),

  /** Une attribution par action, afin qu'un même retour ne rapporte qu'une fois. */
  userPointAwards: defineTable({
    clerkId: v.string(),
    eventKey: v.string(),
    points: v.number(),
    createdAt: v.number(),
  }).index("by_clerkId_and_eventKey", ["clerkId", "eventKey"]),

  /** Demandes de congés / absences déposées depuis Mes Outils. */
  leaveRequests: defineTable({
    clerkId: v.string(),
    requesterName: v.string(),
    requesterEmail: v.optional(v.string()),
    type: v.union(
      v.literal("cp"),
      v.literal("rtt"),
      v.literal("sans_solde"),
      v.literal("maladie"),
      v.literal("autre"),
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("cancelled"),
    ),
    startDate: v.string(),
    endDate: v.string(),
    note: v.optional(v.string()),
    decisionNote: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    decidedByClerkId: v.optional(v.string()),
    decidedByName: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_status_and_startDate", ["status", "startDate"])
    .index("by_startDate", ["startDate"]),

  /** Messagerie client ⇄ administrateurs, rattachée à une demande. */
  messages: defineTable({
    requestId: v.id("requests"),
    senderRole: v.union(v.literal("client"), v.literal("staff")),
    senderName: v.string(),
    senderClerkId: v.optional(v.string()),
    body: v.string(),
    createdAt: v.number(),
    // Accusés de lecture ("Lu à HH:MM").
    readByClientAt: v.optional(v.number()),
    readByStaffAt: v.optional(v.number()),
  })
    .index("by_requestId", ["requestId"])
    .index("by_senderClerkId", ["senderClerkId"])
    .index("by_createdAt", ["createdAt"]),

  notifications: defineTable({
    kind: v.union(v.literal("new_request"), v.literal("new_message")),
    title: v.string(),
    requestId: v.id("requests"),
    requestType,
    customerName: v.string(),
    /** Extrait du dernier message client, seulement pour `new_message`. */
    messagePreview: v.optional(v.string()),
    read: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_read_and_createdAt", ["read", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_requestId", ["requestId"]),

  /**
   * Repère de lecture des notifications CRM, **par utilisateur**.
   *
   * Le drapeau `read` de `notifications` est global : quand quelqu'un ouvrait
   * la page, le compteur retombait à zéro pour toute l'équipe. On stocke donc
   * ici, par compte Clerk, la date jusqu'à laquelle il a tout vu — une
   * notification postérieure à ce repère lui est « non lue », indépendamment
   * des autres. Un seul document par utilisateur, pas un par notification.
   */
  notificationReads: defineTable({
    clerkId: v.string(),
    lastReadAt: v.number(),
  }).index("by_clerkId", ["clerkId"]),

  teamMembers: defineTable({
    name: v.string(),
    role: v.optional(v.string()),
    email: v.optional(v.string()),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    /** Sites de rattachement : un salarié peut intervenir sur les deux. */
    sites: v.optional(v.array(v.union(v.literal("60"), v.literal("76")))),
    employmentType: v.optional(v.union(v.literal("permanent"), v.literal("polyvalent"))),
    active: v.boolean(),
    createdAt: v.number(),
  }),

  /** Droits CRM fins par email staff. Les admins Clerk gardent toujours tous les accès. */
  crmPermissions: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    active: v.boolean(),
    role: v.optional(v.union(v.literal("client"), v.literal("staff"), v.literal("admin"))),
    grants: v.array(
      v.object({
        pageKey: v.string(),
        actions: v.array(v.string()),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
    updatedBy: v.string(),
  }).index("by_email", ["email"]),

  bgJobs: defineTable({
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("error")),
    storageIds: v.array(v.id("_storage")),
    backgroundPrompt: v.string(),
    articleTitle: v.optional(v.string()),
    results: v.optional(
      v.array(v.object({ originalStorageId: v.id("_storage"), newStorageId: v.id("_storage"), url: v.string() })),
    ),
    error: v.optional(v.string()),
  }),

  articleViews: defineTable({
    articleId: v.id("articles"),
    sessionId: v.string(),
    lastSeenAt: v.number(),
  })
    .index("by_articleId", ["articleId"])
    .index("by_sessionId", ["sessionId"])
    .index("by_lastSeenAt", ["lastSeenAt"]),

  /** Documents rattachés à une demande (devis, facture…), côté client + CRM. */
  requestDocuments: defineTable({
    requestId: v.id("requests"),
    storageId: v.id("_storage"),
    name: v.string(),
    docType: v.union(
      v.literal("devis"),
      v.literal("facture"),
      v.literal("bon_commande"),
      v.literal("bon_collecte"),
      v.literal("contrat"),
      v.literal("photo"),
      v.literal("autre"),
    ),
    mimeType: v.optional(v.string()),
    uploadedByRole: v.union(v.literal("client"), v.literal("staff")),
    // Si le document provient du gestionnaire (partage) : on référence le
    // fichier source sans dupliquer le blob, et on ne le supprime pas au retrait.
    sourceDocumentId: v.optional(v.id("documents")),
    sharedWithClientAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_requestId", ["requestId"]),

  /** Arborescence de dossiers du gestionnaire de documents (CRM). */
  documentFolders: defineTable({
    name: v.string(),
    parentId: v.optional(v.id("documentFolders")),
    createdAt: v.number(),
  }).index("by_parent", ["parentId"]),

  /** Fichiers du gestionnaire de documents (CRM). */
  documents: defineTable({
    name: v.string(),
    folderId: v.optional(v.id("documentFolders")),
    storageId: v.id("_storage"),
    mimeType: v.optional(v.string()),
    size: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_folder", ["folderId"]),

  /** Sessions d'arrivage (GDR Collecte). */
  arrivages: defineTable({
    date: v.number(),
    origin: v.union(
      v.literal("decheterie"),
      v.literal("domicile"),
      v.literal("apport"),
      v.literal("tournee"),
    ),
    commune: v.optional(v.string()),
    status: v.union(v.literal("open"), v.literal("closed")),
    note: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_date", ["date"]),

  /** Dépôts scellés en attente d'éclatement. */
  depots: defineTable({
    depotNumber: v.number(),
    date: v.number(),
    origin: v.union(
      v.literal("decheterie"),
      v.literal("domicile"),
      v.literal("apport"),
      v.literal("tournee"),
    ),
    commune: v.optional(v.string()),
    weightKg: v.optional(v.number()),
    defaultCategory: v.optional(v.string()),
    defaultSubcategory: v.optional(v.string()),
    defaultFlux: v.optional(v.string()),
    defaultOrientation: v.optional(v.string()),
    note: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("partial"),
      v.literal("closed"),
    ),
    closedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_date", ["date"]),

  /** Articles enregistrés lors d'un arrivage ou d'un éclatement de dépôt. */
  arrivageItems: defineTable({
    arrivageId: v.optional(v.id("arrivages")),
    depotId: v.optional(v.id("depots")),
    date: v.number(),
    origin: v.union(
      v.literal("decheterie"),
      v.literal("domicile"),
      v.literal("apport"),
      v.literal("tournee"),
    ),
    commune: v.optional(v.string()),
    category: v.string(),
    subcategory: v.optional(v.string()),
    flux: v.optional(v.string()),
    orientation: v.string(),
    weightKg: v.optional(v.number()),
    tare: v.optional(v.number()),
    quantity: v.number(),
    price: v.optional(v.number()),
    condition: v.optional(v.string()),
    labelInfo: v.optional(v.string()),
    reference: v.string(),
    articleId: v.optional(v.id("articles")),
    createdAt: v.number(),
    // Sortie de stock : motif + date quand l'article quitte la recyclerie.
    exitedAt: v.optional(v.number()),
    exitMotif: v.optional(v.string()),
  })
    .index("by_arrivage", ["arrivageId"])
    .index("by_depot", ["depotId"])
    .index("by_reference", ["reference"])
    .index("by_date", ["date"]),

  /** GDR Ateliers — suivi de valorisation article par article. */
  atelierSessions: defineTable({
    articleId: v.id("articles"),
    articleReference: v.string(),
    date: v.number(),
    durationMinutes: v.optional(v.number()),
    technicianId: v.optional(v.id("teamMembers")),
    type: v.string(), // nettoyage | reparation | test | reconditionnement | autre
    notes: v.optional(v.string()),
    status: v.union(v.literal("en_cours"), v.literal("termine")),
    createdAt: v.number(),
  })
    .index("by_article", ["articleId"])
    .index("by_status", ["status"])
    .index("by_date", ["date"]),

  /** GDR Magasin — ventes enregistrées à la caisse. */
  ventes: defineTable({
    date: v.number(),
    receiptNumber: v.string(),
    items: v.array(v.object({
      articleId: v.id("articles"),
      title: v.string(),
      price: v.number(),
    })),
    subtotal: v.number(),
    discountAmount: v.optional(v.number()),
    total: v.number(),
    paymentMethod: v.union(
      v.literal("especes"),
      v.literal("cb"),
      v.literal("cheque"),
      v.literal("cheque_cadeau"),
      v.literal("virement"),
    ),
    amountTendered: v.optional(v.number()),
    change: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_date", ["date"]),

  stripeCheckoutDrafts: defineTable({
    items: v.array(v.object({
      articleId: v.id("articles"),
      title: v.string(),
      price: v.number(),
    })),
    discountAmount: v.optional(v.number()),
    total: v.number(),
    createdBy: v.string(),
    /** Client de la vente : la demande boutique est créée à l'encaissement. */
    customer: v.optional(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.string(),
        phone: v.optional(v.string()),
      }),
    ),
    requestId: v.optional(v.id("requests")),
    stripeSessionId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("completed")),
    venteId: v.optional(v.id("ventes")),
    receiptNumber: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_stripeSessionId", ["stripeSessionId"]),

  /**
   * Lien de paiement généré depuis le CRM : permet de faire régler en ligne
   * une demande boutique existante, ou un ou plusieurs articles choisis, sans
   * passer par le panier. Le `token` est l'identifiant public du lien.
   */
  paymentLinks: defineTable({
    token: v.string(),
    articleIds: v.array(v.id("articles")),
    /** Demande boutique réglée par ce lien (absent pour un lien ad hoc). */
    requestId: v.optional(v.id("requests")),
    /** Coordonnées connues à la création, pour préremplir la page de paiement. */
    customer: v.optional(customer),
    /** Montant figé à la création du lien (euros). */
    amount: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("cancelled"),
    ),
    stripePaymentIntentId: v.optional(v.string()),
    /** Horodatage du dernier envoi par email. */
    sentAt: v.optional(v.number()),
    createdAt: v.number(),
    createdBy: v.optional(v.string()),
    paidAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_request", ["requestId"]),

  /**
   * Bons de réduction de la boutique en ligne.
   *
   * Un bon est généré depuis le CRM, imprimé ou dicté au client, et vaut un
   * pourcentage sur la totalité d'un panier. Le code est long et tiré au sort
   * (« RECY » + 16 chiffres) : il ne se devine pas, et un bon consommé ne peut
   * plus resservir — `status` bascule sur « used » au moment de l'encaissement.
   */
  discountCodes: defineTable({
    code: v.string(),
    /** Remise en pourcentage du panier, de 5 à 80. */
    percent: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("used"),
      v.literal("cancelled"),
    ),
    label: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.string()),
    usedAt: v.optional(v.number()),
    usedByRequestId: v.optional(v.id("requests")),
    /** Montant réellement remisé, en euros, au moment de l'encaissement. */
    discountAmount: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
  })
    .index("by_code", ["code"])
    .index("by_status", ["status"]),

  publicStripeCheckoutDrafts: defineTable({
    articleIds: v.array(v.id("articles")),
    customer: customer,
    comment: v.optional(v.string()),
    /** Montant réellement dû, remise déduite. */
    total: v.number(),
    /** Bon de réduction appliqué au panier, s'il y en a un. */
    discountCodeId: v.optional(v.id("discountCodes")),
    discountPercent: v.optional(v.number()),
    discountAmount: v.optional(v.number()),
    subtotal: v.optional(v.number()),
    stripeSessionId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("completed")),
    requestId: v.optional(v.id("requests")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_stripeSessionId", ["stripeSessionId"]),

  /** GDR Sorties hors magasin — ventes en dehors de la boutique physique. */
  sortiesHorsMagasin: defineTable({
    date: v.number(),
    articleId: v.optional(v.id("articles")),
    articleTitle: v.string(),
    articleReference: v.optional(v.string()),
    price: v.number(),
    channel: v.union(
      v.literal("leboncoin"),
      v.literal("ebay"),
      v.literal("vinted"),
      v.literal("instagram"),
      v.literal("facebook"),
      v.literal("depot_vente"),
      v.literal("commande"),
      v.literal("autre"),
    ),
    buyerName: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_date", ["date"]),

  /** GDR Sorties matières — flux de matières non réemployables. */
  sortiesMatieres: defineTable({
    date: v.number(),
    materialType: v.string(),
    weightKg: v.number(),
    destination: v.string(),
    documentNumber: v.optional(v.string()),
    notes: v.optional(v.string()),
    origin: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_date", ["date"]),

  /** GDR Tournées — planification des collectes. */
  tournees: defineTable({
    date: v.number(),
    label: v.string(),
    vehicleId: v.optional(v.id("teamMembers")),
    // Véhicule de la flotte affecté à la tournée.
    fleetVehicleId: v.optional(v.id("vehicles")),
    driverId: v.optional(v.id("teamMembers")),
    /** Chauffeur issu de l'équipe opérationnelle (remplace `driverId`). */
    driverWorkerId: v.optional(v.id("polyvalentWorkers")),
    stops: v.array(v.object({
      requestId: v.optional(v.id("requests")),
      address: v.string(),
      latitude: v.optional(v.number()),
      longitude: v.optional(v.number()),
      contactName: v.optional(v.string()),
      contactPhone: v.optional(v.string()),
      notes: v.optional(v.string()),
      status: v.union(v.literal("prevu"), v.literal("effectue"), v.literal("annule")),
      order: v.number(),
    })),
    status: v.union(v.literal("planifiee"), v.literal("en_cours"), v.literal("terminee"), v.literal("annulee")),
    notes: v.optional(v.string()),
    depotAddress: v.optional(v.string()),
    depotLatitude: v.optional(v.number()),
    depotLongitude: v.optional(v.number()),
    optimizedAt: v.optional(v.number()),
    estimatedDistanceMeters: v.optional(v.number()),
    estimatedDurationSeconds: v.optional(v.number()),
    routeCoordinates: v.optional(v.array(v.array(v.number()))),
    createdAt: v.number(),
  })
    .index("by_date", ["date"])
    .index("by_fleetVehicle", ["fleetVehicleId"]),

  tourneeTrackingLinks: defineTable({
    tourneeId: v.id("tournees"),
    shareToken: v.string(),
    stopOrder: v.number(),
    requestId: v.optional(v.id("requests")),
    contactName: v.optional(v.string()),
    address: v.string(),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_tourneeId", ["tourneeId"])
    .index("by_requestId", ["requestId"])
    .index("by_shareToken", ["shareToken"]),

  tourneeVehicleLocations: defineTable({
    tourneeId: v.id("tournees"),
    latitude: v.number(),
    longitude: v.number(),
    heading: v.optional(v.number()),
    accuracy: v.optional(v.number()),
    speedKmh: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_tourneeId", ["tourneeId"]),

  /* ─── App « Mes Outils » : portail d'entreprise ──────────────────────────── */

  /** Fil d'actualité interne (style réseau social). */
  posts: defineTable({
    authorClerkId: v.string(),
    authorName: v.string(),
    authorImageUrl: v.optional(v.string()),
    title: v.optional(v.string()),
    body: v.string(),
    externalLink: v.optional(v.string()),
    images: v.array(v.id("_storage")),
    videos: v.optional(v.array(v.id("_storage"))),
    pinned: v.optional(v.boolean()),
    createdAt: v.number(),
    editedAt: v.optional(v.number()),
    migrationSourceRef: v.optional(v.string()),
  })
    .index("by_authorClerkId", ["authorClerkId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_migrationSourceRef", ["migrationSourceRef"]),

  postComments: defineTable({
    postId: v.id("posts"),
    authorClerkId: v.string(),
    authorName: v.string(),
    authorImageUrl: v.optional(v.string()),
    body: v.string(),
    createdAt: v.number(),
  })
    .index("by_postId", ["postId"])
    .index("by_authorClerkId", ["authorClerkId"]),

  postLikes: defineTable({
    postId: v.id("posts"),
    clerkId: v.string(),
    actorName: v.optional(v.string()),
    actorImageUrl: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_postId", ["postId"])
    .index("by_clerkId", ["clerkId"])
    .index("by_post_and_user", ["postId", "clerkId"]),

  mesoutilsNotifications: defineTable({
    recipientClerkId: v.string(),
    kind: v.union(
      v.literal("room_reservation_confirmed"),
      v.literal("equipment_reservation_confirmed"),
      v.literal("vehicle_reservation_decided"),
      v.literal("new_direct_message"),
      v.literal("post_liked"),
      v.literal("post_commented"),
      v.literal("deal_interest"),
      v.literal("vehicle_reservation_request"),
    ),
    title: v.string(),
    body: v.optional(v.string()),
    actorName: v.optional(v.string()),
    /** Auteur de l'action : permet de retrouver sa photo ACTUELLE à la lecture. */
    actorClerkId: v.optional(v.string()),
    // Photo figée à l'écriture — repli pour les notifications sans actorClerkId.
    actorImageUrl: v.optional(v.string()),
    // Photo de la salle / du véhicule concerné (notifications de réservation).
    assetImageUrl: v.optional(v.string()),
    href: v.optional(v.string()),
    read: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_recipient_createdAt", ["recipientClerkId", "createdAt"])
    .index("by_recipient_read_createdAt", ["recipientClerkId", "read", "createdAt"]),

  /** Salles réservables (réservation immédiate si le créneau est libre). */
  rooms: defineTable({
    name: v.string(),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    capacity: v.optional(v.number()),
    color: v.optional(v.string()),
    sourceKey: v.optional(v.string()),
    photo: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    siteLabel: v.optional(v.string()),
    buildingLabel: v.optional(v.string()),
    reservationSummaryRaw: v.optional(v.string()),
    services: v.optional(v.array(v.string())),
    slotsCount: v.optional(v.number()),
    reservable: v.optional(v.boolean()),
    unavailabilityNotes: v.optional(v.string()),
    active: v.boolean(),
    createdAt: v.number(),
  }).index("by_active", ["active"]),

  roomReservations: defineTable({
    roomId: v.id("rooms"),
    clerkId: v.string(),
    userName: v.string(),
    bookedByName: v.optional(v.string()),
    bookedForClerkId: v.optional(v.string()),
    title: v.string(),
    // Type d'usage de la salle (réunion, atelier, formation…).
    usageType: v.optional(v.string()),
    // Nombre de personnes attendues (plafonné à la capacité de la salle).
    attendees: v.optional(v.number()),
    start: v.number(),
    end: v.number(),
    status: v.optional(v.union(v.literal("confirmed"), v.literal("cancelled"))),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    // Retour (« remarques ») demandé automatiquement après le créneau.
    feedbackRequestedAt: v.optional(v.number()),
    feedbackSubmittedAt: v.optional(v.number()),
    feedbackClean: v.optional(v.boolean()),
    feedbackTidy: v.optional(v.boolean()),
    /** L'utilisateur a-t-il déclaré un incident ? Sans incident, le retour ne
     * remonte pas dans la liste des remarques. */
    feedbackIncident: v.optional(v.boolean()),
    feedbackIssues: v.optional(v.string()),
    feedbackNotes: v.optional(v.string()),
  })
    .index("by_roomId", ["roomId"])
    .index("by_clerkId", ["clerkId"])
    .index("by_bookedForClerkId", ["bookedForClerkId"])
    .index("by_start", ["start"]),

  /** Équipements réservables (mêmes règles que les salles : créneau libre = confirmé). */
  equipments: defineTable({
    name: v.string(),
    category: v.optional(v.string()),
    reference: v.optional(v.string()),
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    photo: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    buildingLabel: v.optional(v.string()),
    notes: v.optional(v.string()),
    active: v.boolean(),
    createdAt: v.number(),
  }).index("by_active", ["active"]),

  equipmentReservations: defineTable({
    equipmentId: v.id("equipments"),
    clerkId: v.string(),
    userName: v.string(),
    bookedByName: v.optional(v.string()),
    bookedForClerkId: v.optional(v.string()),
    title: v.string(),
    start: v.number(),
    end: v.number(),
    status: v.optional(v.union(v.literal("confirmed"), v.literal("cancelled"))),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_equipmentId", ["equipmentId"])
    .index("by_clerkId", ["clerkId"])
    .index("by_bookedForClerkId", ["bookedForClerkId"])
    .index("by_start", ["start"]),

  /**
   * Réservations de véhicules via Mes Outils (approbation requise). Les
   * réservations `approved` rendent le véhicule indisponible côté recyclerie
   * (cf. `vehicleBusyReason` dans fleet.ts).
   */
  vehicleReservations: defineTable({
    vehicleId: v.id("vehicles"),
    clerkId: v.string(),
    userName: v.string(),
    bookedByName: v.optional(v.string()),
    bookedForClerkId: v.optional(v.string()),
    purpose: v.string(),
    // Usage professionnel ou personnel (selon les droits du véhicule).
    usageType: v.optional(v.union(v.literal("pro"), v.literal("personal"))),
    // Kilométrage estimé par le demandeur.
    expectedKm: v.optional(v.number()),
    // Transport d'objets/matériel (déménagement, collecte volumineuse…).
    willTransport: v.optional(v.boolean()),
    transportDetails: v.optional(v.string()),
    start: v.number(),
    end: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("cancelled"),
    ),
    decisionNote: v.optional(v.string()),
    decidedBy: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    feedbackRequestedAt: v.optional(v.number()),
    feedbackSubmittedAt: v.optional(v.number()),
    /** Retour libéré manuellement par l'équipe quand l'utilisateur ne peut pas remplir le formulaire. */
    feedbackManualReturnAt: v.optional(v.number()),
    feedbackManualReturnBy: v.optional(v.string()),
    /** Dernière relance manuelle envoyée au demandeur pour compléter son retour. */
    feedbackReminderSentAt: v.optional(v.number()),
    feedbackMileage: v.optional(v.number()),
    feedbackFuelRestored: v.optional(v.boolean()),
    feedbackVehicleEmpty: v.optional(v.boolean()),
    feedbackVehicleClean: v.optional(v.boolean()),
    /** L'utilisateur a-t-il déclaré un incident ? Sans incident, le retour ne
     * remonte ni dans les remarques ni chez Mécania. */
    feedbackIncident: v.optional(v.boolean()),
    feedbackIssues: v.optional(v.string()),
    feedbackNotes: v.optional(v.string()),
    /** Photos / vidéos jointes au retour pour illustrer un problème constaté. */
    feedbackMedia: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          contentType: v.optional(v.string()),
          name: v.optional(v.string()),
        }),
      ),
    ),
    createdAt: v.number(),
  })
    .index("by_vehicleId", ["vehicleId"])
    .index("by_clerkId", ["clerkId"])
    .index("by_bookedForClerkId", ["bookedForClerkId"])
    .index("by_status", ["status"])
    .index("by_start", ["start"]),

  vehicleMaintenanceTasks: defineTable({
    vehicleId: v.id("vehicles"),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    status: v.union(v.literal("todo"), v.literal("in_progress"), v.literal("done")),
    dueDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
    odometerKm: v.optional(v.number()),
    /** Temps passé sur l'intervention, en minutes. Obligatoire pour clôturer. */
    laborMinutes: v.optional(v.number()),
    /** Prix des pièces (€). Obligatoire pour clôturer (0 accepté si aucune pièce). */
    partsCost: v.optional(v.number()),
    /** Pièces jointes : photos de la panne, de la réparation, factures… */
    attachments: v.optional(v.array(v.id("_storage"))),
    /** Nom et type des pièces jointes, dans l'ordre d'`attachments`. Sans eux,
     *  un PDF ne se distingue pas d'une photo et finit dans une balise `img` ;
     *  les fiches d'avant les documents n'en ont pas, elles sont des photos. */
    attachmentMeta: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          name: v.optional(v.string()),
          contentType: v.optional(v.string()),
        }),
      ),
    ),
    /** Photos de l'état AVANT intervention (constat, panne). */
    beforePhotos: v.optional(v.array(v.id("_storage"))),
    /** Descriptif AVANT intervention : constat, symptômes, état relevé. */
    beforeNotes: v.optional(v.string()),
    /** Photos APRÈS intervention (réparation, pièces posées). */
    afterPhotos: v.optional(v.array(v.id("_storage"))),
    /** Descriptif des opérations réalisées pendant l'intervention. */
    afterNotes: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_vehicleId", ["vehicleId"])
    .index("by_status", ["status"])
    .index("by_dueDate", ["dueDate"]),

  /** Synthèse IA des retours de réservation, une par véhicule. */
  vehicleRemarkAnalyses: defineTable({
    vehicleId: v.id("vehicles"),
    summary: v.string(),
    /** Hypothèses mécaniques de l'IA, à vérifier avant toute intervention. */
    diagnosis: v.optional(v.string()),
    /** Sources techniques trouvées lors de la recherche web liée au véhicule. */
    webSources: v.optional(v.array(v.object({
      title: v.string(),
      url: v.string(),
    }))),
    proposals: v.array(v.object({
      title: v.string(),
      description: v.string(),
      priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    })),
    sourceRemarkCount: v.number(),
    latestRemarkAt: v.number(),
    model: v.string(),
    updatedAt: v.number(),
  }).index("by_vehicleId", ["vehicleId"]),

  /** Documents rattachés à un véhicule (carte grise, facture, devis, assurance...). */
  vehicleDocuments: defineTable({
    vehicleId: v.id("vehicles"),
    name: v.string(),
    category: v.union(
      v.literal("carte_grise"),
      v.literal("facture"),
      v.literal("devis"),
      v.literal("assurance"),
      v.literal("controle_technique"),
      v.literal("autre"),
    ),
    storageId: v.id("_storage"),
    uploadedBy: v.string(),
    createdAt: v.number(),
  }).index("by_vehicleId", ["vehicleId"]),

  /** Espace partage — événements internes. */
  events: defineTable({
    authorClerkId: v.string(),
    authorName: v.string(),
    authorImageUrl: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    // Date optionnelle : un événement peut être publié sans créneau précis.
    start: v.optional(v.number()),
    end: v.optional(v.number()),
    images: v.array(v.id("_storage")),
    createdAt: v.number(),
  })
    .index("by_authorClerkId", ["authorClerkId"])
    .index("by_start", ["start"]),

  /** Espace partage — bons plans internes (prêt, don, vente, échange). */
  dealPosts: defineTable({
    authorClerkId: v.string(),
    authorName: v.string(),
    authorImageUrl: v.optional(v.string()),
    title: v.string(),
    description: v.string(),
    adKind: v.optional(v.union(v.literal("offre"), v.literal("demande"))),
    dealType: v.union(
      v.literal("pret"),
      v.literal("don"),
      v.literal("vente"),
      v.literal("echange"),
      v.literal("location"),
    ),
    price: v.optional(v.number()),
    // Unité de facturation d'une location : le prix s'entend « par période ».
    rentalPeriod: v.optional(
      v.union(
        v.literal("jour"),
        v.literal("semaine"),
        v.literal("mois"),
        v.literal("annee"),
      ),
    ),
    availableFrom: v.optional(v.number()),
    availableTo: v.optional(v.number()),
    images: v.array(v.id("_storage")),
    status: v.union(v.literal("open"), v.literal("closed")),
    createdAt: v.number(),
  })
    .index("by_authorClerkId", ["authorClerkId"])
    .index("by_createdAt", ["createdAt"]),

  /** Messagerie interne entre utilisateurs. */
  directMessages: defineTable({
    pairKey: v.string(),
    fromClerkId: v.string(),
    fromName: v.string(),
    fromImageUrl: v.optional(v.string()),
    toClerkId: v.string(),
    toName: v.string(),
    body: v.string(),
    // Image jointe (ex. première photo d'un bon plan, sur le premier message).
    attachmentImageUrl: v.optional(v.string()),
    attachmentTitle: v.optional(v.string()),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_pair", ["pairKey", "createdAt"])
    .index("by_to", ["toClerkId"])
    .index("by_from", ["fromClerkId"]),

  /** Cycle en Bray — vélos reconditionnés, stock CRM et boutique publique. */
  bikes: defineTable({
    photos: v.array(v.id("_storage")),
    title: v.string(),
    description: v.string(),
    site: v.union(v.literal("60"), v.literal("76")),
    gdrReference: v.optional(v.string()),
    internalReference: v.optional(v.string()),
    category: v.string(),
    brand: v.optional(v.string()),
    model: v.optional(v.string()),
    condition: v.string(),
    useMode: v.optional(v.union(v.literal("purchase"), v.literal("rental"))),
    status: v.union(
      v.literal("inactive"),
      v.literal("available"),
      v.literal("purchase_pending"),
      v.literal("sold"),
      // Valeurs intermédiaires conservées pour compatibilité/migration.
      v.literal("waiting"),
      v.literal("online"),
      v.literal("draft"),
      v.literal("atelier"),
      v.literal("ready"),
      v.literal("reserved"),
      v.literal("archived"),
    ),
    pipelineStatus: v.optional(v.union(
      v.literal("nouveau"),
      v.literal("validation"),
      v.literal("en_cours"),
      v.literal("gagnee"),
      v.literal("perdue"),
    )),
    processStep: v.optional(v.number()),
    processLog: v.optional(v.array(v.object({
      step: v.number(),
      by: v.string(),
      at: v.number(),
    }))),
    customerName: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerPhone: v.optional(v.string()),
    customerNotes: v.optional(v.string()),
    price: v.optional(v.number()),
    originalPrice: v.optional(v.number()),
    sizeLabel: v.optional(v.string()),
    frameHeightCm: v.optional(v.number()),
    riderMinCm: v.optional(v.number()),
    riderMaxCm: v.optional(v.number()),
    wheelSize: v.optional(v.string()),
    frameMaterial: v.optional(v.string()),
    color: v.optional(v.string()),
    weightKg: v.optional(v.number()),
    brakeType: v.optional(v.string()),
    drivetrain: v.optional(v.string()),
    speeds: v.optional(v.number()),
    motor: v.optional(v.string()),
    batteryWh: v.optional(v.number()),
    autonomyKm: v.optional(v.number()),
    accessories: v.optional(v.array(v.string())),
    repairs: v.optional(v.array(v.string())),
    defects: v.optional(v.array(v.string())),
    location: v.optional(v.string()),
    featured: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_site", ["site"])
    .index("by_category", ["category"])
    .index("by_gdrReference", ["gdrReference"])
    .index("by_featured", ["featured"])
    .index("by_createdAt", ["createdAt"]),

  cycleCustomers: defineTable({
    firstName: v.string(),
    lastName: v.string(),
    email: v.string(),
    phone: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_email", ["email"]),

  cycleRequests: defineTable({
    requestKind: v.optional(v.union(v.literal("reservation"), v.literal("reebike"), v.literal("repair"))),
    bikeId: v.optional(v.id("bikes")),
    bikeTitle: v.string(),
    bikeGdrReference: v.optional(v.string()),
    customerId: v.id("cycleCustomers"),
    customer: v.object({
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      phone: v.string(),
      message: v.optional(v.string()),
    }),
    reebike: v.optional(v.object({
      desiredAt: v.string(),
      duration: v.optional(v.string()),
      formula: v.string(),
      frontBrake: v.string(),
      bikeType: v.string(),
      wheelSize: v.string(),
      compatibilityPhotos: v.optional(v.array(v.id("_storage"))),
    })),
    reservation: v.optional(v.object({
      rentalStart: v.optional(v.string()),
      rentalEnd: v.optional(v.string()),
    })),
    rental: v.optional(v.object({
      startDate: v.string(),
      endDate: v.string(),
    })),
    management: v.optional(v.object({
      site: v.optional(v.union(v.literal("60"), v.literal("76"))),
      assignedTo: v.optional(v.string()),
      notes: v.optional(v.string()),
    })),
    fieldEdits: v.optional(
      v.object({
        customer: v.optional(v.object({ by: v.string(), at: v.number() })),
        reebike: v.optional(v.object({ by: v.string(), at: v.number() })),
        management: v.optional(v.object({ by: v.string(), at: v.number() })),
      }),
    ),
    pipelineStatus: v.union(
      v.literal("nouveau"),
      v.literal("validation"),
      v.literal("en_cours"),
      v.literal("gagnee"),
      v.literal("perdue"),
    ),
    processStep: v.number(),
    processLog: v.optional(v.array(v.object({
      step: v.number(),
      by: v.string(),
      at: v.number(),
    }))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pipelineStatus", ["pipelineStatus"])
    .index("by_bikeId", ["bikeId"])
    .index("by_customerId", ["customerId"])
    .index("by_createdAt", ["createdAt"]),

  /* ─── Klyd : boutique textile (base de données partagée, tables dédiées) ──── */

  /**
   * Articles textile de la boutique Klyd. Stockés dans une table dédiée
   * (et non dans `articles`) : les articles de la recyclerie et ceux de Klyd
   * restent ainsi totalement séparés, tout en partageant le même déploiement
   * Convex / la même base de données.
   */
  klydeItems: defineTable({
    photos: v.array(v.id("_storage")),
    title: v.string(),
    description: v.string(),
    category: v.string(),
    subcategory: v.optional(v.string()),
    /** Niveau le plus précis de la taxonomie Klyd (ex. Robes courtes). */
    subsubcategory: v.optional(v.string()),
    /** Poids estimé ou corrigé de l'article, en kilogrammes. */
    weightKg: v.optional(v.number()),
    brand: v.optional(v.string()),
    size: v.optional(v.string()),
    condition: v.string(),
    color: v.optional(v.string()),
    material: v.optional(v.string()),
    price: v.optional(v.number()),
    // Prix réellement encaissé. Il peut être inférieur au prix affiché après
    // acceptation d'une offre ; c'est cette valeur qui sert au chiffre d'affaires.
    actualSalePrice: v.optional(v.number()),
    parcelSize: v.optional(v.string()),
    gender: v.optional(v.string()),
    style: v.optional(v.string()),
    location: v.optional(v.string()),
    sku: v.optional(v.string()),
    // Article mis en vente sur Vinted (case cochée dans le stock Klyd).
    vinted: v.optional(v.boolean()),
    /** Publication indépendante dans la boutique Klyde (sans lien avec Vinted). */
    publishedOnBoutique: v.optional(v.boolean()),
    boutiquePublishedAt: v.optional(v.number()),
    // Date de mise en vente sur Vinted (pour l'alerte « 3 semaines »).
    vintedAt: v.optional(v.number()),
    // Date d'envoi de l'alerte email « 3 semaines sur Vinted » (anti-doublon).
    vintedAlertSentAt: v.optional(v.number()),
    // Nombre de fois où l'annonce Vinted a été prolongée après l'alerte de 3 semaines.
    vintedExtensionCount: v.optional(v.number()),
    vintedLastExtendedAt: v.optional(v.number()),
    /**
     * Date d'encaissement, posée au passage en « gagné ». Les rapports de
     * vente se groupent par mois : sans cette date, un article vendu ne peut
     * être rattaché qu'à `updatedAt`, que la moindre retouche déplace.
     */
    soldAt: v.optional(v.number()),
    // Décision prise lorsqu'un article sort de Stock B.
    stockBDisposition: v.optional(v.union(
      v.literal("vente_exceptionnelle"),
      v.literal("magasin"),
    )),
    // Enseigne à laquelle l'article est rattaché : Klyd ou Mobifrip.
    outlet: v.optional(v.union(v.literal("klyd"), v.literal("mobifrip"))),
    quantity: v.number(),
    status: v.union(
      v.literal("stock"),
      v.literal("stock_b"),
      v.literal("en_ligne"),
      v.literal("en_cours_envoi"),
      v.literal("envoye"),
      v.literal("gagne"),
      // Invendu en ligne : l'article repart en rayon à la boutique physique.
      v.literal("magasin"),
      // Anciennes valeurs conservées pour les articles créés avant le suivi.
      v.literal("en_stock"),
      v.literal("reserve"),
      v.literal("vendu"),
      v.literal("archive"),
    ),
    aiConfidence: v.optional(v.number()),
    aiNotes: v.optional(v.string()),
    trackingNotes: v.optional(v.string()),
    featured: v.optional(v.boolean()),
    /**
     * Mise aux archives : l'article sort du stock, de la boutique et des
     * rapports, mais garde son statut pour pouvoir être remis en ligne.
     */
    archivedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_archivedAt", ["archivedAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_sku", ["sku"])
    .index("by_boutiquePublished", ["publishedOnBoutique"])
    .index("by_featured", ["featured"]),

  /** Visuels éditoriaux du header de la boutique Klyde. */
  klydeStorefront: defineTable({
    key: v.string(),
    hommeCover: v.optional(v.id("_storage")),
    femmeCover: v.optional(v.id("_storage")),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  /** Klyde — commandes boutique créées après connexion client. */
  klydeOrders: defineTable({
    itemIds: v.array(v.id("klydeItems")),
    clerkId: v.string(),
    customer: v.object({
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      phone: v.string(),
    }),
    total: v.number(),
    status: v.union(v.literal("en_attente_paiement"), v.literal("payee")),
    paymentMethod: v.literal("card"),
    note: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_createdAt", ["createdAt"]),

  /** Klyde — wishlist client. */
  klydeWishlists: defineTable({
    clerkId: v.string(),
    itemId: v.id("klydeItems"),
    createdAt: v.number(),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_clerkId_itemId", ["clerkId", "itemId"])
    .index("by_itemId", ["itemId"]),

  /* ─── Klyd — boîte Gmail Vinted (OAuth Google + emails analysés) ─────────
   *
   * Vinted n'expose pas d'API publique : la seule source fiable sur ce qui est
   * vendu, expédié ou payé reste la boîte mail du compte. On lit donc, en
   * lecture seule (scope `gmail.readonly`), les emails Vinted du compte Gmail
   * connecté, et on en extrait les informations exploitables dans Klyd.
   */

  /** Compte Gmail connecté via OAuth Google (un par boîte, réutilisable). */
  klydeGmailAccounts: defineTable({
    /** Adresse Gmail réellement connectée (renvoyée par Google, pas saisie). */
    email: v.string(),
    /** Clerk de la personne qui a autorisé l'accès (traçabilité). */
    connectedByClerkId: v.string(),
    connectedByName: v.optional(v.string()),
    /**
     * Jeton de rafraîchissement Google : c'est LUI qui donne l'accès durable.
     * Google ne le renvoie qu'au premier consentement (`prompt=consent` force
     * son renvoi) — on ne l'écrase donc jamais par une valeur vide.
     */
    refreshToken: v.string(),
    accessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    /** Requête Gmail appliquée à la synchronisation (surchargeable). */
    query: v.optional(v.string()),
    active: v.boolean(),
    /** Date (ms) du message le plus récent déjà importé : borne du sync incrémental. */
    lastMessageDate: v.optional(v.number()),
    lastSyncAt: v.optional(v.number()),
    lastSyncError: v.optional(v.string()),
    importedCount: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_active", ["active"]),

  /**
   * État anti-CSRF de la redirection OAuth. Créé avant l'envoi chez Google,
   * consommé (et supprimé) au retour : un `code` sans état connu est rejeté.
   */
  klydeGmailOAuthStates: defineTable({
    state: v.string(),
    clerkId: v.string(),
    clerkName: v.optional(v.string()),
    returnUrl: v.string(),
    createdAt: v.number(),
  }).index("by_state", ["state"]),

  /** Email Vinted importé et analysé (une ligne par message Gmail). */
  klydeVintedEmails: defineTable({
    accountId: v.id("klydeGmailAccounts"),
    /** Identifiant Gmail du message : clé d'idempotence de l'import. */
    gmailId: v.string(),
    threadId: v.optional(v.string()),
    /** Date d'envoi (ms), telle que donnée par Gmail (`internalDate`). */
    sentAt: v.number(),
    subject: v.string(),
    from: v.string(),
    snippet: v.optional(v.string()),
    /** Corps en texte brut (HTML aplati si l'email n'a pas de partie texte). */
    bodyText: v.optional(v.string()),
    /** Nature du message, déduite du sujet et du corps. */
    kind: v.union(
      v.literal("vente"),
      v.literal("bordereau"),
      v.literal("expedition"),
      v.literal("paiement"),
      v.literal("offre"),
      v.literal("message"),
      v.literal("autre"),
    ),
    /** Informations extraites (regex, complétées si besoin par l'IA). */
    itemTitle: v.optional(v.string()),
    amount: v.optional(v.number()),
    buyer: v.optional(v.string()),
    orderRef: v.optional(v.string()),
    trackingNumber: v.optional(v.string()),
    carrier: v.optional(v.string()),
    /** Lien « imprimer le bordereau » trouvé dans l'email. */
    labelUrl: v.optional(v.string()),
    /** Lien vers la conversation Vinted avec l'acheteur. */
    conversationUrl: v.optional(v.string()),
    /** Lien vers l'annonce Vinted concernée. */
    itemUrl: v.optional(v.string()),
    /** Enseigne d'où vient l'email, déduite de la boîte scrutée. */
    outlet: v.optional(v.union(v.literal("klyd"), v.literal("mobifrip"))),
    /** Coordonnées de l'acheteur, telles que Vinted les donne dans l'email. */
    buyerName: v.optional(v.string()),
    buyerAddress: v.optional(v.string()),
    buyerEmail: v.optional(v.string()),
    /** Facture générée pour cette vente (PDF dans le stockage Convex). */
    invoiceStorageId: v.optional(v.id("_storage")),
    invoiceNumber: v.optional(v.string()),
    invoiceGeneratedAt: v.optional(v.number()),
    /** Envoi de la facture au client (date et adresse réellement servie). */
    invoiceSentAt: v.optional(v.number()),
    invoiceSentTo: v.optional(v.string()),
    /** Adresse qui a transféré la notification Vinted (le cas courant). */
    forwardedBy: v.optional(v.string()),
    /** Date de réception du transfert, quand elle diffère de la date d'origine. */
    forwardedAt: v.optional(v.number()),
    /** Pièces jointes rapatriées dans le stockage Convex (bordereaux PDF). */
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
    /** `true` si l'extraction a été complétée par l'IA. */
    aiParsed: v.optional(v.boolean()),
    /** Article Klyd rattaché (rapprochement automatique ou manuel). */
    matchedItemId: v.optional(v.id("klydeItems")),
    matchConfidence: v.optional(v.number()),
    /** Email traité par l'équipe (masqué de la file d'attente). */
    handled: v.optional(v.boolean()),
    handledAt: v.optional(v.number()),
    handledByClerkId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_gmailId", ["gmailId"])
    .index("by_sentAt", ["sentAt"])
    .index("by_kind", ["kind"])
    .index("by_handled", ["handled"])
    .index("by_account", ["accountId"])
    .index("by_matchedItem", ["matchedItemId"]),

  /* ─── App « Bennes & Pro » : dépôts de déchets par les entreprises ──────── */

  /** Entreprises qui déposent des déchets sur le site. */
  bpCompanies: defineTable({
    name: v.string(),
    siret: v.optional(v.string()),
    address: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    /** Email dédié à la facturation (peut différer de l'email de contact). */
    billingEmail: v.optional(v.string()),
    /** Profil de l'entreprise (artisan, BTP, distributeur…). */
    companyType: v.optional(bpCompanyType),
    /** Précision libre quand `companyType === "autre"`. */
    companyTypeOther: v.optional(v.string()),
    /** Sujet Clerk du client propriétaire (compte espace client). */
    ownerUserId: v.optional(v.string()),
    /** Documents obligatoires marqués « Signé » par le staff. */
    conventionSignedAt: v.optional(v.number()),
    protocoleSignedAt: v.optional(v.number()),
    /** Client Stripe associé à la facturation. */
    stripeCustomerId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_owner", ["ownerUserId"]),

  /** Documents rattachés à une entreprise (KBIS, RIB… ; client ↔ staff). */
  bpCompanyDocuments: defineTable({
    companyId: v.id("bpCompanies"),
    storageId: v.id("_storage"),
    name: v.string(),
    docType: v.union(
      v.literal("kbis"),
      v.literal("rib"),
      v.literal("assurance"),
      v.literal("convention"),
      v.literal("protocole"),
      v.literal("autre"),
    ),
    mimeType: v.optional(v.string()),
    /** Message de contexte optionnel joint au document. */
    note: v.optional(v.string()),
    /** Qui a déposé le document (portail client ou CRM). */
    uploadedByRole: v.union(v.literal("client"), v.literal("staff")),
    /** Horodatage de partage au client (docs staff visibles côté client). */
    sharedWithClientAt: v.optional(v.number()),
    /** Validation par le staff d'un document signé (convention, protocole…). */
    validatedAt: v.optional(v.number()),
    validatedBy: v.optional(v.string()),
    createdBy: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_company", ["companyId"]),

  /** Messagerie entre une entreprise cliente et le staff. */
  bpCompanyMessages: defineTable({
    companyId: v.id("bpCompanies"),
    senderRole: v.union(v.literal("client"), v.literal("staff")),
    senderName: v.string(),
    // Compte Clerk de l'expéditeur : sert à afficher sa photo de profil (résolue
    // à la lecture via `users.imageUrl`, toujours à jour).
    senderClerkId: v.optional(v.string()),
    body: v.string(),
    readByClientAt: v.optional(v.number()),
    readByStaffAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_company", ["companyId"]),

  /** Réglages Bennes & Pro (doc unique, key = "bennespro"). */
  bpSettings: defineTable({
    key: v.string(),
    /** Prix du DIB en centimes d'euro par kg (défaut : 34). */
    dibPriceCentsPerKg: v.optional(v.number()),
    /** Code PIN de l'onglet « Profils » (défaut : 0205). */
    profilesPin: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
    updatedBy: v.optional(v.string()),
  }).index("by_key", ["key"]),

  /**
   * Profils d'un compte Bennes & Pro partagé par plusieurs personnes.
   *
   * Le compte est unique mais l'équipe est multiple : à l'ouverture, chacun
   * choisit son profil (à la Netflix), et c'est ce nom-là qui est inscrit sur
   * les dépôts qu'il enregistre. Sans ça, tous les dépôts porteraient la même
   * adresse email et on ne saurait jamais qui était sur le terrain.
   */
  bpProfiles: defineTable({
    /** Compte partagé auquel appartient le profil (email Clerk, en minuscules). */
    ownerEmail: v.string(),
    name: v.string(),
    /** Rôle ou mention libre affichée sous le nom (« Chauffeur », « Quai »…). */
    role: v.optional(v.string()),
    /** Teinte de la vignette, pour distinguer les profils d'un coup d'œil. */
    color: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerEmail"]),

  /** Véhicules appartenant à une entreprise (bennes, camions...). */
  bpVehicles: defineTable({
    companyId: v.id("bpCompanies"),
    label: v.string(),
    plate: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_company", ["companyId"]),

  /** Dépôts de déchets. Les lignes de déchets sont embarquées dans le doc. */
  bpDepots: defineTable({
    depotNumber: v.number(),
    companyId: v.id("bpCompanies"),
    vehicleId: v.id("bpVehicles"),
    depositorName: v.string(),
    siteRef: v.string(),
    items: v.array(
      v.object({
        material: bpMaterial,
        unit: bpUnit,
        quantity: v.number(),
        siteRef: v.string(),
      }),
    ),
    ticketPhoto: v.optional(v.id("_storage")),
    truckExteriorPhoto: v.optional(v.id("_storage")),
    truckInteriorPhoto: v.optional(v.id("_storage")),
    attachments: v.array(v.id("_storage")),
    comment: v.optional(v.string()),
    signature: v.optional(v.id("_storage")),
    /** Facturation Stripe des matières payantes, au poids. */
    billing: v.optional(bpBilling),
    createdBy: v.optional(v.string()),
    /**
     * Profil de la personne qui a saisi le dépôt derrière un compte partagé.
     * Le nom est recopié : un profil renommé ou supprimé plus tard ne doit pas
     * effacer la trace de qui a fait le dépôt ce jour-là.
     */
    createdByProfileId: v.optional(v.id("bpProfiles")),
    createdByProfile: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_company", ["companyId"])
    .index("by_number", ["depotNumber"])
    .index("by_profile", ["createdByProfileId"]),

  // ───────────────────────── App « Pointeuse LSDB » ─────────────────────────
  // Suivi des salariés et des chantiers : clients, projets, pointages,
  // fournisseurs, dépenses, factures. Tables préfixées `pt`.

  /** Salariés (avec taux horaire environné). */
  ptEmployees: defineTable({
    firstName: v.string(),
    lastName: v.string(),
    status: v.union(
      v.literal("MAD"),
      v.literal("Compagnon permanent"),
      v.literal("Compagnon insertion"),
      v.literal("Renfort ponctuel"),
      v.literal("Encadrant"),
    ),
    /** Taux horaire environné, en euros par heure. */
    hourlyRate: v.number(),
    active: v.boolean(),
    createdAt: v.number(),
  }).index("by_active", ["active"]),

  /** Clients (donneurs d'ordre des chantiers). */
  ptClients: defineTable({
    name: v.string(),
    /** Interne (structures du groupe) ou externe — filtre principal de l'UI. */
    clientType: v.optional(v.union(v.literal("interne"), v.literal("externe"))),
    contactName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_name", ["name"]),

  /** Projets / chantiers rattachés à un client. */
  ptProjects: defineTable({
    name: v.string(),
    clientId: v.id("ptClients"),
    address: v.optional(v.string()),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
    lat: v.optional(v.number()),
    lon: v.optional(v.number()),
    /** Distance aller (km) depuis la base — sert au calcul des déplacements. */
    distanceKm: v.number(),
    /** Coût kilométrique HT utilisé pour les déplacements sur ce projet. */
    travelRatePerKm: v.optional(v.number()),
    status: v.union(
      v.literal("en_cours"),
      v.literal("termine"),
      v.literal("en_pause"),
    ),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_client", ["clientId"])
    .index("by_status", ["status"]),

  /** Pointages : temps passé par salarié sur un projet + déplacements. */
  ptTimeEntries: defineTable({
    projectId: v.id("ptProjects"),
    /** Dénormalisé depuis le projet au moment du pointage. */
    clientId: v.id("ptClients"),
    date: v.number(),
    lines: v.array(
      v.object({
        employeeId: v.id("ptEmployees"),
        hours: v.number(),
        /** Snapshot du taux horaire au moment du pointage. */
        hourlyRate: v.number(),
        /** hours × hourlyRate. */
        cost: v.number(),
      }),
    ),
    /** Déplacements : coût = roundTrips × distanceKm × 2 (× 1 €/km). */
    travel: v.optional(
      v.object({
        roundTrips: v.number(),
        distanceKm: v.number(),
        ratePerKm: v.optional(v.number()),
        cost: v.number(),
      }),
    ),
    laborCost: v.number(),
    travelCost: v.number(),
    totalCost: v.number(),
    billingStatus: v.optional(
      v.union(v.literal("a_facturer"), v.literal("facture")),
    ),
    notes: v.optional(v.string()),
    documentIds: v.array(v.id("ptDocuments")),
    createdAt: v.number(),
    createdBy: v.optional(v.string()),
  })
    .index("by_project", ["projectId"])
    .index("by_date", ["date"]),

  /**
   * Tâches planifiées (nouveau flux) : un encadrant crée une tâche (projet,
   * date, déplacement, salariés affectés + temps estimé). Chaque salarié
   * affecté confirme ensuite son temps réel depuis « Pointages ». Distinct de
   * `ptTimeEntries` (pointages historiques, inchangés).
   */
  ptTasks: defineTable({
    projectId: v.id("ptProjects"),
    /** Dénormalisé depuis le projet à la création. */
    clientId: v.id("ptClients"),
    date: v.number(),
    travel: v.optional(
      v.object({
        roundTrips: v.number(),
        distanceKm: v.number(),
        ratePerKm: v.optional(v.number()),
        cost: v.number(),
      }),
    ),
    notes: v.optional(v.string()),
    documentIds: v.array(v.id("ptDocuments")),
    assignments: v.array(
      v.object({
        employeeId: v.id("ptEmployees"),
        /** Snapshot du taux horaire à la création de la tâche. */
        hourlyRate: v.number(),
        /** Temps estimé à la création (heures). */
        estimatedHours: v.number(),
        /** Temps réel confirmé par le salarié (heures). */
        confirmedHours: v.optional(v.number()),
        confirmedAt: v.optional(v.number()),
      }),
    ),
    /** « confirmed » dès que toutes les affectations ont un temps réel. */
    status: v.union(v.literal("pending"), v.literal("confirmed")),
    createdAt: v.number(),
    createdBy: v.optional(v.string()),
  })
    .index("by_project", ["projectId"])
    .index("by_date", ["date"])
    .index("by_status", ["status"]),

  /** Fournisseurs. */
  ptSuppliers: defineTable({
    name: v.string(),
    supplierType: v.optional(v.string()),
    contactName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_name", ["name"]),

  /** Dépenses (rattachables à un projet et/ou un fournisseur). */
  ptExpenses: defineTable({
    label: v.string(),
    amount: v.number(),
    date: v.number(),
    projectId: v.optional(v.id("ptProjects")),
    supplierId: v.optional(v.id("ptSuppliers")),
    category: v.optional(v.string()),
    documentIds: v.array(v.id("ptDocuments")),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_supplier", ["supplierId"]),

  /** Factures — suivi manuel par projet. */
  ptInvoices: defineTable({
    projectId: v.id("ptProjects"),
    clientId: v.id("ptClients"),
    number: v.string(),
    amount: v.number(),
    status: v.union(
      v.literal("brouillon"),
      v.literal("envoyee"),
      v.literal("payee"),
      v.literal("en_retard"),
    ),
    issuedAt: v.number(),
    dueAt: v.optional(v.number()),
    paidAt: v.optional(v.number()),
    documentIds: v.array(v.id("ptDocuments")),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_status", ["status"]),

  /** Documents rattachés à un projet (et éventuellement pointage/dépense/facture).
   *  Un document ajouté lors d'un pointage porte le projet du pointage : il se
   *  retrouve donc dans la fiche du projet relié. */
  ptDocuments: defineTable({
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
    /** Fournisseur rattaché (justificatifs de dépenses). */
    supplierId: v.optional(v.id("ptSuppliers")),
    timeEntryId: v.optional(v.id("ptTimeEntries")),
    expenseId: v.optional(v.id("ptExpenses")),
    invoiceId: v.optional(v.id("ptInvoices")),
    uploadedAt: v.number(),
    uploadedBy: v.optional(v.string()),
  }).index("by_project", ["projectId"]),

  /** Salariés RH Mes Outils. */
  hrEmployees: defineTable({
    firstName: v.string(),
    lastName: v.string(),
    fullName: v.string(),
    gender: hrEmployeeGender,
    address: v.string(),
    structure: hrEmployeeStructure,
    socialSecurityNumber: v.string(),
    socialSecurityNumberNormalized: v.string(),
    firstContractDate: v.optional(v.string()),
    active: v.boolean(),
    importedFrom: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: v.optional(v.string()),
    updatedBy: v.optional(v.string()),
  })
    .index("by_fullName", ["fullName"])
    .index("by_lastName_and_firstName", ["lastName", "firstName"])
    .index("by_socialSecurityNumberNormalized", ["socialSecurityNumberNormalized"])
    .index("by_structure", ["structure"]),

  /** Historique des générations de contrats RH envoyées à Make. */
  hrContracts: defineTable({
    employeeId: v.id("hrEmployees"),
    payload: hrContractWebhookPayload,
    webhookUrl: v.string(),
    webhookStatus: v.union(
      v.literal("pending"),
      v.literal("success"),
      v.literal("error"),
    ),
    webhookResponseCode: v.optional(v.number()),
    webhookResponseBody: v.optional(v.string()),
    requestedAt: v.number(),
    requestedBy: v.string(),
    /** Horodatage du dernier email de prévenance de fin de contrat. */
    endNoticeSentAt: v.optional(v.number()),
    /** Paliers de prévenance déjà envoyés (22, 15, 3 jours) — évite les doublons. */
    endNoticeSentThresholds: v.optional(v.array(v.number())),
  })
    .index("by_employee_and_requestedAt", ["employeeId", "requestedAt"])
    .index("by_requestedAt", ["requestedAt"]),

  /**
   * App « Feedback » (feedback.groupemes.fr) — retours utilisateurs sur
   * n'importe quelle app de l'écosystème. Table dédiée : aucun lien avec les
   * `requests` de la recyclerie (autre métier, autres droits).
   */
  feedback: defineTable({
    /**
     * App concernée par le retour (clé de tuile du portail Mes Outils).
     * Absente pour les retours de type `nouvelle_application` : l'idée ne vise
     * par définition aucune app existante.
     */
    app: v.optional(feedbackApp),
    type: feedbackType,
    description: v.string(),
    /** Captures, photos ou documents fournis avec le retour. */
    attachments: v.optional(v.array(v.id("_storage"))),
    status: feedbackStatus,
    /** Urgence choisie par l'auteur, modifiable par lui après coup. */
    priority: v.optional(feedbackPriority),
    /** Auteur : identité Clerk figée à la création. */
    authorClerkId: v.string(),
    authorEmail: v.string(),
    authorName: v.optional(v.string()),
    authorImageUrl: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Dernier message de la conversation — tri et pastille « non lu ». */
    lastCommentAt: v.optional(v.number()),
  })
    .index("by_author_and_createdAt", ["authorClerkId", "createdAt"])
    .index("by_status", ["status"])
    .index("by_app", ["app"])
    .index("by_createdAt", ["createdAt"]),

  /**
   * Conversation attachée à un retour : l'auteur et l'équipe produit échangent
   * ici. Table dédiée plutôt qu'un champ unique : un retour appelle plusieurs
   * allers-retours, et on veut savoir qui a dit quoi et quand.
   */
  feedbackComments: defineTable({
    feedbackId: v.id("feedback"),
    body: v.string(),
    /** Auteur du message : identité Clerk figée à l'écriture. */
    authorClerkId: v.string(),
    authorEmail: v.string(),
    authorName: v.optional(v.string()),
    authorImageUrl: v.optional(v.string()),
    /** Vrai si le message vient de l'équipe produit (affichage distinct). */
    fromTeam: v.boolean(),
    createdAt: v.number(),
  }).index("by_feedback_and_createdAt", ["feedbackId", "createdAt"]),

  /* ─── Agents polyvalents (Recyclerie) ─────────────────────────────────────
   * Gestion des ouvriers polyvalents : un catalogue de tâches, une liste
   * d'ouvriers (nom/prénom), et des activités qui affectent un ouvrier à une
   * tâche sur un créneau daté. `polyvalentWorkers` est désormais l'unique
   * équipe Recyclerie (les anciens « agents permanents » y ont été fusionnés). */
  polyvalentTasks: defineTable({
    name: v.string(),
    /** Site de traitement : une tâche appartient à une recyclerie. */
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    /** Main d'œuvre requise par mois, en heures (base du plan de charge). */
    requiredMonthlyHours: v.optional(v.number()),
    createdBy: v.string(),
    createdAt: v.number(),
  }).index("by_name", ["name"]),

  polyvalentWorkers: defineTable({
    firstName: v.string(),
    lastName: v.string(),
    email: v.optional(v.string()),
    /** Recycleries de rattachement : un salarié peut intervenir sur les deux. */
    sites: v.optional(v.array(v.union(v.literal("60"), v.literal("76")))),
    /** Type de contrat : agent permanent ou agent polyvalent. */
    employmentType: v.optional(v.union(v.literal("permanent"), v.literal("polyvalent"))),
    /** Inactif = conservé pour l'historique mais plus attribuable. */
    active: v.optional(v.boolean()),
    /** Salarié RH correspondant : la fiche RH fait foi pour l'identité. */
    hrEmployeeId: v.optional(v.id("hrEmployees")),
    /** Fin du dernier contrat (`YYYY-MM-DD`) ; absente pour un CDI. */
    contractEndAt: v.optional(v.string()),
    /** Réactivation manuelle : la synchro RH ne redésactive plus ce salarié. */
    reactivatedAt: v.optional(v.number()),
    /**
     * Statut forcé à la main dans l'app. Il l'emporte sur la fin de contrat,
     * mais pas sur une sortie d'effectif RH.
     */
    activeOverride: v.optional(v.boolean()),
    /** Durée mensuelle de travail du dernier contrat, en heures (source RH). */
    monthlyHours: v.optional(v.number()),
    createdBy: v.string(),
    createdAt: v.number(),
  }).index("by_hrEmployee", ["hrEmployeeId"]),

  polyvalentWorkerSchedules: defineTable({
    workerId: v.id("polyvalentWorkers"),
    availability: v.array(v.object({
      weekday: v.number(),
      start: v.string(),
      end: v.string(),
    })),
  }).index("by_worker", ["workerId"]),

  /** Règles hebdomadaires durables : elles restent actives jusqu'à annulation. */
  polyvalentTaskRecurrences: defineTable({
    taskId: v.id("polyvalentTasks"),
    workerId: v.optional(v.id("polyvalentWorkers")),
    slots: v.array(v.object({ weekday: v.number(), start: v.string(), end: v.string() })),
    /** @deprecated La charge d'un créneau est la durée du créneau. */
    plannedHours: v.optional(v.number()),
    /** @deprecated La recyclerie vient désormais de la tâche. */
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    createdBy: v.string(),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_worker", ["workerId"]),

  polyvalentActivities: defineTable({
    taskId: v.id("polyvalentTasks"),
    /** Une tâche peut être planifiée avant qu'un salarié lui soit affecté. */
    workerId: v.optional(v.id("polyvalentWorkers")),
    /** Début et fin du créneau, en millisecondes epoch (date + heure). */
    startAt: v.number(),
    endAt: v.number(),
    /** @deprecated La charge d'un créneau est la durée du créneau. */
    plannedHours: v.optional(v.number()),
    /** @deprecated La recyclerie vient désormais de la tâche. */
    site: v.optional(v.union(v.literal("60"), v.literal("76"))),
    createdBy: v.string(),
    createdAt: v.number(),
  })
    .index("by_worker", ["workerId"])
    .index("by_task", ["taskId"])
    .index("by_startAt", ["startAt"]),

  // ───────────────────────────── App « Bâtire » ─────────────────────────────
  // Matériaux de construction de seconde main : catalogue, boutique en ligne,
  // vitrine kiosque et demandes clients. Tables préfixées `bt`, distinctes des
  // `articles` de la Recyclerie — un matériau se vend au mètre cube ou à la
  // tonne, se stocke sur palette et porte des caractéristiques techniques
  // qu'un objet de brocante n'a pas.

  btMaterials: defineTable({
    title: v.string(),
    description: v.string(),
    /** Niveau 1 de l'arborescence. */
    category: v.string(),
    /** Niveau 2 : famille. */
    family: v.optional(v.string()),
    /** Niveau 3 : sous-famille. */
    subcategory: v.optional(v.string()),
    condition: btCondition,
    /** Unité de vente : c'est elle qui donne son sens au prix et au stock. */
    unit: btUnit,
    /** Stock disponible, exprimé dans l'unité de vente. */
    quantity: v.number(),
    /** Prix pour UNE unité de vente (un m³, une tonne, une palette…). */
    price: v.number(),
    /** Prix barré : le neuf équivalent, pour situer l'économie du réemploi. */
    originalPrice: v.optional(v.number()),
    /** Conditionnement : « palette de 60 sacs », « botte de 10 ». */
    packaging: v.optional(v.string()),
    /** Dimensions en centimètres, quand elles ont un sens pour le matériau. */
    lengthCm: v.optional(v.number()),
    widthCm: v.optional(v.number()),
    heightCm: v.optional(v.number()),
    thicknessMm: v.optional(v.number()),
    weightKg: v.optional(v.number()),
    brand: v.optional(v.string()),
    /** Référence fabricant ou modèle lu sur l'étiquette. */
    modelReference: v.optional(v.string()),
    /** Matière : bois, béton, acier, PVC, aluminium, plâtre, terre cuite… */
    material: v.optional(v.string()),
    color: v.optional(v.string()),
    /** Normes et certifications visibles : CE, NF, A+, classe d'emploi… */
    standards: v.optional(v.string()),
    /** Caractéristiques techniques libres : lambda, résistance, section… */
    technicalNotes: v.optional(v.string()),
    /** Dépôt où le matériau est entreposé. */
    depot: v.optional(v.string()),
    /** Emplacement précis dans le dépôt : « allée B3 », « extérieur ». */
    location: v.optional(v.string()),
    photos: v.array(v.id("_storage")),
    status: btMaterialStatus,
    /** Publié dans la boutique en ligne (distinct du statut de stock). */
    published: v.optional(v.boolean()),
    publishedAt: v.optional(v.number()),
    featured: v.optional(v.boolean()),
    /** Référence du QR code collé sur le matériau. */
    qrReference: v.optional(v.string()),

    /* ── Fiche réemploi ───────────────────────────────────────────────────
     *
     * Champs du diagnostic PEMD attendus par les maîtres d'ouvrage et les
     * plateformes de réemploi. Tous facultatifs : une fiche reste publiable
     * sans eux, ils se complètent au fil du diagnostic.
     */

    /** Référence interne du matériau, propre au dépôt. */
    reference: v.optional(v.string()),
    /** Provenance : reconditionné, occasion réemploi, surplus de chantier… */
    origin: v.optional(v.string()),
    /** Types de structures d'où vient le matériau, ou qu'il vise. */
    profiles: v.optional(v.array(v.string())),
    /**
     * Matières constitutives. `material` garde la version texte : elle est lue
     * par la recherche, la boutique et l'import Excel existants.
     */
    materials: v.optional(v.array(v.string())),
    diameterCm: v.optional(v.number()),
    /**
     * Unité dans laquelle sont exprimées longueur, largeur, hauteur et
     * diamètre. Absente = centimètres, ce qu'ont toujours voulu dire les
     * champs `…Cm` des fiches déjà saisies.
     */
    dimensionUnit: v.optional(v.string()),
    /** Fenêtre de disponibilité du lot. */
    availableFrom: v.optional(v.number()),
    availableUntil: v.optional(v.number()),

    /* Potentiels du diagnostic, notés de 1 à 5 étoiles. */
    reusePotential: v.optional(v.number()),
    repurposePotential: v.optional(v.number()),
    recyclingPotential: v.optional(v.number()),
    recoveryPotential: v.optional(v.number()),
    disposalPotential: v.optional(v.number()),

    /** Comment le matériau est assemblé, et donc démontable. */
    assemblyMode: v.optional(v.string()),
    transportTerms: v.optional(v.string()),
    packagingTerms: v.optional(v.string()),
    storageTerms: v.optional(v.string()),
    accessTerms: v.optional(v.string()),
    /** Amiante, plomb, HAP… ce qui conditionne la reprise. */
    hazardousSubstances: v.optional(v.string()),
    typology: v.optional(v.string()),
    /** Code déchet européen à 6 chiffres. */
    wasteCode: v.optional(v.string()),
    /** Bilan carbone en kg CO₂ équivalent. */
    carbonFootprintKg: v.optional(v.number()),
    /** Coût de mise en décharge évité, en euros. */
    landfillCost: v.optional(v.number()),
    /** Fiche technique jointe (PDF ou document). */
    datasheet: v.optional(v.id("_storage")),
    datasheetName: v.optional(v.string()),
    /** Commentaire d'équipe, jamais publié. */
    internalNote: v.optional(v.string()),

    aiConfidence: v.optional(v.number()),
    aiNotes: v.optional(v.string()),
    /** Date d'envoi des alertes « je recherche » : elles ne partent qu'une fois. */
    searchAlertsSentAt: v.optional(v.number()),
    createdBy: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_published", ["published"])
    .index("by_category", ["category"])
    .index("by_qrReference", ["qrReference"])
    .index("by_createdAt", ["createdAt"]),

  /**
   * Valeurs ajoutées par l'équipe aux listes fermées de Bâtire (matières, pour
   * l'instant). Une table plutôt qu'un champ libre : une matière saisie par
   * l'un doit être proposée à tous, sinon la liste diverge d'un poste à
   * l'autre et le filtrage de la boutique ne veut plus rien dire.
   */
  btOptions: defineTable({
    /** Liste visée : « material » aujourd'hui, d'autres si le besoin vient. */
    kind: v.string(),
    value: v.string(),
    createdBy: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_kind", ["kind"]),

  btRequests: defineTable({
    reference: v.string(),
    type: btRequestType,
    customer: v.object({
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      phone: v.string(),
      company: v.optional(v.string()),
    }),
    /** Matériaux visés. Vide pour une demande de reprise ou une question. */
    items: v.array(
      v.object({
        materialId: v.optional(v.id("btMaterials")),
        title: v.string(),
        quantity: v.number(),
        unit: btUnit,
      }),
    ),
    message: v.optional(v.string()),
    /** Photos jointes : indispensables pour une proposition de reprise. */
    photos: v.optional(v.array(v.id("_storage"))),
    outcome: btRequestOutcome,
    /** Suivi interne, non visible du client. */
    internalNotes: v.optional(v.string()),
    depot: v.optional(v.string()),
    /** Compte client Clerk rattaché, si la demande vient d'un utilisateur connu. */
    userId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_outcome", ["outcome"])
    .index("by_reference", ["reference"])
    .index("by_createdAt", ["createdAt"]),

  /** Ventes Bâtire : paiement en ligne (boutique) ou au terminal (kiosque). */
  btOrders: defineTable({
    reference: v.string(),
    materialId: v.id("btMaterials"),
    materialTitle: v.string(),
    quantity: v.number(),
    unit: btUnit,
    /** Prix unitaire au moment de la vente : le catalogue peut changer après. */
    unitPrice: v.number(),
    /** Montant total en centimes, tel qu'encaissé par Stripe. */
    amountCents: v.number(),
    customer: v.object({
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      phone: v.optional(v.string()),
      company: v.optional(v.string()),
    }),
    /** Lieu choisi par le client pour récupérer sa commande en boutique. */
    pickupLocation: v.optional(
      v.union(
        v.literal("usine_agile"),
        v.literal("comptoir_c"),
        v.literal("recyclerie_pays_de_bray"),
        v.literal("esspace_150"),
      ),
    ),
    channel: v.union(v.literal("boutique"), v.literal("terminal")),
    status: v.union(v.literal("en_attente"), v.literal("payee"), v.literal("annulee")),
    stripeSessionId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    paidAt: v.optional(v.number()),
    userId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_reference", ["reference"])
    .index("by_material", ["materialId"])
    .index("by_stripeSession", ["stripeSessionId"]),

  /**
   * Messagerie Bâtire : un fil par client et par matériau.
   *
   * Négocier une reprise ou organiser un enlèvement se fait en quelques
   * échanges ; les rattacher au matériau évite de chercher de quoi on parle.
   */
  btMessages: defineTable({
    /** Fil = matériau + client. Un matériau retiré garde son historique. */
    materialId: v.optional(v.id("btMaterials")),
    materialTitle: v.string(),
    /** Identifiant Clerk du client : c'est lui qui identifie le fil. */
    clientId: v.string(),
    clientName: v.string(),
    clientEmail: v.string(),
    body: v.string(),
    /** Vrai si le message vient de l'équipe. */
    fromStaff: v.boolean(),
    authorName: v.string(),
    readByStaff: v.optional(v.boolean()),
    readByClient: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_client", ["clientId"])
    .index("by_material", ["materialId"])
    .index("by_createdAt", ["createdAt"]),

  /**
   * Dernier encaissement tenté au terminal pour un article de la vitrine.
   *
   * L'écran du kiosque n'a aucun moyen de savoir ce qui se passe sur le
   * lecteur, tenu par l'équipe : cette trace lui sert d'accusé de réception.
   * Une ligne par article, réécrite à chaque tentative.
   */
  kioskTerminalPayments: defineTable({
    articleId: v.id("articles"),
    status: v.union(v.literal("en_cours"), v.literal("payee"), v.literal("refusee")),
    /** Message d'échec de Stripe, affiché tel quel au client. */
    message: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_article", ["articleId"]),

  /**
   * « Je recherche » : ce qu'un client attend et que le dépôt n'a pas encore.
   *
   * Une recherche vise une branche du catalogue (catégorie, éventuellement
   * affinée) et s'éteint d'elle-même à sa date de fin. Un matériau mis en ligne
   * APRÈS la recherche déclenche un email ; le stock déjà présent, non — le
   * client vient de le parcourir.
   */
  btSearchAlerts: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    category: v.string(),
    family: v.optional(v.string()),
    subcategory: v.optional(v.string()),
    /** Fin de la recherche. Absente = tant que le client ne l'arrête pas. */
    until: v.optional(v.number()),
    /** Dernière notification envoyée, pour l'afficher au client. */
    lastNotifiedAt: v.optional(v.number()),
    matchCount: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_category", ["category"]),

  /** QR codes imprimés à l'avance, collés sur les matériaux à leur arrivée. */
  btQrCodes: defineTable({
    reference: v.string(),
    materialId: v.optional(v.id("btMaterials")),
    createdBy: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_reference", ["reference"])
    .index("by_material", ["materialId"]),

  /**
   * Espace client Bâtire : la fiche donateur d'une entreprise.
   *
   * Les mêmes coordonnées repartaient à chaque achat et à chaque proposition
   * de don. Elles vivent ici une fois pour toutes, rattachées au compte Clerk,
   * et alimentent le formulaire d'achat comme celui de don.
   */
  btDonorProfiles: defineTable({
    clerkId: v.string(),
    /** Raison sociale. Une personne seule peut laisser le champ vide. */
    company: v.optional(v.string()),
    siret: v.optional(v.string()),
    /** Code APE (NAF) de l'entreprise : « 4399C », « 4120A »… */
    apeCode: v.optional(v.string()),
    /** Type de donateur : mêmes valeurs que l'« Origine » d'une fiche matériau. */
    profiles: v.optional(v.array(v.string())),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
    postalCode: v.optional(v.string()),
    city: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_clerkId", ["clerkId"]),

  /**
   * Dons proposés depuis la boutique par les entreprises.
   *
   * Un don est un lot : ce que le donateur décrit et photographie en une fois.
   * L'équipe l'accepte — le donateur reçoit les conditions de dépôt — ou le
   * refuse avec un motif, qui part tel quel dans l'email.
   */
  btDonations: defineTable({
    reference: v.string(),
    /** Compte Clerk du donateur : c'est lui qui suit son don. */
    clerkId: v.string(),
    /** Coordonnées figées au moment du dépôt : la fiche donateur peut changer. */
    donor: v.object({
      company: v.optional(v.string()),
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      phone: v.optional(v.string()),
      profiles: v.optional(v.array(v.string())),
      address: v.optional(v.string()),
      postalCode: v.optional(v.string()),
      city: v.optional(v.string()),
    }),
    title: v.string(),
    description: v.optional(v.string()),
    category: v.string(),
    family: v.optional(v.string()),
    subcategory: v.optional(v.string()),
    condition: v.optional(btCondition),
    quantity: v.optional(v.number()),
    unit: v.optional(btUnit),
    /** Date à partir de laquelle le lot est disponible chez le donateur. */
    availableFrom: v.optional(v.number()),
    photos: v.array(v.id("_storage")),
    /**
     * Qui déplace le lot : « depot » = le donateur l'apporte, « recuperer » =
     * l'équipe vient le chercher, et l'adresse d'enlèvement devient nécessaire.
     */
    handover: v.optional(v.union(v.literal("depot"), v.literal("recuperer"))),
    pickupAddress: v.optional(v.string()),
    pickupPostalCode: v.optional(v.string()),
    pickupCity: v.optional(v.string()),
    status: btDonationStatus,
    /** Motif du refus, ou consignes de dépôt jointes à l'acceptation. */
    decisionMessage: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    decidedBy: v.optional(v.string()),
    /** Suivi interne, jamais montré au donateur. */
    internalNote: v.optional(v.string()),
    /** Fiche matériau née de ce don, une fois le lot entré en stock. */
    materialId: v.optional(v.id("btMaterials")),
    convertedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_clerkId", ["clerkId"])
    .index("by_reference", ["reference"])
    .index("by_createdAt", ["createdAt"]),
  },
  { schemaValidation: false },
);

/**
 * Définition des process (étapes séquentielles) par type de demande.
 * Partagé par les mutations Convex pour résoudre et valider l'avancement.
 */

export const STEP = {
  contact: "Contact pris",
  devisEdite: "Devis édité",
  devisSigne: "Devis signé",
  prestaPlanifiee: "Prestation planifiée",
  prestaTerminee: "Prestation terminée",
  factureEditee: "Facture éditée",
  factureReglee: "Facture réglée",
  // Livraison
  acompteVerse: "Acompte versé",
  // Dépôt en recyclerie
  rdvConfirme: "Rendez-vous confirmé",
  depotRealise: "Dépôt réalisé",
  // Boutique : la commande est réglée, reste à savoir si le client l'a retirée.
  paiementValide: "Paiement validé",
  retraitEffectue: "Retrait effectué",
} as const;

/** Process complet à 7 étapes (aérogommage, collecte C2/C3, vélo par défaut). */
const FULL = [
  STEP.contact,
  STEP.devisEdite,
  STEP.devisSigne,
  STEP.prestaPlanifiee,
  STEP.prestaTerminee,
  STEP.factureEditee,
  STEP.factureReglee,
];

/**
 * Vrai quand la dernière étape cochée est « Facture éditée » et que l'étape
 * suivante est « Facture réglée » : la facture attend son règlement, et la
 * compta doit être prévenue pour venir cocher l'étape une fois encaissée.
 */
export function isAwaitingInvoicePayment(
  steps: string[],
  completedSteps: number,
): boolean {
  return (
    completedSteps > 0 &&
    steps[completedSteps - 1] === STEP.factureEditee &&
    steps[completedSteps] === STEP.factureReglee
  );
}

export type RequestType =
  | "aerogommage"
  | "collecte"
  | "article"
  | "velo"
  | "livraison"
  | "depot";

export type CollecteType = "indefini" | "C1" | "C2" | "C3";

/**
 * Résout la liste ordonnée des étapes pour une demande donnée.
 * Pour une collecte « à définir » (indefini), le process est vide tant que le
 * sous-type (C1/C2/C3) n'a pas été choisi dans le CRM.
 */
export function resolveProcess(
  type: RequestType,
  collecteType?: CollecteType,
): string[] {
  switch (type) {
    case "aerogommage":
      return [...FULL];
    case "velo":
      // TODO Cycle en Bray : process défini ultérieurement (placeholder = complet).
      return [...FULL];
    case "article":
      // Une commande boutique n'a que deux jalons : l'encaissement, puis le
      // retrait en boutique. Tant que le client n'est pas venu chercher ses
      // articles, la demande reste ouverte dans le CRM.
      return [STEP.paiementValide, STEP.retraitEffectue];
    case "livraison":
      return [STEP.acompteVerse, STEP.prestaPlanifiee, STEP.prestaTerminee];
    case "depot":
      // Le créneau est choisi par le client : le rendez-vous existe déjà, il
      // reste à le confirmer puis à constater le dépôt.
      return [STEP.rdvConfirme, STEP.depotRealise];
    case "collecte":
      switch (collecteType) {
        case "C1":
          return [STEP.contact, STEP.prestaPlanifiee, STEP.prestaTerminee];
        case "C2":
        case "C3":
          return [...FULL];
        default:
          return [];
      }
  }
}

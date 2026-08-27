import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Rappels contrôle technique / pollution des véhicules (J-30, J-15, J-5, J-1),
// tous les jours à 05:00 UTC (06h/07h à Paris selon la saison).
crons.daily(
  "rappels controles vehicules",
  { hourUTC: 5, minuteUTC: 0 },
  internal.vehicleControlReminders.sendControlReminders,
);

crons.hourly(
  "emails retour reservations vehicules",
  { minuteUTC: 10 },
  internal.reservations.requestVehicleFeedbackForPastReservations,
);

crons.hourly(
  "emails retour reservations salles",
  { minuteUTC: 25 },
  internal.reservations.requestRoomFeedbackForPastReservations,
);

// Prévenance de fin de contrat RH : à J-22, J-15 et J-3 de l'échéance du
// dernier contrat du salarié, aux responsables de sa structure.
crons.daily(
  "prevenance fin de contrat rh",
  { hourUTC: 5, minuteUTC: 30 },
  internal.hrContractNotices.sendContractEndNotices,
);

// Équipe Recyclerie : miroir quotidien des salariés RH des structures
// Recyclerie 60 / 76 (une fin de contrat rend le salarié inactif).
crons.daily(
  "synchronisation equipe recyclerie rh",
  { hourUTC: 4, minuteUTC: 45 },
  internal.polyvalents.syncFromHrDaily,
);

// Rappel J-1 aux clients qui ont réservé un créneau de dépôt en recyclerie.
crons.daily(
  "rappel depot recyclerie",
  { hourUTC: 7, minuteUTC: 0 },
  internal.requests.sendDepotReminders,
);

// Alerte Klyd : article sur Vinted depuis 3 semaines et toujours non gagné.
crons.daily(
  "alerte klyd vinted 3 semaines",
  { hourUTC: 6, minuteUTC: 0 },
  internal.klyde.sendVintedAlerts,
);

// Filet de sécurité du catalogue Stripe : chaque écriture sur un article
// planifie déjà sa synchronisation, mais un statut peut changer par un chemin
// qui ne la déclenche pas. On repousse ici, chaque nuit, ce qui a dérivé.
crons.daily(
  "synchronisation catalogue stripe",
  { hourUTC: 3, minuteUTC: 20 },
  internal.stripeCatalog.reconcile,
);

// Boîte Gmail Vinted de Klyd : import des ventes, bordereaux et virements.
// Toutes les heures — Vinted n'a pas d'API, l'email est la seule source.
crons.hourly(
  "import emails vinted klyd",
  { minuteUTC: 40 },
  internal.klydeGmail.syncAll,
);

export default crons;

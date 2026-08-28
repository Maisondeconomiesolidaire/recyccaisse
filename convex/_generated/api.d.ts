/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as arrivages from "../arrivages.js";
import type * as articleQrCodes from "../articleQrCodes.js";
import type * as articles from "../articles.js";
import type * as ateliers from "../ateliers.js";
import type * as batire from "../batire.js";
import type * as bennespro from "../bennespro.js";
import type * as bennesproClientVehicles from "../bennesproClientVehicles.js";
import type * as bennesproProfiles from "../bennesproProfiles.js";
import type * as bikes from "../bikes.js";
import type * as caisses from "../caisses.js";
import type * as clerkMigration from "../clerkMigration.js";
import type * as clients from "../clients.js";
import type * as community from "../community.js";
import type * as crmClients from "../crmClients.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as discountCodes from "../discountCodes.js";
import type * as documents from "../documents.js";
import type * as emails from "../emails.js";
import type * as equipements from "../equipements.js";
import type * as feedback from "../feedback.js";
import type * as files from "../files.js";
import type * as fleet from "../fleet.js";
import type * as gotravaux from "../gotravaux.js";
import type * as hrContractNotices from "../hrContractNotices.js";
import type * as http from "../http.js";
import type * as importLegacy from "../importLegacy.js";
import type * as kiosk from "../kiosk.js";
import type * as klyde from "../klyde.js";
import type * as klydeGmail from "../klydeGmail.js";
import type * as klydeInvoices from "../klydeInvoices.js";
import type * as klydeReports from "../klydeReports.js";
import type * as klydeTaxonomy from "../klydeTaxonomy.js";
import type * as leaves from "../leaves.js";
import type * as lib from "../lib.js";
import type * as livraison from "../livraison.js";
import type * as mesoutilsEmails from "../mesoutilsEmails.js";
import type * as mesoutilsNotifications from "../mesoutilsNotifications.js";
import type * as messages from "../messages.js";
import type * as notifications from "../notifications.js";
import type * as paymentLinks from "../paymentLinks.js";
import type * as pdf from "../pdf.js";
import type * as permissions from "../permissions.js";
import type * as pointeuse from "../pointeuse.js";
import type * as points from "../points.js";
import type * as polyvalents from "../polyvalents.js";
import type * as posts from "../posts.js";
import type * as processes from "../processes.js";
import type * as requestAnalysis from "../requestAnalysis.js";
import type * as requests from "../requests.js";
import type * as reservations from "../reservations.js";
import type * as rh from "../rh.js";
import type * as sorties from "../sorties.js";
import type * as stripe from "../stripe.js";
import type * as stripeCatalog from "../stripeCatalog.js";
import type * as team from "../team.js";
import type * as terminal from "../terminal.js";
import type * as users from "../users.js";
import type * as vehicleControlReminders from "../vehicleControlReminders.js";
import type * as vehicleRemarkAnalysis from "../vehicleRemarkAnalysis.js";
import type * as ventes from "../ventes.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  arrivages: typeof arrivages;
  articleQrCodes: typeof articleQrCodes;
  articles: typeof articles;
  ateliers: typeof ateliers;
  batire: typeof batire;
  bennespro: typeof bennespro;
  bennesproClientVehicles: typeof bennesproClientVehicles;
  bennesproProfiles: typeof bennesproProfiles;
  bikes: typeof bikes;
  caisses: typeof caisses;
  clerkMigration: typeof clerkMigration;
  clients: typeof clients;
  community: typeof community;
  crmClients: typeof crmClients;
  crons: typeof crons;
  dashboard: typeof dashboard;
  discountCodes: typeof discountCodes;
  documents: typeof documents;
  emails: typeof emails;
  equipements: typeof equipements;
  feedback: typeof feedback;
  files: typeof files;
  fleet: typeof fleet;
  gotravaux: typeof gotravaux;
  hrContractNotices: typeof hrContractNotices;
  http: typeof http;
  importLegacy: typeof importLegacy;
  kiosk: typeof kiosk;
  klyde: typeof klyde;
  klydeGmail: typeof klydeGmail;
  klydeInvoices: typeof klydeInvoices;
  klydeReports: typeof klydeReports;
  klydeTaxonomy: typeof klydeTaxonomy;
  leaves: typeof leaves;
  lib: typeof lib;
  livraison: typeof livraison;
  mesoutilsEmails: typeof mesoutilsEmails;
  mesoutilsNotifications: typeof mesoutilsNotifications;
  messages: typeof messages;
  notifications: typeof notifications;
  paymentLinks: typeof paymentLinks;
  pdf: typeof pdf;
  permissions: typeof permissions;
  pointeuse: typeof pointeuse;
  points: typeof points;
  polyvalents: typeof polyvalents;
  posts: typeof posts;
  processes: typeof processes;
  requestAnalysis: typeof requestAnalysis;
  requests: typeof requests;
  reservations: typeof reservations;
  rh: typeof rh;
  sorties: typeof sorties;
  stripe: typeof stripe;
  stripeCatalog: typeof stripeCatalog;
  team: typeof team;
  terminal: typeof terminal;
  users: typeof users;
  vehicleControlReminders: typeof vehicleControlReminders;
  vehicleRemarkAnalysis: typeof vehicleRemarkAnalysis;
  ventes: typeof ventes;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

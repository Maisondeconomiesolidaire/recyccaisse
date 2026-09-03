import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    STRIPE_SECRET_KEY: v.optional(v.string()),
    /** Clé Stripe de la boutique en ligne Recycapp (paiement client). */
    RECYCAPP_STRIPE_SECRET_KEY: v.optional(v.string()),
    /** Secret de signature du webhook Stripe de la boutique (whsec_…). */
    RECYCAPP_STRIPE_WEBHOOK_SECRET: v.optional(v.string()),
    BENNESPRO_STRIPE_SECRET_KEY: v.optional(v.string()),
    BENNESPRO_STRIPE_TVA_TAX_RATE_ID: v.optional(v.string()),
    BENNESPRO_EMAIL_LOGO_ID: v.optional(v.string()),
    MAPBOX_ACCESS_TOKEN: v.optional(v.string()),
    STAFF_EMAILS: v.optional(v.string()),
    ADMIN_EMAILS: v.optional(v.string()),
    CLERK_DEV_SECRET_KEY: v.optional(v.string()),
    CLERK_SECRET_KEY: v.optional(v.string()),
    CLERK_PROD_SECRET_KEY: v.optional(v.string()),
    APP_URL: v.optional(v.string()),
    MESOUTILS_APP_URL: v.optional(v.string()),
    CONVEX_SITE_URL: v.optional(v.string()),
    EMAIL_LOGO_ID: v.optional(v.string()),
    OPENAI_API_KEY: v.optional(v.string()),
    OPENAI_REQUEST_ANALYSIS_MODEL: v.optional(v.string()),
    /**
     * Modèle de vision qui remplit les fiches matériaux de Bâtire. Réglable
     * sans redéploiement : c'est le principal levier sur la qualité des
     * fiches, et il doit pouvoir suivre les sorties d'OpenAI.
     */
    BATIRE_ANALYSIS_MODEL: v.optional(v.string()),
    /** OAuth Google (client « Application Web ») — boîte Gmail Vinted de Klyd. */
    GOOGLE_CLIENT_ID: v.optional(v.string()),
    GOOGLE_CLIENT_SECRET: v.optional(v.string()),
    /** URL publique de Klyd : retour de l'utilisateur après le consentement. */
    KLYDE_APP_URL: v.optional(v.string()),
  },
});

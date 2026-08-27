const PROD_ISSUER_FALLBACK = "https://clerk.groupemes.fr";

export default {
  providers: [
    {
      domain: (process.env.CLERK_JWT_ISSUER_DOMAIN ?? PROD_ISSUER_FALLBACK).trim(),
      applicationID: "convex",
    },
  ],
};

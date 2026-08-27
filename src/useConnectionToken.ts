import { useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";

/**
 * Jeton de connexion du SDK Terminal.
 *
 * Le SDK l'appelle tout seul, à la connexion au lecteur puis chaque fois qu'il
 * doit se réauthentifier. Le secret est fabriqué côté Convex, jamais ici : il
 * donne accès à tous les lecteurs du compte Stripe.
 */
export function useConnectionToken() {
  const connectionToken = useAction(api.terminal.connectionToken);
  return useCallback(async () => {
    const { secret } = await connectionToken({});
    return secret;
  }, [connectionToken]);
}

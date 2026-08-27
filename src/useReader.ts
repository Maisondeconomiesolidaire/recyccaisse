import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, PermissionsAndroid } from "react-native";
import { useStripeTerminal, type Reader } from "@stripe/stripe-terminal-react-native";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";

/**
 * Lecteur BBPOS WisePad 3, apparié en Bluetooth.
 *
 * Stripe impose la localisation pour encaisser au terminal (obligation
 * réglementaire, pas un confort), et Android exige en plus les permissions
 * Bluetooth depuis la version 12. Sans elles, la découverte ne renvoie jamais
 * rien — d'où la demande explicite avant tout scan.
 */
async function requestAndroidPermissions() {
  if (Platform.OS !== "android") return true;
  const wanted = [
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
  ].filter(Boolean) as string[];
  const granted = await PermissionsAndroid.requestMultiple(wanted as never);
  return Object.values(granted).every((state) => state === "granted");
}

export function useReader() {
  const {
    discoverReaders,
    connectReader,
    connectedReader,
    discoveredReaders,
    initialize,
  } = useStripeTerminal();
  const listLocations = useAction(api.terminal.locations);
  const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void initialize?.();
  }, [initialize]);

  useEffect(() => {
    if (connectedReader) {
      setStatus("ready");
      setError(null);
    }
  }, [connectedReader]);

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    try {
      if (!(await requestAndroidPermissions())) {
        throw new Error(
          "Autorisations refusées : Bluetooth et localisation sont nécessaires pour encaisser.",
        );
      }
      const locations = await listLocations({});
      const locationId = locations[0]?.id;
      if (!locationId) {
        throw new Error(
          "Aucun emplacement Terminal dans le compte Stripe. Créez-en un dans le Dashboard (Terminal → Emplacements).",
        );
      }

      const discovery = await discoverReaders({ discoveryMethod: "bluetoothScan", timeout: 20 });
      if (discovery.error) throw new Error(discovery.error.message);

      // `discoverReaders` alimente `discoveredReaders` au fil de l'eau : on
      // laisse au SDK le temps de publier au moins un lecteur avant d'abandonner.
      const reader = await waitForReader(() => discoveredReaders);
      if (!reader) {
        throw new Error(
          "Aucun lecteur trouvé. Allumez le WisePad 3 et gardez-le à moins d'un mètre.",
        );
      }

      const connection = await connectReader({
        discoveryMethod: "bluetoothScan",
        reader,
        locationId,
        autoReconnectOnUnexpectedDisconnect: true,
      });
      if (connection.error) throw new Error(connection.error.message);
      setStatus("ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Connexion au lecteur impossible.");
      setStatus("error");
    }
  }, [connectReader, discoverReaders, discoveredReaders, listLocations]);

  return useMemo(
    () => ({ connectedReader, connect, status, error }),
    [connectedReader, connect, status, error],
  );
}

/** Attend qu'un lecteur apparaisse dans la liste publiée par le SDK. */
async function waitForReader(
  read: () => Reader.Type[],
  attempts = 20,
): Promise<Reader.Type | undefined> {
  for (let index = 0; index < attempts; index++) {
    const [first] = read();
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

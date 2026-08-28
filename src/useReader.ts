import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, PermissionsAndroid } from "react-native";
import { useStripeTerminal, type Reader } from "@stripe/stripe-terminal-react-native";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";

/**
 * Lecteur BBPOS WisePad 3, en Bluetooth.
 *
 * ⚠️ Le lecteur ne doit PAS être appairé dans les réglages Bluetooth d'Android :
 * Stripe est formel, un lecteur appairé au système devient invisible pour le
 * SDK. C'est l'app qui découvre et connecte le lecteur elle-même.
 *
 * Stripe impose par ailleurs la localisation pour encaisser au terminal
 * (obligation réglementaire, pas un confort), et Android exige les permissions
 * Bluetooth depuis la version 12. Sans elles, la découverte ne renvoie rien.
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
  // Les lecteurs arrivent par la callback du SDK, au fil du scan. Un `useRef`
  // les rend lisibles depuis la boucle d'attente, qu'un état React laisserait
  // figée sur la valeur du rendu où elle a démarré.
  const readers = useRef<Reader.Type[]>([]);
  const [found, setFound] = useState<Reader.Type[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const { discoverReaders, connectReader, connectedReader, initialize } = useStripeTerminal({
    onUpdateDiscoveredReaders: (discovered) => {
      readers.current = discovered;
      setFound(discovered);
    },
    // Une mise à jour obligatoire du microprogramme peut durer plusieurs
    // minutes : sans ces messages, l'app paraîtrait bloquée.
    onDidStartInstallingUpdate: () => setProgress("Mise à jour du lecteur : 0 %"),
    onDidReportReaderSoftwareUpdateProgress: (value) =>
      setProgress(`Mise à jour du lecteur : ${Math.round(Number(value) * 100)} %`),
    onDidFinishInstallingUpdate: () => setProgress(null),
  });

  const listLocations = useAction(api.terminal.locations);

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
    readers.current = [];
    setFound([]);
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

      const reader = await waitForReader(readers);
      if (!reader) {
        throw new Error(
          "Aucun lecteur trouvé. Vérifiez que le WisePad 3 est allumé, à moins d'un mètre, et qu'il n'est PAS appairé dans les réglages Bluetooth d'Android : un lecteur appairé au système est invisible pour l'application.",
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
  }, [connectReader, discoverReaders, listLocations]);

  return { connectedReader, connect, status, error, progress, found };
}

/** Attend qu'un lecteur apparaisse dans les résultats publiés par le SDK. */
async function waitForReader(
  readers: { current: Reader.Type[] },
  attempts = 40,
): Promise<Reader.Type | undefined> {
  for (let index = 0; index < attempts; index++) {
    const [first] = readers.current;
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

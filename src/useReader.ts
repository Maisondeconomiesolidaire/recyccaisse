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
type PermissionCheck = { granted: boolean; missing: string[]; blocked: boolean };

/** Libellés côté réglages Android, pour dire précisément ce qui manque. */
const PERMISSION_LABELS: Record<string, string> = {
  "android.permission.ACCESS_FINE_LOCATION": "Localisation précise",
  "android.permission.BLUETOOTH_CONNECT": "Appareils à proximité (connexion)",
  "android.permission.BLUETOOTH_SCAN": "Appareils à proximité (recherche)",
};

async function requestAndroidPermissions(): Promise<PermissionCheck> {
  if (Platform.OS !== "android") return { granted: true, missing: [], blocked: false };

  // BLUETOOTH_SCAN et BLUETOOTH_CONNECT n'existent qu'à partir d'Android 12
  // (API 31). Les demander plus bas renvoie « denied » pour une permission
  // inexistante, et ferait échouer un appareil pourtant correctement réglé.
  const required = [
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ...(Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        ]
      : []),
  ].filter(Boolean) as string[];

  const missing: string[] = [];
  for (const permission of required) {
    if (await PermissionsAndroid.check(permission as never)) continue;
    missing.push(permission);
  }
  if (missing.length === 0) return { granted: true, missing: [], blocked: false };

  const results = await PermissionsAndroid.requestMultiple(missing as never[]);
  const refused = Object.entries(results).filter(([, state]) => state !== "granted");
  // « never_ask_again » : Android n'affichera plus la demande, il faut passer
  // par les réglages de l'application.
  const blocked = refused.some(([, state]) => state === "never_ask_again");
  return {
    granted: refused.length === 0,
    missing: refused.map(([permission]) => PERMISSION_LABELS[permission] ?? permission),
    blocked,
  };
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
      const permissions = await requestAndroidPermissions();
      if (!permissions.granted) {
        throw new Error(
          `Autorisation manquante : ${permissions.missing.join(", ")}.` +
            (permissions.blocked
              ? " Android ne la redemandera plus : ouvrez Paramètres › Applications › Recyc Caisse › Autorisations pour l'accorder."
              : " Stripe l'exige pour encaisser au terminal.") +
            " À ne pas confondre avec les interrupteurs Bluetooth et localisation du téléphone, qui doivent aussi être allumés.",
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

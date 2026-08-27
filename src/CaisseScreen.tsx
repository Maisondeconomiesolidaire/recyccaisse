import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useStripeTerminal } from "@stripe/stripe-terminal-react-native";
import { useAction, useConvex } from "convex/react";
import { useAuth } from "@clerk/clerk-expo";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { theme } from "./theme";
import { useReader } from "./useReader";

type ScannedArticle = {
  _id: Id<"articles">;
  title: string;
  price: number;
  imageUrl: string | null;
  available: boolean;
};

type Step = "scan" | "customer" | "payment" | "done";

/** Le QR code de la vitrine encode l'URL d'achat : on n'en garde que l'article. */
function articleIdFromQr(value: string): string | null {
  const match = value.trim().match(/\/acheter\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

function euros(amount: number) {
  return amount.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
}

export function CaisseScreen() {
  const convex = useConvex();
  const { signOut } = useAuth();
  const reader = useReader();
  const { retrievePaymentIntent, collectPaymentMethod, confirmPaymentIntent } =
    useStripeTerminal();
  const startPayment = useAction(api.terminal.startPayment);
  const finalizePayment = useAction(api.terminal.finalizePayment);

  const [permission, requestPermission] = useCameraPermissions();
  const [step, setStep] = useState<Step>("scan");
  const [article, setArticle] = useState<ScannedArticle | null>(null);
  const [mode, setMode] = useState<"existing" | "new" | null>(null);
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep("scan");
    setArticle(null);
    setMode(null);
    setEmail("");
    setFirstName("");
    setLastName("");
    setPhone("");
    setError(null);
    setBusy(null);
  }, []);

  const onScan = useCallback(
    async ({ data }: { data: string }) => {
      if (busy || step !== "scan") return;
      const articleId = articleIdFromQr(data);
      if (!articleId) {
        setError("Ce QR code n'est pas celui d'un article de la vitrine.");
        return;
      }
      setBusy("scan");
      setError(null);
      try {
        const found = await convex.query(api.terminal.scannedArticle, {
          articleId: articleId as Id<"articles">,
        });
        if (!found) throw new Error("Article introuvable.");
        if (!found.available) throw new Error(`« ${found.title} » n'est plus disponible.`);
        if (found.price == null) throw new Error(`« ${found.title} » n'a pas de prix.`);
        setArticle(found as ScannedArticle);
        setStep("customer");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Lecture impossible.");
      } finally {
        setBusy(null);
      }
    },
    [busy, convex, step],
  );

  /** Reprend les coordonnées d'un client connu, pour ne pas les ressaisir. */
  const lookupCustomer = useCallback(async () => {
    setBusy("lookup");
    setError(null);
    try {
      const known = await convex.query(api.terminal.knownCustomer, { email: email.trim() });
      if (!known) {
        setError("Aucun client connu à cette adresse. Utilisez « Nouveau client ».");
        return;
      }
      setFirstName(known.firstName);
      setLastName(known.lastName);
      setPhone(known.phone);
      await pay(known.email, known.firstName, known.lastName, known.phone);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Recherche impossible.");
    } finally {
      setBusy(null);
    }
  }, [convex, email]);

  /**
   * Encaissement : le montant est verrouillé côté serveur, le lecteur collecte
   * la carte, puis la commande n'est enregistrée qu'après relecture du statut
   * chez Stripe.
   */
  const pay = useCallback(
    async (
      customerEmail: string,
      customerFirst: string,
      customerLast: string,
      customerPhone: string,
    ) => {
      if (!article) return;
      if (!reader.connectedReader) {
        setError("Connectez d'abord le lecteur.");
        return;
      }
      setStep("payment");
      setBusy("payment");
      setError(null);
      try {
        const prepared = await startPayment({
          articleId: article._id,
          email: customerEmail,
          firstName: customerFirst,
          lastName: customerLast,
          phone: customerPhone,
        });

        const retrieved = await retrievePaymentIntent(prepared.clientSecret);
        if (retrieved.error || !retrieved.paymentIntent) {
          throw new Error(retrieved.error?.message ?? "Paiement introuvable.");
        }
        const collected = await collectPaymentMethod({ paymentIntent: retrieved.paymentIntent });
        if (collected.error || !collected.paymentIntent) {
          throw new Error(collected.error?.message ?? "Carte non lue.");
        }
        const confirmed = await confirmPaymentIntent({ paymentIntent: collected.paymentIntent });
        if (confirmed.error) throw new Error(confirmed.error.message);

        await finalizePayment({
          draftId: prepared.draftId,
          paymentIntentId: prepared.paymentIntentId,
        });
        setStep("done");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Paiement refusé.");
        setStep("customer");
      } finally {
        setBusy(null);
      }
    },
    [
      article,
      collectPaymentMethod,
      confirmPaymentIntent,
      finalizePayment,
      reader.connectedReader,
      retrievePaymentIntent,
      startPayment,
    ],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
      <ReaderBar reader={reader} onSignOut={() => void signOut()} />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        {step === "scan" ? (
          <ScanStep
            granted={permission?.granted ?? false}
            onRequest={() => void requestPermission()}
            onScan={onScan}
            busy={busy === "scan"}
            error={error}
          />
        ) : (
          <ScrollView contentContainerStyle={{ padding: 24, gap: 18 }}>
            {article ? <ArticleCard article={article} /> : null}

            {step === "customer" ? (
              <CustomerStep
                mode={mode}
                setMode={setMode}
                email={email}
                setEmail={setEmail}
                firstName={firstName}
                setFirstName={setFirstName}
                lastName={lastName}
                setLastName={setLastName}
                phone={phone}
                setPhone={setPhone}
                busy={busy}
                onExisting={() => void lookupCustomer()}
                onNew={() => void pay(email.trim(), firstName.trim(), lastName.trim(), phone.trim())}
              />
            ) : null}

            {step === "payment" ? (
              <View style={{ alignItems: "center", gap: 14, paddingVertical: 40 }}>
                <ActivityIndicator size="large" color={theme.brand} />
                <Text style={{ color: theme.text, fontSize: 20, fontWeight: "700" }}>
                  Présentez la carte au lecteur
                </Text>
                <Text style={{ color: theme.muted, fontSize: 15, textAlign: "center" }}>
                  Sans contact, puce ou code PIN : le WisePad 3 guide le client.
                </Text>
              </View>
            ) : null}

            {step === "done" ? (
              <View style={{ alignItems: "center", gap: 16, paddingVertical: 30 }}>
                <Text style={{ fontSize: 46 }}>✅</Text>
                <Text style={{ color: theme.success, fontSize: 22, fontWeight: "800" }}>
                  Paiement encaissé
                </Text>
                <Text style={{ color: theme.muted, fontSize: 15, textAlign: "center" }}>
                  La commande est enregistrée et le reçu part par email. L'article passe en vendu.
                </Text>
                <Button label="Nouvelle vente" onPress={reset} />
              </View>
            ) : null}

            {error ? (
              <Text style={{ color: theme.danger, fontSize: 15 }}>{error}</Text>
            ) : null}

            {step !== "done" ? (
              <Pressable onPress={reset} style={{ paddingVertical: 14, alignItems: "center" }}>
                <Text style={{ color: theme.muted, fontSize: 15 }}>Annuler</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ReaderBar({
  reader,
  onSignOut,
}: {
  reader: ReturnType<typeof useReader>;
  onSignOut: () => void;
}) {
  const connected = Boolean(reader.connectedReader);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.border,
      }}
    >
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: connected ? theme.success : theme.muted,
        }}
      />
      <Text style={{ color: theme.text, fontSize: 14, flex: 1 }}>
        {connected
          ? `Lecteur ${reader.connectedReader?.serialNumber ?? ""}`
          : reader.status === "connecting"
            ? "Recherche du lecteur…"
            : "Lecteur non connecté"}
      </Text>
      {!connected ? (
        <Pressable
          onPress={() => void reader.connect()}
          disabled={reader.status === "connecting"}
          style={{
            backgroundColor: theme.surfaceAlt,
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 12,
          }}
        >
          <Text style={{ color: theme.text, fontSize: 13, fontWeight: "600" }}>Connecter</Text>
        </Pressable>
      ) : null}
      <Pressable onPress={onSignOut} style={{ paddingHorizontal: 8, paddingVertical: 8 }}>
        <Text style={{ color: theme.muted, fontSize: 13 }}>Quitter</Text>
      </Pressable>
    </View>
  );
}

function ScanStep({
  granted,
  onRequest,
  onScan,
  busy,
  error,
}: {
  granted: boolean;
  onRequest: () => void;
  onScan: (result: { data: string }) => void;
  busy: boolean;
  error: string | null;
}) {
  if (!granted) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: 30, gap: 18 }}>
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: "700", textAlign: "center" }}>
          Scannez le produit
        </Text>
        <Text style={{ color: theme.muted, fontSize: 15, textAlign: "center" }}>
          L'appareil photo sert à lire le QR code affiché sous l'article dans la vitrine.
        </Text>
        <Button label="Autoriser l'appareil photo" onPress={onRequest} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={busy ? undefined : onScan}
      />
      <View style={{ padding: 24, gap: 8 }}>
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: "800", textAlign: "center" }}>
          Scannez le produit
        </Text>
        <Text style={{ color: theme.muted, fontSize: 15, textAlign: "center" }}>
          Visez le QR code affiché sous l'article.
        </Text>
        {busy ? <ActivityIndicator color={theme.brand} /> : null}
        {error ? (
          <Text style={{ color: theme.danger, fontSize: 15, textAlign: "center" }}>{error}</Text>
        ) : null}
      </View>
    </View>
  );
}

function ArticleCard({ article }: { article: ScannedArticle }) {
  return (
    <View
      style={{
        backgroundColor: theme.surface,
        borderRadius: theme.radius,
        borderWidth: 1,
        borderColor: theme.border,
        padding: 18,
        gap: 6,
      }}
    >
      <Text style={{ color: theme.text, fontSize: 19, fontWeight: "700" }}>{article.title}</Text>
      <Text style={{ color: theme.brand, fontSize: 28, fontWeight: "900" }}>
        {euros(article.price)}
      </Text>
    </View>
  );
}

function CustomerStep({
  mode,
  setMode,
  email,
  setEmail,
  firstName,
  setFirstName,
  lastName,
  setLastName,
  phone,
  setPhone,
  busy,
  onExisting,
  onNew,
}: {
  mode: "existing" | "new" | null;
  setMode: (mode: "existing" | "new") => void;
  email: string;
  setEmail: (value: string) => void;
  firstName: string;
  setFirstName: (value: string) => void;
  lastName: string;
  setLastName: (value: string) => void;
  phone: string;
  setPhone: (value: string) => void;
  busy: string | null;
  onExisting: () => void;
  onNew: () => void;
}) {
  if (!mode) {
    return (
      <View style={{ gap: 12 }}>
        <Button label="Client existant" onPress={() => setMode("existing")} />
        <Button label="Nouveau client" variant="outline" onPress={() => setMode("new")} />
      </View>
    );
  }

  return (
    <View style={{ gap: 14 }}>
      <Field
        label="Adresse email"
        value={email}
        onValue={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder="client@exemple.fr"
      />
      {mode === "new" ? (
        <>
          <Field label="Prénom" value={firstName} onValue={setFirstName} placeholder="Jean" />
          <Field label="Nom" value={lastName} onValue={setLastName} placeholder="Dupont" />
          <Field
            label="Téléphone"
            value={phone}
            onValue={setPhone}
            keyboardType="phone-pad"
            placeholder="06 12 34 56 78"
          />
        </>
      ) : null}

      <Button
        label={busy ? "Préparation…" : "Encaisser"}
        onPress={mode === "existing" ? onExisting : onNew}
        disabled={
          Boolean(busy) ||
          !email.trim() ||
          (mode === "new" && (!firstName.trim() || !lastName.trim()))
        }
      />
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
  variant = "solid",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "solid" | "outline";
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        backgroundColor: variant === "solid" ? theme.brand : "transparent",
        borderWidth: variant === "solid" ? 0 : 1,
        borderColor: theme.border,
        borderRadius: theme.radius,
        paddingVertical: 18,
        alignItems: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: variant === "solid" ? "#fff" : theme.text,
          fontSize: 17,
          fontWeight: "700",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Field({
  label,
  value,
  onValue,
  ...input
}: {
  label: string;
  value: string;
  onValue: (value: string) => void;
} & Omit<React.ComponentProps<typeof TextInput>, "value" | "onChangeText">) {
  return (
    <View>
      <Text style={{ color: theme.muted, fontSize: 13, marginBottom: 6, fontWeight: "600" }}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onValue}
        placeholderTextColor="#52525b"
        style={{
          backgroundColor: theme.surface,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: 14,
          paddingHorizontal: 16,
          paddingVertical: 14,
          color: theme.text,
          fontSize: 16,
        }}
        {...input}
      />
    </View>
  );
}

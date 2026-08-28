import { useState } from "react";
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
import { useSignIn } from "@clerk/clerk-expo";
import { theme } from "./theme";

type Step = "email" | "password" | "code";

/** Message lisible d'une erreur Clerk, plutôt qu'un texte générique de notre cru. */
function clerkError(caught: unknown, fallback: string) {
  const errors = (caught as { errors?: Array<{ longMessage?: string; message?: string }> })?.errors;
  return errors?.[0]?.longMessage ?? errors?.[0]?.message ?? fallback;
}

/**
 * Connexion du poste, une fois pour toutes.
 *
 * L'annuaire Clerk de l'écosystème accepte deux façons d'entrer : un mot de
 * passe, ou un code reçu par email. Beaucoup de comptes ont été créés via
 * Google et n'ont donc AUCUN mot de passe — d'où le code par email proposé
 * d'emblée, et le mot de passe seulement quand le compte en possède un.
 */
export function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [hasEmailCode, setHasEmailCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Étape 1 : on demande à Clerk ce que CE compte accepte comme preuve. */
  async function identify() {
    if (!isLoaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.create({ identifier: email.trim() });
      const factors = attempt.supportedFirstFactors ?? [];
      const password = factors.some((factor) => factor.strategy === "password");
      const emailCode = factors.some((factor) => factor.strategy === "email_code");
      setHasPassword(password);
      setHasEmailCode(emailCode);
      if (password) setStep("password");
      else if (emailCode) await sendCode();
      else setError("Ce compte n'accepte ni mot de passe ni code par email.");
    } catch (caught) {
      setError(clerkError(caught, "Compte introuvable."));
    } finally {
      setBusy(false);
    }
  }

  /** Envoi du code à six chiffres sur l'adresse du compte. */
  async function sendCode() {
    if (!isLoaded) return;
    setError(null);
    try {
      const factor = signIn.supportedFirstFactors?.find(
        (item) => item.strategy === "email_code",
      );
      if (!factor || !("emailAddressId" in factor)) {
        setError("Ce compte ne peut pas recevoir de code par email.");
        return;
      }
      await signIn.prepareFirstFactor({
        strategy: "email_code",
        emailAddressId: factor.emailAddressId,
      });
      setNotice(`Code envoyé à ${email.trim()}. Il expire au bout de dix minutes.`);
      setStep("code");
    } catch (caught) {
      setError(clerkError(caught, "Envoi du code impossible."));
    }
  }

  /** Étape 2 : mot de passe ou code, selon le chemin choisi. */
  async function finish(strategy: "password" | "email_code") {
    if (!isLoaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt =
        strategy === "password"
          ? await signIn.attemptFirstFactor({ strategy: "password", password })
          : await signIn.attemptFirstFactor({ strategy: "email_code", code: code.trim() });

      if (attempt.status === "complete") {
        await setActive({ session: attempt.createdSessionId });
        return;
      }
      // Un second facteur reste à fournir : l'app ne le gère pas, autant le dire.
      setError(
        `Étape supplémentaire demandée par Clerk (${attempt.status}). Connectez ce compte depuis Mes Outils, ou utilisez un compte sans double authentification.`,
      );
    } catch (caught) {
      setError(
        clerkError(
          caught,
          strategy === "password" ? "Mot de passe incorrect." : "Code incorrect ou expiré.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    setStep("email");
    setPassword("");
    setCode("");
    setError(null);
    setNotice(null);
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: theme.background }}
    >
      <ScrollView contentContainerStyle={{ padding: 28, paddingTop: 90 }}>
        <Text style={{ color: theme.text, fontSize: 30, fontWeight: "800" }}>Caisse</Text>
        <Text style={{ color: theme.muted, fontSize: 15, marginTop: 8, lineHeight: 22 }}>
          Connectez le poste avec un compte de l'équipe. La session reste ouverte sur cette
          tablette.
        </Text>

        <View style={{ marginTop: 28, gap: 14 }}>
          <Field
            label="Adresse email"
            value={email}
            onValue={setEmail}
            editable={step === "email"}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="prenom.nom@eco-solidaire.fr"
          />

          {step === "password" ? (
            <Field
              label="Mot de passe"
              value={password}
              onValue={setPassword}
              secureTextEntry
              autoFocus
              placeholder="••••••••"
            />
          ) : null}

          {step === "code" ? (
            <Field
              label="Code reçu par email"
              value={code}
              onValue={setCode}
              keyboardType="number-pad"
              autoFocus
              placeholder="123456"
            />
          ) : null}
        </View>

        {notice ? (
          <Text style={{ color: theme.muted, marginTop: 14, fontSize: 14 }}>{notice}</Text>
        ) : null}
        {error ? (
          <Text style={{ color: theme.danger, marginTop: 14, fontSize: 14 }}>{error}</Text>
        ) : null}

        <Button
          label={step === "email" ? "Continuer" : "Se connecter"}
          busy={busy}
          disabled={
            !email.trim() ||
            (step === "password" && !password) ||
            (step === "code" && code.trim().length < 4)
          }
          onPress={() => {
            if (step === "email") void identify();
            else void finish(step === "password" ? "password" : "email_code");
          }}
        />

        {step === "password" && hasEmailCode ? (
          <Pressable onPress={() => void sendCode()} style={{ paddingVertical: 16 }}>
            <Text style={{ color: theme.brand, fontSize: 15, textAlign: "center" }}>
              Recevoir plutôt un code par email
            </Text>
          </Pressable>
        ) : null}

        {step === "code" && hasPassword ? (
          <Pressable onPress={() => setStep("password")} style={{ paddingVertical: 16 }}>
            <Text style={{ color: theme.brand, fontSize: 15, textAlign: "center" }}>
              Utiliser le mot de passe
            </Text>
          </Pressable>
        ) : null}

        {step !== "email" ? (
          <Pressable onPress={restart} style={{ paddingVertical: 8 }}>
            <Text style={{ color: theme.muted, fontSize: 14, textAlign: "center" }}>
              Changer de compte
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Button({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={{
        marginTop: 24,
        backgroundColor: theme.brand,
        borderRadius: theme.radius,
        paddingVertical: 18,
        alignItems: "center",
        opacity: disabled || busy ? 0.5 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Text style={{ color: "#fff", fontSize: 17, fontWeight: "700" }}>{label}</Text>
      )}
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
          color: input.editable === false ? theme.muted : theme.text,
          fontSize: 16,
        }}
        {...input}
      />
    </View>
  );
}

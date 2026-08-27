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

/**
 * Connexion du poste, une fois pour toutes.
 *
 * Le compte est un compte staff de l'écosystème (même annuaire Clerk que Mes
 * Outils et Recycapp) : la session reste ouverte sur la tablette, l'équipe ne
 * la ressaisit pas à chaque vente.
 */
export function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!isLoaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.create({ identifier: email.trim(), password });
      if (attempt.status === "complete") {
        await setActive({ session: attempt.createdSessionId });
      } else {
        setError("Connexion incomplète : vérifiez le compte utilisé.");
      }
    } catch (caught) {
      const message =
        (caught as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ??
        "Connexion impossible.";
      setError(message);
    } finally {
      setBusy(false);
    }
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
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="prenom.nom@eco-solidaire.fr"
          />
          <Field
            label="Mot de passe"
            value={password}
            onValue={setPassword}
            secureTextEntry
            placeholder="••••••••"
          />
        </View>

        {error ? (
          <Text style={{ color: theme.danger, marginTop: 16, fontSize: 14 }}>{error}</Text>
        ) : null}

        <Pressable
          onPress={submit}
          disabled={busy || !email.trim() || !password}
          style={{
            marginTop: 24,
            backgroundColor: theme.brand,
            borderRadius: theme.radius,
            paddingVertical: 18,
            alignItems: "center",
            opacity: busy || !email.trim() || !password ? 0.5 : 1,
          }}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={{ color: "#fff", fontSize: 17, fontWeight: "700" }}>Se connecter</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
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

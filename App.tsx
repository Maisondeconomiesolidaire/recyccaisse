import { ClerkProvider, useAuth } from "@clerk/clerk-expo";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { StripeTerminalProvider } from "@stripe/stripe-terminal-react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { convex } from "./src/convexClient";
import { tokenCache } from "./src/tokenCache";
import { CaisseScreen } from "./src/CaisseScreen";
import { SignInScreen } from "./src/SignInScreen";
import { useConnectionToken } from "./src/useConnectionToken";
import { theme } from "./src/theme";
import { View, ActivityIndicator } from "react-native";

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) {
  throw new Error(
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY manquante : copiez .env.example vers .env.local.",
  );
}

/**
 * Caisse mobile de la Recyclerie.
 *
 * Une tablette Android à l'accueil, un lecteur BBPOS WisePad 3 en Bluetooth.
 * L'équipe scanne le QR code affiché sous l'article dans la vitrine, identifie
 * le client, et le montant part sur le lecteur.
 */
export default function App() {
  return (
    <ClerkProvider publishableKey={publishableKey!} tokenCache={tokenCache}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <Root />
        </SafeAreaProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

function Root() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.background, justifyContent: "center" }}>
        <ActivityIndicator color={theme.brand} size="large" />
      </View>
    );
  }
  // Le jeton Terminal exige une session staff : on ne monte le fournisseur
  // Stripe qu'une fois connecté, sinon sa première demande de jeton échoue.
  return isSignedIn ? <TerminalRoot /> : <SignInScreen />;
}

function TerminalRoot() {
  const fetchToken = useConnectionToken();
  return (
    <StripeTerminalProvider logLevel="error" tokenProvider={fetchToken}>
      <CaisseScreen />
    </StripeTerminalProvider>
  );
}

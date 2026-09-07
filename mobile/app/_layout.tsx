import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../src/theme/theme';
import { AppText } from '../src/components/AppText';
import { AuthProvider, useAuth } from '../src/lib/auth';

/**
 * Shown when a session IS stored on this device but could not be verified yet
 * (cold start with no network). Sending a signed-in person to the sign-in
 * screen here would be wrong: their refresh token is still in the Keychain and
 * the auto-refresh ticker retries every 30s, so this clears itself.
 */
function ReconnectingScreen() {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[4], backgroundColor: colors.bg }}>
      <ActivityIndicator color={colors.brand} />
      <AppText variant="muted">Reconnecting…</AppText>
    </View>
  );
}

SplashScreen.preventAutoHideAsync().catch(() => { /* already hidden */ });

function RootNavigator() {
  const { ready, restoring, session } = useAuth();
  const { mode, colors } = useTheme();

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => { /* noop */ });
  }, [ready]);

  if (!ready) return null;
  if (restoring && !session) return <ReconnectingScreen />;
  const signedIn = Boolean(session);

  return (
    <>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="settings"
            options={{
              presentation: 'modal',
              headerShown: true,
              title: 'Settings',
              headerStyle: { backgroundColor: colors.surface },
              headerTintColor: colors.fg,
              headerTitleStyle: { color: colors.fg },
            }}
          />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

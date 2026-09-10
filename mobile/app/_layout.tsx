import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../src/theme/theme';
import { ReconnectingScreen } from '../src/components/ReconnectingScreen';
import { AuthProvider, useAuth } from '../src/lib/auth';

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

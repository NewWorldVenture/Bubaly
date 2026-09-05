import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { Field } from '../../src/components/Field';
import { GlassCard } from '../../src/components/GlassCard';
import { useAuth } from '../../src/lib/auth';
import { validateCredentials } from '../../src/lib/auth-core';
import { isSupabaseConfigured, webUrl } from '../../src/lib/config';
import { useTheme } from '../../src/theme/theme';

export default function SignInScreen() {
  const { colors, spacing, radius, toggle, mode } = useTheme();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const invalid = validateCredentials(email, password);
    if (invalid) { setError(invalid); return; }
    setBusy(true);
    setError(null);
    const result = await signIn(email, password);
    setBusy(false);
    if (result.error) setError(result.error);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: spacing[5], justifyContent: 'center', gap: spacing[6] }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[3] }}>
              <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="home" size={22} color={colors.brandFg} />
              </View>
              <AppText variant="title">Bubaly</AppText>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`} onPress={toggle} hitSlop={12}>
              <Ionicons name={mode === 'dark' ? 'sunny-outline' : 'moon-outline'} size={22} color={colors.muted} />
            </Pressable>
          </View>

          <View style={{ gap: spacing[2] }}>
            <AppText variant="display">Run your family like a calm, connected team.</AppText>
            <AppText variant="muted">Sign in with the account you use on the web.</AppText>
          </View>

          <GlassCard style={{ gap: spacing[4] }}>
            {!isSupabaseConfigured() ? (
              <AppText variant="muted" color={colors.warning}>
                This build isn’t pointed at a Supabase project yet — set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.
              </AppText>
            ) : null}
            <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" placeholder="you@example.com" returnKeyType="next" />
            <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" placeholder="••••••••" returnKeyType="go" onSubmitEditing={submit} error={error} />
            <Button title="Sign in" onPress={submit} loading={busy} />
          </GlassCard>

          <View style={{ gap: spacing[2], alignItems: 'center' }}>
            <Button title="Forgot password?" variant="ghost" onPress={() => Linking.openURL(webUrl('/login?reset=1'))} />
            <AppText variant="muted" style={{ textAlign: 'center' }}>
              New to Bubaly? Create your family on the web, then sign in here.
            </AppText>
            <Button title="Create an account" variant="secondary" onPress={() => Linking.openURL(webUrl('/signup'))} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

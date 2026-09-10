import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import * as Linking from 'expo-linking';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from '../src/components/AppText';
import { Button } from '../src/components/Button';
import { GlassCard } from '../src/components/GlassCard';
import { Divider, ListRow } from '../src/components/ListRow';
import { Screen } from '../src/components/Screen';
import { useAuth } from '../src/lib/auth';
import { deviceLocale, mobileTranslate } from '../src/lib/mobile-i18n';
import { webUrl } from '../src/lib/config';
import { THEME_PREFERENCES, type ThemePreference } from '../src/theme/theme-core';
import { useTheme } from '../src/theme/theme';

const LABELS: Record<ThemePreference, string> = { dark: 'Dark', light: 'Light', system: 'Match device' };

export default function SettingsScreen() {
  const theme = useTheme();
  const { colors, spacing, radius } = theme;
  const { session, family, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const t = (key: string) => mobileTranslate(deviceLocale(), key);

  return (
    <Screen>
      <GlassCard style={{ gap: spacing[3] }}>
        <AppText variant="label">Appearance</AppText>
        <View style={{ flexDirection: 'row', gap: spacing[2] }}>
          {THEME_PREFERENCES.map((pref) => {
            const active = theme.preference === pref;
            return (
              <Pressable
                key={pref}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                onPress={() => theme.setPreference(pref)}
                style={{ flex: 1, minHeight: theme.layout.touchTarget, borderRadius: radius.lg, borderWidth: 1, borderColor: active ? colors.brand : colors.border, backgroundColor: active ? colors.brandSoft : colors.surface, alignItems: 'center', justifyContent: 'center' }}
              >
                <AppText variant="heading" style={{ fontSize: 14 }} color={active ? colors.brandText : colors.fg}>{LABELS[pref]}</AppText>
              </Pressable>
            );
          })}
        </View>
        <AppText variant="muted">Dark is the default, just like the web app. Currently showing {theme.mode}.</AppText>
      </GlassCard>

      <GlassCard>
        <AppText variant="label" style={{ marginBottom: spacing[2] }}>Account</AppText>
        <ListRow title={session?.user.email ?? 'Signed in'} subtitle={family ? `${family.displayName} · ${family.role} · ${family.familyName}` : 'No family yet'} leading={<Ionicons name="person-circle-outline" size={28} color={colors.muted} />} />
        <Divider />
        <ListRow title="Manage family on the web" subtitle="Members, invites, billing" leading={<Ionicons name="open-outline" size={24} color={colors.muted} />} onPress={() => Linking.openURL(webUrl('/dashboard/family'))} />
        <Divider />
        <ListRow title="Notification preferences" subtitle="Push + email, per module" leading={<Ionicons name="notifications-outline" size={24} color={colors.muted} />} onPress={() => Linking.openURL(webUrl('/dashboard/notifications'))} />
      </GlassCard>

      <GlassCard>
        <AppText variant="label" style={{ marginBottom: spacing[2] }}>About</AppText>
        <ListRow title="Bubaly for iOS, iPadOS and Android" subtitle={`Version ${Constants.expoConfig?.version ?? '0.1.0'} · Expo`} leading={<Ionicons name="information-circle-outline" size={24} color={colors.muted} />} />
        <Divider />
        <ListRow title="Privacy" leading={<Ionicons name="shield-checkmark-outline" size={24} color={colors.muted} />} onPress={() => Linking.openURL(webUrl('/privacy'))} />
        <Divider />
        <ListRow title="Terms" leading={<Ionicons name="document-text-outline" size={24} color={colors.muted} />} onPress={() => Linking.openURL(webUrl('/terms'))} />
      </GlassCard>

      {signOutFailed ? <AppText accessibilityRole="alert" color={colors.danger}>{t('mobileAssistant.signOutFailed')}</AppText> : null}
      <Button title={t('mobileAssistant.signOutDevice')} variant="danger" loading={signingOut} onPress={async () => {
        setSigningOut(true); setSignOutFailed(false);
        try { await signOut(); } catch { setSignOutFailed(true); } finally { setSigningOut(false); }
      }} />
    </Screen>
  );
}

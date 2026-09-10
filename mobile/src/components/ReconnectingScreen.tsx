import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { useAuth } from '../lib/auth';
import { deviceLocale, mobileTranslate } from '../lib/mobile-i18n';
import { AppText } from './AppText';
import { Button } from './Button';

/** Keep a saved session while it recovers; only explicit sign-out clears it. */
export function ReconnectingScreen() {
  const { colors, spacing } = useTheme();
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const t = (key: string) => mobileTranslate(deviceLocale(), key);
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[4], padding: spacing[5], backgroundColor: colors.bg }}>
      <ActivityIndicator color={colors.brand} />
      <AppText variant="muted">{t('mobileAssistant.reconnecting')}</AppText>
      {failed ? <AppText accessibilityRole="alert" color={colors.danger}>{t('mobileAssistant.signOutFailed')}</AppText> : null}
      <Button title={t('mobileAssistant.signOutDevice')} variant="ghost" loading={signingOut} onPress={async () => {
        setSigningOut(true); setFailed(false);
        try { await signOut(); } catch { setFailed(true); } finally { setSigningOut(false); }
      }} />
    </View>
  );
}

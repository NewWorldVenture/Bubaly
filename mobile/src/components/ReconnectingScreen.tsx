import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { useAuth } from '../lib/auth';
import { restoreCopy } from '../lib/auth-core';
import { deviceLocale, mobileTranslate } from '../lib/mobile-i18n';
import { AppText } from './AppText';
import { Button } from './Button';

/**
 * Keep a saved session while it recovers; only explicit sign-out clears it.
 *
 * Three states share this screen and used to share one line of copy and one
 * 30-second retry without end. Offline at a cold start is a reconnect: the
 * refresh token is in the Keychain and the next read will find the network
 * back. A saved session the device cannot READ — a missing chunk, a corrupt
 * header, an invalidated Keystore — is not: nothing rewrites it without a
 * session, so "Reconnecting…" would spin for ever over a state only "Sign out
 * of this device" ends. And a reconnect that has failed for minutes deserves to
 * say so. `restoreCopy` (auth-core.ts) tells them apart; the sign-out becomes
 * the primary action for the two that need it.
 */
export function ReconnectingScreen() {
  const { colors, spacing } = useTheme();
  const { signOut, restoreIssue } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const t = (key: string) => mobileTranslate(deviceLocale(), key);
  const copy = restoreCopy(restoreIssue ?? null);
  const unreadable = copy === 'mobileAssistant.savedSignInUnreadable';
  const stuck = unreadable || copy === 'mobileAssistant.stillReconnecting';
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[4], padding: spacing[5], backgroundColor: colors.bg }}>
      {unreadable ? null : <ActivityIndicator color={colors.brand} />}
      <AppText variant={stuck ? undefined : 'muted'} style={{ textAlign: 'center' }}>{t(copy)}</AppText>
      {failed ? <AppText accessibilityRole="alert" color={colors.danger}>{t('mobileAssistant.signOutFailed')}</AppText> : null}
      <Button title={t('mobileAssistant.signOutDevice')} variant={stuck ? 'primary' : 'ghost'} loading={signingOut} onPress={async () => {
        setSigningOut(true); setFailed(false);
        try { await signOut(); } catch { setFailed(true); } finally { setSigningOut(false); }
      }} />
    </View>
  );
}

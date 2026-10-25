import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import * as Linking from 'expo-linking';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { webUrl } from '../lib/config';
import { deviceLocale, mobileTranslate } from '../lib/mobile-i18n';
import { useTheme } from '../theme/theme';

type Props = {
  /** The family read is in flight (`familyLoading`). */
  loading: boolean;
  /** The family read failed (`familyError`) — shown with a retry, never as an empty list. */
  error: string | null;
  onRetry: () => void;
};

/**
 * What a tab shows while it has no family to show: the read in progress, the
 * read's failure with a way to try again, or a person with no household yet.
 *
 * Chores, Grocery and Calendar used to read only `family`, so when the family
 * context read failed (network loss, a Supabase 5xx, an expired token at the
 * moment of refresh) each tab's loader resolved to nothing and the healthy
 * empty state — "Nothing open", "Your list is empty", "A clear fortnight" —
 * stood in for an error nobody had seen; the same states, and Today's
 * onboarding card, flashed during every initial family read. Now every tab
 * says which of the three it is.
 */
export function FamilyGate({ loading, error, onRetry }: Props) {
  const { colors, spacing } = useTheme();
  const t = (key: string) => mobileTranslate(deviceLocale(), key);
  if (error) {
    return (
      <EmptyState
        icon="people-outline"
        title={t('mobileAssistant.familyLoadFailed')}
        body={error}
        action={<Button title={t('mobileAssistant.retry')} variant="secondary" loading={loading} onPress={onRetry} accessibilityLabel={t('mobileAssistant.retry')} />}
      />
    );
  }
  if (loading) {
    return (
      <View accessibilityRole="progressbar" accessibilityLabel={t('mobileAssistant.checking')} style={{ paddingVertical: spacing[8], alignItems: 'center' }}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }
  return (
    <EmptyState
      icon="people-outline"
      title={t('mobileAssistant.familyNeeded')}
      body={t('mobileAssistant.familyNeededBody')}
      action={<Button title={t('mobileAssistant.openWebApp')} variant="secondary" onPress={() => Linking.openURL(webUrl('/onboarding'))} accessibilityLabel={t('mobileAssistant.openWebApp')} />}
    />
  );
}

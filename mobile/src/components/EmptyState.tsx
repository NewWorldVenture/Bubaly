import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from './AppText';
import { GlassCard } from './GlassCard';
import { useTheme } from '../theme/theme';

type Props = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  body?: string;
  action?: React.ReactNode;
};

export function EmptyState({ icon, title, body, action }: Props) {
  const { colors, spacing } = useTheme();
  return (
    <GlassCard style={{ alignItems: 'center', gap: spacing[3], paddingVertical: spacing[8] }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={26} color={colors.brandText} />
      </View>
      <AppText variant="heading" style={{ textAlign: 'center' }}>{title}</AppText>
      {body ? <AppText variant="muted" style={{ textAlign: 'center' }}>{body}</AppText> : null}
      {action}
    </GlassCard>
  );
}

import React from 'react';
import { View } from 'react-native';
import { AppText } from './AppText';
import { useTheme } from '../theme/theme';

type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'muted' | 'info';

export function Pill({ label, tone = 'muted' }: { label: string; tone?: Tone }) {
  const { colors, radius, spacing } = useTheme();
  const color = { brand: colors.brandText, success: colors.success, warning: colors.warning, danger: colors.danger, muted: colors.muted, info: colors.info }[tone];
  return (
    <View style={{ alignSelf: 'flex-start', borderRadius: radius.sm, borderWidth: 1, borderColor: color, paddingHorizontal: spacing[2], paddingVertical: 2 }}>
      <AppText variant="caption" color={color}>{label}</AppText>
    </View>
  );
}

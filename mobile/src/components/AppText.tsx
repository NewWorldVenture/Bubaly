import React from 'react';
import { Text, type TextProps } from 'react-native';
import { useTheme } from '../theme/theme';

export type TextVariant = 'display' | 'title' | 'heading' | 'body' | 'muted' | 'label' | 'caption';

export function AppText({ variant = 'body', color, style, ...rest }: TextProps & { variant?: TextVariant; color?: string }) {
  const { colors, font } = useTheme();
  const base = {
    display: { fontSize: font.size['3xl'], fontWeight: font.weight.bold as '700', color: colors.fg, letterSpacing: -0.5 },
    title: { fontSize: font.size['2xl'], fontWeight: font.weight.bold as '700', color: colors.fg, letterSpacing: -0.3 },
    heading: { fontSize: font.size.lg, fontWeight: font.weight.semibold as '600', color: colors.fg },
    body: { fontSize: font.size.base, fontWeight: font.weight.regular as '400', color: colors.fg, lineHeight: 22 },
    muted: { fontSize: font.size.sm, fontWeight: font.weight.regular as '400', color: colors.muted, lineHeight: 20 },
    label: { fontSize: font.size.xs, fontWeight: font.weight.semibold as '600', color: colors.muted, letterSpacing: 0.8, textTransform: 'uppercase' as const },
    caption: { fontSize: font.size.xs, fontWeight: font.weight.medium as '500', color: colors.muted },
  }[variant];
  return <Text {...rest} style={[base, color ? { color } : null, style]} />;
}

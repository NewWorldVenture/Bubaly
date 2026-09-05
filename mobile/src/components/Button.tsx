import React from 'react';
import { ActivityIndicator, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { useTheme } from '../theme/theme';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  title, variant = 'primary', loading = false, disabled, style, ...rest
}: Omit<PressableProps, 'style'> & { title: string; variant?: Variant; loading?: boolean; style?: StyleProp<ViewStyle> }) {
  const { colors, glass, radius, spacing, layout } = useTheme();
  const palette = {
    primary: { bg: colors.brand, fg: colors.brandFg, border: colors.brand },
    secondary: { bg: glass.background, fg: colors.fg, border: glass.border },
    ghost: { bg: 'transparent', fg: colors.brandText, border: 'transparent' },
    danger: { bg: 'transparent', fg: colors.danger, border: colors.danger },
  }[variant];
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: loading }}
      disabled={isDisabled}
      {...rest}
      style={({ pressed }) => [{
        minHeight: layout.touchTarget,
        paddingHorizontal: spacing[5],
        borderRadius: radius.lg,
        backgroundColor: palette.bg,
        borderColor: palette.border,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        opacity: isDisabled ? 0.55 : pressed ? 0.85 : 1,
      }, style]}
    >
      {loading ? <ActivityIndicator color={palette.fg} /> : <AppText variant="heading" color={palette.fg} style={{ fontSize: 16 }}>{title}</AppText>}
    </Pressable>
  );
}

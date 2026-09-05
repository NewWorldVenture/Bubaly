import React from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { AppText } from './AppText';
import { useTheme } from '../theme/theme';

export function Field({ label, error, style, ...rest }: TextInputProps & { label?: string; error?: string | null }) {
  const { colors, radius, spacing, layout, font } = useTheme();
  return (
    <View style={{ gap: spacing[2] }}>
      {label ? <AppText variant="label">{label}</AppText> : null}
      <TextInput
        placeholderTextColor={colors.muted}
        selectionColor={colors.brandText}
        accessibilityLabel={label}
        {...rest}
        style={[{
          minHeight: layout.touchTarget + 4,
          paddingHorizontal: spacing[4],
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: error ? colors.danger : colors.border,
          backgroundColor: colors.surface,
          color: colors.fg,
          fontSize: font.size.base,
        }, style]}
      />
      {error ? <AppText variant="caption" color={colors.danger}>{error}</AppText> : null}
    </View>
  );
}

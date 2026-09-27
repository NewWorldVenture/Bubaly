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
          // colors.border is 1.38:1 (dark) / 1.28:1 (light) against the surface
          // behind it — under WCAG 1.4.11's 3:1 for a control boundary. The web
          // fix (audit C2-B04) added a dedicated token; this is its mobile half.
          // It matters MORE here: on the web the (broken) permanent focus ring was
          // accidentally outlining every field, and React Native has no such
          // accident — TextInput gets no focus ring and this component defines no
          // focus state, so the border is the only boundary a field ever has.
          borderColor: error ? colors.danger : colors.borderInput,
          backgroundColor: colors.surface,
          color: colors.fg,
          fontSize: font.size.base,
        }, style]}
      />
      {error ? <AppText variant="caption" color={colors.danger}>{error}</AppText> : null}
    </View>
  );
}

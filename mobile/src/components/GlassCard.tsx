import React from 'react';
import { View, type ViewProps } from 'react-native';
import { useTheme } from '../theme/theme';

/** The glassmorphism surface from the web (`.glass`), in native form. */
export function GlassCard({ style, children, ...rest }: ViewProps) {
  const { glass, radius, spacing } = useTheme();
  return (
    <View
      {...rest}
      style={[{
        backgroundColor: glass.background,
        borderColor: glass.border,
        borderWidth: 1,
        borderRadius: radius.xl,
        padding: spacing[4],
      }, style]}
    >
      {children}
    </View>
  );
}

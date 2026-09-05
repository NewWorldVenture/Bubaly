import React from 'react';
import { Pressable, View } from 'react-native';
import { AppText } from './AppText';
import { useTheme } from '../theme/theme';

type Props = {
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onPress?: () => void;
  muted?: boolean;
  accessibilityLabel?: string;
};

export function ListRow({ title, subtitle, leading, trailing, onPress, muted = false, accessibilityLabel }: Props) {
  const { colors, spacing, layout } = useTheme();
  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[3], minHeight: layout.touchTarget, paddingVertical: spacing[2] }}>
      {leading}
      <View style={{ flex: 1 }}>
        <AppText style={muted ? { color: colors.muted, textDecorationLine: 'line-through' } : undefined} numberOfLines={2}>{title}</AppText>
        {subtitle ? <AppText variant="muted" numberOfLines={1}>{subtitle}</AppText> : null}
      </View>
      {trailing}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {content}
    </Pressable>
  );
}

export function Divider() {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.border, opacity: 0.6 }} />;
}

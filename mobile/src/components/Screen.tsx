import React from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText } from './AppText';
import { useTheme } from '../theme/theme';

type Props = {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  /** Wrap children in a ScrollView (default). Use false for FlatList/SectionList screens. */
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  children: React.ReactNode;
};

export function Screen({ title, subtitle, right, scroll = true, refreshing = false, onRefresh, children }: Props) {
  const { colors, spacing } = useTheme();
  const header = (title || right) ? (
    <View style={[styles.header, { paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[3] }]}>
      <View style={{ flex: 1 }}>
        {title ? <AppText variant="title">{title}</AppText> : null}
        {subtitle ? <AppText variant="muted" style={{ marginTop: 2 }}>{subtitle}</AppText> : null}
      </View>
      {right}
    </View>
  ) : null;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {header}
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: spacing[5], paddingBottom: spacing[10], gap: spacing[4] }}
          refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brandText} colors={[colors.brand]} /> : undefined}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
});

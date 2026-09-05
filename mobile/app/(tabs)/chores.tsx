import React, { useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { EmptyState } from '../../src/components/EmptyState';
import { GlassCard } from '../../src/components/GlassCard';
import { Pill } from '../../src/components/Pill';
import { Screen } from '../../src/components/Screen';
import { useAsyncData } from '../../src/hooks/use-async-data';
import { useAuth } from '../../src/lib/auth';
import { isOpenChore, statusLabel } from '../../src/lib/chores-core';
import { dueLabel } from '../../src/lib/format';
import { completeChore, fetchOpenChores, type ChoreRow } from '../../src/lib/queries';
import { supabase } from '../../src/lib/supabase';
import { useTheme } from '../../src/theme/theme';

export default function ChoresScreen() {
  const { colors, spacing } = useTheme();
  const { family } = useAuth();
  const familyId = family?.familyId ?? null;
  const tz = family?.timezone ?? 'UTC';
  const chores = useAsyncData(() => (familyId ? fetchOpenChores(supabase, familyId) : Promise.resolve([] as ChoreRow[])), [familyId]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const markDone = async (row: ChoreRow) => {
    setBusyId(row.id);
    setActionError(null);
    try {
      await completeChore(supabase, row);
      chores.setData((prev) => (prev ?? []).map((c) => (c.id === row.id ? { ...c, status: 'submitted' } : c)));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not update that chore.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen title="Chores" subtitle={family ? `${(chores.data ?? []).filter((c) => c.status !== 'submitted').length} open` : undefined} scroll={false}>
      <FlatList
        data={chores.data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: spacing[5], paddingBottom: spacing[10], gap: spacing[3] }}
        refreshControl={<RefreshControl refreshing={chores.refreshing} onRefresh={chores.refresh} tintColor={colors.brandText} colors={[colors.brand]} />}
        ListHeaderComponent={actionError ? <AppText color={colors.danger}>{actionError}</AppText> : null}
        renderItem={({ item }) => {
          const open = isOpenChore(item.status);
          const tone = item.status === 'submitted' ? 'warning' : item.due_at && new Date(item.due_at) < new Date() ? 'danger' : 'muted';
          return (
            <GlassCard style={{ gap: spacing[3] }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing[3] }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <AppText variant="heading">{item.chores?.title ?? 'Chore'}</AppText>
                  <AppText variant="muted">{item.family_members?.display_name ?? 'Unassigned'} · {dueLabel(item.due_at, tz)}</AppText>
                  <View style={{ flexDirection: 'row', gap: spacing[2] }}>
                    <Pill label={statusLabel(item.status)} tone={tone} />
                    <Pill label={`${item.chores?.points ?? 0} pts`} tone="brand" />
                  </View>
                </View>
                {open ? <Button title="Done" variant="secondary" loading={busyId === item.id} onPress={() => markDone(item)} style={{ paddingHorizontal: spacing[4] }} accessibilityLabel={`Mark ${item.chores?.title ?? 'chore'} done`} /> : null}
              </View>
            </GlassCard>
          );
        }}
        ListEmptyComponent={
          chores.loading ? null : (
            <View style={{ marginTop: spacing[4] }}>
              {chores.error
                ? <AppText color={colors.danger}>{chores.error}</AppText>
                : <EmptyState icon="checkmark-done-outline" title="Nothing open" body="Every chore is done or waiting on approval." />}
            </View>
          )
        }
      />
    </Screen>
  );
}

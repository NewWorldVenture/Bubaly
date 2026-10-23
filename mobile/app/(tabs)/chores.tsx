import React, { useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { EmptyState } from '../../src/components/EmptyState';
import { FamilyGate } from '../../src/components/FamilyGate';
import { GlassCard } from '../../src/components/GlassCard';
import { Pill } from '../../src/components/Pill';
import { Screen } from '../../src/components/Screen';
import { useAsyncData } from '../../src/hooks/use-async-data';
import { useAuth } from '../../src/lib/auth';
import { REFUSAL_COPY, isOpenChore, mayCompleteChore, statusLabel } from '../../src/lib/chores-core';
import { messageFor } from '../../src/lib/errors';
import { dueLabel } from '../../src/lib/format';
import { deviceLocale, mobileTranslate } from '../../src/lib/mobile-i18n';
import { completeChore, fetchOpenChores, type ChorePage, type ChoreRow } from '../../src/lib/queries';
import { supabase } from '../../src/lib/supabase';
import { useTheme } from '../../src/theme/theme';

const EMPTY: ChorePage = { rows: [], count: 0, openCount: 0 };

export default function ChoresScreen() {
  const { colors, spacing } = useTheme();
  const { family, familyLoading, familyError, refreshFamily } = useAuth();
  const familyId = family?.familyId ?? null;
  const tz = family?.timezone ?? 'UTC';
  const t = (key: string, params?: Record<string, string | number>) => mobileTranslate(deviceLocale(), key, params);
  const chores = useAsyncData<ChorePage>((signal) => (familyId ? fetchOpenChores(supabase, familyId, signal) : Promise.resolve(EMPTY)), [familyId]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const markDone = async (row: ChoreRow) => {
    if (!family) return;
    setBusyId(row.id);
    setActionError(null);
    try {
      // The write carries the rule (queries.ts): done or submitted as the chore
      // needs, only while the row is still open, in this family, and this
      // member's unless a parent or adult. A row that no longer matches is NOT
      // flipped here — the refusal is shown in its own words and the list
      // re-read, where the unconditional write used to be shown as "Waiting
      // for approval" whatever had actually happened to the row.
      const result = await completeChore(supabase, row, { familyId: family.familyId, memberId: family.memberId, role: family.role });
      if (!result.saved) {
        setActionError(t(REFUSAL_COPY[result.reason]));
        await chores.refresh();
        return;
      }
      chores.setData((prev) => prev ? {
        rows: result.status === 'done' ? prev.rows.filter((c) => c.id !== row.id) : prev.rows.map((c) => (c.id === row.id ? { ...c, status: result.status } : c)),
        count: result.status === 'done' ? Math.max(0, prev.count - 1) : prev.count,
        openCount: isOpenChore(row.status) ? Math.max(0, prev.openCount - 1) : prev.openCount,
      } : prev);
    } catch (e) {
      setActionError(messageFor(e, t('mobileAssistant.choreUpdateFailed')));
    } finally {
      setBusyId(null);
    }
  };

  if (!family) {
    return (
      <Screen title="Chores">
        <FamilyGate loading={familyLoading} error={familyError} onRetry={() => void refreshFamily()} />
      </Screen>
    );
  }

  const rows = chores.data?.rows ?? [];
  const viewer = { memberId: family.memberId, role: family.role };
  // A failed refresh keeps the rows and says so above them; a failed first
  // read has no rows to keep and says so in their place.
  const readError = chores.error ? (chores.data ? t('mobileAssistant.refreshFailed') : chores.error) : null;
  return (
    <Screen title="Chores" subtitle={chores.data ? `${chores.data.openCount} open` : undefined} scroll={false}>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: spacing[5], paddingBottom: spacing[10], gap: spacing[3] }}
        refreshControl={<RefreshControl refreshing={chores.refreshing} onRefresh={chores.refresh} tintColor={colors.brandText} colors={[colors.brand]} />}
        ListHeaderComponent={readError || actionError ? (
          <View style={{ gap: spacing[2] }}>
            {readError ? <AppText accessibilityRole="alert" color={colors.danger}>{readError}</AppText> : null}
            {actionError ? <AppText accessibilityRole="alert" color={colors.danger}>{actionError}</AppText> : null}
          </View>
        ) : null}
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
                {open && mayCompleteChore(item, viewer) ? <Button title="Done" variant="secondary" loading={busyId === item.id} onPress={() => markDone(item)} style={{ paddingHorizontal: spacing[4] }} accessibilityLabel={`Mark ${item.chores?.title ?? 'chore'} done`} /> : null}
              </View>
            </GlassCard>
          );
        }}
        ListFooterComponent={chores.data && chores.data.count > rows.length
          ? <AppText variant="muted">{t('mobileAssistant.showingChores', { shown: rows.length, total: chores.data.count })}</AppText>
          : null}
        ListEmptyComponent={
          chores.loading || chores.error ? null : (
            <View style={{ marginTop: spacing[4] }}>
              <EmptyState icon="checkmark-done-outline" title="Nothing open" body="Every chore is done or waiting on approval." />
            </View>
          )
        }
      />
    </Screen>
  );
}

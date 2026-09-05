import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { EmptyState } from '../../src/components/EmptyState';
import { GlassCard } from '../../src/components/GlassCard';
import { Divider, ListRow } from '../../src/components/ListRow';
import { Pill } from '../../src/components/Pill';
import { Screen } from '../../src/components/Screen';
import { useAsyncData } from '../../src/hooks/use-async-data';
import { useAuth } from '../../src/lib/auth';
import { webUrl } from '../../src/lib/config';
import { dueLabel, formatTime, greeting, dayLabel } from '../../src/lib/format';
import { isOpenChore } from '../../src/lib/chores-core';
import { fetchGroceryList, fetchOpenChores, fetchUpcomingEvents } from '../../src/lib/queries';
import { supabase } from '../../src/lib/supabase';
import { useTheme } from '../../src/theme/theme';

export default function TodayScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const { family, familyLoading, familyError, refreshFamily } = useAuth();
  const familyId = family?.familyId ?? null;
  const tz = family?.timezone ?? 'UTC';

  const today = useAsyncData(async () => {
    if (!familyId) return null;
    const [events, chores, grocery] = await Promise.all([
      fetchUpcomingEvents(supabase, familyId, 3),
      fetchOpenChores(supabase, familyId),
      fetchGroceryList(supabase, familyId),
    ]);
    const open = chores.filter((c) => isOpenChore(c.status));
    return { events: events.slice(0, 4), chores: open.slice(0, 4), openChores: open.length, toBuy: grocery.items.filter((i) => !i.is_checked).length };
  }, [familyId]);

  const settings = (
    <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push('/settings')} hitSlop={12} style={{ paddingTop: 6 }}>
      <Ionicons name="settings-outline" size={24} color={colors.muted} />
    </Pressable>
  );

  if (!family) {
    return (
      <Screen title={greeting(new Date(), tz)} right={settings} refreshing={familyLoading} onRefresh={refreshFamily}>
        <EmptyState
          icon="people-outline"
          title={familyError ? 'Couldn’t load your family' : 'Finish setting up your family'}
          body={familyError ?? 'Create your household on the web app, then pull to refresh here.'}
          action={<Button title={familyError ? 'Try again' : 'Open Bubaly on the web'} variant="secondary" onPress={familyError ? refreshFamily : () => Linking.openURL(webUrl('/onboarding'))} />}
        />
      </Screen>
    );
  }

  const data = today.data;
  return (
    <Screen title={`${greeting(new Date(), tz)}, ${family.displayName.split(' ')[0]}`} subtitle={family.familyName} right={settings} refreshing={today.refreshing} onRefresh={today.refresh}>
      {today.error ? <AppText variant="muted" color={colors.danger}>{today.error}</AppText> : null}

      <View style={{ flexDirection: 'row', gap: spacing[3] }}>
        <Stat label="Chores open" value={data ? String(data.openChores) : '–'} onPress={() => router.push('/chores')} />
        <Stat label="To buy" value={data ? String(data.toBuy) : '–'} onPress={() => router.push('/grocery')} />
        <Stat label="Next 3 days" value={data ? String(data.events.length) : '–'} onPress={() => router.push('/calendar')} />
      </View>

      <GlassCard>
        <AppText variant="label" style={{ marginBottom: spacing[2] }}>Up next</AppText>
        {data && data.events.length === 0 ? <AppText variant="muted">Nothing on the calendar for the next few days.</AppText> : null}
        {data?.events.map((e, i) => (
          <View key={e.id}>
            {i > 0 ? <Divider /> : null}
            <ListRow title={e.title} subtitle={`${dayLabel(new Date(e.starts_at), tz)} · ${formatTime(e.starts_at, tz, e.all_day)}${e.location ? ` · ${e.location}` : ''}`} trailing={<Pill label={e.category} tone="info" />} />
          </View>
        ))}
      </GlassCard>

      <GlassCard>
        <AppText variant="label" style={{ marginBottom: spacing[2] }}>Chores due</AppText>
        {data && data.chores.length === 0 ? <AppText variant="muted">All caught up.</AppText> : null}
        {data?.chores.map((c, i) => (
          <View key={c.id}>
            {i > 0 ? <Divider /> : null}
            <ListRow title={c.chores?.title ?? 'Chore'} subtitle={`${c.family_members?.display_name ?? 'Unassigned'} · ${dueLabel(c.due_at, tz)}`} trailing={<Pill label={`${c.chores?.points ?? 0} pts`} tone="brand" />} />
          </View>
        ))}
      </GlassCard>

      <GlassCard style={{ gap: spacing[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
          <Ionicons name="sparkles" size={18} color={colors.brandText} />
          <AppText variant="heading">Ask Bubaly</AppText>
        </View>
        <AppText variant="muted">“Add soccer Saturday at 10”, “Plan tacos for Friday”, “What’s due this week?”</AppText>
        <Button title="Open the assistant" onPress={() => router.push('/assistant')} />
      </GlassCard>
    </Screen>
  );
}

function Stat({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const { spacing } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} onPress={onPress} style={{ flex: 1 }}>
      <GlassCard style={{ padding: spacing[3], gap: 2 }}>
        <AppText variant="title">{value}</AppText>
        <AppText variant="caption">{label}</AppText>
      </GlassCard>
    </Pressable>
  );
}

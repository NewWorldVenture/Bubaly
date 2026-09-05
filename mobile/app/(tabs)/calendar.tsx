import React, { useMemo } from 'react';
import { RefreshControl, SectionList, View } from 'react-native';
import { AppText } from '../../src/components/AppText';
import { EmptyState } from '../../src/components/EmptyState';
import { GlassCard } from '../../src/components/GlassCard';
import { ListRow } from '../../src/components/ListRow';
import { Pill } from '../../src/components/Pill';
import { Screen } from '../../src/components/Screen';
import { useAsyncData } from '../../src/hooks/use-async-data';
import { useAuth } from '../../src/lib/auth';
import { formatTime, groupByDay } from '../../src/lib/format';
import { fetchUpcomingEvents, type EventRow } from '../../src/lib/queries';
import { supabase } from '../../src/lib/supabase';
import { useTheme } from '../../src/theme/theme';

export default function CalendarScreen() {
  const { colors, spacing } = useTheme();
  const { family } = useAuth();
  const familyId = family?.familyId ?? null;
  const tz = family?.timezone ?? 'UTC';
  const events = useAsyncData(() => (familyId ? fetchUpcomingEvents(supabase, familyId, 14) : Promise.resolve([] as EventRow[])), [familyId]);

  const sections = useMemo(
    () => groupByDay(events.data ?? [], (e) => e.starts_at, tz).map((g) => ({ key: g.key, title: g.label, data: g.items })),
    [events.data, tz],
  );

  return (
    <Screen title="Calendar" subtitle="The next two weeks" scroll={false}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: spacing[5], paddingBottom: spacing[10], gap: spacing[2] }}
        refreshControl={<RefreshControl refreshing={events.refreshing} onRefresh={events.refresh} tintColor={colors.brandText} colors={[colors.brand]} />}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <AppText variant="label" style={{ marginTop: spacing[3] }}>{section.title}</AppText>}
        renderItem={({ item }) => (
          <GlassCard style={{ paddingVertical: spacing[2] }}>
            <ListRow
              title={item.title}
              subtitle={`${formatTime(item.starts_at, tz, item.all_day)}${item.ends_at && !item.all_day ? ` – ${formatTime(item.ends_at, tz)}` : ''}${item.location ? ` · ${item.location}` : ''}`}
              trailing={<Pill label={item.category} tone="info" />}
            />
          </GlassCard>
        )}
        ListEmptyComponent={
          events.loading ? null : (
            <View style={{ marginTop: spacing[4] }}>
              {events.error
                ? <AppText color={colors.danger}>{events.error}</AppText>
                : <EmptyState icon="calendar-outline" title="A clear fortnight" body="Nothing scheduled in the next 14 days. Ask the assistant to add something." />}
            </View>
          )
        }
      />
    </Screen>
  );
}

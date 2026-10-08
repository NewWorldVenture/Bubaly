import React, { useMemo } from 'react';
import { RefreshControl, SectionList, View } from 'react-native';
import { AppText } from '../../src/components/AppText';
import { EmptyState } from '../../src/components/EmptyState';
import { GlassCard } from '../../src/components/GlassCard';
import { ListRow } from '../../src/components/ListRow';
import { Pill } from '../../src/components/Pill';
import { Screen } from '../../src/components/Screen';
import { useCalendar } from '../../src/hooks/use-calendar';
import { useAuth } from '../../src/lib/auth';
import { formatTime } from '../../src/lib/format';
import { groupCalendarDays } from '../../src/lib/calendar-core';
import { useTheme } from '../../src/theme/theme';

export default function CalendarScreen() {
  const { colors, spacing } = useTheme();
  const { family } = useAuth();
  const events = useCalendar(14);
  const tz = events.data?.timezone ?? family?.timezone ?? 'UTC';

  const sections = useMemo(
    () => groupCalendarDays(events.data?.occurrences ?? [], tz, events.data?.fromDay && events.data.toDay ? { fromDay: events.data.fromDay, toDay: events.data.toDay } : undefined).map((g) => ({ key: g.key, title: g.label, data: g.items })),
    [events.data, tz],
  );

  return (
    <Screen title="Calendar" subtitle="The next two weeks" scroll={false}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.segmentKey}
        contentContainerStyle={{ paddingHorizontal: spacing[5], paddingBottom: spacing[10], gap: spacing[2] }}
        refreshControl={<RefreshControl refreshing={events.refreshing} onRefresh={events.refresh} tintColor={colors.brandText} colors={[colors.brand]} />}
        stickySectionHeadersEnabled={false}
        ListFooterComponent={events.data && events.data.count > events.data.occurrences.length ? <AppText variant="muted">Showing {events.data.occurrences.length} of {events.data.count} events.</AppText> : null}
        renderSectionHeader={({ section }) => <AppText variant="label" style={{ marginTop: spacing[3] }}>{section.title}</AppText>}
        renderItem={({ item }) => (
          <GlassCard style={{ paddingVertical: spacing[2] }}>
            <ListRow
              title={item.title ?? '—'}
              subtitle={`${formatTime(item.segmentStartsAt, tz, item.all_day)}${!item.all_day ? ` – ${formatTime(item.segmentEndsAt, tz)}` : ''}${item.location ? ` · ${item.location}` : ''}`}
              trailing={item.category ? <Pill label={item.category} tone="info" /> : null}
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

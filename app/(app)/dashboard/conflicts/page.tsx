import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock, ArrowLeft } from 'lucide-react';
import { requireFeature } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { isSeries, readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { createServer } from '@/lib/supabase/server';
import { detectConflicts, quickFixMoveAfter, type TimedEvent } from '@/lib/family/conflicts';
import { ConflictResolver, type ConflictView } from '@/components/family/conflict-resolver';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import type { LocaleCode } from '@/lib/i18n/locales';
import { dayKeyInTz } from '@/lib/services/scope';
import { ErrorState } from '@/components/ui/states';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.aiConflictResolution') };
}
export const dynamic = 'force-dynamic';

// `tz` is the family's zone. Without it every clock here was the HOST's — a
// 5:30pm practice in Los Angeles read "Sun, Oct 4, 12:30 AM" from a UTC host,
// and `toDateString()` decided "same day" on the host's calendar too.
function whenLabel(startsAt: string, endsAt: string | null, locale: LocaleCode, tz: string): string {
  const s = new Date(startsAt);
  const start = s.toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz });
  if (!endsAt) return start;
  const e = new Date(endsAt);
  const sameDay = dayKeyInTz(s, tz) === dayKeyInTz(e, tz);
  const end = e.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz });
  return sameDay ? `${start} – ${end}` : `${start} → ${e.toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz })}`;
}

/** The soonest events to consider, and the most overlaps worth showing at once.
 *  A resolver listing thousands of pairs is unusable long before it is slow. */
const MAX_EVENTS = 500;
const MAX_CONFLICTS = 100;

export default async function ConflictsPage() {
  const t = await getTranslations();
  // A server page: the locale comes from the request, as the translator does.
  const { locale } = await getLocaleContext();
  const ctx = await requireFeature('/dashboard/conflicts');
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const tz = ctx.active.family.timezone || 'UTC';

  const now = new Date();
  const in14 = new Date(now.getTime() + 14 * 24 * 3_600_000);

  // A failed read here is not "no conflicts". `detectConflicts([])` returns an
  // empty list, which this page renders as the all-clear — the one answer a
  // conflict detector must never give when it could not look.
  //
  // Series-aware, and overlapping the window (N3). This read raw rows by
  // `starts_at`, but a recurring event is ONE row whose `starts_at` is its
  // first occurrence (lib/calendar/occurrences.ts): a weekly practice created
  // last month had no row in the fortnight, so a one-off booked over it was
  // never a clash, and an event already under way was not read either. The
  // shared occurrence read — the one readiness, the briefs and the conflict
  // notifications use — expands every series in the family's zone.
  let bounds: ReturnType<typeof instantCalendarBounds>;
  try {
    bounds = instantCalendarBounds(now.toISOString(), in14.toISOString(), tz);
  } catch {
    console.error('[conflicts] calendar window could not be built', { familyId });
    return <ErrorState message={t('conflicts.couldNotCheckForClashes')} />;
  }
  const [{ data: events, count: eventCount, error: eventsError }, { data: members, error: membersError }] = await settleAll([
    readCalendarOccurrences(supabase, familyId, bounds, tz, {
      columns: ['id', 'title', 'starts_at', 'ends_at', 'all_day', 'location', 'assignee_id'],
      overlap: true,
      // Bounded on both sides: the read, and the pairs it can produce below.
      // Neither was, and a dense fortnight rendered a card per overlapping pair.
      // `count` is every occurrence in the window, so a capped read is said.
      limit: MAX_EVENTS,
    }),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
  ]);

  // `settleAll` hands back `{ data: null, error }` on a failed read, so
  // destructuring `{ data }` alone turns an outage into "no conflicts found" —
  // on the page whose entire job is finding them. That is the same shape as the
  // ledger reconciler rendering "everything reconciles" from a truncated read:
  // an absence presented as an all-clear.
  const readError = eventsError ?? membersError;
  if (readError) {
    console.error('[conflicts] calendar read failed', readError);
    return <ErrorState message={t('conflicts.couldNotCheckForClashes')} />;
  }

  const nameById = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  // Which ids are a series: an occurrence carries the series row's id.
  const seriesIds = new Set((events ?? []).filter(isSeries).map((e) => e.id));
  const timed: TimedEvent[] = (events ?? []).map((e) => ({
    id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day,
    location: e.location, assignee_id: e.assignee_id,
  }));
  // The fortnight was not read whole: not every event was checked, so an
  // empty list below is not an all-clear, and the page says so.
  const eventsCapped = (eventCount ?? 0) > timed.length;

  const conflicts = detectConflicts(timed, { maxConflicts: MAX_CONFLICTS });
  const truncated = conflicts.length >= MAX_CONFLICTS;
  // An occurrence is named by its series AND its start: two weeks of the same
  // pair of series are two clashes, not one card that resolves both.
  const occurrenceKey = (e: TimedEvent) => (seriesIds.has(e.id) ? `${e.id}@${e.starts_at}` : e.id);
  const views: ConflictView[] = conflicts.map((c) => {
    // No one-tap move for a recurring event: its row is the whole series, so
    // moving "this" occurrence would move every week (N11).
    const qf = seriesIds.has(c.b.id) ? null : quickFixMoveAfter(c);
    const ev = (e: TimedEvent) => ({
      id: e.id,
      title: e.title,
      whenLabel: whenLabel(e.starts_at, e.ends_at, locale.code, tz),
      location: e.location ?? null,
      assignee: e.assignee_id ? nameById.get(e.assignee_id) ?? null : null,
    });
    return {
      key: `${occurrenceKey(c.a)}:${occurrenceKey(c.b)}`,
      a: ev(c.a),
      b: ev(c.b),
      overlapLabel: `Overlaps ${c.overlapMinutes} min`,
      quickFix: qf
        ? {
            eventId: qf.eventId,
            label: qf.label,
            startsAtIso: qf.startsAtIso,
            endsAtIso: qf.endsAtIso,
            // The times the fix was computed from: the move is refused if the
            // event has changed since this render (N11).
            rendered: { startsAt: c.b.starts_at, endsAt: c.b.ends_at, allDay: c.b.all_day },
            newWhenLabel: whenLabel(qf.startsAtIso, qf.endsAtIso, locale.code, tz),
          }
        : null,
      aiPayload: {
        a: { title: c.a.title, starts_at: c.a.starts_at, ends_at: c.a.ends_at, location: c.a.location ?? null },
        b: { title: c.b.title, starts_at: c.b.starts_at, ends_at: c.b.ends_at, location: c.b.location ?? null },
      },
    };
  });

  return (
    <div className="module-page">
      <Link href="/dashboard/command-center" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> {t('dashboardConflicts.commandCenter')}
      </Link>
      <div className="flex items-center gap-3">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
          <CalendarClock className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t('dashboardConflicts.aiConflictResolution')}</h1>
          <p className="text-sm text-muted">{t('dashboardConflicts.overlappingEventsInTheNextTwo')}</p>
        </div>
      </div>

      {eventsCapped && (
        <p role="status" className="text-sm text-muted">
          {t('dashboardConflicts.onlyTheFirstEventsWereChecked', { count: MAX_EVENTS })}
        </p>
      )}
      {truncated && (
        <p className="text-sm text-muted">
          {t('dashboardConflicts.showingTheFirstConflicts', { count: MAX_CONFLICTS })}
        </p>
      )}
      <ConflictResolver conflicts={views} partial={eventsCapped} />
    </div>
  );
}

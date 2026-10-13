// The Conflicts screen's quick fix must say which week of an event it moves.
//
// "Apply & reschedule" calls `rescheduleEventAction` with the moved event's id
// and its new start and end. For a repeating event that start belongs to one
// week, and `updateEvent` wrote it into the series row, which is the
// re-anchoring the Edit modal and the assistant had
// (tests/editing-one-week-of-a-repeating-event-keeps-the-earlier-weeks.test.ts,
// tests/the-assistant-moves-one-week-of-a-repeating-event-without-losing-the-rest.test.ts).
// It was the last writer of an event's time that did not name the week it
// showed.
//
// The quick-fix math now records the start of the event it moves, the page and
// the card pass it on, and the action maps the move through the same service
// path. A repeating event is refused only when no week arrives at all, which
// only a tab still running the old page code can cause, and the family is told
// to refresh.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { detectConflicts, quickFixMoveAfter, type TimedEvent } from '@/lib/family/conflicts';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { rescheduleEventAction } from '@/app/(app)/dashboard/conflicts/actions';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const FAMILY = 'family-1';
const SWIM = '11111111-1111-4111-8111-111111111111';
const DENTIST = '22222222-2222-4222-8222-222222222222';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const row = (id: string) => db.table('calendar_events').find((r) => r.id === id)!;
const instant = (value: unknown) => new Date(String(value)).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      calendar_events: {
        description: null, location: null, ends_at: null, all_day: false, category: 'general',
        recurrence: 'none', recurrence_until: null, assignee_id: null, idempotency_key: null, feed_id: null, external_uid: null,
      },
    },
  });
  db.seed('calendar_events', [
    // Tuesdays 16:00-17:30 New York from 1 September; 3 November is EST (21:00Z).
    { id: SWIM, family_id: FAMILY, title: 'Swim', starts_at: '2026-09-01T20:00:00.000Z', ends_at: '2026-09-01T21:30:00.000Z', recurrence: 'weekly' },
    { id: DENTIST, family_id: FAMILY, title: 'Dentist', starts_at: '2026-11-03T20:30:00.000Z', ends_at: '2026-11-03T21:30:00.000Z' },
  ]);
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: { familyId: FAMILY, role: 'parent', family: { name: 'Family One', timezone: 'America/New_York' }, member: { id: 'member-1' } },
  });
  mocks.createServer.mockResolvedValue(db);
});

describe('the quick fix for one week of a repeating event', () => {
  // The 3 November swim (21:00Z-22:30Z) overlaps the dentist (20:30Z-21:30Z),
  // so the fix moves that week's swim to start when the dentist ends.
  const week: TimedEvent = { id: SWIM, title: 'Swim', starts_at: '2026-11-03T21:00:00.000Z', ends_at: '2026-11-03T22:30:00.000Z', all_day: false };
  const dentist: TimedEvent = { id: DENTIST, title: 'Dentist', starts_at: '2026-11-03T20:30:00.000Z', ends_at: '2026-11-03T21:30:00.000Z', all_day: false };

  it('records the start of the week it moves', () => {
    const fix = quickFixMoveAfter(detectConflicts([dentist, week])[0]!);
    expect(fix).toMatchObject({ eventId: SWIM, startsAtIso: '2026-11-03T21:30:00.000Z', occurrenceStartsAt: week.starts_at });
  });

  it('moves every week from the series\' first, not from the week on screen', async () => {
    const fix = quickFixMoveAfter(detectConflicts([dentist, week])[0]!)!;
    const result = await rescheduleEventAction(fix.eventId, fix.startsAtIso, fix.endsAtIso, fix.occurrenceStartsAt);
    expect(result.ok, result.error).toBe(true);
    // 16:30 New York: 20:30Z in September (EDT).
    expect(instant(row(SWIM).starts_at), 'the series was restarted on the week on screen').toBe('2026-09-01T20:30:00.000Z');
    expect(instant(row(SWIM).ends_at)).toBe('2026-09-01T22:00:00.000Z');
  });

  it('a repeating event with no week named is refused with a reason the family can act on, and nothing moves', async () => {
    const result = await rescheduleEventAction(SWIM, '2026-11-03T21:30:00.000Z', '2026-11-03T23:00:00.000Z');
    expect(result.ok, 'a week\'s time was written into the series').toBe(false);
    expect(result.error).toBe(MESSAGES['actions.thisEventRepeatsAndThis']);
    expect(instant(row(SWIM).starts_at)).toBe('2026-09-01T20:00:00.000Z');
  });

  it('a one-off event still moves with or without its start named', async () => {
    const without = await rescheduleEventAction(DENTIST, '2026-11-03T19:00:00.000Z', '2026-11-03T20:00:00.000Z');
    expect(without.ok, without.error).toBe(true);
    expect(instant(row(DENTIST).starts_at)).toBe('2026-11-03T19:00:00.000Z');
    const named = await rescheduleEventAction(DENTIST, '2026-11-03T18:00:00.000Z', '2026-11-03T19:00:00.000Z', '2026-11-03T19:00:00.000Z');
    expect(named.ok, named.error).toBe(true);
    expect(instant(row(DENTIST).starts_at)).toBe('2026-11-03T18:00:00.000Z');
  });
});

describe('the page and the card carry the week to the action', () => {
  it('the page puts the moved week on the quick fix it renders', () => {
    const page = readFileSync('app/(app)/dashboard/conflicts/page.tsx', 'utf8');
    expect(page).toMatch(/occurrenceStartsAt: qf\.occurrenceStartsAt,/);
  });

  it('the card hands it to the action', () => {
    const card = readFileSync('components/family/conflict-resolver.tsx', 'utf8');
    expect(card).toMatch(/rescheduleEventAction\(qf\.eventId, qf\.startsAtIso, qf\.endsAtIso, qf\.occurrenceStartsAt\)/);
  });

  it('the refusal is translated in every base locale', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(messages['actions.thisEventRepeatsAndThis'], locale).toBeTruthy();
      if (locale !== 'en-US') expect(messages['actions.thisEventRepeatsAndThis'], locale).not.toBe(MESSAGES['actions.thisEventRepeatsAndThis']);
    }
  });
});

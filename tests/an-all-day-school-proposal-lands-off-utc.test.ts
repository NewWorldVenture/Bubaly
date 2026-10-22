// A school front-desk proposal with a day and no time is an all-day event, and
// an approved one has to LAND for a family that is not in UTC.
//
// `buildProposal` emitted `starts_at: "${date}T00:00:00"` with `all_day: true`.
// On approval, `createEvent` reads a zone-less start in the family's zone
// (07:00Z in Los Angeles, 22:00Z the evening before in Berlin) and then
// requires an all-day start to be UTC midnight of its civil date — so every
// approved all-day proposal failed with "An event cannot end before it starts"
// for every family outside UTC. The approval test pinned `timezone: 'UTC'` and
// the classifier test pinned the broken shape, so CI could not see it. The tool
// contract (lib/ai/tools/calendar.ts) is a bare `YYYY-MM-DD` for all-day.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { buildProposal, classify } from '@/lib/front-desk/school-sports';
import { executeTool } from '@/lib/ai/tools/execute';

const OPTS = { now: '2026-09-09T12:00:00.000Z' };
const message = { subject: 'School closed', body: 'School is closed; the date has been changed to Oct 2.' };
const timed = { subject: 'School schedule change', body: 'The school field trip is rescheduled to September 16, 2026 at 4pm.' };

let db: InMemorySupabase & SupabaseClient<Database>;
const scope = (tz: string): ServiceScope => ({ db, familyId: 'fam-1', userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz });

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({ uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] } });
  holder.db = db;
  db.seed('family_members', [{ id: 'mem-1', family_id: 'fam-1', user_id: 'user-1', role: 'parent', display_name: 'Alex', is_active: true }]);
});

describe('buildProposal follows the calendar tool\'s contract', () => {
  it('a day with no time is a bare civil date, flagged all-day', () => {
    const proposal = buildProposal(message, classify(message, [], [], [], OPTS));
    expect(proposal).toMatchObject({ name: 'create_calendar_event', args: { starts_at: '2026-10-02', all_day: true, category: 'school' } });
  });

  it('a day with a time is a family-local clock, not all-day', () => {
    const proposal = buildProposal(timed, classify(timed, [], [], [], OPTS));
    expect(proposal).toMatchObject({ args: { starts_at: '2026-09-16T16:00:00', all_day: false } });
  });
});

describe('an approved all-day proposal is created for a family in any zone', () => {
  it.each(['America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'UTC'])('%s', async (tz) => {
    const proposal = buildProposal(message, classify(message, [], [], [], OPTS))!;
    // `skipTrust`, as the approval replay does: the parent's yes was the gate.
    const outcome = await executeTool(scope(tz), proposal.name, proposal.args, { skipTrust: true });
    expect(outcome.status, tz).toBe('ok');
    const rows = db.table('calendar_events') as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ all_day: true, title: 'School closed', category: 'school' });
    // An all-day row is stored as UTC midnight of its civil date, whatever the family's zone.
    expect(new Date(rows[0].starts_at as string).toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('and a timed proposal lands at the family\'s 4pm', async () => {
    const proposal = buildProposal(timed, classify(timed, [], [], [], OPTS))!;
    const outcome = await executeTool(scope('America/Los_Angeles'), proposal.name, proposal.args, { skipTrust: true });
    expect(outcome.status).toBe('ok');
    const rows = db.table('calendar_events') as Record<string, unknown>[];
    expect(new Date(rows[0].starts_at as string).toISOString()).toBe('2026-09-16T23:00:00.000Z');
    expect(rows[0].all_day).toBe(false);
  });
});

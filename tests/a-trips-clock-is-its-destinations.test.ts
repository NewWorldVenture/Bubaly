// `vacations.timezone` is the DESTINATION's zone: the confirmation-import RPC
// projects a booking's instant into it, the disruption re-flow resolves a
// flight's arrival into that day and clock, and itinerary `start_time` values
// are civil times in it. It was written as the FAMILY's home zone by the
// service and not at all by the UI, with nothing to edit it — so a Los Angeles
// family's Tokyo trip filed a 09:00 breakfast as the previous evening and a
// UI-created trip had NULL and the import refused with "set up the timezone"
// and no field to do so.
//
// Beside it, three small gates the same audit found open: the trip layout read
// the trip without a family filter (a dual-family member stamped the active
// family's id onto another family's rows), the Sports Hub had no plan gate
// while the sidebar declared it Family+, and the disruption form rendered for
// every role while the action refuses non-managers.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { findOrCreateVacation } from '@/lib/services/trips';
import { getTool } from '@/lib/ai/tools/registry';
import type { ServiceScope } from '@/lib/services/types';
import { FEATURE_CATALOG } from '@/lib/constants/feature-catalog';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

function scopeIn(tz: string) {
  const db = createInMemorySupabase({ defaults: { vacations: { status: 'planning', currency: 'USD' } } });
  const scope: ServiceScope = { db: db as unknown as SupabaseClient<Database>, familyId: 'fam-1', userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz };
  return { scope, trips: () => db.table('vacations') as Record<string, unknown>[] };
}

describe('findOrCreateVacation stores the destination zone', () => {
  it('writes the zone the caller names', async () => {
    const { scope, trips } = scopeIn('America/Los_Angeles');
    const res = await findOrCreateVacation(scope, { destination: 'Tokyo', startDate: '2026-11-01', endDate: '2026-11-08', timezone: 'Asia/Tokyo' });
    expect(res).toMatchObject({ ok: true, data: { created: true, vacation: { timezone: 'Asia/Tokyo' } } });
    expect(trips()[0].timezone).toBe('Asia/Tokyo');
  });

  it('defaults to the family zone for a trip close to home', async () => {
    const { scope } = scopeIn('America/Los_Angeles');
    const res = await findOrCreateVacation(scope, { destination: 'San Diego', startDate: '2026-11-01' });
    expect(res).toMatchObject({ ok: true, data: { vacation: { timezone: 'America/Los_Angeles' } } });
  });

  it('refuses a zone Intl does not know before any write', async () => {
    const { scope, trips } = scopeIn('America/Los_Angeles');
    expect(await findOrCreateVacation(scope, { destination: 'Mars', startDate: '2026-11-01', timezone: 'Mars/Olympus' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(trips()).toHaveLength(0);
  });

  it('the AI tool offers the zone, so "plan our Tokyo trip" can set it', () => {
    const tool = getTool('trips.findOrCreateVacation')!;
    expect(tool.input.safeParse({ destination: 'Tokyo', timezone: 'Asia/Tokyo' }).success).toBe(true);
  });
});

describe('the trip is editable and created with a zone in the UI', () => {
  const list = readFileSync('components/vacations/vacations-list.tsx', 'utf8');
  const overview = readFileSync('components/vacations/trip-overview.tsx', 'utf8');

  it('the create form validates and writes a destination time zone, defaulting to the family\'s', () => {
    expect(list).toContain("const timezone = form.timezone.trim() || clock.timeZone;");
    expect(list).toContain("if (!isValidTimezone(timezone)) return toastError(tr('vacationsList.unknownTimeZone'));");
    expect(list).toMatch(/is_international: form\.is_international,\s*timezone,/);
  });

  it('the overview edits it with a confirmed write and re-reads the trip', () => {
    expect(overview).toContain("from('vacations').update({ timezone })");
    expect(overview).toContain('.eq(\'family_id\', familyId).select(\'id\')');
    expect(overview).toContain('wroteNoRows(updated)');
    expect(overview).toContain('void tripQuery.refresh();');
  });
});

describe('the trip layout, the Sports Hub and the disruption form hold their gates', () => {
  it('the [id] layout reads the trip in the ACTIVE family only', () => {
    const layout = readFileSync('app/(app)/dashboard/vacations/[id]/layout.tsx', 'utf8');
    expect(layout).toContain(".from('vacations').select('*').eq('id', id).eq('family_id', ctx.active.familyId).maybeSingle()");
  });

  it('the Sports Hub is a catalogued Family+ feature and the page gates on it', () => {
    const entry = FEATURE_CATALOG.find((f) => f.href === '/dashboard/family-sports');
    expect(entry).toMatchObject({ defaultTier: 'plus' });
    const page = readFileSync('app/(app)/dashboard/family-sports/page.tsx', 'utf8');
    expect(page).toContain("requireFeature('/dashboard/family-sports')");
    expect(page).not.toContain('requireUserContext()');
  });

  it('the disruption form is shown to managers only', () => {
    const page = readFileSync('app/(app)/dashboard/vacations/[id]/travel/page.tsx', 'utf8');
    expect(page).toContain('{isManager(ctx.active.role) && <DisruptionForm vacationId={id} />}');
  });
});

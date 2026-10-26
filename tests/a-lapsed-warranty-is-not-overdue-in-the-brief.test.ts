// A warranty that has run out was "overdue" in every morning brief, for good.
//
// `buildConciergeDigest` (lib/concierge/digest.ts) classified any warranty past
// its end date as `overdue`, and both brief reads, the morning brief the cron
// pushes to the managers (`readMorningBrief`, lib/briefing/deliver.ts) and the
// Briefing page (`POST /api/ai/briefing`), read every warranty ending on or
// before the horizon, with no lower bound. So once a fridge's warranty lapsed,
// the pushed brief was titled "Morning brief: 1 overdue" every day, and
// "Fridge warranty — Expired 400 days ago" sat at the top of the brief, above
// that week's bills, with nothing anyone could do about it. Both reads are
// oldest-first with a limit of 20, so twenty lapsed warranties also pushed out
// the one that was really about to end.
//
// A warranty is a heads-up from 30 days before its end through the end day;
// after that it is history (the warranties page still lists it as expired).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { buildConciergeDigest } from '@/lib/concierge/digest';
import { deliverMorningBriefs, morningTarget, readMorningBrief } from '@/lib/briefing/deliver';
import { scopeForSystem } from '@/lib/services/scope';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { entitledServiceClient } from './helpers/entitled-service-client';

const mocks = vi.hoisted(() => ({ context: vi.fn(), server: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ 'accept-language': 'en-US' }),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: mocks.server,
  createServiceClient: () => entitledServiceClient(),
}));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => false, resolveProvider: async () => ({ complete: vi.fn() }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: async (_scope: unknown, _input: unknown, fn: (obs: { used: () => void }) => unknown) => fn({ used: () => {} }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ countHandledThisWeek: async () => ({ total: 0 }) }));
import { POST } from '@/app/api/ai/briefing/route';

type DB = SupabaseClient<Database>;
type DigestItem = { domain: string; title: string; urgency: string };
const warrantyTitles = (items: DigestItem[]) => items.filter((item) => item.domain === 'warranty').map((item) => item.title);

describe('the digest', () => {
  const NOW = '2026-09-07T12:00:00.000Z';

  it('does not call a lapsed warranty overdue, or list it at all', () => {
    const d = buildConciergeDigest({
      now: NOW,
      warranties: [
        { name: 'Fridge', expiresOn: '2025-08-01' },
        { name: 'Dryer', expiresOn: '2026-09-06' },
      ],
    });
    expect(warrantyTitles(d.items)).toEqual([]);
    expect(d.counts.overdue).toBe(0);
  });

  it('still gives the heads-up through the end day', () => {
    const d = buildConciergeDigest({
      now: NOW,
      warranties: [
        { name: 'Dishwasher', expiresOn: '2026-09-07' },
        { name: 'Oven', expiresOn: '2026-10-07' },
        { name: 'Roof', expiresOn: '2026-10-08' },
      ],
    });
    expect(d.items.filter((i) => i.domain === 'warranty').map((i) => [i.title, i.urgency])).toEqual([
      ['Dishwasher warranty', 'today'],
      ['Oven warranty', 'soon'],
    ]);
  });
});

// The notifications cron's tick: 7am in New York.
const TICK = new Date('2026-09-07T11:00:00Z');
const TZ = 'America/New_York';

/** Twenty-one warranties that ran out over the past years, one ending today and one in three days. */
function family(db: InMemorySupabase, familyId: string) {
  db.seed('families', [{ id: familyId, timezone: TZ }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: familyId, user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true },
  ]);
  db.seed('home_warranties', [
    ...Array.from({ length: 21 }, (_, i) => ({
      id: `w-lapsed-${i}`, family_id: familyId, name: `Old appliance ${i}`,
      expires_on: `20${String(10 + Math.floor(i / 12)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}-15`, deleted_at: null,
    })),
    { id: 'w-today', family_id: familyId, name: 'Washer', expires_on: '2026-09-07', deleted_at: null },
    { id: 'w-live', family_id: familyId, name: 'Dishwasher', expires_on: '2026-09-10', deleted_at: null },
  ]);
}

describe('the morning brief the managers are sent', () => {
  it('names the warranties about to end, not the ones long gone', async () => {
    const db = createInMemorySupabase<DB>();
    family(db, 'fam-1');
    const scope = scopeForSystem(db, { id: 'fam-1', timezone: TZ }, { now: TICK });

    const brief = await readMorningBrief(scope, morningTarget(TICK, TZ));

    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(warrantyTitles(brief.data.digest.items)).toEqual(['Washer warranty', 'Dishwasher warranty']);
    expect(brief.data.digest.counts.overdue).toBe(0);
  });

  it('is not titled overdue because of a lapsed warranty', async () => {
    const db = createInMemorySupabase<DB>();
    family(db, 'fam-1');

    await deliverMorningBriefs(db, TICK);

    const titles = db.table('notifications').map((row) => String(row.title));
    expect(titles).toHaveLength(1);
    expect(titles[0]).not.toMatch(/overdue/);
  });
});

describe('the Briefing page', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TICK);
    db = createInMemorySupabase<DB>();
    family(db, 'family');
    mocks.server.mockResolvedValue(db);
    mocks.context.mockResolvedValue({
      user: { id: 'auth-parent' },
      active: { familyId: 'family', role: 'parent', member: { id: 'm-parent', display_name: 'Alex' }, family: { name: 'Family', timezone: TZ } },
    });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden'); }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('lists the warranties about to end, not the ones long gone', async () => {
    const response = await POST(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: JSON.stringify({ type: 'morning' }) }));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(warrantyTitles(body.digest.items)).toEqual(['Washer warranty', 'Dishwasher warranty']);
    expect(body.digest.counts.overdue).toBe(0);
  });
});

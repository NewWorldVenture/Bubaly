// A warranty the family deleted is not in the brief.
//
// Deleting a warranty on the Home pages is a soft delete: `deleteWarranty`
// (app/(app)/dashboard/home/actions.ts) stamps `deleted_at`, and every other
// reader of `home_warranties` skips such rows: the warranties page
// (lib/home/queries.ts), search, the asset page and the twin projection.
//
// The two briefing reads did not. The morning brief the cron pushes to the
// managers (`readMorningBrief`, lib/briefing/deliver.ts) and the Briefing page
// (`POST /api/ai/briefing`) both read every warranty expiring within 30 days,
// deleted or not, so a warranty the family had thrown away was still
// announced every morning as "expires soon" or "expired", and counted in the
// brief's overdue total. Both reads are ordered oldest first with a limit of
// 20, so deleted warranties that expired long ago could also crowd the live
// ones out of the brief altogether.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
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

// The notifications cron's tick: 7am in New York.
const TICK = new Date('2026-09-07T11:00:00Z');
const TZ = 'America/New_York';

function family(db: InMemorySupabase, familyId: string) {
  db.seed('families', [{ id: familyId, timezone: TZ }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: familyId, user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true },
  ]);
  db.seed('home_warranties', [
    // Live: expires in three days.
    { id: 'w-live', family_id: familyId, name: 'Dishwasher', expires_on: '2026-09-10', deleted_at: null },
    // Deleted by the family: one expiring tomorrow, one that expired last week.
    { id: 'w-gone-soon', family_id: familyId, name: 'Old fridge', expires_on: '2026-09-08', deleted_at: '2026-09-01T10:00:00Z' },
    { id: 'w-gone-expired', family_id: familyId, name: 'Sold car stereo', expires_on: '2026-09-01', deleted_at: '2026-08-20T10:00:00Z' },
  ]);
}

type DigestItem = { domain: string; title: string };
const warrantyTitles = (items: DigestItem[]) => items.filter((item) => item.domain === 'warranty').map((item) => item.title);

describe('the morning brief the managers are sent', () => {
  it('names only the warranties the family still has', async () => {
    const db = createInMemorySupabase<DB>();
    family(db, 'fam-1');
    const scope = scopeForSystem(db, { id: 'fam-1', timezone: TZ }, { now: TICK });

    const brief = await readMorningBrief(scope, morningTarget(TICK, TZ));

    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(warrantyTitles(brief.data.digest.items)).toEqual(['Dishwasher warranty']);
    expect(brief.data.digest.counts.overdue).toBe(0);
  });

  it('does not tell the managers about an overdue warranty they deleted', async () => {
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

  it('lists only the warranties the family still has', async () => {
    const response = await POST(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: JSON.stringify({ type: 'morning' }) }));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(warrantyTitles(body.digest.items)).toEqual(['Dishwasher warranty']);
    expect(body.digest.counts.overdue).toBe(0);
  });
});

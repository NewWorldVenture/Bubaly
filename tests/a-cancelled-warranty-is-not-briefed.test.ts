// A warranty the family marked cancelled was still briefed.
//
// The warranty form offers Active, Expired, Claimed and Cancelled. Both brief
// reads, the morning brief the cron pushes to the managers
// (`readMorningBrief`, lib/briefing/deliver.ts) and the Briefing page
// (`POST /api/ai/briefing`), selected no status, so the extended warranty the
// family cancelled was announced every morning as "expires in N days" until its
// end date, as if there were still something to renew. A cancelled warranty is
// not briefed; the rest keep the 30-day heads-up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { morningTarget, readMorningBrief } from '@/lib/briefing/deliver';
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
type DigestItem = { domain: string; title: string };
const warrantyTitles = (items: DigestItem[]) => items.filter((item) => item.domain === 'warranty').map((item) => item.title);

// The notifications cron's tick: 7am in New York.
const TICK = new Date('2026-09-07T11:00:00Z');
const TZ = 'America/New_York';

function family(db: InMemorySupabase, familyId: string) {
  db.seed('families', [{ id: familyId, timezone: TZ }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: familyId, user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true },
  ]);
  db.seed('home_warranties', [
    { id: 'w-cancelled', family_id: familyId, name: 'Extended TV plan', status: 'cancelled', expires_on: '2026-09-08', deleted_at: null },
    { id: 'w-active', family_id: familyId, name: 'Dishwasher', status: 'active', expires_on: '2026-09-10', deleted_at: null },
    { id: 'w-claimed', family_id: familyId, name: 'Washer', status: 'claimed', expires_on: '2026-09-20', deleted_at: null },
  ]);
}

describe('the morning brief the managers are sent', () => {
  it('leaves out the warranty the family cancelled', async () => {
    const db = createInMemorySupabase<DB>();
    family(db, 'fam-1');
    const scope = scopeForSystem(db, { id: 'fam-1', timezone: TZ }, { now: TICK });

    const brief = await readMorningBrief(scope, morningTarget(TICK, TZ));

    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(warrantyTitles(brief.data.digest.items)).toEqual(['Dishwasher warranty', 'Washer warranty']);
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

  it('leaves out the warranty the family cancelled', async () => {
    const response = await POST(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: JSON.stringify({ type: 'morning' }) }));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(warrantyTitles(body.digest.items)).toEqual(['Dishwasher warranty', 'Washer warranty']);
  });
});

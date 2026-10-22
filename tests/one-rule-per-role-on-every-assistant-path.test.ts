// The assistant's read tools refuse a guest the household's school, sports and
// trip details, and a child its trips (lib/trust/engine.ts, guest/child
// sensitiveDomains). Two other assistant paths handed the same rows over:
//
//   • POST /api/ai/insights had no role check for kinds 'school', 'sports' and
//     'trips', so a guest asking the sports module's AI Assist got a model
//     summary naming each coach and every practice location;
//   • search.household lives in the 'tasks' domain and returned a vacation's
//     title, destination and dates to a guest that trips.getTrip refuses.
//
// Both now answer to the same view rule. This is the assistant's rule, not a
// database boundary — RLS still shows these rows in the app — and the tool
// comments that called the data "private to the adults" now say exactly that.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ role: 'guest' as string, createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: 'user-1' },
  active: { familyId: 'fam-1', role: holder.role, member: { id: 'mem-1' }, family: { name: 'The Rivers', timezone: 'UTC' } },
}) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: holder.createServer, createServiceClient: () => { throw new Error('no service client in this test'); } }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/ai/provider')>()), isAIConfigured: async () => true }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
// The first thing after the role checks: answering 429 here proves a caller got past them.
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: false, retryAfter: 60 }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { POST } from '@/app/api/ai/insights/route';
import { searchHousehold } from '@/lib/services/search';

const ask = async (role: string, kind: string) => {
  holder.role = role;
  const res = await POST(new Request('http://localhost/api/ai/insights', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, question: 'Where is practice on Thursday?' }),
  }));
  return { status: res.status, body: await res.json() as { error?: string } };
};

beforeEach(() => {
  holder.createServer.mockReset().mockResolvedValue(createInMemorySupabase());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('AI Assist summaries answer to the read tools\' rule', () => {
  it.each(['sports', 'school', 'trips'])('a guest asking for the %s summary is refused before any read', async (kind) => {
    expect(await ask('guest', kind)).toEqual({ status: 403, body: { error: 'insights.thatSummaryIsForThe' } });
    expect(holder.createServer).not.toHaveBeenCalled();
  });

  it('a child is refused the trips summary and keeps the school and sports ones', async () => {
    expect((await ask('child', 'trips')).status).toBe(403);
    expect((await ask('child', 'school')).status).toBe(429);
    expect((await ask('child', 'sports')).status).toBe(429);
  });

  it.each(['teen', 'caregiver', 'parent', 'adult'])('a %s still gets all three', async (role) => {
    for (const kind of ['sports', 'school', 'trips']) expect((await ask(role, kind)).status, `${role} ${kind}`).toBe(429);
  });

  it('a guest keeps the summaries of the shared surfaces a guest is for', async () => {
    expect((await ask('guest', 'meals')).status).toBe(429);
  });
});

describe('household search does not hand a guest or a child the trips trips.getTrip refuses them', () => {
  let db: InMemorySupabase;
  const scopeAs = (role: ServiceScope['role']): ServiceScope => ({
    db: db as unknown as SupabaseClient<Database>, familyId: 'fam-1', userId: 'user-1', memberId: 'mem-1', role, actorKind: 'member', tz: 'UTC',
  });

  beforeEach(() => {
    db = createInMemorySupabase();
    db.seed('vacations', [{ id: 'trip-1', family_id: 'fam-1', title: 'Tokyo spring break', destination: 'Tokyo', description: null, notes: null, start_date: '2027-03-20' }]);
    db.seed('trips', [{ id: 'old-1', family_id: 'fam-1', name: 'Tokyo 2024', destination: 'Tokyo', notes: null, start_date: '2024-04-01' }]);
    db.seed('calendar_events', [{ id: 'ev-1', family_id: 'fam-1', title: 'Tokyo call', description: null, location: null, starts_at: '2026-10-12T09:00:00Z' }]);
  });

  it.each(['guest', 'child'] as const)('a %s does not search the trip sources, and is told so', async (role) => {
    const res = await searchHousehold(scopeAs(role), 'Tokyo');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.searched).not.toContain('vacations');
    expect(res.data.searched).not.toContain('trips');
    expect(res.data.hits.map((h) => h.kind)).toEqual(['event']);
    expect(res.data.withheld).toEqual(expect.arrayContaining(['trip', 'vacation']));
  });

  it.each(['teen', 'caregiver', 'parent'] as const)('a %s still finds them', async (role) => {
    const res = await searchHousehold(scopeAs(role), 'Tokyo');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.hits.map((h) => h.kind).sort()).toEqual(['event', 'trip', 'vacation']);
    expect(res.data.withheld).not.toContain('vacation');
  });

  it('the search page names role-withheld kinds without calling them money', () => {
    const page = readFileSync('app/(app)/dashboard/search/page.tsx', 'utf8');
    expect(page).toContain("t('search.recordsNotSearchedForYourRole'");
    expect(page).toContain('withheld.filter((kind) => MANAGER_ONLY_KINDS.includes(kind))');
  });
});

describe('the tool comments say what is true', () => {
  it('no read tool calls school or sports data "private to the adults" any more', () => {
    for (const file of ['lib/ai/tools/sports.ts', 'lib/ai/tools/school.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('private to the adults');
    }
    expect(readFileSync('lib/trust/engine.ts', 'utf8')).toContain("That is the\n    // assistant's rule, not the database's");
  });
});

// Negative controls for the memory audit:
//  - SENSITIVE_TERMS must match inflected stems and plurals;
//  - the schedule, shopping and travel slices must honour "Allow memory" off;
//  - confirmFact must be a compare-and-set on the card's status;
//  - activity titles must not carry the remembered value.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import type { SliceEnv } from '@/lib/ai/context/policy';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const activity = vi.hoisted(() => ({ record: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: activity.record }));
vi.mock('@/lib/services/groceries', () => ({
  listOpen: async () => ({ ok: true, data: { listId: null, items: [] } }),
  pantryList: async () => ({ ok: true, data: { low: [], expiring: [] } }),
}));
vi.mock('@/lib/services/trips', () => ({ listTrips: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/services/calendar', () => ({
  findConflicts: async () => ({ ok: true, data: { conflicts: [], advisories: [], subjects: {}, events: {} } }),
}));
vi.mock('@/lib/services/calendar/search-occurrences', () => ({
  validateCalendarSearchWindow: () => undefined,
  searchCalendarOccurrences: async () => ({ ok: true, data: {
    events: [], source_events: [], totalVisibleCount: 0, matchedCount: 0, returnedCount: 0, truncated: false, horizonEndsAt: null, filterScope: 'all',
  } }),
}));

import { confirmFact, forgetFact, isSensitiveMemory, rememberFact } from '@/lib/services/memory';
import { shoppingSlice } from '@/lib/ai/context/slices/shopping';
import { scheduleSlice } from '@/lib/ai/context/slices/schedule';
import { travelSlice } from '@/lib/ai/context/slices/travel';

const NOW = new Date('2026-09-06T12:00:00.000Z');

function setup(settings: { memory_enabled: boolean } | 'error' | 'missing' = { memory_enabled: true }) {
  const db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      family_facts: { member_id: null, notes: null, is_pinned: false, source: 'user', confidence: null, expires_at: null, updated_at: '2026-09-01T00:00:00Z' },
      family_playbook_suggestions: { member_id: null, evidence: null, confidence: 60, expires_at: null, fact_id: null, status: 'suggested' },
    },
  });
  if (settings !== 'error' && settings !== 'missing') db.seed('family_ai_settings', [{ family_id: 'family-1', ...settings }]);
  const scope: ServiceScope = {
    db, familyId: 'family-1', userId: 'user-1', memberId: 'member-1',
    role: 'parent', actorKind: 'member', tz: 'UTC', now: NOW,
  };
  if (settings === 'error') {
    const from = db.from.bind(db);
    (db as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      if (table !== 'family_ai_settings') return from(table);
      const failing = { select: () => failing, eq: () => failing, maybeSingle: async () => ({ data: null, error: { message: 'synthetic refusal' } }) };
      return failing;
    };
  }
  return { db, scope };
}

const env: SliceEnv = {
  now: NOW, tz: 'UTC', todayKey: '2026-09-06', weekFromIso: '2026-09-06T00:00:00.000Z', weekToIso: '2026-09-13T00:00:00.000Z',
  viewer: { role: 'parent', memberId: 'member-1', canManage: true }, members: [], pageContext: null,
};

function seedPreferences(db: ReturnType<typeof setup>['db']) {
  db.seed('family_facts', [
    { id: 'shop', family_id: 'family-1', category: 'preference', label: 'Shopping day', value: 'We shop at Costco on SHOPMARKER', source: 'ai_conversation' },
    { id: 'sched', family_id: 'family-1', category: 'preference', label: 'Bedtime', value: 'Nothing after 8pm SCHEDMARKER', source: 'user' },
    { id: 'trav', family_id: 'family-1', category: 'preference', label: 'Flight seats', value: 'Window seat TRAVELMARKER', source: 'ai_inferred' },
  ]);
}

const slices = [
  ['shopping', shoppingSlice, 'SHOPMARKER'],
  ['schedule', scheduleSlice, 'SCHEDMARKER'],
  ['travel', travelSlice, 'TRAVELMARKER'],
] as const;

beforeEach(() => { activity.record.mockClear(); });

describe('SENSITIVE_TERMS matches stems and plurals', () => {
  it.each([
    'diagnosis', 'diagnosed with ADHD', 'therapy on tuesdays', 'therapist', 'pregnant', 'pregnancy',
    'medications', 'passwords', 'banking', 'prescriptions', 'credit cards',
  ])('treats %s as sensitive', (word) => {
    expect(isSensitiveMemory({ category: 'other', key: 'Note', content: word })).toBe(true);
  });
  it('treats the chat tool example (key Diagnosis, content ADHD) as sensitive', () => {
    expect(isSensitiveMemory({ category: 'other', key: 'Diagnosis', content: 'ADHD' })).toBe(true);
  });
  it.each(['Taco night', 'shopping on Sunday', 'spinach', 'Ping pong', 'Prefer a compact blender'])('leaves %s alone', (word) => {
    expect(isSensitiveMemory({ category: 'preference', key: 'Note', content: word })).toBe(false);
  });
});

describe('context slices honour "Allow memory" off', () => {
  it.each(slices)('%s slice keeps remembered facts when memory is on', async (_name, slice, marker) => {
    const { db, scope } = setup({ memory_enabled: true });
    seedPreferences(db);
    const res = await slice.load(scope, env);
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.lines.join('\n')).toContain(marker);
  });

  it.each(slices)('%s slice sends no remembered facts when memory is off', async (_name, slice, marker) => {
    const { db, scope } = setup({ memory_enabled: false });
    seedPreferences(db);
    const res = await slice.load(scope, env);
    expect(res.ok).toBe(true);
    const text = res.ok ? res.data.lines.join('\n') + JSON.stringify(res.data.data) : '';
    expect(text).not.toContain(marker);
  });

  it.each(slices)('%s slice fails closed on facts when the setting cannot be read', async (_name, slice, marker) => {
    const { db, scope } = setup('error');
    seedPreferences(db);
    const res = await slice.load(scope, env);
    expect(res.ok).toBe(true);
    const text = res.ok ? res.data.lines.join('\n') + JSON.stringify(res.data.data) : '';
    expect(text).not.toContain(marker);
  });
});

describe('confirmFact is a compare-and-set on the card', () => {
  function seedCard(db: ReturnType<typeof setup>['db'], status = 'suggested') {
    db.seed('family_playbook_suggestions', [{
      id: 'card-1', family_id: 'family-1', category: 'preference', label: 'Go-to dinner', value: 'Taco night',
      signature: 'ai_memory:abc', status,
    }]);
  }

  it('two concurrent confirms produce one fact', async () => {
    const { db, scope } = setup();
    seedCard(db);
    const results = await Promise.all([confirmFact(scope, 'card-1'), confirmFact(scope, 'card-1')]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const facts = db.table('family_facts');
    expect(facts).toHaveLength(1);
    expect(db.table('family_playbook_suggestions')[0]).toMatchObject({ status: 'accepted', fact_id: facts[0].id });
  });

  it('a dismissed card cannot be confirmed into a fact', async () => {
    const { db, scope } = setup();
    seedCard(db, 'dismissed');
    const res = await confirmFact(scope, 'card-1');
    expect(res.ok).toBe(false);
    expect(db.table('family_facts')).toHaveLength(0);
    expect(db.table('family_playbook_suggestions')[0]).toMatchObject({ status: 'dismissed' });
  });

  it('a confirm racing a dismissal does not turn the card back to accepted', async () => {
    const { db, scope } = setup();
    seedCard(db);
    const [confirmed] = await Promise.all([confirmFact(scope, 'card-1'), forgetFact(scope, 'card-1', { kind: 'suggestion' })]);
    expect(confirmed.ok).toBe(false);
    expect(db.table('family_facts')).toHaveLength(0);
    expect(db.table('family_playbook_suggestions')[0]).toMatchObject({ status: 'dismissed' });
  });
});

describe('activity titles do not carry remembered values', () => {
  it('rememberFact records the label only', async () => {
    const { scope } = setup();
    const res = await rememberFact(scope, { category: 'other', key: 'School', content: 'Maple Elementary VALUEMARKER', source: 'user' });
    expect(res.ok).toBe(true);
    const titles = activity.record.mock.calls.map((call) => (call as unknown as [unknown, { title: string }])[1].title);
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title).not.toContain('VALUEMARKER');
  });

  it('confirmFact records the label only', async () => {
    const { db, scope } = setup();
    db.seed('family_playbook_suggestions', [{
      id: 'card-2', family_id: 'family-1', category: 'other', label: 'School', value: 'Maple Elementary VALUEMARKER', signature: 'ai_memory:def',
    }]);
    expect((await confirmFact(scope, 'card-2')).ok).toBe(true);
    const titles = activity.record.mock.calls.map((call) => (call as unknown as [unknown, { title: string }])[1].title);
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title).not.toContain('VALUEMARKER');
  });
});

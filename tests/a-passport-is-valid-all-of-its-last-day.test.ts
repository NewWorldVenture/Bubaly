// S7 — a document's expiry is a DATE, and "needs you" read it as an instant.
//
// documentExpiryToNeed counted Math.floor((Date.parse('2026-10-20') - now) /
// day): midnight UTC against the current instant. `documents.expires_at` is a
// `date` (0002_tables.sql:349) — the last day the passport is valid on the
// family's wall. So for a Los Angeles family it said "expires today" the day
// before, "expired" from 17:00 PDT that evening, and "expired" all through the
// last valid day. The assistant's list_pending_decisions (POST /api/ai/chat)
// handed those titles to the model; the dashboard's Needs-attention card
// showed them.
//
// Driven through the real assistant toolbox, as /api/ai/chat builds it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';

const FAMILY = 'fam-la';
type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

async function pendingTitles(tz: string): Promise<{ title: string; urgency: string }[]> {
  const ctx = { familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role: 'parent', members: [{ id: 'mem-1', display_name: 'Sam' }], tz };
  const tools = wrapToolsWithTrust(buildAssistantTools(db, ctx), db, FAMILY, 'parent', 'mem-1');
  const tool = tools.find((t) => t.name === 'list_pending_decisions');
  if (!tool) throw new Error('list_pending_decisions is not in the toolbox');
  const result = await tool.execute({}) as { ok: boolean; items?: { title: string; urgency: string }[]; error?: string };
  expect(result.ok, result.error).toBe(true);
  return (result.items ?? []).filter((item) => item.title.startsWith('Passport'));
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>() as DB;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Exactly what an <input type="date"> writes into the DATE column.
  db.seed('documents', [{ id: 'd-passport', family_id: FAMILY, title: 'Passport', category: null, is_secure: false, expires_at: '2026-10-20' }]);
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); });

describe('a passport expiring 2026-10-20, for a family in Los Angeles', () => {
  it('the morning before, it expires tomorrow', async () => {
    vi.setSystemTime(new Date('2026-10-19T17:00:00Z')); // 10:00 PDT, Oct 19
    expect(await pendingTitles('America/Los_Angeles')).toEqual([{ title: 'Passport — expires in 1d', urgency: 'urgent' }]);
  });

  it('the evening before, it has not expired', async () => {
    vi.setSystemTime(new Date('2026-10-20T01:00:00Z')); // 18:00 PDT, Oct 19
    expect(await pendingTitles('America/Los_Angeles')).toEqual([{ title: 'Passport — expires in 1d', urgency: 'urgent' }]);
  });

  it('on its last valid day, it expires today', async () => {
    vi.setSystemTime(new Date('2026-10-20T19:00:00Z')); // noon PDT, Oct 20
    expect(await pendingTitles('America/Los_Angeles')).toEqual([{ title: 'Passport — expires today', urgency: 'urgent' }]);
  });

  it('the day after, it has expired', async () => {
    vi.setSystemTime(new Date('2026-10-21T19:00:00Z')); // noon PDT, Oct 21
    expect(await pendingTitles('America/Los_Angeles')).toEqual([{ title: 'Passport — expired', urgency: 'urgent' }]);
  });
});

describe('the same passport, for a family east of Greenwich', () => {
  it('is still valid all of its last day in Tokyo', async () => {
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z')); // 21:00 JST, Oct 20
    expect(await pendingTitles('Asia/Tokyo')).toEqual([{ title: 'Passport — expires today', urgency: 'urgent' }]);
  });
});

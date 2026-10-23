// A poll past its deadline is not an open decision in the Family Operating Index.
//
// A poll closes two ways: a manager presses Close (status 'closed'), or its
// `closes_at` passes (lib/voting/polls.ts isPollClosed — nothing flips the
// status when the deadline goes by). The voting page, the vote check and the
// AI insights all treat a poll past its deadline as closed. The index's
// snapshot read counted `status = 'open'` alone, so last month's "Pizza or
// tacos?" with a deadline long gone still counted as a decision the family had
// left open, every day, in the decisions backlog the index scores.
//
// The read now also asks that `closes_at` is unset or still ahead.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { buildSnapshot } from '@/lib/operating-index/server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const NOW = new Date('2026-10-23T15:00:00.000Z');

function familyWith(polls: { id: string; status: string; closes_at: string | null }[]) {
  const db = createInMemorySupabase<SupabaseClient<Database>>();
  db.seed('family_polls', polls.map((p) => ({ family_id: FAMILY, question: p.id, kind: 'single', ...p })));
  return db;
}

describe('open decisions in the operating index', () => {
  it('counts an open poll with no deadline, or one still ahead, and nothing else', async () => {
    const db = familyWith([
      { id: 'no-deadline', status: 'open', closes_at: null },
      { id: 'closes-tonight', status: 'open', closes_at: '2026-10-23T23:00:00.000Z' },
      { id: 'deadline-gone', status: 'open', closes_at: '2026-09-30T18:00:00.000Z' },
      { id: 'closed-by-hand', status: 'closed', closes_at: null },
    ]);
    const snapshot = await buildSnapshot(db, FAMILY, 'America/New_York', NOW);
    expect(snapshot.openVotes).toBe(2);
  });

  it('a poll whose deadline is this very minute has closed (isPollClosed: closes_at <= now)', async () => {
    const db = familyWith([{ id: 'closing-now', status: 'open', closes_at: NOW.toISOString() }]);
    expect((await buildSnapshot(db, FAMILY, 'America/New_York', NOW)).openVotes).toBe(0);
  });

  it('another family\'s open poll is not this family\'s decision', async () => {
    const db = familyWith([{ id: 'ours', status: 'open', closes_at: null }]);
    db.seed('family_polls', [{ id: 'theirs', family_id: 'family-2', question: 'theirs', kind: 'single', status: 'open', closes_at: null }]);
    expect((await buildSnapshot(db, FAMILY, 'America/New_York', NOW)).openVotes).toBe(1);
  });
});

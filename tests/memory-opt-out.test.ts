// "Allow memory" (Settings → Bubaly AI) promises two things in one line:
// "Let Bubaly remember what it learns about your family … and use it next
// time." The column existed, the toggle wrote it, and nothing read it — a
// family that switched memory off went on being learned from, and everything
// already remembered still went into every prompt.
//
// These tests are the two halves of that promise, plus the third thing the
// switch cannot be allowed to break: a person's own memory is theirs.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { rememberFact } from '@/lib/services/memory';
import { getTool } from '@/lib/ai/tools/registry';
import { memorySlice } from '@/lib/ai/context/slices/memory';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; payload?: unknown };

function makeDb(memoryEnabled: boolean, facts: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select' };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const reply = () => {
      if (table === 'family_ai_settings') {
        return { data: { family_id: 'fam-1', enabled: true, behavior: 'execute', category_behavior: {}, risk_overrides: {}, child_channels: {}, memory_enabled: memoryEnabled }, error: null };
      }
      if (table === 'family_facts') return { data: facts, error: null };
      if (call.kind === 'insert') return { data: { ...(call.payload as Record<string, unknown>), id: 'new-1', created_at: '', updated_at: '' }, error: null };
      return { data: [], error: null };
    };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: chain, eq: chain, is: chain, in: chain,
      ilike: chain, gte: chain,
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(reply()),
      maybeSingle: () => Promise.resolve({ ...reply(), data: Array.isArray(reply().data) ? (reply().data as unknown[])[0] ?? null : reply().data }),
      then: (resolve: (v: unknown) => void) => resolve(reply()),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

function scopeWith(db: SupabaseClient<Database>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-user-1', memberId: 'member-1', role: 'parent',
    actorKind: 'ai', tz: 'America/New_York', now: new Date('2026-09-05T12:00:00Z'),
  };
}

describe('memory off — Bubaly stops keeping what it notices', () => {
  it('refuses an inference, and writes nothing', async () => {
    const { db, calls } = makeDb(false);
    const res = await rememberFact(scopeWith(db), {
      category: 'preference', key: 'Go-to dinner', content: 'Taco night', source: 'ai_conversation', confidence: 70,
    });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(res.ok === false && res.error).toMatch(/memory switched off/i);
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('still writes what a person entered — their memory is not Bubaly’s', async () => {
    const { db, calls } = makeDb(false);
    const res = await rememberFact(scopeWith(db), {
      category: 'preference', key: 'Shoe size', content: 'US 3', source: 'user',
    });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.table === 'family_facts' && c.kind === 'insert')).toBe(true);
  });

  it('keeps remembering for a family that left it on', async () => {
    const { db, calls } = makeDb(true);
    const res = await rememberFact(scopeWith(db), {
      category: 'preference', key: 'Go-to dinner', content: 'Taco night', source: 'ai_conversation', confidence: 70,
    });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.kind === 'insert')).toBe(true);
  });
});

describe('a confirmed fact needs somebody who could have asked', () => {
  it('a background run cannot mint one, whatever source it claims', async () => {
    const { db, calls } = makeDb(true);
    const systemScope = { ...scopeWith(db), actorKind: 'system' as const, memberId: null };
    const res = await rememberFact(systemScope, {
      category: 'preference', key: 'Shopping day', content: 'Sunday', source: 'user',
    });
    expect(res).toMatchObject({ ok: true, data: { kind: 'suggestion' } });
    expect(calls.some((c) => c.table === 'family_facts' && c.kind === 'insert')).toBe(false);
  });
});

describe('memory off — Bubaly stops using what it already knows', () => {
  const FACTS = [
    { id: 'f1', family_id: 'fam-1', member_id: null, category: 'preference', label: 'Diet', value: 'vegetarian', notes: null, is_pinned: false, created_by: 'u', created_at: '', updated_at: '' },
  ];

  it('recall comes back empty rather than reading the family’s facts aloud', async () => {
    const { db } = makeDb(false, FACTS);
    const res = await getTool('memory.recall')!.execute(scopeWith(db), {});
    expect(res).toMatchObject({ ok: true, data: { facts: [] } });
  });

  it('recall still answers for a family that left it on', async () => {
    const { db } = makeDb(true, FACTS);
    const res = await getTool('memory.recall')!.execute(scopeWith(db), {});
    expect(res.ok === true && (res.data as { facts: unknown[] }).facts).toHaveLength(1);
  });

  it('the context slice says so instead of listing them', async () => {
    const { db } = makeDb(false, FACTS);
    const env = { viewer: { canManage: true }, members: [] } as never;
    const res = await memorySlice.load(scopeWith(db), env);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.data).toMatchObject({ facts: [], pending: [] });
    expect(res.data.lines?.join('\n')).toMatch(/asked Bubaly not to use what it remembers/);
  });

  it('the context slice still carries them for a family that left it on', async () => {
    const { db } = makeDb(true, FACTS);
    const env = { viewer: { canManage: true }, members: [] } as never;
    const res = await memorySlice.load(scopeWith(db), env);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.data.data as { facts: unknown[] }).facts).toHaveLength(1);
  });
});

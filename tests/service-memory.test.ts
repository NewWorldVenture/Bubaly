// Behavioural tests for the memory service. The policy under test (spec §14):
// a person's "remember" is a confirmed fact; anything the AI infers goes to
// the review inbox with its confidence and is invisible to recall until
// confirmed; medical and account details are never written by the AI; and
// "clear AI memory" removes only what Bubaly learned, never what a person
// typed.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  AI_MEMORY_MARKER,
  clearAiMemory,
  confirmFact,
  forgetFact,
  isSensitiveMemory,
  listMemories,
  memorySignature,
  recallFacts,
  rememberFact,
} from '@/lib/services/memory';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: chain,
      eq: filter, is: filter,
      // `in` is recorded distinctly, like `ilike` and `gte`: a set membership
      // and an equality are different assertions and a test should be able to
      // tell them apart.
      in: (c: string, v: unknown) => filter(`in:${c}`, v),
      ilike: (c: string, v: unknown) => filter(`ilike:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-user-1', memberId: 'member-1', role: 'parent',
    actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra,
  };
}

const FACT = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'fact-1', family_id: 'fam-1', member_id: 'member-2', category: 'preference', label: "Doesn't eat", value: 'mushrooms',
  notes: null, is_pinned: false, source: 'user', confidence: null, expires_at: null,
  created_by: 'auth-user-1', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...overrides,
});

const SUGGESTION = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'sug-1', family_id: 'fam-1', member_id: 'member-2', category: 'preference', label: 'Go-to dinner', value: 'Taco night',
  evidence: 'Mentioned in a conversation', confidence: 70, signature: 'ai_memory:abc', status: 'suggested', fact_id: null,
  created_by: 'auth-user-1', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...overrides,
});

describe('isSensitiveMemory', () => {
  it('refuses medical and account categories and credential-shaped words in any category', () => {
    expect(isSensitiveMemory({ category: 'medical', key: 'Allergy', content: 'peanuts' })).toBe(true);
    expect(isSensitiveMemory({ category: 'account', key: 'Netflix', content: 'family@example.com' })).toBe(true);
    expect(isSensitiveMemory({ category: 'other', key: 'Wifi', content: 'password is hunter2' })).toBe(true);
    expect(isSensitiveMemory({ category: 'preference', key: "Doesn't eat", content: 'mushrooms' })).toBe(false);
  });
});

describe('rememberFact — from a person', () => {
  it('writes a confirmed fact with the auth user id and the family id', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert' ? { data: FACT(), error: null } : { data: null, error: null }));
    const res = await rememberFact(scopeWith(db, { actorKind: 'ai' }), {
      category: 'preference', key: " Doesn't eat ", content: 'mushrooms', source: 'user', memberId: 'member-2',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ kind: 'fact', updated: false });
    const probe = calls[0];
    expect(probe.table).toBe('family_facts');
    expect(probe.filters).toMatchObject({ family_id: 'fam-1', member_id: 'member-2', "ilike:label": "Doesn't eat" });
    const insert = calls.find((c) => c.kind === 'insert' && c.table === 'family_facts');
    expect(insert?.payload).toEqual({
      family_id: 'fam-1', member_id: 'member-2', category: 'preference', label: "Doesn't eat", value: 'mushrooms',
      // 0265: a person said this, so it carries `source: 'user'`, no
      // confidence (nobody had to guess) and no expiry.
      notes: null, is_pinned: false, source: 'user', expires_at: null, created_by: 'auth-user-1',
    });
    expect(calls.some((c) => c.table === 'family_playbook_suggestions')).toBe(false);
  });

  it('updates the same label for the same person instead of duplicating it', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'update'
      ? { data: FACT({ value: 'mushrooms and olives' }), error: null }
      : { data: FACT(), error: null }));
    const res = await rememberFact(scopeWith(db), { key: "doesn't eat", content: 'mushrooms and olives', source: 'user', memberId: 'member-2' });
    expect(res.ok && res.data.kind === 'fact' && res.data.updated).toBe(true);
    const update = calls.find((c) => c.kind === 'update');
    expect(update?.filters).toMatchObject({ id: 'fact-1', family_id: 'fam-1' });
    expect(update?.payload).toMatchObject({ value: 'mushrooms and olives' });
    // 0265: restating a fact refreshes the value and clears any expiry, but it
    // must NOT rewrite provenance. A person correcting something Bubaly
    // inferred is not claiming to have said it first — and this very write is
    // what used to erase the `Learned by Bubaly` marker from the notes and
    // hide the row from "clear what Bubaly learned" for good.
    expect(update?.payload).not.toHaveProperty('source');
    expect(update?.payload).toMatchObject({ expires_at: null });
    expect(calls.some((c) => c.kind === 'insert' && c.table === 'family_facts')).toBe(false);
  });

  it('refuses a sensitive fact relayed through the assistant even when the source is the user', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await rememberFact(scopeWith(db, { actorKind: 'ai' }), { category: 'medical', key: 'Allergy', content: 'peanuts', source: 'user' });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('lets a person enter a medical fact through the UI directly', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert' ? { data: FACT({ category: 'medical' }), error: null } : { data: null, error: null }));
    const res = await rememberFact(scopeWith(db), { category: 'medical', key: 'Allergy', content: 'peanuts', source: 'user' });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.kind === 'insert')).toBe(true);
  });

  it('rejects an empty label or content before any query', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await rememberFact(scopeWith(db), { key: '', content: 'x', source: 'user' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await rememberFact(scopeWith(db), { key: 'x', content: '  ', source: 'user' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('rememberFact — inferred by the AI', () => {
  it('lands in the inbox unconfirmed with its confidence, evidence and a stable signature', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert' ? { data: SUGGESTION(), error: null } : { data: null, error: null }));
    const res = await rememberFact(scopeWith(db, { actorKind: 'ai' }), {
      category: 'preference', key: 'Go-to dinner', content: 'Taco night', source: 'ai_conversation', confidence: 70, memberId: 'member-2', note: 'Said "tacos again?" twice this week',
    });
    expect(res.ok && res.data.kind === 'suggestion' && !res.data.duplicate).toBe(true);
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.table).toBe('family_playbook_suggestions');
    expect(insert?.payload).toMatchObject({
      family_id: 'fam-1', member_id: 'member-2', category: 'preference', label: 'Go-to dinner', value: 'Taco night',
      confidence: 70, status: 'suggested', evidence: 'Said "tacos again?" twice this week',
      signature: memorySignature({ memberId: 'member-2', category: 'preference', key: 'go-to DINNER' }),
    });
    expect(calls.some((c) => c.table === 'family_facts')).toBe(false);
  });

  it('does not re-open a card that was already decided', async () => {
    const { db, calls } = makeDb(() => ({ data: SUGGESTION({ status: 'dismissed' }), error: null }));
    const res = await rememberFact(scopeWith(db, { actorKind: 'ai' }), { key: 'Go-to dinner', content: 'Taco night', source: 'ai_inferred' });
    expect(res.ok && res.data.kind === 'suggestion' && res.data.duplicate).toBe(true);
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('never infers a medical or account fact', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await rememberFact(scopeWith(db, { actorKind: 'ai' }), { category: 'preference', key: 'Meds', content: 'takes a prescription at 8', source: 'ai_conversation' });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('clamps a wild confidence into 0–100', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert' ? { data: SUGGESTION(), error: null } : { data: null, error: null }));
    await rememberFact(scopeWith(db, { actorKind: 'ai' }), { key: 'Bedtime', content: '8pm', source: 'ai_inferred', confidence: 400 });
    expect((calls.find((c) => c.kind === 'insert')?.payload as { confidence: number }).confidence).toBe(100);
  });
});

describe('recallFacts', () => {
  it('reads only the confirmed facts table, family-scoped, and filters by the query in memory', async () => {
    const { db, calls } = makeDb(() => ({
      data: [FACT(), FACT({ id: 'fact-2', label: 'Shoe size', value: 'US 3', is_pinned: true })],
      error: null,
    }));
    const res = await recallFacts(scopeWith(db), { query: 'mushroom', category: 'preference', memberId: 'member-2' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.map((f) => f.id)).toEqual(['fact-1']);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('family_facts');
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', category: 'preference', member_id: 'member-2' });
  });

  it('hides medical and account facts from a child, even when asked for them by category', async () => {
    const rows = [FACT(), FACT({ id: 'fact-3', category: 'medical', label: 'Allergy', value: 'peanuts' }), FACT({ id: 'fact-4', category: 'account', label: 'Bank', value: 'acct 1234' })];
    const { db } = makeDb(() => ({ data: rows, error: null }));
    // The recorder fake ignores the category filter, so assert on what must
    // never come back rather than on the exact list.
    const child = await recallFacts(scopeWith(db, { role: 'child', memberId: 'member-2' }), { category: 'medical' });
    expect(child.ok && child.data.every((f) => f.category !== 'medical' && f.category !== 'account')).toBe(true);
    const childAll = await recallFacts(scopeWith(db, { role: 'child', memberId: 'member-2' }));
    expect(childAll.ok && childAll.data.map((f) => f.id)).toEqual(['fact-1']);
    const parent = await recallFacts(scopeWith(db));
    expect(parent.ok && parent.data.map((f) => f.id).sort()).toEqual(['fact-1', 'fact-3', 'fact-4']);
  });

  it('does not recall a fact whose shelf life has run out', async () => {
    // 0265. A coat size and a school year stop being true on their own, and a
    // stale one steering a plan is worse than not knowing, because it reads as
    // confidently as a fresh one. The expired row stays in the table for a
    // person to update — `listMemories` still returns it — it just does not
    // reach a tool or the planner.
    const rows = [
      FACT(),
      FACT({ id: 'fact-past', label: 'Coat size', value: 'Age 8', expires_at: '2026-09-04T00:00:00.000Z' }),
      FACT({ id: 'fact-future', label: 'Swim class', value: 'Thursdays', expires_at: '2026-12-01T00:00:00.000Z' }),
    ];
    const { db } = makeDb(() => ({ data: rows, error: null }));
    const res = await recallFacts(scopeWith(db));
    expect(res.ok && res.data.map((f) => f.id).sort()).toEqual(['fact-1', 'fact-future']);
  });

  it('treats an unreadable expiry as no expiry rather than silently dropping the fact', async () => {
    const { db } = makeDb(() => ({ data: [FACT({ expires_at: 'not a date' })], error: null }));
    const res = await recallFacts(scopeWith(db));
    expect(res.ok && res.data.map((f) => f.id)).toEqual(['fact-1']);
  });

  it('puts pinned facts first when there is no query', async () => {
    const { db } = makeDb(() => ({ data: [FACT(), FACT({ id: 'fact-2', label: 'Shoe size', value: 'US 3', is_pinned: true })], error: null }));
    const res = await recallFacts(scopeWith(db));
    expect(res.ok && res.data.map((f) => f.id)).toEqual(['fact-2', 'fact-1']);
  });
});

describe('listMemories', () => {
  it('returns confirmed facts alongside only the still-suggested inbox cards', async () => {
    const { db, calls } = makeDb((call) => (call.table === 'family_facts'
      ? { data: [FACT()], error: null }
      : { data: [SUGGESTION()], error: null }));
    const res = await listMemories(scopeWith(db));
    expect(res.ok && res.data.facts.length === 1 && res.data.pending.length === 1).toBe(true);
    const inbox = calls.find((c) => c.table === 'family_playbook_suggestions');
    expect(inbox?.filters).toMatchObject({ family_id: 'fam-1', status: 'suggested' });
  });
});

describe('confirmFact', () => {
  it('copies the card into family_facts with the AI provenance marker and marks it accepted', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_playbook_suggestions' && call.kind === 'select') return { data: SUGGESTION(), error: null };
      if (call.table === 'family_facts' && call.kind === 'insert') return { data: FACT({ id: 'fact-9', notes: `${AI_MEMORY_MARKER} — Mentioned in a conversation` }), error: null };
      return { data: null, error: null };
    });
    const res = await confirmFact(scopeWith(db), 'sug-1');
    expect(res.ok && !res.data.alreadyAccepted && res.data.fact?.id === 'fact-9').toBe(true);
    const insert = calls.find((c) => c.table === 'family_facts' && c.kind === 'insert');
    expect(insert?.payload).toMatchObject({
      family_id: 'fam-1', member_id: 'member-2', category: 'preference', label: 'Go-to dinner', value: 'Taco night',
      notes: `${AI_MEMORY_MARKER} — Mentioned in a conversation`, created_by: 'auth-user-1',
      // 0265: accepting the card confirms the fact; it does not make it
      // something a person stated. The signature says which of the two AI
      // routes it came by, and the confidence — which this move used to
      // discard at the one moment somebody is deciding whether to keep it —
      // comes across unchanged.
      source: 'ai_conversation', confidence: 70,
    });
    const accept = calls.find((c) => c.table === 'family_playbook_suggestions' && c.kind === 'update');
    expect(accept?.filters).toMatchObject({ family_id: 'fam-1', id: 'sug-1' });
    expect(accept?.payload).toEqual({ status: 'accepted', fact_id: 'fact-9' });
  });

  it("calls the playbook miner's own card an inference, not something it heard", async () => {
    // The two are read differently by a family: `ai_conversation` is "you said
    // it and I kept it"; `ai_inferred` is Bubaly deriving it from what the
    // household does. Only this service's cards carry the `ai_memory:` prefix.
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_playbook_suggestions' && call.kind === 'select') return { data: SUGGESTION({ signature: 'meals:taco-night', confidence: 45 }), error: null };
      if (call.table === 'family_facts' && call.kind === 'insert') return { data: FACT({ id: 'fact-9' }), error: null };
      return { data: null, error: null };
    });
    await confirmFact(scopeWith(db), 'sug-1');
    const insert = calls.find((c) => c.table === 'family_facts' && c.kind === 'insert');
    expect(insert?.payload).toMatchObject({ source: 'ai_inferred', confidence: 45 });
  });

  it('is idempotent for an already-accepted card', async () => {
    const { db, calls } = makeDb((call) => (call.table === 'family_playbook_suggestions'
      ? { data: SUGGESTION({ status: 'accepted', fact_id: 'fact-9' }), error: null }
      : { data: FACT({ id: 'fact-9' }), error: null }));
    const res = await confirmFact(scopeWith(db), 'sug-1');
    expect(res.ok && res.data.alreadyAccepted && res.data.fact?.id === 'fact-9').toBe(true);
    expect(calls.some((c) => c.kind === 'insert' || c.kind === 'update')).toBe(false);
  });

  it('removes the fact again when the card cannot be marked accepted', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_playbook_suggestions' && call.kind === 'select') return { data: SUGGESTION(), error: null };
      if (call.table === 'family_playbook_suggestions' && call.kind === 'update') return { data: null, error: { code: '42501', message: 'permission denied' } };
      if (call.table === 'family_facts' && call.kind === 'insert') return { data: FACT({ id: 'fact-9' }), error: null };
      return { data: null, error: null };
    });
    const res = await confirmFact(scopeWith(db), 'sug-1');
    expect(res).toMatchObject({ ok: false, code: 'db' });
    const undo = calls.find((c) => c.table === 'family_facts' && c.kind === 'delete');
    expect(undo?.filters).toMatchObject({ family_id: 'fam-1', id: 'fact-9' });
  });

  it('is a parent/adult action', async () => {
    const { db, calls } = makeDb(() => ({ data: SUGGESTION(), error: null }));
    expect(await confirmFact(scopeWith(db, { role: 'teen' }), 'sug-1')).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });
});

describe('forgetFact', () => {
  it('deletes a fact, family-scoped', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'select' ? { data: FACT(), error: null } : { data: null, error: null }));
    const res = await forgetFact(scopeWith(db), 'fact-1');
    expect(res).toMatchObject({ ok: true, data: { kind: 'fact', label: "Doesn't eat" } });
    const del = calls.find((c) => c.kind === 'delete');
    expect(del?.table).toBe('family_facts');
    expect(del?.filters).toEqual({ family_id: 'fam-1', id: 'fact-1' });
  });

  it('lets a teen forget only facts about themselves', async () => {
    const { db, calls } = makeDb(() => ({ data: FACT({ member_id: 'member-2' }), error: null }));
    expect(await forgetFact(scopeWith(db, { role: 'teen', memberId: 'member-3' }), 'fact-1')).toMatchObject({ ok: false, code: 'denied' });
    expect(calls.some((c) => c.kind === 'delete')).toBe(false);
    const own = await forgetFact(scopeWith(db, { role: 'teen', memberId: 'member-2' }), 'fact-1');
    expect(own.ok).toBe(true);
  });

  it('dismisses an inbox card rather than deleting it', async () => {
    const { db, calls } = makeDb(() => ({ data: { label: 'Go-to dinner' }, error: null }));
    const res = await forgetFact(scopeWith(db), 'sug-1', { kind: 'suggestion' });
    expect(res).toMatchObject({ ok: true, data: { kind: 'suggestion', label: 'Go-to dinner' } });
    expect(calls[0]).toMatchObject({ table: 'family_playbook_suggestions', kind: 'update', payload: { status: 'dismissed' } });
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', id: 'sug-1' });
  });

  it('reports a missing fact honestly', async () => {
    const { db } = makeDb(() => ({ data: null, error: null }));
    expect(await forgetFact(scopeWith(db), 'nope')).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('clearAiMemory', () => {
  it("deletes facts by provenance, not by a prefix in the note, plus this service's inbox cards", async () => {
    // 0265. `ilike('notes', 'Learned by Bubaly%')` took a person's own fact if
    // they happened to write that sentence, and missed a real one whose note
    // had since been edited — which `rememberConfirmed` does on every restate.
    const { db, calls } = makeDb((call) => (call.table === 'family_facts'
      ? { data: [{ id: 'fact-7' }, { id: 'fact-8' }], error: null }
      : { data: [{ id: 'sug-1' }], error: null }));
    const res = await clearAiMemory(scopeWith(db, { actorKind: 'ai' }));
    expect(res).toMatchObject({ ok: true, data: { facts: 2, suggestions: 1 } });
    const [facts, suggestions] = calls.filter((c) => c.kind === 'delete');
    expect(facts.table).toBe('family_facts');
    expect(facts.filters).toEqual({ family_id: 'fam-1', 'in:source': ['ai_conversation', 'ai_inferred'] });
    expect(JSON.stringify(facts.filters)).not.toContain(AI_MEMORY_MARKER);
    expect(suggestions.table).toBe('family_playbook_suggestions');
    expect(suggestions.filters).toEqual({ family_id: 'fam-1', 'ilike:signature': 'ai_memory:%' });
  });

  it('is denied to anyone who cannot manage the family', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    expect(await clearAiMemory(scopeWith(db, { role: 'child' }))).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });
});

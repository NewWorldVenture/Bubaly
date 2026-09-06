import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { memoryTools } from '@/lib/ai/tools/memory';
import { memorySlice, type MemorySliceData } from '@/lib/ai/context/slices/memory';
import { viewerFor, type SliceEnv } from '@/lib/ai/context/policy';
import {
  confirmFact, listMemories, memorySignature, recallFacts, rememberFact,
  type MemorySource,
} from '@/lib/services/memory';
import type { ServiceResult, ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn(async () => undefined) }));

const NOW = new Date('2026-09-06T03:30:00.000Z');
const DEADLINE = '2026-09-07T16:00:00.000Z';
const OFFSET_DEADLINE = '2026-09-07T12:00:00-04:00';
const rememberTool = memoryTools.find((tool) => tool.name === 'memory.remember')!;

function setup() {
  const db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      family_facts: { member_id: null, notes: null, is_pinned: false, source: 'user', confidence: null, expires_at: null },
      family_playbook_suggestions: { member_id: null, evidence: null, confidence: 50, expires_at: null, fact_id: null, status: 'suggested' },
    },
    uniques: { family_playbook_suggestions: [['family_id', 'signature']] },
  });
  db.seed('family_ai_settings', [{ family_id: 'family-1', memory_enabled: true }]);
  const scope: ServiceScope = {
    db, familyId: 'family-1', userId: 'user-1', memberId: 'member-1',
    role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW,
  };
  return { db, scope };
}

function unwrap<T>(res: ServiceResult<T>): T {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function env(scope: ServiceScope): SliceEnv {
  return {
    now: scope.now!, tz: scope.tz, todayKey: '2026-09-06',
    weekFromIso: NOW.toISOString(), weekToIso: '2026-09-13T03:30:00.000Z',
    viewer: viewerFor(scope), members: [], pageContext: null,
  };
}

const input = { category: 'sizes', key: 'Shoe size', content: 'US 3', source: 'user' as const, memberId: 'member-2' };

describe('memory expiry through persistence and acceptance', () => {
  it.each(['user', 'import'] as const)('replaces an existing deadline for %s, preserving provenance and row scope', async (source) => {
    const { db, scope } = setup();
    db.seed('family_facts', [
      { id: 'own', family_id: scope.familyId, member_id: 'member-2', category: 'sizes', label: 'Shoe size', value: 'US 2', source: 'ai_conversation', confidence: 70, is_pinned: true, expires_at: NOW.toISOString() },
      { id: 'other-family', family_id: 'family-2', member_id: 'member-2', category: 'sizes', label: 'Shoe size', value: 'US 5', expires_at: null },
      { id: 'other-member', family_id: scope.familyId, member_id: 'member-3', category: 'sizes', label: 'Shoe size', value: 'US 6', expires_at: null },
    ]);
    const result = unwrap(await rememberFact(scope, { ...input, source, expiresAt: OFFSET_DEADLINE }));
    expect(result).toMatchObject({
      kind: 'fact', updated: true,
      fact: { id: 'own', value: 'US 3', source: 'ai_conversation', confidence: 70, is_pinned: true, expires_at: DEADLINE },
    });
    expect(db.table('family_facts')).toHaveLength(3);
    expect(db.table('family_facts').find((row) => row.id === 'other-family')).toMatchObject({ value: 'US 5', expires_at: null });
    expect(db.table('family_facts').find((row) => row.id === 'other-member')).toMatchObject({ value: 'US 6', expires_at: null });
    expect(unwrap(await recallFacts(scope, { memberId: 'member-2' })).map((fact) => fact.id)).toEqual(['own']);
  });

  it.each([undefined, null, '', ' ', '   '])('preserves canonical no-deadline inputs (%s), on insert and restatement', async (expiresAt) => {
    const { scope } = setup();
    const expiryInput = expiresAt === undefined ? {} : { expiresAt };
    expect(unwrap(await rememberFact(scope, { ...input, ...expiryInput }))).toMatchObject({ kind: 'fact', updated: false, fact: { expires_at: null } });
    unwrap(await rememberFact(scope, { ...input, expiresAt: DEADLINE }));
    expect(unwrap(await rememberFact(scope, { ...input, ...expiryInput }))).toMatchObject({ kind: 'fact', updated: true, fact: { expires_at: null } });
    const later = { ...scope, now: new Date(DEADLINE) };
    expect(unwrap(await recallFacts(later))).toHaveLength(1);
  });

  it('carries tool expiry into the pending row, acceptance, recall and context, stopping exactly at the deadline', async () => {
    const { db, scope } = setup();
    const toolResult = unwrap(await rememberTool.execute({ ...scope, actorKind: 'ai' }, rememberTool.input.parse({
      key: input.key, content: input.content, category: input.category, member_id: input.memberId,
      asked_for: false, confidence: 72, note: 'Said this during the fitting.', expires_at: OFFSET_DEADLINE,
    })));
    expect(rememberTool.output.parse(toolResult)).toMatchObject({ kind: 'suggestion', confirmed: false, expires_at: DEADLINE });
    expect(unwrap(await recallFacts(scope))).toEqual([]);
    const pending = unwrap(await listMemories(scope, { memberId: input.memberId })).pending[0];
    expect(pending).toMatchObject({
      family_id: scope.familyId, member_id: input.memberId, expires_at: DEADLINE,
      confidence: 72, evidence: 'Said this during the fitting.',
      signature: memorySignature({ memberId: input.memberId, category: input.category, key: input.key }),
    });
    const waitingContext = unwrap(await memorySlice.load(scope, env(scope)));
    expect(waitingContext.data).toMatchObject({ facts: [], pending: [{ expires_at: DEADLINE }] });
    expect(waitingContext.lines.join('\n')).toContain('Unconfirmed guess (not a fact, do not rely on it)');

    const accepted = unwrap(await confirmFact(scope, pending.id));
    expect(accepted).toMatchObject({
      alreadyAccepted: false,
      fact: { family_id: scope.familyId, member_id: input.memberId, expires_at: DEADLINE, source: 'ai_conversation', confidence: 72 },
    });
    expect(db.table('family_playbook_suggestions')[0]).toMatchObject({ status: 'accepted', fact_id: accepted.fact!.id, expires_at: DEADLINE });
    expect(unwrap(await recallFacts(scope)).map((fact) => fact.id)).toEqual([accepted.fact!.id]);
    expect(unwrap(await memorySlice.load(scope, env(scope))).data).toMatchObject({ facts: [{ id: accepted.fact!.id }], pending: [] });

    const atDeadline = { ...scope, now: new Date(DEADLINE) };
    expect(unwrap(await recallFacts(atDeadline))).toEqual([]);
    const expiredContext = unwrap(await memorySlice.load(atDeadline, env(atDeadline)));
    expect(expiredContext.data).toMatchObject({ facts: [], pending: [] });
    expect(expiredContext.lines.join('\n')).not.toContain('Shoe size');
    expect(unwrap(await listMemories(atDeadline)).facts).toHaveLength(1);
    expect(unwrap(await confirmFact(atDeadline, pending.id))).toMatchObject({ alreadyAccepted: true, fact: { expires_at: DEADLINE } });
    expect(db.table('family_facts')).toHaveLength(1);
  });

  it.each([undefined, null, '', ' ', '   '])('accepts legacy and new suggestions without expiry (%s)', async (expiresAt) => {
    const { scope } = setup();
    const result = unwrap(await rememberFact(scope, { ...input, source: 'ai_inferred', expiresAt }));
    if (result.kind !== 'suggestion') throw new Error('Expected pending suggestion');
    expect(result.suggestion.expires_at).toBeNull();
    expect(unwrap(await confirmFact(scope, result.suggestion.id)).fact?.expires_at).toBeNull();
  });

  it('treats a date-only deadline as midnight UTC, hides expired pending cards from context and refuses their acceptance', async () => {
    const { db, scope } = setup();
    const result = unwrap(await rememberFact(scope, { ...input, source: 'ai_conversation', expiresAt: '2026-09-07' }));
    if (result.kind !== 'suggestion') throw new Error('Expected pending suggestion');
    expect(result.suggestion.expires_at).toBe('2026-09-07T00:00:00.000Z');
    const later = { ...scope, now: new Date('2026-09-07T00:00:00.000Z') };
    expect(unwrap(await memorySlice.load(later, env(later))).data).toMatchObject({ pending: [] });
    expect(await confirmFact(later, result.suggestion.id)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(db.table('family_facts')).toEqual([]);
    expect(unwrap(await listMemories(later)).pending).toHaveLength(1);
  });

  it('keeps duplicate pending cards stable, including the deadline actually offered for review', async () => {
    const { scope } = setup();
    const original = unwrap(await rememberFact(scope, { ...input, source: 'ai_conversation', expiresAt: DEADLINE }));
    const duplicate = unwrap(await rememberFact(scope, { ...input, source: 'ai_conversation', expiresAt: '2027-01-01' }));
    expect(duplicate).toMatchObject({ kind: 'suggestion', duplicate: true, suggestion: { expires_at: DEADLINE } });
    if (original.kind !== 'suggestion' || duplicate.kind !== 'suggestion') throw new Error('Expected pending suggestions');
    expect(duplicate.suggestion.id).toBe(original.suggestion.id);
  });

  it('preserves canonical zoned minute precision and trimmed input', async () => {
    const { scope } = setup();
    expect(unwrap(await rememberFact(scope, { ...input, expiresAt: ' 2026-09-07T12:00-04:00 ' }))).toMatchObject({
      kind: 'fact', fact: { expires_at: DEADLINE },
    });
  });

  it('preserves the canonical stored timestamp precision on acceptance', async () => {
    const { db, scope } = setup();
    const expiresAt = '2026-09-07T16:00:00.123456+00:00';
    db.seed('family_playbook_suggestions', [{
      id: 'precise', family_id: scope.familyId, member_id: input.memberId,
      label: input.key, value: input.content, category: input.category,
      signature: 'ai_memory:precise', expires_at: expiresAt,
    }]);
    expect(unwrap(await confirmFact(scope, 'precise')).fact?.expires_at).toBe(expiresAt);
  });

  it('does not let tool retry deduplication swallow an explicit deadline change', () => {
    const { scope } = setup();
    const base = { key: input.key, content: input.content, asked_for: true };
    const keyFor = (expires_at?: string | null) => rememberTool.idempotencyFrom!(rememberTool.input.parse({ ...base, expires_at }), scope);
    expect(keyFor(DEADLINE)).not.toBe(keyFor('2027-01-01'));
    expect(keyFor(DEADLINE)).not.toBe(keyFor(null));
    expect(keyFor()).toBe(keyFor(null));
  });
});

describe('invalid expiry and existing memory restrictions', () => {
  const invalidValues = ['not a date', '2026-02-30', '2026-09-07T12:00:00', '2026-09-07T25:00:00Z', '2026-09-07T24:00:00Z', '2026-09-07T12:60:00Z', '2026-09-07T12:00:60Z', '2026-09-07T12:00:00+30:00', '2026-09-07T12:00:00+00:60'];
  it.each(invalidValues)('rejects %j in both lanes before any database work', async (expiresAt) => {
    const { db, scope } = setup();
    for (const source of ['user', 'ai_conversation'] as const) {
      expect(await rememberFact(scope, { ...input, source, expiresAt })).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(db.log).toEqual([]);
    expect(db.table('family_facts')).toEqual([]);
    expect(db.table('family_playbook_suggestions')).toEqual([]);
  });

  it('rejects invalid expiry through the tool too', async () => {
    const { db, scope } = setup();
    expect(await rememberTool.execute(scope, rememberTool.input.parse({
      key: input.key, content: input.content, asked_for: true, expires_at: 'not a date',
    }))).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(db.table('family_facts')).toEqual([]);
  });

  it('does not replace an existing deadline when a restatement has invalid expiry', async () => {
    const { scope } = setup();
    unwrap(await rememberFact(scope, { ...input, expiresAt: DEADLINE }));
    expect(await rememberFact(scope, { ...input, content: 'US 4', expiresAt: 'invalid' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(unwrap(await recallFacts(scope))[0]).toMatchObject({ value: input.content, expires_at: DEADLINE });
  });

  it('refuses a malformed persisted suggestion deadline without accepting or inserting', async () => {
    const { db, scope } = setup();
    db.seed('family_playbook_suggestions', [{ id: 'bad', family_id: scope.familyId, label: 'Shoe size', value: 'US 3', category: 'sizes', signature: 'ai_memory:bad', expires_at: 'not a date' }]);
    expect(await confirmFact(scope, 'bad')).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(db.table('family_facts')).toEqual([]);
    expect(db.table('family_playbook_suggestions')[0].status).toBe('suggested');
  });

  it('requires a manager and the matching family to accept a suggestion with expiry', async () => {
    const { db, scope } = setup();
    const pending = unwrap(await rememberFact(scope, { ...input, source: 'ai_conversation', expiresAt: DEADLINE }));
    if (pending.kind !== 'suggestion') throw new Error('Expected pending suggestion');
    for (const role of ['child', 'teen'] as const) {
      expect(await confirmFact({ ...scope, role }, pending.suggestion.id)).toMatchObject({ ok: false, code: 'denied' });
    }
    expect(await confirmFact({ ...scope, familyId: 'family-2' }, pending.suggestion.id)).toMatchObject({ ok: false, code: 'not_found' });
    expect(unwrap(await listMemories({ ...scope, familyId: 'family-2' }))).toEqual({ facts: [], pending: [] });
    expect(unwrap(await listMemories(scope, { memberId: 'member-3' }))).toEqual({ facts: [], pending: [] });
    const child = { ...scope, role: 'child' as const };
    expect((unwrap(await memorySlice.load(child, env(child))).data as MemorySliceData).pending).toEqual([]);
    expect(db.table('family_facts')).toEqual([]);
    expect(db.table('family_playbook_suggestions')[0].status).toBe('suggested');
  });

  it.each(['user', 'ai_conversation', 'ai_inferred'] as MemorySource[])('expiry does not bypass sensitive memory restrictions for AI source %s', async (source) => {
    const { db, scope } = setup();
    expect(await rememberFact({ ...scope, actorKind: 'ai' }, {
      ...input, source, category: 'medical', key: 'Allergy', content: 'peanuts', expiresAt: DEADLINE,
    })).toMatchObject({ ok: false, code: 'denied' });
    expect(db.log).toEqual([]);
  });

  it('keeps the opt-out and background explicit-acceptance boundary with expiry', async () => {
    const { db, scope } = setup();
    db.replace('family_ai_settings', [{ family_id: scope.familyId, memory_enabled: false }]);
    expect(await rememberFact(scope, { ...input, source: 'ai_conversation', expiresAt: DEADLINE })).toMatchObject({ ok: false, code: 'denied' });
    expect(db.table('family_playbook_suggestions')).toEqual([]);
    db.replace('family_ai_settings', [{ family_id: scope.familyId, memory_enabled: true }]);
    expect(unwrap(await rememberFact({ ...scope, actorKind: 'system', memberId: null }, {
      ...input, expiresAt: DEADLINE,
    }))).toMatchObject({ kind: 'suggestion', suggestion: { expires_at: DEADLINE } });
    expect(db.table('family_facts')).toEqual([]);
  });

  it('still withholds unexpired sensitive confirmed facts from children', async () => {
    const { scope } = setup();
    unwrap(await rememberFact(scope, { ...input, category: 'medical', key: 'Allergy', content: 'peanuts', expiresAt: DEADLINE }));
    expect(unwrap(await recallFacts(scope))).toHaveLength(1);
    const child = { ...scope, role: 'child' as const };
    expect(unwrap(await recallFacts(child))).toEqual([]);
    expect(unwrap(await memorySlice.load(child, env(child))).data).toMatchObject({ facts: [], pending: [] });
  });
});

// Memory context is data too: notes become confirmed notes or suggestion
// evidence, and accepting evidence copies it back into confirmed notes.
// These tests execute the actual tool/service/export builder against the
// repository's query-capable in-memory client. They do not prove SQL/RLS,
// direct browser reads, live Auth, model behavior, or deployed privacy.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryTools } from '@/lib/ai/tools/memory';
import {
  confirmFact, isSensitiveMemory, listMemories, recallFacts, rememberFact, updateFact,
  type Memories, type RememberInput,
} from '@/lib/services/memory';
import { buildFamilyExport, serializeExport } from '@/lib/privacy/export';
import type { ServiceScope, ServiceResult } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const FAMILY = 'synthetic-memory-family';
const FOREIGN = 'synthetic-other-family';
const NOW = new Date('2026-10-01T12:00:00Z');
const sensitiveNotes = [
  'Synthetic passport number FAKE-ONLY',
  'Synthetic password FAKE-ONLY',
  'Synthetic prescription context FAKE-ONLY',
];
const BENIGN = 'Meet at the side gate after school';
const INPUT: RememberInput = { category: 'other', key: 'Arrival', content: 'After school', source: 'user' };
const tool = memoryTools.find((definition) => definition.name === 'memory.remember')!;

let db: InMemorySupabase;

function scope(role: ServiceScope['role'] = 'parent', actorKind: ServiceScope['actorKind'] = 'member', familyId = FAMILY): ServiceScope {
  return {
    db: db as unknown as ServiceScope['db'], familyId, role, actorKind,
    userId: `synthetic-user-${role}`, memberId: `synthetic-member-${role}`, tz: 'UTC', now: NOW,
  };
}

function data<T>(result: ServiceResult<T>): T {
  expect(result.ok, result.ok ? '' : result.error).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function seedFact(overrides: Record<string, unknown> = {}) {
  db.seed('family_facts', [{
    id: 'synthetic-fact', family_id: FAMILY, member_id: null,
    category: 'other', label: 'Arrival', value: 'After school', created_by: 'synthetic-user-parent',
    ...overrides,
  }]);
}

function seedSuggestion(evidence: string) {
  db.seed('family_playbook_suggestions', [{
    id: 'synthetic-suggestion', family_id: FAMILY, member_id: null,
    category: 'other', label: 'Arrival', value: 'After school', evidence,
    confidence: 75, signature: 'ai_memory:synthetic', status: 'suggested', created_by: 'synthetic-user-parent',
  }]);
}

beforeEach(() => {
  db = createInMemorySupabase({
    defaults: {
      family_facts: { notes: null, is_pinned: false, source: 'user', expires_at: null, confidence: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString() },
      family_playbook_suggestions: { expires_at: null, fact_id: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString() },
    },
  });
  db.seed('families', [{ id: FAMILY, name: 'Synthetic household', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: 'synthetic-member-parent', family_id: FAMILY, user_id: 'synthetic-user-parent', role: 'parent', display_name: 'Synthetic parent', is_active: true },
    { id: 'synthetic-member-child', family_id: FAMILY, user_id: 'synthetic-user-child', role: 'child', display_name: 'Synthetic child', is_active: true },
  ]);
});

describe('sensitive memory context', () => {
  it.each(sensitiveNotes)('classifies notes and evidence without requiring a sensitive label: %s', (context) => {
    expect(isSensitiveMemory({ ...INPUT, notes: context })).toBe(true);
    expect(isSensitiveMemory({ ...INPUT, evidence: context })).toBe(true);
    expect(isSensitiveMemory({ ...INPUT, notes: BENIGN, evidence: null })).toBe(false);
  });

  for (const askedFor of [true, false]) {
    it.each(sensitiveNotes)(`refuses a parsed tool note before writing, asked_for=${askedFor}: %s`, async (note) => {
      const input = tool.input.parse({ category: 'other', key: INPUT.key, content: INPUT.content, note, asked_for: askedFor });
      expect(await tool.execute(scope('parent', 'ai'), input)).toMatchObject({ ok: false, code: 'denied' });
      expect(db.table('family_facts')).toEqual([]);
      expect(db.table('family_playbook_suggestions')).toEqual([]);
      expect(db.table('audit_logs')).toEqual([]);
    });
  }

  it.each([
    { role: 'parent', actorKind: 'ai', source: 'user' },
    { role: 'parent', actorKind: 'ai', source: 'import' },
    { role: 'parent', actorKind: 'ai', source: 'ai_conversation' },
    { role: 'parent', actorKind: 'member', source: 'ai_inferred' },
    { role: 'system', actorKind: 'system', source: 'user' },
    { role: 'child', actorKind: 'member', source: 'user' },
    { role: 'teen', actorKind: 'member', source: 'import' },
  ] satisfies Array<{ role: ServiceScope['role']; actorKind: ServiceScope['actorKind']; source: RememberInput['source'] }>)('the service also refuses note-only sensitivity for $role/$actorKind/$source', async ({ role, actorKind, source }) => {
    expect(await rememberFact(scope(role, actorKind), { ...INPUT, source, note: sensitiveNotes[0] })).toMatchObject({ ok: false, code: 'denied' });
    expect(db.table('family_facts')).toEqual([]);
    expect(db.table('family_playbook_suggestions')).toEqual([]);
    expect(db.table('audit_logs')).toEqual([]);
  });

  it('a benign inferred tool note still reaches the review inbox as evidence', async () => {
    data(await tool.execute(scope('parent', 'ai'), tool.input.parse({ category: 'other', key: INPUT.key, content: INPUT.content, note: BENIGN, asked_for: false })));
    expect(db.table('family_facts')).toEqual([]);
    expect(db.table('family_playbook_suggestions')).toHaveLength(1);
    expect(db.table('family_playbook_suggestions')[0]).toMatchObject({ evidence: BENIGN, status: 'suggested' });
    expect(data(await listMemories(scope('child'))).pending[0].evidence).toBe(BENIGN);
  });

  it('a benign explicitly requested tool note still becomes a confirmed fact', async () => {
    data(await tool.execute(scope('parent', 'ai'), tool.input.parse({ category: 'other', key: INPUT.key, content: INPUT.content, note: BENIGN, asked_for: true })));
    expect(db.table('family_playbook_suggestions')).toEqual([]);
    expect(db.table('family_facts')).toHaveLength(1);
    expect(data(await recallFacts(scope('child')))[0].notes).toBe(BENIGN);
  });
});

describe('stored context is checked on every service read', () => {
  for (const role of ['parent', 'adult', 'system'] as const) {
    it(`preserves ${role} visibility of deliberately entered context`, async () => {
      const viewer = scope(role, role === 'system' ? 'system' : 'member');
      if (role === 'system') seedFact({ notes: sensitiveNotes[1] });
      else data(await rememberFact(viewer, { ...INPUT, note: sensitiveNotes[1] }));
      expect(data(await listMemories(viewer)).facts[0].notes).toBe(sensitiveNotes[1]);
      expect(data(await recallFacts(viewer))[0].notes).toBe(sensitiveNotes[1]);
    });
  }

  for (const role of ['teen', 'child', 'caregiver', 'guest'] as const) {
    it(`withholds existing sensitive notes and evidence from ${role}, retaining benign rows`, async () => {
      seedFact({ notes: sensitiveNotes[0] });
      seedFact({ id: 'synthetic-benign-fact', label: 'Meeting', notes: BENIGN });
      seedSuggestion(sensitiveNotes[2]);
      db.seed('family_playbook_suggestions', [{ ...db.table('family_playbook_suggestions')[0], id: 'synthetic-benign-suggestion', label: 'Meeting', evidence: BENIGN }]);
      const memories = data(await listMemories(scope(role)));
      expect(memories.facts.map((fact) => fact.id)).toEqual(['synthetic-benign-fact']);
      expect(memories.pending.map((suggestion) => suggestion.id)).toEqual(['synthetic-benign-suggestion']);
      expect(data(await recallFacts(scope(role))).map((fact) => fact.id)).toEqual(['synthetic-benign-fact']);
      expect(data(await recallFacts(scope(role), { complete: true })).map((fact) => fact.id)).toEqual(['synthetic-benign-fact']);
      expect(data(await recallFacts(scope(role), { query: 'passport number' }))).toEqual([]);
    });
  }

  it('a manager can review both sensitive metadata fields in existing rows', async () => {
    seedFact({ notes: sensitiveNotes[0] });
    seedSuggestion(sensitiveNotes[2]);
    const memories = data(await listMemories(scope()));
    expect(memories.facts[0].notes).toBe(sensitiveNotes[0]);
    expect(memories.pending[0].evidence).toBe(sensitiveNotes[2]);
  });

  it('a foreign family never receives confirmed notes or pending evidence', async () => {
    seedFact({ notes: BENIGN });
    seedSuggestion(BENIGN);
    expect(data(await listMemories(scope('parent', 'member', FOREIGN)))).toEqual({ facts: [], pending: [] });
    expect(data(await recallFacts(scope('parent', 'member', FOREIGN)))).toEqual([]);
  });

  it('accepting legacy sensitive evidence preserves it for managers and keeps it hidden from a child', async () => {
    seedSuggestion(sensitiveNotes[1]);
    const accepted = data(await confirmFact(scope(), 'synthetic-suggestion'));
    expect(accepted.fact?.notes).toBe(`Learned by Bubaly — ${sensitiveNotes[1]}`);
    expect(db.table('family_playbook_suggestions')[0].status).toBe('accepted');
    expect(data(await recallFacts(scope('child')))).toEqual([]);
    expect(data(await listMemories(scope('child'))).facts).toEqual([]);
    expect(data(await recallFacts(scope()))[0].notes).toBe(accepted.fact?.notes);
  });
});

describe('editing notes evaluates the resulting row', () => {
  it('refuses a notes-only sensitive edit to the child’s own otherwise ordinary fact', async () => {
    seedFact({ member_id: 'synthetic-member-child', created_by: 'synthetic-user-child' });
    expect(await updateFact(scope('child'), 'synthetic-fact', { notes: sensitiveNotes[2] })).toMatchObject({ ok: false, code: 'denied' });
    expect(db.table('family_facts')[0].notes).toBeNull();
    expect(db.table('audit_logs')).toEqual([]);
  });

  it('a pin-only or value-only edit does not hide the inherited sensitive note from the write gate', async () => {
    seedFact({ member_id: 'synthetic-member-child', created_by: 'synthetic-user-child', notes: sensitiveNotes[0] });
    for (const patch of [{ pinned: true }, { value: 'Before school' }]) {
      expect(await updateFact(scope('child'), 'synthetic-fact', patch)).toMatchObject({ ok: false, code: 'denied' });
    }
    expect(db.table('family_facts')[0]).toMatchObject({ notes: sensitiveNotes[0], value: INPUT.content, is_pinned: false });
  });

  it.each([null, '', '  '])('explicitly clearing a sensitive note (%j) checks the cleared row', async (notes) => {
    seedFact({ member_id: 'synthetic-member-child', created_by: 'synthetic-user-child', notes: sensitiveNotes[0] });
    data(await updateFact(scope('child'), 'synthetic-fact', { notes }));
    expect(db.table('family_facts')[0].notes).toBeNull();
    expect(data(await recallFacts(scope('child')))[0].notes).toBeNull();
  });

  it('a manager can preserve sensitive notes during an unrelated edit', async () => {
    seedFact({ notes: sensitiveNotes[2] });
    data(await updateFact(scope(), 'synthetic-fact', { pinned: true }));
    expect(db.table('family_facts')[0]).toMatchObject({ notes: sensitiveNotes[2], is_pinned: true });
  });

  it('a benign notes-only edit remains allowed and readable', async () => {
    seedFact({ member_id: 'synthetic-member-child', created_by: 'synthetic-user-child' });
    data(await updateFact(scope('child'), 'synthetic-fact', { notes: BENIGN }));
    expect(data(await recallFacts(scope('child')))[0].notes).toBe(BENIGN);
  });
});

describe('the actual family export uses the same context boundary', () => {
  it('withholds parent-entered sensitive notes and legacy evidence from a different child’s serialized export', async () => {
    data(await rememberFact(scope(), { ...INPUT, note: sensitiveNotes[0] }));
    data(await rememberFact(scope(), { ...INPUT, key: 'Meeting', note: BENIGN }));
    seedSuggestion(sensitiveNotes[2]);
    const child = await buildFamilyExport(scope('child'));
    expect(child.ok).toBe(true);
    if (!child.ok) throw new Error(JSON.stringify(child.failed));
    const memories = child.data.sections.find((section) => section.key === 'memories')!.data as Memories;
    expect(memories.facts.map((fact) => fact.label)).toEqual(['Meeting']);
    expect(memories.pending).toEqual([]);
    const serialized = await new Response(serializeExport(child.data)).text();
    expect(serialized).toContain(BENIGN);
    expect(serialized).not.toContain(sensitiveNotes[0]);
    expect(serialized).not.toContain(sensitiveNotes[2]);
    const parent = await buildFamilyExport(scope());
    expect(parent.ok).toBe(true);
    if (!parent.ok) throw new Error(JSON.stringify(parent.failed));
    const managerData = parent.data.sections.find((section) => section.key === 'memories')!.data as Memories;
    expect(managerData.facts.find((fact) => fact.label === INPUT.key)?.notes).toBe(sensitiveNotes[0]);
    expect(managerData.pending[0].evidence).toBe(sensitiveNotes[2]);
  });
});

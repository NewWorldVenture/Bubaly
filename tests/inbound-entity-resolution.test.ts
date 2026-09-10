import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import { resolveInboundEntities, type InboundEntity } from '@/lib/graph/resolve';
import { resolveInboundEntityContext } from '@/lib/graph/resolve-server';
import { enrichPaperworkEntities } from '@/lib/services/paperwork';
import { fileInboundPaperwork } from '@/lib/contact-center/server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const NOW = new Date('2026-09-09T12:00:00Z');
const FAMILY = 'ours';
let db: ReturnType<typeof createInMemorySupabase>;
const scope = (): ServiceScope => ({ db: db as never, familyId: FAMILY, role: 'system', actorKind: 'system', userId: null, memberId: null, tz: 'UTC', now: NOW });
const candidate = (id: string, label: string, extras: Partial<InboundEntity> = {}): InboundEntity => ({ id, key: `graph_entities:${id}`, label, kind: 'school', aliases: [], senders: [], ...extras });
const manual = (id: string, name: string, extras: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, name, kind: 'org', ref_table: null, ref_id: null,
  attributes: { provenance: { source: 'manual' }, node_type: 'school' },
  // The shared fake does not evaluate PostgREST JSON path filters. Keep its
  // filter input beside the real JSON value, which the resolver still checks.
  'attributes->provenance->>source': 'manual', ...extras,
});
const contact = (id: string, label: string, value: string, extras: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, label, value, category: 'contact', source: 'user', expires_at: null, ...extras,
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ defaults: { paperwork_items: { updated_at: NOW.toISOString(), meta: {} } } });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
});
afterEach(() => vi.restoreAllMocks());

describe('exact household entity matching', () => {
  it('matches names and explicitly saved aliases with whole-name boundaries', () => {
    const oak = candidate('oak', 'Oak School', { aliases: ['Oak Primary'] });
    expect(resolveInboundEntities({ text: 'OAK SCHOOL: permission slip' }, [oak]).matches).toEqual([{ key: oak.key, id: oak.id, label: oak.label, kind: oak.kind, matchedBy: 'name' }]);
    expect(resolveInboundEntities({ text: 'A letter from Oak Primary.' }, [oak]).matches[0]?.matchedBy).toBe('alias');
    expect(resolveInboundEntities({ text: 'Oak Schoolhouse needs supplies.' }, [oak]).matches).toEqual([]);
    expect(resolveInboundEntities({ text: 'Oaks School needs supplies.' }, [oak]).matches).toEqual([]);
  });

  it('matches only an exact single sender mailbox and never guesses from its domain', () => {
    const oak = candidate('oak', 'Oak School', { senders: ['office@oak.example'] });
    expect(resolveInboundEntities({ text: 'Permission slip', sender: 'Office <OFFICE@oak.example>' }, [oak]).matches[0]?.matchedBy).toBe('sender');
    expect(resolveInboundEntities({ text: 'Permission slip', sender: 'stranger@oak.example' }, [oak]).matches).toEqual([]);
    expect(resolveInboundEntities({ text: 'Permission slip', sender: 'office@oak.example>' }, [oak]).matches).toEqual([]);
    expect(resolveInboundEntities({ text: 'Permission slip', sender: 'office@oak.example, stranger@example.com' }, [oak]).matches).toEqual([]);
  });

  it('leaves duplicate exact names, aliases and senders unresolved', () => {
    const candidates = [candidate('one', 'Oak School', { aliases: ['The Oaks'], senders: ['office@oak.example'] }), candidate('two', 'Oak School', { aliases: ['The Oaks'], senders: ['office@oak.example'] })];
    expect(resolveInboundEntities({ text: 'Oak School (The Oaks)', sender: 'office@oak.example' }, candidates)).toEqual({ matches: [], ambiguousCount: 3 });
  });
});

describe('narrow confirmed household read', () => {
  it('returns only current household safe sources and explicit manual provenance', async () => {
    db.seed('graph_entities', [manual('school', 'Oak School'),
      manual('foreign', 'Other School', { family_id: 'theirs' }),
      manual('unknown', 'Unknown School', { attributes: { node_type: 'school' } }),
      manual('inferred', 'Guessed School', { attributes: { node_type: 'school', provenance: { source: 'ai_inferred' } } }),
      manual('doctor', 'Dr. Lee', { ref_table: 'health_providers', attributes: { provenance: { source: 'projection', ref_table: 'health_providers' } } }),
      manual('bank', 'Family Bank', { ref_table: 'financial_accounts' }),
      manual('team', 'Hawks', { kind: 'activity', ref_table: 'teams', ref_id: 'real-team', attributes: { provenance: { source: 'projection', ref_table: 'teams' } } }),
    ]);
    const savedGraph = structuredClone(db.table('graph_entities'));
    const result = await resolveInboundEntityContext(scope(), { text: 'Oak School, Other School, Unknown School, Guessed School, Dr. Lee, Family Bank and Hawks.' });
    expect(result.ok && result.data.matches.map((m) => m.id).sort()).toEqual(['school', 'team']);
    expect(db.log.every((entry) => entry.table !== 'health_providers' && entry.table !== 'financial_accounts')).toBe(true);
    expect(db.table('graph_entities')).toEqual(savedGraph);
    expect(db.table('family_facts')).toEqual([]);
  });

  it('uses confirmed contact mailboxes and explicit alias facts, not arbitrary notes or unconfirmed suggestions', async () => {
    db.seed('graph_entities', [manual('school', 'Oak School')]);
    db.seed('family_facts', [contact('mail', 'Oak School', 'office@oak.example'), contact('alias', 'Alias for Oak School', 'Oak Primary'),
      contact('freeform', 'Oak School', 'Everyone calls it The Oaks'),
      contact('expired', 'Alias for Oak School', 'Old School', { expires_at: '2026-08-01' }),
      contact('unknown', 'Alias for Oak School', 'Unknown Source', { source: null }),
      contact('private', 'Dr. Lee', 'doctor@example.com'),
      contact('foreign', 'Alias for Oak School', 'Other Tenant', { family_id: 'theirs' }),
    ]);
    db.seed('family_playbook_suggestions', [contact('pending', 'Alias for Oak School', 'Unconfirmed')]);
    expect((await resolveInboundEntityContext(scope(), { text: 'Oak Primary' })).ok).toBe(true);
    const sender = await resolveInboundEntityContext(scope(), { text: 'Please sign', sender: 'office@oak.example' });
    expect(sender.ok && sender.data.matches[0]).toMatchObject({ id: 'school', matchedBy: 'sender' });
    const absent = await resolveInboundEntityContext(scope(), { text: 'The Oaks, Old School, Unknown Source, Dr. Lee, Other Tenant and Unconfirmed.' });
    expect(absent.ok && absent.data.matches).toEqual([]);
    expect(db.log.some((entry) => entry.table === 'family_playbook_suggestions')).toBe(false);
  });

  it('preserves ambiguity between separate confirmed contact records with the same label', async () => {
    db.seed('family_facts', [contact('one', 'Coach Casey', 'coach@example.com'), contact('two', 'Coach Casey', 'coach@example.com')]);
    const result = await resolveInboundEntityContext(scope(), { text: 'Coach Casey', sender: 'coach@example.com' });
    expect(result.ok && result.data).toEqual({ matches: [], ambiguousCount: 2 });
  });

  it('does not use contact memory when the family turned memory off', async () => {
    db.seed('family_ai_settings', [{ family_id: FAMILY, memory_enabled: false }]);
    db.seed('family_facts', [contact('mail', 'Oak School', 'office@oak.example')]);
    const result = await resolveInboundEntityContext(scope(), { text: 'Oak School', sender: 'office@oak.example' });
    expect(result.ok && result.data.matches).toEqual([]);
    expect(db.log.some((entry) => entry.table === 'family_facts')).toBe(false);
  });

  it('includes late alias collisions beyond the first page, including server-capped pages', async () => {
    db.seed('graph_entities', Array.from({ length: 405 }, (_, i) => manual(String(i).padStart(4, '0'), i === 0 || i === 404 ? 'Oak School' : `School ${i}`)));
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      const range = query.range.bind(query);
      query.range = (start: number, end: number) => range(start, Math.min(end, start + 99));
      return query;
    }) as typeof db.from);
    const result = await resolveInboundEntityContext(scope(), { text: 'Oak School' });
    expect(result.ok && result.data).toEqual({ matches: [], ambiguousCount: 1 });
    expect(db.log.filter((entry) => entry.table === 'graph_entities').length).toBeGreaterThan(5);
  });

  it('reads confirmed sender collisions after the first contact page', async () => {
    db.seed('family_facts', Array.from({ length: 405 }, (_, i) => contact(String(i).padStart(4, '0'), `Coach ${i}`, i === 0 || i === 404 ? 'coach@example.com' : `coach${i}@example.com`)));
    const result = await resolveInboundEntityContext(scope(), { text: 'Please sign', sender: 'coach@example.com' });
    expect(result.ok && result.data).toEqual({ matches: [], ambiguousCount: 1 });
  });

  it.each([{ data: null, error: null }, { data: null, error: { message: 'read denied' } }])('does not resolve from an incomplete source reply %j', async (reply) => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table !== 'family_facts') return from(table);
      const query = { select: () => query, eq: () => query, order: () => query, range: () => Promise.resolve(reply) };
      return query;
    }) as typeof db.from);
    expect(await resolveInboundEntityContext(scope(), { text: 'Oak School' })).toMatchObject({ ok: false, retryable: true });
  });

  it.each(['family_ai_settings', 'graph_entities', 'family_facts'])('fails retryably on a rejected %s read', async (failedTable) => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table !== failedTable) return from(table);
      const query = { select: () => query, eq: () => query, in: () => query, is: () => query, order: () => query,
        range: () => Promise.reject(new Error('offline')), maybeSingle: () => Promise.reject(new Error('offline')) };
      return query;
    }) as typeof db.from);
    expect(await resolveInboundEntityContext(scope(), { text: 'Oak School' })).toMatchObject({ ok: false, retryable: true });
    expect(console.error).toHaveBeenCalled();
  });
});

describe('saved paperwork runtime enrichment', () => {
  it('propagates an unreadable dedupe lookup as retryable without inserting a duplicate', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table !== 'paperwork_items') return from(table);
      const query = { select: () => query, eq: () => query, limit: () => query, maybeSingle: () => Promise.resolve({ data: null, error: { message: 'offline' } }) };
      return query;
    }) as typeof db.from);
    await expect(fileInboundPaperwork(db as never, FAMILY, 'Oak School permission slip', NOW)).rejects.toMatchObject({ retryable: true });
    expect(db.table('paperwork_items')).toEqual([]);
  });
  it('attaches canonical identities on the existing inbound body path', async () => {
    db.seed('graph_entities', [manual('school', 'Oak School')]);
    const id = await fileInboundPaperwork(db as never, FAMILY, 'Oak School permission slip. Sign and return by September 12.', NOW, 'mail-1');
    const row = db.table('paperwork_items').find((item) => item.id === id)!;
    expect(row.meta).toMatchObject({ source: 'inbound_email', provider_ref: 'mail-1', entity_matches: [{ key: 'graph_entities:school', id: 'school', label: 'Oak School' }], entity_resolution: { status: 'complete' } });
    expect(row.raw_text).toContain('Sign and return');
  });

  it('preserves original capture on failure and safely enriches the same row on retry', async () => {
    const from = db.from.bind(db);
    const broken = vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table === 'family_ai_settings') throw new Error('offline');
      return from(table);
    }) as typeof db.from);
    const text = 'Oak School permission slip. Sign and return.';
    await expect(fileInboundPaperwork(db as never, FAMILY, text, NOW, 'mail-1')).rejects.toMatchObject({ retryable: true });
    expect(db.table('paperwork_items')).toHaveLength(1);
    const row = db.table('paperwork_items')[0];
    row.title = 'My edited title';
    row.raw_text = 'Updated Oak School permission slip';
    row.meta = { ...(row.meta as object), draft_reply: 'My saved reply' };
    broken.mockRestore();
    db.seed('graph_entities', [manual('school', 'Oak School')]);
    expect(await fileInboundPaperwork(db as never, FAMILY, text, NOW, 'mail-1')).toBe(row.id);
    expect(db.table('paperwork_items')).toHaveLength(1);
    expect(db.table('paperwork_items')[0]).toMatchObject({ title: 'My edited title', raw_text: 'Updated Oak School permission slip', meta: { draft_reply: 'My saved reply', entity_matches: [{ id: 'school' }] } });
  });

  it('does not touch another household item or its metadata', async () => {
    db.seed('paperwork_items', [{ id: 'foreign', family_id: 'theirs', raw_text: 'Oak School', meta: { secret: 'private' }, updated_at: NOW.toISOString() }]);
    const saved = structuredClone(db.table('paperwork_items'));
    expect(await enrichPaperworkEntities(scope(), 'foreign')).toMatchObject({ ok: false, retryable: true });
    expect(db.table('paperwork_items')[0].meta).toEqual({ secret: 'private' });
    expect(db.table('paperwork_items')).toEqual(saved);
  });

  it('leaves a concurrent user edit intact and returns a retryable result', async () => {
    db.seed('paperwork_items', [{ id: 'paper', family_id: FAMILY, raw_text: 'Oak School', meta: {}, updated_at: NOW.toISOString() }]);
    db.seed('graph_entities', [manual('school', 'Oak School')]);
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table === 'graph_entities') {
        const paper = db.table('paperwork_items')[0];
        paper.updated_at = '2026-09-09T12:01:00Z';
        paper.meta = { draft_reply: 'Concurrent edit' };
      }
      return from(table);
    }) as typeof db.from);
    expect(await enrichPaperworkEntities(scope(), 'paper')).toMatchObject({ ok: false, retryable: true });
    expect(db.table('paperwork_items')[0].meta).toEqual({ draft_reply: 'Concurrent edit' });
  });
});

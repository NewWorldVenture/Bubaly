// Exercise the public tool adapter, registry, trust gate, ledger and real Home
// service together. Only database transport is modeled; this is not RLS proof.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const server = vi.hoisted(() => ({ client: null as DB | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!server.client) throw new Error('No test ledger client');
    return server.client;
  },
}));

const { toToolSpecs, toolInputSchema } = await import('@/lib/ai/tools/legacy-adapter');
const { getTool } = await import('@/lib/ai/tools/registry');
const { saveContractor } = await import('@/lib/services/home');

const FAMILY = 'family-contractor-owner';
const USER = 'auth-parent';
const NAME = 'Bob Pipes';
const OPTIONAL = ['trade', 'company', 'phone', 'email', 'website', 'rating', 'is_preferred', 'notes'] as const;
const TEXT = ['company', 'phone', 'email', 'website', 'notes'] as const;
const PLACEHOLDERS = Object.fromEntries(OPTIONAL.map((key) => [key, null]));

const SAVED = {
  id: 'contractor-bob', family_id: FAMILY, name: NAME, trade: 'hvac',
  company: 'Bob Heating', phone: '555-0100', email: 'bob@example.invalid',
  website: 'https://example.invalid/bob', rating: 4, hourly_rate: 125,
  is_preferred: true, last_used_on: '2026-09-05', notes: 'Call before visiting.',
  created_by: 'original-author', updated_by: 'original-author', deleted_at: null,
  metadata: { source: 'family-address-book' },
  created_at: '2026-09-01T12:00:00.000Z', updated_at: '2026-09-01T12:00:00.000Z',
};

type Fault = 'returned-error' | 'thrown-error' | 'zero-row';

function household(options: { rows?: Row[]; fault?: Fault; enabled?: boolean; behavior?: string } = {}) {
  const db = createInMemorySupabase({
    // 0036: nullable columns and is_preferred=false for a newly saved contact.
    defaults: { home_contractors: {
      trade: null, company: null, phone: null, email: null, website: null,
      rating: null, hourly_rate: null, is_preferred: false, notes: null,
      last_used_on: null, deleted_at: null, metadata: {},
    } },
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
  });
  db.seed('home_contractors', options.rows ?? [SAVED]);
  db.seed('family_ai_settings', [{
    family_id: FAMILY, enabled: options.enabled ?? true, behavior: options.behavior ?? 'execute',
  }]);
  const writes: { kind: 'insert' | 'update'; payload: unknown }[] = [];
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table) => {
    const builder = from(table);
    if (table !== 'home_contractors') return builder;
    let writing = false;
    const update = builder.update.bind(builder);
    const insert = builder.insert.bind(builder);
    vi.spyOn(builder, 'update').mockImplementation((patch) => {
      writing = true;
      writes.push({ kind: 'update', payload: structuredClone(patch) });
      return update(patch);
    });
    vi.spyOn(builder, 'insert').mockImplementation((rows) => {
      writing = true;
      writes.push({ kind: 'insert', payload: structuredClone(rows) });
      return insert(rows);
    });
    const maybeSingle = builder.maybeSingle.bind(builder);
    vi.spyOn(builder, 'maybeSingle').mockImplementation(async () => {
      if (!writing || !options.fault) return maybeSingle();
      // Fail before executing this modeled UPDATE; the successful scenarios
      // above delegate every terminal call to the real stateful helper.
      if (options.fault === 'thrown-error') throw new Error('Synthetic contractor transport failure');
      return {
        data: null, count: null, status: options.fault === 'zero-row' ? 200 : 403,
        statusText: options.fault === 'zero-row' ? 'OK' : 'Forbidden',
        error: options.fault === 'zero-row' ? null : {
          code: '42501', message: 'Synthetic contractor refusal', details: null, hint: null,
        },
      };
    });
    return builder;
  });
  const client = db as unknown as DB;
  server.client = client;
  const scope: ServiceScope = {
    db: client, familyId: FAMILY, userId: USER, memberId: 'member-parent',
    role: 'parent', actorKind: 'ai', tz: 'UTC', now: new Date('2026-10-16T12:00:00Z'),
  };
  const spec = toToolSpecs(scope, { names: ['home.saveContractor'] })[0];
  const before = structuredClone(db.table('home_contractors'));
  return { db, scope, writes, before, call: (args: Record<string, unknown>) => spec.execute(args) };
}

type Household = ReturnType<typeof household>;

function expectSaved(h: Household, changes: Row = {}) {
  expect(h.db.table('home_contractors')).toEqual([{
    ...h.before[0], ...changes, updated_by: USER, updated_at: expect.any(String),
  }]);
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0].kind).toBe('update');
  expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({
    family_id: FAMILY, tool_name: 'home.saveContractor', state: 'succeeded',
    resource_table: 'home_contractors', resource_id: SAVED.id,
  })]);
  expect(h.db.table('agent_activity')).toHaveLength(1);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('This fixture may not use the network'); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  server.client = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AI contractor edits preserve fields the request did not supply', () => {
  it('preserves every saved detail when only the existing name is supplied', async () => {
    const h = household();
    expect(await h.call({ name: NAME })).toMatchObject({ ok: true, data: { id: SAVED.id, created: false } });
    expectSaved(h);
  });

  it('preserves every saved detail with the strict-provider null placeholders', async () => {
    const schema = toolInputSchema(getTool('home.saveContractor')!);
    expect(schema).toMatchObject({
      required: expect.arrayContaining(['name', ...OPTIONAL]), additionalProperties: false,
      properties: { phone: { type: ['string', 'null'] }, rating: { type: ['integer', 'null'] } },
    });
    const h = household();
    expect(await h.call({ name: NAME, ...PLACEHOLDERS })).toMatchObject({ ok: true, data: { created: false } });
    expectSaved(h);
  });

  it('updates a supplied rating and false preference without clearing other details', async () => {
    const h = household();
    expect(await h.call({ name: NAME, ...PLACEHOLDERS, rating: 5, is_preferred: false })).toMatchObject({ ok: true });
    expectSaved(h, { rating: 5, is_preferred: false });
  });

  it('normalizes a supplied trade without clearing the saved contacts', async () => {
    const h = household();
    expect(await h.call({ name: NAME, trade: 'plumber' })).toMatchObject({ ok: true, data: { trade: 'plumbing' } });
    expectSaved(h, { trade: 'plumbing' });
  });

  for (const field of TEXT) {
    it(`updates only the supplied ${field}`, async () => {
      const h = household();
      expect(await h.call({ name: NAME, [field]: ' Updated detail ' })).toMatchObject({ ok: true });
      expectSaved(h, { [field]: 'Updated detail' });
    });
    it(`deliberately clears only ${field} with an empty string`, async () => {
      const h = household();
      expect(await h.call({ name: NAME, ...PLACEHOLDERS, [field]: '' })).toMatchObject({ ok: true });
      expectSaved(h, { [field]: null });
    });
  }

  it('retains the existing whitespace-only contact clear behavior', async () => {
    const h = household();
    expect(await h.call({ name: NAME, phone: '   ' })).toMatchObject({ ok: true });
    expectSaved(h, { phone: null });
  });

  it('does not invent a trade-clear command from an empty trade', async () => {
    const h = household();
    expect(await h.call({ name: NAME, trade: '' })).toMatchObject({ ok: true });
    expectSaved(h);
  });

  it('updates all explicitly supplied fields and keeps the unexposed hourly rate', async () => {
    const h = household();
    const supplied = {
      trade: 'plumbing', company: 'New company', phone: '555-0199', email: 'new@example.invalid',
      website: 'https://example.invalid/new', rating: 1, is_preferred: false, notes: 'New notes',
    };
    expect(await h.call({ name: NAME, ...supplied })).toMatchObject({ ok: true });
    expectSaved(h, supplied);
  });

  it('creates a new contractor with the supplied details', async () => {
    const h = household({ rows: [] });
    expect(await h.call({ name: NAME, trade: 'plumber', phone: '555-0199', rating: 5 })).toMatchObject({
      ok: true, data: { name: NAME, trade: 'plumbing', created: true },
    });
    expect(h.db.table('home_contractors')).toEqual([expect.objectContaining({
      family_id: FAMILY, name: NAME, trade: 'plumbing', phone: '555-0199', rating: 5,
      company: null, email: null, notes: null, is_preferred: false, created_by: USER,
    })]);
    expect(h.writes.map((w) => w.kind)).toEqual(['insert']);
  });

  it('creates a minimally named contractor with strict null placeholders', async () => {
    const h = household({ rows: [] });
    expect(await h.call({ name: NAME, ...PLACEHOLDERS })).toMatchObject({
      ok: true, data: { name: NAME, trade: null, created: true },
    });
    expect(h.db.table('home_contractors')).toEqual([expect.objectContaining({
      family_id: FAMILY, name: NAME, trade: null, phone: null, rating: null, is_preferred: false,
    })]);
    expect(h.writes.map((w) => w.kind)).toEqual(['insert']);
  });

  for (const hidden of [
    { label: 'another family', row: { ...SAVED, family_id: 'other-family' } },
    { label: 'a deleted contractor', row: { ...SAVED, deleted_at: '2026-10-01T12:00:00Z' } },
  ]) {
    it(`never updates the same name belonging to ${hidden.label}`, async () => {
      const h = household({ rows: [hidden.row] });
      expect(await h.call({ name: NAME, phone: '555-0199' })).toMatchObject({ ok: true, data: { created: true } });
      expect(h.db.table('home_contractors')[0]).toEqual(h.before[0]);
      expect(h.db.table('home_contractors')).toHaveLength(2);
      expect(h.db.table('home_contractors')[1]).toMatchObject({ family_id: FAMILY, deleted_at: null, phone: '555-0199' });
      expect(h.writes.map((w) => w.kind)).toEqual(['insert']);
    });
  }

  for (const rating of [0, 6, 1.5]) {
    it(`refuses invalid rating ${rating} without a contractor write`, async () => {
      const h = household();
      expect(await h.call({ name: NAME, rating })).toMatchObject({ ok: false });
      expect(h.db.table('home_contractors')).toEqual(h.before);
      expect(h.writes).toEqual([]);
      expect(h.db.table('agent_activity')).toEqual([]);
    });
  }

  for (const denied of [{ enabled: false }, { behavior: 'recommend' }]) {
    it(`honors the real family AI setting ${JSON.stringify(denied)}`, async () => {
      const h = household(denied);
      expect(await h.call({ name: NAME, rating: 5 })).toMatchObject({ ok: false });
      expect(h.db.table('home_contractors')).toEqual(h.before);
      expect(h.writes).toEqual([]);
      expect(h.db.table('ai_tool_calls')).toEqual([]);
    });
  }

  for (const fault of ['returned-error', 'thrown-error', 'zero-row'] as const) {
    it(`reports ${fault} without claiming a saved contractor`, async () => {
      const h = household({ fault });
      expect(await h.call({ name: NAME, rating: 5 })).toMatchObject({ ok: false });
      expect(h.db.table('home_contractors')).toEqual(h.before);
      expect(h.writes).toHaveLength(1);
      expect(h.db.table('agent_activity')).toEqual([]);
      expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({ state: 'failed' })]);
    });
  }

  it('leaves direct-service explicit null clearing intact for existing callers', async () => {
    const h = household();
    expect(await saveContractor(h.scope, { name: NAME, trade: null, rating: null, phone: null })).toMatchObject({ ok: true });
    expect(h.db.table('home_contractors')).toEqual([{
      ...h.before[0], trade: null, rating: null, phone: null, updated_by: USER, updated_at: expect.any(String),
    }]);
  });
});

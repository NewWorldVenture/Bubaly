import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runTwinProjection } from '@/lib/twin/project-server';

// The projector reads twenty domain tables. Each one is a place the graph can
// silently lose a whole kind of knowledge: if a rejected read were treated as
// "this family owns nothing", the next projection would prune every asset,
// obligation and preference node and the graph would confidently claim the
// household has none. So every read fails CLOSED — the run stops, says which
// table refused, and the surface renders a retryable error instead of a graph
// that quietly shrank.

type Reply = { data: unknown; error: { message: string } | null };

/**
 * A PostgREST-shaped stub. Every filter returns the chain and the chain is
 * awaitable at any point, so one stub serves reads that end in `.limit()`,
 * `.eq()`, `.is()` or `.in()` alike.
 */
function chainFor(reply: Reply) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'neq', 'gte', 'gt', 'lt', 'lte', 'is', 'in', 'not', 'limit', 'order']) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (r: Reply) => unknown) => Promise.resolve(reply).then(resolve);
  return chain;
}

type Options = { failing?: Record<string, string>; writeError?: string };

function fakeSupabase(opts: Options = {}) {
  const writes: Array<{ table: string; op: string; rows: unknown }> = [];
  const client = {
    from(table: string) {
      const failure = opts.failing?.[table];
      const reply: Reply = failure ? { data: null, error: { message: failure } } : { data: [], error: null };
      const chain = chainFor(reply) as Record<string, unknown>;
      const writeReply = opts.writeError ? { data: null, error: { message: opts.writeError } } : { data: [], error: null };
      for (const op of ['upsert', 'insert', 'delete', 'update']) {
        chain[op] = (rows: unknown) => {
          writes.push({ table, op, rows });
          return chainFor(writeReply);
        };
      }
      return chain;
    },
  } as unknown as SupabaseClient<Database>;
  return { client, writes };
}

const EVERY_READ_TABLE = [
  'family_members', 'pets', 'vehicles', 'school_classes', 'teams', 'family_routines',
  'family_places', 'financial_accounts', 'health_providers',
  'calendar_events', 'homes', 'home_locations', 'home_assets', 'inventory_items',
  'home_warranties', 'home_projects', 'bills', 'paperwork_items', 'renewals', 'family_facts',
];

describe('runTwinProjection read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(EVERY_READ_TABLE)('fails closed and names the table when %s refuses the read', async (table) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, writes } = fakeSupabase({ failing: { [table]: `permission denied for table ${table}` } });

    const res = await runTwinProjection(client, 'fam-1', null);

    // Fail closed: no partial projection is written when a source read failed.
    expect(res.ok).toBe(false);
    expect(res.error).toContain(table);
    expect(res.entities).toBe(0);
    expect(writes).toHaveLength(0);

    // Observability: the failure names the table so a drifted/renamed source is
    // diagnosable rather than invisible.
    expect(err.mock.calls.map((c) => String(c[0]))).toContain(`[twin] ${table} read failed`);
  });

  it('does not log, and writes nothing, when every table is simply empty', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, writes } = fakeSupabase();

    const res = await runTwinProjection(client, 'fam-1', null);

    // An empty household is a fact, not a failure: ok, zero, silent.
    expect(res).toMatchObject({ ok: true, entities: 0, edges: 0 });
    expect(err).not.toHaveBeenCalled();
    // Nothing to upsert; the only write worth making would be a prune, and there
    // is nothing stale either.
    expect(writes.filter((w) => w.op === 'upsert')).toHaveLength(0);
  });

  it('fails closed when the graph write itself is rejected', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ writeError: 'new row violates row-level security policy' });
    // Give the projection something to write.
    const withMember = {
      from(table: string) {
        if (table === 'family_members') {
          const chain = chainFor({ data: [{ id: 'm1', display_name: 'Emma' }], error: null }) as Record<string, unknown>;
          return chain;
        }
        return (client as unknown as { from: (t: string) => unknown }).from(table);
      },
    } as unknown as SupabaseClient<Database>;

    const res = await runTwinProjection(withMember, 'fam-1', null);

    expect(res.ok).toBe(false);
    expect(res.error).toContain('row-level security');
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[twin] graph_entities upsert failed');
  });
});

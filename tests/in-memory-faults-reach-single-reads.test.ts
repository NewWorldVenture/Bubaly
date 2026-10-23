import { describe, expect, it } from 'vitest';
import { createInMemorySupabase, withFaults, type FaultCall } from './helpers/in-memory-supabase';

// `withFaults` used to fault only a query awaited as the builder itself.
// `.maybeSingle()` and `.single()` return a promise instead, which the proxy
// passed straight through, so a read ending in either answered from the
// database and a test that faulted it saw a fault that never fired (review
// R9-AI-CONFIG-VIEW-FAILED-READ-IS-A-VALUE: getAIConfigView's read on
// /admin/ai, /admin/settings and /admin/marketing/settings).
function seeded() {
  const db = createInMemorySupabase();
  db.seed('app_settings', [{ id: 'row-1', key: 'ai_provider', value: { model: 'gpt-4.1' } }]);
  return db;
}

describe('withFaults reaches a query that ends in maybeSingle or single', () => {
  it.each(['maybeSingle', 'single'] as const)('a faulted %s read answers the error, with the call recorded', async (terminal) => {
    const seen: FaultCall[][] = [];
    const client = withFaults(seeded(), (table, calls) => {
      seen.push([...calls]);
      return table === 'app_settings' ? { code: '42501', message: 'permission denied' } : null;
    });
    const query = client.from('app_settings').select('value').eq('key', 'ai_provider');
    const { data, error } = await query[terminal]();
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: '42501', message: 'permission denied' });
    expect(seen).toHaveLength(1);
    expect(seen[0].map((c) => c.method)).toEqual(['select', 'eq', terminal]);
  });

  it.each(['maybeSingle', 'single'] as const)('an unfaulted %s read answers from the database', async (terminal) => {
    let consulted = 0;
    const client = withFaults(seeded(), () => { consulted += 1; return null; });
    const { data, error } = await client.from('app_settings').select('value').eq('key', 'ai_provider')[terminal]();
    expect(error).toBeNull();
    expect(data).toEqual({ value: { model: 'gpt-4.1' } });
    expect(consulted).toBe(1);
  });

  it('a faulted write ending in single does not land', async () => {
    const db = seeded();
    const client = withFaults(db, (table, calls) =>
      calls.some((c) => c.method === 'insert') ? { message: 'insert refused' } : null);
    const { data, error } = await client.from('app_settings').insert({ key: 'other', value: {} }).select('id').single();
    expect(data).toBeNull();
    expect(error).toMatchObject({ message: 'insert refused' });
    expect(db.table('app_settings').map((r) => r.key)).toEqual(['ai_provider']);
  });

  it('a builder awaited without a terminal call is faulted as before', async () => {
    const client = withFaults(seeded(), (table) => (table === 'app_settings' ? { message: 'down' } : null));
    const { data, error } = await client.from('app_settings').select('value');
    expect(data).toBeNull();
    expect(error).toMatchObject({ message: 'down' });
  });
});

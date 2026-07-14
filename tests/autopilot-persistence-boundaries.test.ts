import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAutopilotScan } from '@/lib/autopilot/scan';

type QueryResult = { data: unknown; error: unknown };
type Write = { table: string; operation: string };

function failingReadClient(failingTable: string) {
  const writes: Write[] = [];
  const methods = ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'not', 'order', 'limit', 'maybeSingle', 'single'];
  const client = {
    from(table: string) {
      const result: QueryResult = table === failingTable
        ? { data: null, error: new Error(`read failed: ${table}`) }
        : { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const method of methods) chain[method] = () => chain;
      chain.insert = () => { writes.push({ table, operation: 'insert' }); return chain; };
      chain.update = () => { writes.push({ table, operation: 'update' }); return chain; };
      chain.delete = () => { writes.push({ table, operation: 'delete' }); return chain; };
      chain.then = (resolveResult: (value: QueryResult) => unknown, rejectResult: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolveResult, rejectResult);
      return chain;
    },
  };
  return { client, writes };
}

function suggestionInsertFailureClient() {
  const writes: Write[] = [];
  const now = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const reads: Record<string, QueryResult> = {
    renewals: { data: [{ id: 'renewal-1', title: 'Passport', expires_at: now, status: 'active' }], error: null },
    appointments: { data: [], error: null },
    chore_assignments: { data: [], error: null },
    family_members: { data: [], error: null },
    grocery_items: { data: [], error: null },
    reminders: { data: [], error: null },
    calendar_events: { data: [], error: null },
    subscriptions_tracked: { data: [], error: null },
    family_stress_signals: { data: [], error: null },
    medications: { data: [], error: null },
    family_digital_twin_profiles: { data: [], error: null },
    meal_plans: { data: [], error: null },
    family_insurance_policies: { data: [], error: null },
    wishlist_items: { data: [], error: null },
    autopilot_suggestions: { data: [], error: null },
  };
  const client = {
    from(table: string) {
      let operation = 'read';
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'not', 'order', 'limit', 'maybeSingle', 'single']) {
        chain[method] = () => chain;
      }
      chain.insert = () => { operation = 'insert'; writes.push({ table, operation }); return chain; };
      chain.update = () => { operation = 'update'; writes.push({ table, operation }); return chain; };
      chain.delete = () => { operation = 'delete'; writes.push({ table, operation }); return chain; };
      chain.then = (resolveResult: (value: QueryResult) => unknown, rejectResult: (reason: unknown) => unknown) => {
        let result = reads[table] ?? { data: [], error: null };
        if (table === 'reminders' && operation === 'insert') result = { data: { id: 'reminder-1' }, error: null };
        if (table === 'autopilot_suggestions' && operation === 'insert') result = { data: null, error: new Error('suggestion insert failed') };
        return Promise.resolve(result).then(resolveResult, rejectResult);
      };
      return chain;
    },
  };
  return { client, writes };
}

describe('autopilot persistence boundaries', () => {
  it('fails closed before any write when a required family read fails', async () => {
    const { client, writes } = failingReadClient('calendar_events');

    await expect(runAutopilotScan(client as never, 'family-1', 'user-1'))
      .rejects.toThrow('Autopilot could not read the required family data');
    expect(writes).toEqual([]);
  });

  it('removes an auto-created reminder when its suggestion cannot be saved', async () => {
    const { client, writes } = suggestionInsertFailureClient();

    await expect(runAutopilotScan(client as never, 'family-1', 'user-1'))
      .rejects.toThrow('Autopilot could not save the suggestion');
    expect(writes).toEqual([
      { table: 'reminders', operation: 'insert' },
      { table: 'autopilot_suggestions', operation: 'insert' },
      { table: 'reminders', operation: 'delete' },
    ]);
  });

  it('checks suggestion persistence and compensates auto-created side effects', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/autopilot/scan.ts'), 'utf8');

    expect(source).toContain('const { data: inserted, error: suggestionError }');
    expect(source).toContain('createdReminderId');
    expect(source).toContain('createdGroceryIds');
    expect(source).toContain(".from('reminders').delete().eq('id', createdReminderId)");
    expect(source).toContain(".from('grocery_items').delete().in('id', createdGroceryIds)");
    expect(source).toContain("throw new Error('Autopilot could not save the suggestion')");
  });

  it('does not treat list lookup or stale suggestion deletion errors as empty state', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/autopilot/scan.ts'), 'utf8');

    expect(source).toContain('if (lookupError) throw new Error');
    expect(source).toContain('if (staleError) throw new Error');
    expect(source).toContain('if (readResults.some((result) => result.error))');
  });
});

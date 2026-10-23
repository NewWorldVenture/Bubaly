// Actual export + finance reader + serializer, with only the database fluent
// boundary synthetic. This does not execute native RLS or the HTTP route.
import { describe, expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import type { ServiceScope } from '@/lib/services/types';

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => null }));
const { buildFamilyExport, serializeExport } = await import('@/lib/privacy/export');
const { listTransactions } = await import('@/lib/services/finances');
type ExportSection = import('@/lib/privacy/export').ExportSection;

const FAMILY = 'synthetic-export-family';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const FROM = '2024-10-14';
const TO = '2026-10-14';

function household() {
  const db = createInMemorySupabase({ userId: 'synthetic-parent', maxRows: 37 });
  db.seed('families', [{ id: FAMILY, name: 'Synthetic Export Family', timezone: 'America/New_York' }]);
  db.seed('family_members', [{
    id: 'synthetic-member', family_id: FAMILY, user_id: 'synthetic-parent',
    display_name: 'Synthetic Parent', role: 'parent', is_active: true,
    birthday: null, color: 'teal', avatar_url: null,
  }]);
  return db;
}
function scope(db: InMemorySupabase, role: ServiceScope['role'] = 'parent'): ServiceScope {
  return {
    db: db as unknown as ServiceScope['db'], familyId: FAMILY,
    userId: 'synthetic-parent', memberId: 'synthetic-member', role,
    actorKind: 'member', tz: 'America/New_York', now: NOW,
  };
}
function transaction(id: string, date: string, familyId = FAMILY) {
  return {
    id, family_id: familyId, name: `Synthetic ${id}`, merchant: 'Synthetic Market',
    amount: 12.34, category: 'food', date, type: 'expense',
    member_id: null, account_id: null,
  };
}
function rows(section: ExportSection): Array<{ id: string; date: string }> {
  const financial = section.data as { transactions?: Array<{ id: string; date: string }> };
  expect(Array.isArray(financial.transactions)).toBe(true);
  return financial.transactions!;
}
async function financialSection(db: InMemorySupabase, role: ServiceScope['role'] = 'parent') {
  const result = await buildFamilyExport(scope(db, role));
  expect(result.ok, result.ok ? '' : JSON.stringify(result.failed)).toBe(true);
  if (!result.ok) throw new Error('Synthetic financial export failed');
  const section = result.data.sections.find((item) => item.key === 'finances');
  expect(section).toBeDefined();
  if (!section) throw new Error('Synthetic financial section missing');
  expect(section.count).toBe(rows(section).length);
  // Include the real serializer in every financial read control, including
  // the two failing completeness cases. This preserves nested data.range:
  // the defect is the top-level flag, not a wholly undisclosed date window.
  const decoded = JSON.parse(await new Response(serializeExport(result.data)).text());
  const serialized: ExportSection = decoded.sections.find((item: { key: string }) => item.key === 'finances');
  expect(serialized).toEqual(section);
  const observationPath = process.env.FINANCE_EXPORT_OBSERVATIONS_PATH;
  if (observationPath) {
    if (!observationPath.startsWith('G:/BubalyFinanceExportWindowEvidence20261023/temp/')) {
      throw new Error('Synthetic observation output must stay in the owned G evidence directory');
    }
    appendFileSync(observationPath, `${JSON.stringify({ role, serializedFinance: serialized })}\n`);
  }
  return { result: result.data, section: serialized };
}

// The contract permits a complete archive instead of a bounded window. If
// stored rows are omitted, the export must name bounds that explain the
// omissions AND say truncated. Merely adding a window is insufficient.
function expectHonestCoverage(section: ExportSection, stored: Array<{ id: string; date: string }>) {
  const included = new Set(rows(section).map((row) => row.id));
  const omitted = stored.filter((row) => !included.has(row.id));
  console.info('[synthetic-finance-export-coverage]', JSON.stringify({
    stored: stored.map((row) => ({ id: row.id, date: row.date })),
    included: [...included], omitted: omitted.map((row) => row.id),
    count: section.count, truncated: section.truncated, window: section.window ?? null,
  }));
  if (omitted.length === 0) {
    expect(section.truncated).toBe(false);
    return;
  }
  expect(section.truncated, `Omitted ${omitted.map((row) => row.id).join(', ')} cannot be called complete`).toBe(true);
  expect(section.window, 'A bounded financial export must name the actual date window').toBeDefined();
  if (!section.window) throw new Error('Missing financial export window');
  expect(section.window.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(section.window.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(section.window.from <= section.window.to).toBe(true);
  for (const row of omitted) {
    expect(row.date < section.window.from || row.date > section.window.to,
      `Window must actually explain why ${row.id} was omitted`).toBe(true);
  }
  for (const row of rows(section)) {
    expect(row.date >= section.window.from && row.date <= section.window.to).toBe(true);
  }
}

describe('a financial export acknowledges the stored records it left out', () => {
  it('an older family transaction is either included or explicitly disclosed as an omission', async () => {
    const db = household();
    const stored = [transaction('current', TO), transaction('old', '2020-01-01')];
    db.seed('transactions', stored);
    const direct = await listTransactions(scope(db), { from: FROM, to: TO, limit: 5000 });
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error('Synthetic finance reader failed');
    expect(direct.data.range).toEqual({ from: FROM, to: TO });
    expect(direct.data.transactions.map((row) => row.id)).toEqual(['current']);
    expect(direct.data.complete).toBe(true); // complete within its window only
    const { section } = await financialSection(db);
    expectHonestCoverage(section, stored);
  });

  it('a future family transaction is either included or explicitly disclosed as an omission', async () => {
    const db = household();
    const stored = [transaction('current', TO), transaction('future', '2027-01-01')];
    db.seed('transactions', stored);
    const { section } = await financialSection(db);
    expectHonestCoverage(section, stored);
  });

  it('the real serializer preserves a complete in-window financial section and its exact records', async () => {
    const db = household();
    const stored = [transaction('first', '2025-01-01'), transaction('second', '2026-03-01')];
    db.seed('transactions', stored);
    const { result, section } = await financialSection(db);
    expectHonestCoverage(section, stored);
    expect(rows(section).map((row) => row.id).sort()).toEqual(['first', 'second']);
    const decoded = JSON.parse(await new Response(serializeExport(result)).text());
    const serialized = decoded.sections.find((item: { key: string }) => item.key === 'finances');
    expect(serialized).toEqual(section);
    expect(decoded.family.id).toBe(FAMILY);
    expect(decoded.exportedBy).toMatchObject({ userId: 'synthetic-parent', role: 'parent' });
  });

  it('both inclusive finance window endpoints are retained, even with a small synthetic response cap', async () => {
    const db = household();
    db.seed('transactions', [transaction('at-from', FROM), transaction('at-to', TO)]);
    const { section } = await financialSection(db);
    expect(rows(section).map((row) => row.id).sort()).toEqual(['at-from', 'at-to']);
    expect(section.truncated).toBe(false);
  });

  it('another family’s old or future transactions neither leak nor mark this family truncated', async () => {
    const db = household();
    db.seed('transactions', [
      transaction('own', TO), transaction('foreign-old', '2020-01-01', 'synthetic-other-family'),
      transaction('foreign-future', '2027-01-01', 'synthetic-other-family'),
    ]);
    const { section } = await financialSection(db);
    expect(rows(section).map((row) => row.id)).toEqual(['own']);
    expect(section.truncated).toBe(false);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('%s receives no finance section and makes no transaction read', async (role) => {
    const db = household();
    db.seed('transactions', [transaction('private', TO)]);
    const built = await buildFamilyExport(scope(db, role));
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('Synthetic nonmanager export failed');
    expect(built.data.withheld).toContain('finances');
    expect(built.data.sections.map((section) => section.key)).not.toContain('finances');
    const direct = await listTransactions(scope(db, role), { from: FROM, to: TO });
    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error('Synthetic restricted reader was allowed');
    expect(direct.code).toBe('denied');
    expect(db.log.filter((read) => read.table === 'transactions')).toEqual([]);
  });

  it('a transaction read error fails the entire export instead of supplying an empty financial attachment', async () => {
    const raw = household();
    raw.seed('transactions', [transaction('current', TO)]);
    const failed = withFaults(raw, (table) => table === 'transactions'
      ? { code: '57014', message: 'Synthetic transaction read refused' } : null);
    const built = await buildFamilyExport(scope(failed));
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('Unreadable financial export must not be serialized');
    expect(built.failed.map((failure) => failure.key)).toContain('finances');
    expect(built).not.toHaveProperty('data');
  });

  it('reaching the financial row ceiling remains explicitly truncated rather than a complete backup', async () => {
    const db = household();
    db.seed('transactions', Array.from({ length: 5001 }, (_, index) => transaction(`row-${String(index).padStart(5, '0')}`, TO)));
    const { section } = await financialSection(db);
    expect(section.count).toBe(5000);
    expect(section.limit).toBe(5000);
    expect(section.truncated).toBe(true);
    expect(new Set(rows(section).map((row) => row.id)).size).toBe(5000);
  });

  it('an unreadable outside-window exact count refuses the export instead of declaring its financial section complete', async () => {
    const raw = household();
    raw.seed('transactions', [transaction('current', TO), transaction('old-outside-count', '2020-01-01')]);
    let countRefused = false;
    const failed = withFaults(raw, (table, calls) => {
      const exactHeadCount = calls.some((call) => {
        if (call.method !== 'select') return false;
        const options = call.args[1] as { count?: unknown; head?: unknown } | undefined;
        return options?.count === 'exact' && options.head === true;
      });
      if (table !== 'transactions' || !exactHeadCount) return null;
      countRefused = true;
      return { code: '57014', message: 'Synthetic financial completeness count unreadable' };
    });
    const built = await buildFamilyExport(scope(failed));
    if (built.ok) {
      // A complete archive need not count rows outside a date window. It is
      // acceptable only if no count failed and the old record is really here.
      expect(countRefused, 'A failed completeness count must fail the whole export').toBe(false);
      const section = built.data.sections.find((item) => item.key === 'finances');
      expect(section).toBeDefined();
      if (!section) throw new Error('Synthetic financial section missing');
      expect(rows(section).map((row) => row.id).sort()).toEqual(['current', 'old-outside-count']);
    } else {
      expect(countRefused, 'Only the targeted completeness read is refused by this control').toBe(true);
      expect(built.failed.map((failure) => failure.key)).toContain('finances');
      expect(built).not.toHaveProperty('data');
    }
  });
});

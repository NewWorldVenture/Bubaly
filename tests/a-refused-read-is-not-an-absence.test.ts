import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, between } from './helpers/source-order';

/**
 * Audit C1-S9-75 — a refused read answered as an absence.
 *
 * Two shapes, both from a read that bound only `data`:
 *  - "not found": thirteen server actions answered "Plan not found", "no
 *    winner yet", "that gift link is no longer active" to a read that never
 *    saw the row. A smaller answer — the action still failed — but a false one.
 *  - get-or-create: the absence then CREATED. A refused list read made a
 *    second "Groceries" list; a refused "what is already on it" read re-added
 *    every item; the admin plan tool inserted a second subscription and
 *    audited `previous_plan: null`. A different answer.
 */
const requireUserContext = vi.fn();
const createServer = vi.fn();
const createServiceClient = vi.fn();
const isSuperAdmin = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: () => requireUserContext(),
  isSuperAdmin: () => isSuperAdmin(),
  getUser: async () => ({ id: 'admin-1' }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer(), createServiceClient: () => createServiceClient() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));

type Outcome = { data?: unknown; error?: unknown };
type Call = { table: string; op: string; payload?: unknown };

/** Reads resolve per table in order; writes are recorded and succeed. */
function fakeDb(reads: Record<string, Outcome[]>, calls: Call[]) {
  return {
    from(table: string) {
      let op = 'select';
      const chain: Record<string, unknown> = {};
      const settle = () => {
        if (op !== 'select') return Promise.resolve({ data: [{ id: `${table}-new` }], error: null, count: 1 });
        const o = reads[table]?.shift() ?? { data: null };
        return Promise.resolve({ data: o.error ? null : (o.data ?? null), error: o.error ?? null });
      };
      Object.assign(chain, {
        select: () => chain, eq: () => chain, is: () => chain, in: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: settle,
        single: () => settle().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej),
        insert: (payload: unknown) => { op = 'insert'; calls.push({ table, op, payload }); return chain; },
        update: (payload: unknown) => { op = 'update'; calls.push({ table, op, payload }); return chain; },
      });
      return chain;
    },
  };
}

const refused = { error: { message: 'permission denied', code: '42501' } };

beforeEach(() => {
  requireUserContext.mockResolvedValue({ active: { familyId: 'fam-1', role: 'parent' }, user: { id: 'user-1' } });
  isSuperAdmin.mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('get-or-create does not create over a refused read', () => {
  it('a moment grocery add creates no second list when the list read is refused', async () => {
    const calls: Call[] = [];
    createServer.mockResolvedValue(fakeDb({ grocery_lists: [refused] }, calls));
    const { addMomentGroceryAction } = await import('@/app/(app)/dashboard/moment-actions');
    const res = await addMomentGroceryAction({ familyId: 'fam-1', items: ['juice boxes'] });
    expect(res.ok).toBe(false);
    expect(calls, 'a second "Groceries" list, or items on it').toEqual([]);
  });

  it('a moment grocery add re-adds nothing when "what is already on it" is refused', async () => {
    const calls: Call[] = [];
    createServer.mockResolvedValue(fakeDb({ grocery_lists: [{ data: [{ id: 'list-1' }] }], grocery_items: [refused] }, calls));
    const { addMomentGroceryAction } = await import('@/app/(app)/dashboard/moment-actions');
    const res = await addMomentGroceryAction({ familyId: 'fam-1', items: ['juice boxes'] });
    expect(res.ok).toBe(false);
    expect(calls.filter((c) => c.op === 'insert')).toEqual([]);
  });

  it('the moment add still creates the list when there genuinely is none (not over-tightened)', async () => {
    const calls: Call[] = [];
    createServer.mockResolvedValue(fakeDb({ grocery_lists: [{ data: [] }], grocery_items: [{ data: [] }] }, calls));
    const { addMomentGroceryAction } = await import('@/app/(app)/dashboard/moment-actions');
    await addMomentGroceryAction({ familyId: 'fam-1', items: ['juice boxes'] });
    expect(calls.some((c) => c.table === 'grocery_lists' && c.op === 'insert')).toBe(true);
  });

  it('the admin plan tool inserts no second subscription over a refused read', async () => {
    const calls: Call[] = [];
    createServiceClient.mockReturnValue(fakeDb({ subscriptions: [refused] }, calls));
    const { adminSetFamilyPlanAction } = await import('@/app/(app)/admin/actions');
    const res = await adminSetFamilyPlanAction({ familyId: 'fam-1', plan: 'plus' });
    expect(res.ok).toBe(false);
    expect(calls.filter((c) => c.table === 'subscriptions')).toEqual([]);
  });

  it("the admin plan tool updates a family's cancelled subscription instead of colliding with it", async () => {
    const calls: Call[] = [];
    createServiceClient.mockReturnValue(fakeDb({ subscriptions: [{ data: { id: 'sub-1', plan: 'basic' } }] }, calls));
    const { adminSetFamilyPlanAction } = await import('@/app/(app)/admin/actions');
    const res = await adminSetFamilyPlanAction({ familyId: 'fam-1', plan: 'plus' });
    expect(res.ok).toBe(true);
    expect(calls.filter((c) => c.table === 'subscriptions').map((c) => c.op)).toEqual(['update']);
    const src = readFileSync('app/(app)/admin/actions.ts', 'utf8');
    const fn = src.slice(at(src, 'export async function adminSetFamilyPlanAction('));
    // The lookup that made a `canceled` row invisible must not come back.
    expect(fn.slice(0, at(fn, 'const previousPlan'))).not.toContain(".in('status'");
  });
});

describe('onboarding ensures its trial subscription without failing over one that exists', () => {
  const src = readFileSync('app/onboarding/actions.ts', 'utf8');
  const step = between(src, '// 2c. Ensure a trial subscription exists', '// 3. Set this as the active family');

  it('a refused check is logged and the insert still ensures the row', () => {
    expect(step).toContain('error: existingSubError } = await admin');
    expect(step).toContain('if (existingSubError || !existingSub || existingSub.length === 0) {');
    expect(at(step, "if (existingSubError) console.error('[onboarding] subscription check failed")).toBeLessThan(at(step, ".from('subscriptions').insert("));
  });

  it('a unique violation is the row existing; every other refusal still fails closed', () => {
    expect(step).toContain("if (subErr && subErr.code !== '23505') return onboardingFailure(");
  });

  it('it is not an ON CONFLICT upsert — 0285 may have skipped the index it would need', () => {
    expect(step).not.toMatch(/from\('subscriptions'\)\.upsert\(/);
    expect(step).not.toContain("onConflict: 'family_id'");
  });
});

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^[^\S\n]*\/\/.*$/gm, '');

describe('the class is closed with two ratchets (C1-S9-75)', () => {
  it('no server action answers "not found" from a read that bound only `data`', () => {
    const files = execSync("grep -rl \"^'use server'\" app lib --include=*.ts --include=*.tsx", { encoding: 'utf8' }).trim().split('\n');
    const found: string[] = [];
    for (const f of files) {
      const lines = strip(readFileSync(f, 'utf8')).split('\n');
      lines.forEach((l, i) => {
        const m = l.match(/const \{ data: (\w+) \} = await/);
        if (!m || m[1] === 'auth') return; // auth.getUser(): verified fail-closed under C1-S9-42
        const window = lines.slice(i + 1, i + 14).join('\n');
        if (new RegExp(`if \\(!${m[1]}\\b`).test(window)) found.push(`${f}::${m[1]}`);
      });
    }
    expect(found, 'bind the error and say "could not", not "not found"').toEqual([]);
  });

  it('no get-or-create in app/ or lib/ creates on a read that bound only `data`', () => {
    const files = execSync("git ls-files 'app/**/*.ts' 'app/**/*.tsx' 'lib/**/*.ts'", { encoding: 'utf8' }).trim().split('\n');
    const accepted = new Set([
      // Analytics beacon, triaged under C1-S9-37: a failed experiment lookup
      // answers `{ recorded: false }`, which is true. Its insert is the event,
      // not a created parent.
      'app/api/ab/track/route.ts::exp',
    ]);
    const found: string[] = [];
    for (const f of files) {
      const lines = strip(readFileSync(f, 'utf8')).split('\n');
      lines.forEach((l, i) => {
        const m = l.match(/const \{ data: (\w+) \} = await/);
        if (!m || m[1] === 'auth') return; // auth.getUser(): a sign-in check, not a get-or-create (C1-S9-42)
        const window = lines.slice(i, i + 14).join('\n');
        if (/\.(insert|upsert)\(/.test(window) && new RegExp(`if \\(!(${m[1]}|\\w+Id)\\b`).test(window)) found.push(`${f}::${m[1]}`);
      });
    }
    expect(found.filter((k) => !accepted.has(k)).sort(), 'bind the read error before creating').toEqual([]);
    expect([...accepted].filter((k) => !found.includes(k)), 'an accepted entry that no longer occurs').toEqual([]);
  });
});

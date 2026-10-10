import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
    // A database without 0443's get-or-create (PGRST202), so the default-list
    // helper takes the read-then-insert path these cases were written against.
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
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
        // One row or null, as PostgREST answers it — the same unwrapping
        // `single` below does, so a spec's array means the same to both.
        maybeSingle: () => settle().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
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

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path.replace(/\\/g, '/'));
  }
  return out;
}

// Match the original grep prefix exactly, including trailing comments/statements.
const hasServerDirective = (source: string) => /^'use server'/m.test(source);

function refusedReadMatches(source: string, creates: boolean): string[] {
  const lines = strip(source).split('\n');
  const found: string[] = [];
  lines.forEach((line, i) => {
    const match = line.match(/const \{ data: (\w+) \} = await/);
    // auth.getUser() remains the verified fail-closed sign-in exception (C1-S9-42).
    if (!match || match[1] === 'auth') return;
    const window = lines.slice(creates ? i : i + 1, i + 14).join('\n');
    if (creates
      ? /\.(insert|upsert)\(/.test(window) && new RegExp(`if \\(!(${match[1]}|\\w+Id)\\b`).test(window)
      : new RegExp(`if \\(!${match[1]}\\b`).test(window)) found.push(match[1]);
  });
  return found;
}

describe('the class is closed with two ratchets (C1-S9-75)', () => {
  it('detects forbidden reads and preserves the server directive prefix scope', () => {
    expect(hasServerDirective("'use server';\r\nexport async function action() {}")).toBe(true);
    expect(hasServerDirective("'use server'; // action module\nexport async function action() {}")).toBe(true);
    expect(hasServerDirective("'use server'; export async function action() {}")).toBe(true);
    expect(hasServerDirective("// 'use server'\nconst text = 'use server';")).toBe(false);
    expect(refusedReadMatches("const { data: row } = await db.select();\nif (!row) return 'not found';", false)).toEqual(['row']);
    expect(refusedReadMatches("const { data: row } = await db.select();\nif (!row) await db.insert({});", true)).toEqual(['row']);
    expect(refusedReadMatches("const { data: row, error } = await db.select();\nif (!row) await db.insert({});", true)).toEqual([]);
  });
  it('no server action answers "not found" from a read that bound only `data`', () => {
    const files = [...sourceFiles('app'), ...sourceFiles('lib')].filter(file => hasServerDirective(readFileSync(file, 'utf8')));
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('app/(app)/dashboard/moment-actions.ts');
    const found: string[] = [];
    for (const f of files) {
      for (const name of refusedReadMatches(readFileSync(f, 'utf8'), false)) found.push(`${f}::${name}`);
    }
    expect(found, 'bind the error and say "could not", not "not found"').toEqual([]);
  });

  it('no get-or-create in app/ or lib/ creates on a read that bound only `data`', () => {
    const files = [...sourceFiles('app'), ...sourceFiles('lib')];
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('app/api/ab/track/route.ts');
    const accepted = new Set([
      // Analytics beacon, triaged under C1-S9-37: a failed experiment lookup
      // answers `{ recorded: false }`, which is true. Its insert is the event,
      // not a created parent.
      'app/api/ab/track/route.ts::exp',
    ]);
    const found: string[] = [];
    for (const f of files) {
      for (const name of refusedReadMatches(readFileSync(f, 'utf8'), true)) found.push(`${f}::${name}`);
    }
    expect(found.filter((k) => !accepted.has(k)).sort(), 'bind the read error before creating').toEqual([]);
    expect([...accepted].filter((k) => !found.includes(k)), 'an accepted entry that no longer occurs').toEqual([]);
  });
});

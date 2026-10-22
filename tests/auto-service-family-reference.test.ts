// Actual action, explicit rows and finite query/fault models. The child FK and
// family predicate below model 0037; these are not native RLS or race proofs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { saveAutoServiceAction } from '@/app/(app)/dashboard/auto/actions';

const h = vi.hoisted(() => ({ db: null as unknown, family: 'family-a', role: 'parent',
  locale: 'en-US' as 'en-US' | 'de-DE', authError: null as unknown, clientError: null as unknown,
  auth: vi.fn(), client: vi.fn(), refresh: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: h.refresh }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => tr(messages(h.locale), key) };
});
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => {
  h.auth(); if (h.authError) throw h.authError;
  return { user: { id: 'user-a' }, active: { familyId: h.family, role: h.role,
    family: { timezone: 'America/Los_Angeles' }, member: { id: 'member-a' } } };
} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => {
  h.client(); if (h.clientError) throw h.clientError; return h.db;
} }));

const OWN = 'car-a', FOREIGN = 'car-b', PRIVATE = 'synthetic database detail';
const UUID = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
type Fault = 'none' | 'error' | 'data-error' | 'throw' | 'reject' | 'empty';
type Call = { table: string; op: string; projection?: unknown; filters: Record<string, unknown>; payload?: unknown; condition?: unknown };
let db: InMemorySupabase;
let calls: Call[];
let violations: string[];
let visibleFamilies: Set<string>;
let admissionFault: Fault, odometerReadFault: Fault, odometerWriteFault: Fault, insertFault: Fault;
let receipt: { value: unknown } | null;
let alias: { requested: string; canonical: string } | null;
let familyAlias: { requested: string; canonical: string } | null;
let admissions: number, insertAttempts: number, odometerWrites: number;
let network: ReturnType<typeof vi.fn>;
function forbid(message: string): never { violations.push(message); throw new Error(message); }
const failure = () => ({ code: '42501', message: PRIVATE, details: PRIVATE, hint: PRIVATE });
const knownId = (value: unknown) => alias && value === alias.requested ? alias.canonical : value;
const knownFamily = (value: unknown) => familyAlias && value === familyAlias.requested ? familyAlias.canonical : value;
const records = () => db.table('auto_service_records');
function client() {
  return { from(table: string) {
    if (!['vehicles', 'auto_service_records'].includes(table)) forbid(`Unexpected table ${table}`);
    const target = db.from(table);
    const call: Call = { table, op: 'select', filters: {} }; calls.push(call);
    const proxy: typeof target = new Proxy(target, { get(builder, property) {
      if (property === 'maybeSingle') return () => {
        if (table !== 'vehicles' || call.op !== 'select' || !['id, family_id', 'id, mileage'].includes(String(call.projection))
          || call.filters.family_id !== h.family || typeof call.filters.id !== 'string'
          || Object.keys(call.filters).length !== 2) forbid('Unexpected vehicle read');
        const admission = call.projection === 'id, family_id';
        if (admission) admissions++;
        const fault = admission ? admissionFault : odometerReadFault;
        if (fault === 'throw') throw new Error(PRIVATE);
        if (fault === 'reject') return Promise.reject(new Error(PRIVATE));
        return builder.maybeSingle().then(result => {
          const data = result.data as { family_id?: string } | null;
          if (data?.family_id && !visibleFamilies.has(data.family_id)) return { ...result, data: null };
          if (fault === 'error' || fault === 'data-error') return { ...result,
            data: fault === 'data-error' ? result.data : null, error: failure() };
          if (fault === 'empty') return { ...result, data: null };
          return admission && receipt ? { ...result, data: receipt.value } : result;
        });
      };
      if (property === 'then') return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        if (table === 'auto_service_records' && call.op === 'insert') {
          insertAttempts++;
          const row = call.payload as { family_id: string; vehicle_id: string | null };
          // Child-family membership and single-ID parent existence are distinct:
          // a known foreign vehicle satisfies this FK, as in migration 0037.
          if (!visibleFamilies.has(String(knownFamily(row.family_id)))) return Promise.resolve({ data: null, error: failure() }).then(resolve, reject);
          if (row.vehicle_id !== null && !db.table('vehicles').some(v => v.id === knownId(row.vehicle_id))) {
            return Promise.resolve({ data: null, error: { code: '23503', message: PRIVATE } }).then(resolve, reject);
          }
          if (insertFault === 'error') return Promise.resolve({ data: null, error: failure() }).then(resolve, reject);
          if (insertFault === 'throw') return Promise.reject(new Error(PRIVATE)).then(resolve, reject);
          return Promise.resolve(builder).then(result => resolve({ ...result, data: null }), reject);
        }
        if (table !== 'vehicles' || call.op !== 'update' || call.projection !== 'id'
          || call.filters.family_id !== h.family || typeof call.filters.id !== 'string'
          || Object.keys(call.filters).length !== 2 || typeof call.condition !== 'string') forbid('Unexpected vehicle write');
        odometerWrites++;
        if (odometerWriteFault === 'throw') return Promise.reject(new Error(PRIVATE)).then(resolve, reject);
        if (odometerWriteFault === 'error') return Promise.resolve({ data: null, error: failure() }).then(resolve, reject);
        if (odometerWriteFault === 'empty') return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        return Promise.resolve(builder).then(resolve, reject);
      };
      const value: unknown = Reflect.get(builder, property, builder);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (property === 'select') call.projection = args[0];
        else if (property === 'eq') {
          call.filters[String(args[0])] = args[1];
          // Only explicitly armed literal UUID witnesses map to their fixed
          // canonical row. No copy of the production normalizer is used here.
          if (args[0] === 'id') args[1] = knownId(args[1]);
          if (args[0] === 'family_id') args[1] = knownFamily(args[1]);
        } else if (property === 'insert' && table === 'auto_service_records') {
          call.op = 'insert'; call.payload = args[0];
          expect(args[0]).toMatchObject({ family_id: h.family, created_by: 'user-a' });
        } else if (property === 'update' && table === 'vehicles') { call.op = 'update'; call.payload = args[0]; }
        else if (property === 'or' && table === 'vehicles') call.condition = args[0];
        else forbid(`Unexpected method ${table}.${String(property)}`);
        const result: unknown = Reflect.apply(value, builder, args);
        return result === builder ? proxy : result;
      };
    } });
    return proxy;
  } };
}
function form(fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ vehicle_id: OWN, title: 'Service', ...fields })) fd.set(key, value);
  return fd;
}
function revalidated() { expect(h.refresh.mock.calls).toEqual([['/dashboard/auto'], ['/dashboard/auto/service']]); }
async function refused(fields: Record<string, string> = {}) {
  const outcome = await saveAutoServiceAction(form(fields)).then(() => null, error => error as Error & { digest?: string });
  expect({ persisted: records(), insertAttempts, odometerWrites }).toEqual({ persisted: [], insertAttempts: 0, odometerWrites: 0 });
  expect(h.refresh).not.toHaveBeenCalled(); expect(admissions).toBe(1);
  expect(outcome).toMatchObject({ message: translate(getMessages(h.locale), 'actions.couldNotSaveThatService'), digest: 'ACTION_REFUSED:notSaved' });
  expect(outcome?.message).not.toContain(PRIVATE);
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T02:00:00Z'));
  h.family = 'family-a'; h.role = 'parent'; h.locale = 'en-US'; h.authError = null; h.clientError = null;
  calls = []; violations = []; visibleFamilies = new Set(['family-a']);
  admissionFault = odometerReadFault = odometerWriteFault = insertFault = 'none';
  receipt = null; alias = null; familyAlias = null; admissions = insertAttempts = odometerWrites = 0;
  db = createInMemorySupabase();
  db.seed('vehicles', [{ id: OWN, family_id: 'family-a', mileage: 52000, deleted_at: null },
    { id: FOREIGN, family_id: 'family-b', mileage: 12000, deleted_at: null }]);
  h.db = client();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  network = vi.fn(() => { throw new Error('Unexpected network'); }); vi.stubGlobal('fetch', network);
});
afterEach(() => {
  try { expect(violations).toEqual([]); expect(network).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); }
});

describe('service records admit an existing parent in the active family before writing', () => {
  it.each<Record<string, string>>([{}, { mileage: '0' }, { mileage: '53000' }])('refuses a known foreign vehicle with mileage fields %j', async fields => {
    await refused({ vehicle_id: FOREIGN, ...fields });
  });
  it('rejects a foreign parent even when the actor legitimately belongs to both families', async () => {
    visibleFamilies.add('family-b'); await refused({ vehicle_id: FOREIGN });
  });
  it('refuses a missing parent before the insert attempt; native FK refusal is a separate boundary', async () => { await refused({ vehicle_id: 'missing' }); });
  it.each(['error', 'data-error', 'throw', 'reject'] as const)('refuses %s preflight before insert and cache work', async fault => {
    admissionFault = fault; await refused();
  });
  it.each([
    ['null', null], ['array', [{ id: OWN, family_id: 'family-a' }]], ['scalar', 7], ['empty', {}],
    ['missing-id', { family_id: 'family-a' }], ['wrong-id', { id: FOREIGN, family_id: 'family-a' }],
    ['blank-id', { id: ' ', family_id: 'family-a' }], ['wrong-family', { id: OWN, family_id: 'family-b' }],
    ['missing-family', { id: OWN }], ['nonstring-family', { id: OWN, family_id: 7 }],
  ])('refuses malformed or mismatched %s receipt', async (_name, value) => { receipt = { value }; await refused(); });
  it('uses existing translated refusal copy for an uncertain parent', async () => { h.locale = 'de-DE'; admissionFault = 'data-error'; await refused(); });
  it('completes parent admission before the first child write even without mileage', async () => {
    await saveAutoServiceAction(form());
    expect(calls.map(c => [c.table, c.op, c.projection])).toEqual([
      ['vehicles', 'select', 'id, family_id'], ['auto_service_records', 'insert', undefined],
    ]); expect(records()).toHaveLength(1); revalidated();
  });
});

describe('nullable references, literal UUID aliases and existing action behavior', () => {
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'])('preserves the existing %s action path after a same-family lookup', async role => {
    h.role = role; await expect(saveAutoServiceAction(form())).resolves.toBeUndefined();
    expect(records()[0]).toMatchObject({ family_id: 'family-a', vehicle_id: OWN, mileage: null }); revalidated();
  });
  it.each(['omitted', 'blank'] as const)('keeps the %s vehicle as a nullable record without a lookup', async mode => {
    const fd = form(); if (mode === 'omitted') fd.delete('vehicle_id'); else fd.set('vehicle_id', '  ');
    await saveAutoServiceAction(fd); expect(records()[0].vehicle_id).toBeNull(); expect(admissions).toBe(0);
    expect(calls.map(c => c.table)).toEqual(['auto_service_records']); revalidated();
  });
  it.each([
    'A1B2C3D4-E5F6-4789-ABCD-0123456789AB',
    '{a1b2c3d4-e5f6-4789-abcd-0123456789ab}',
    'a1b2c3d4e5f64789abcd0123456789ab',
    'a1b2-c3d4-e5f6-4789-abcd-0123-4567-89ab',
  ])('preserves valid literal UUID input %s without rewriting the query or record', async requested => {
    alias = { requested, canonical: UUID }; db.seed('vehicles', [{ id: UUID, family_id: h.family, mileage: 1 }]);
    await saveAutoServiceAction(form({ vehicle_id: requested }));
    expect(records()[0].vehicle_id).toBe(requested);
    const read = calls.find(c => c.table === 'vehicles'); if (read) expect(read.filters.id).toBe(requested);
    revalidated();
  });
  it('compares canonical family UUID while retaining the original scope spelling', async () => {
    h.family = 'A1B2C3D4-E5F6-4789-ABCD-0123456789AB'; familyAlias = { requested: h.family, canonical: UUID };
    visibleFamilies = new Set([UUID]); db.table('vehicles')[0].family_id = UUID;
    await saveAutoServiceAction(form()); expect(records()[0].family_id).toBe(h.family); revalidated();
  });
  it.each(['-a1b2c3d4-e5f6-4789-abcd-0123456789ab', '{a1b2c3d4-e5f6-4789-abcd-0123456789ab', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'CAR-A'])('does not admit a mismatched receipt for requested id %s', async requested => {
    receipt = { value: { id: UUID, family_id: h.family } }; await refused({ vehicle_id: requested });
  });
  it('preserves trimmed payloads, family-local day, numeric values and no-return INSERT success', async () => {
    await saveAutoServiceAction(form({ vehicle_id: ' car-a ', title: ' Tyres ', provider: ' Garage ', cost: '12.5', description: ' note ', next_due_on: '2026-12-12', next_due_mileage: '60000' }));
    expect(records()[0]).toMatchObject({ family_id: 'family-a', vehicle_id: OWN, title: 'Tyres', provider: 'Garage', cost: 12.5,
      description: 'note', service_date: '2026-10-16', next_due_on: '2026-12-12', next_due_mileage: 60000, created_by: 'user-a' }); revalidated();
  });
  it('keeps an existing same-family soft-deleted parent eligible without inventing a new history policy', async () => {
    db.table('vehicles')[0].deleted_at = '2026-10-01T00:00:00Z'; await saveAutoServiceAction(form()); expect(records()).toHaveLength(1); revalidated();
  });
  it('preserves authentication redirects outside the parent-lookup boundary', async () => {
    const error = Object.assign(new Error('redirect'), { digest: 'NEXT_REDIRECT' }); h.authError = error;
    await expect(saveAutoServiceAction(form())).rejects.toBe(error); expect(h.client).not.toHaveBeenCalled(); expect(calls).toEqual([]); expect(h.refresh).not.toHaveBeenCalled();
  });
  it('preserves client-construction rejection without a write', async () => {
    const error = new Error('client unavailable'); h.clientError = error;
    await expect(saveAutoServiceAction(form())).rejects.toBe(error); expect(calls).toEqual([]); expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe('parent admission leaves the existing post-insert odometer contract intact', () => {
  it.each([
    { current: 52000, input: '30000', expected: 52000, writes: 0 },
    { current: 52000, input: '52000', expected: 52000, writes: 0 },
    { current: 52000, input: '53000', expected: 53000, writes: 1 },
    { current: null, input: '0', expected: 0, writes: 1 },
  ])('preserves current=$current input=$input odometer behavior', async ({ current, input, expected, writes }) => {
    db.table('vehicles')[0].mileage = current; await saveAutoServiceAction(form({ mileage: input }));
    expect(records()).toHaveLength(1); expect(db.table('vehicles')[0].mileage).toBe(expected); expect(odometerWrites).toBe(writes);
    if (writes) expect(calls.find(c => c.op === 'update')?.condition).toBe(`mileage.is.null,mileage.lt.${input}`);
    revalidated();
  });
  it('rejects negative mileage before any parent read or write', async () => {
    await expect(saveAutoServiceAction(form({ mileage: '-5' }))).rejects.toMatchObject({ digest: 'ACTION_REFUSED:invalid' });
    expect(calls).toEqual([]); expect(records()).toEqual([]); expect(h.refresh).not.toHaveBeenCalled();
  });
  it.each(['error', 'throw'] as const)('retains %s INSERT refusal after parent admission', async fault => {
    insertFault = fault; await expect(saveAutoServiceAction(form({ mileage: '53000' }))).rejects.toBeInstanceOf(Error);
    expect(insertAttempts).toBe(1); expect(records()).toEqual([]); expect(odometerWrites).toBe(0); expect(h.refresh).not.toHaveBeenCalled();
  });
  it.each(['error', 'empty'] as const)('retains success for a returned %s odometer read after persistence', async fault => {
    odometerReadFault = fault; await expect(saveAutoServiceAction(form({ mileage: '53000' }))).resolves.toBeUndefined();
    expect(records()).toHaveLength(1); expect(odometerWrites).toBe(0); expect(console.error).toHaveBeenCalledWith('[auto] vehicle odometer read failed', expect.any(Object)); revalidated();
  });
  it.each(['error', 'empty'] as const)('retains success for a returned %s odometer update after persistence', async fault => {
    odometerWriteFault = fault; await expect(saveAutoServiceAction(form({ mileage: '53000' }))).resolves.toBeUndefined();
    expect(records()).toHaveLength(1); expect(odometerWrites).toBe(1); expect(db.table('vehicles')[0].mileage).toBe(52000);
    expect(console.error).toHaveBeenCalledWith('[auto] vehicle odometer update failed', expect.any(Object)); revalidated();
  });
  it.each(['read', 'update'] as const)('retains thrown post-insert odometer %s rejection after persistence and before revalidation', async stage => {
    if (stage === 'read') odometerReadFault = 'reject'; else odometerWriteFault = 'throw';
    await expect(saveAutoServiceAction(form({ mileage: '53000' }))).rejects.toThrow(PRIVATE);
    expect(records()).toHaveLength(1); expect(db.table('vehicles')[0].mileage).toBe(52000); expect(h.refresh).not.toHaveBeenCalled();
  });
});

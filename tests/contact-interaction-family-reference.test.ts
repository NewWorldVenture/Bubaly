// Actual action and translated refusals, explicit model rows. This proves app
// admission, not native FK/RLS, concurrent ownership locks or production Auth.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { logInteractionAction } from '@/app/(app)/dashboard/contacts/[id]/actions';

const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent', family: 'family-a', locale: 'en-US' as 'en-US' | 'de-DE',
  authError: null as unknown, clientError: null as unknown, auth: vi.fn(), client: vi.fn(), refresh: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: h.refresh }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => tr(messages(h.locale), key) };
});
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => {
  h.auth(); if (h.authError) throw h.authError;
  return { user: { id: 'user-a' }, active: { familyId: h.family, role: h.role, family: { timezone: 'America/Los_Angeles' } } };
} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => {
  h.client(); if (h.clientError) throw h.clientError; return h.db;
} }));

const OWN = 'contact-a', FOREIGN = 'contact-b';
const UUID = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
const PRIVATE = 'synthetic private database detail';
type Fault = 'none' | 'returned' | 'codeless' | 'data-error' | 'throw' | 'reject';
let db: InMemorySupabase;
let fault: Fault;
let receipt: { value: unknown } | null;
let alias: { requested: string; received: string } | null;
let familyAlias: { requested: string; received: string } | null;
let insertFault: 'none' | 'returned' | 'throw';
let calls: { table: string; op: string; projection?: unknown; filters: Record<string, unknown>; payload?: unknown }[];
let admissions: number;
let inserts: number;
let violations: string[];
let network: ReturnType<typeof vi.fn>;
function forbid(message: string): never { violations.push(message); throw new Error(message); }
const failure = () => ({ code: '42501', message: PRIVATE, details: PRIVATE, hint: PRIVATE });

function client() {
  return { from(table: string) {
    if (!['family_contacts', 'contact_interactions'].includes(table)) forbid(`Unexpected table ${table}`);
    const target = db.from(table);
    const call = { table, op: 'select', filters: {} as Record<string, unknown>, projection: undefined as unknown, payload: undefined as unknown };
    calls.push(call);
    const proxy: typeof target = new Proxy(target, { get(builder, property) {
      if (property === 'maybeSingle') return () => {
        if (table !== 'family_contacts' || call.op !== 'select' || call.projection !== 'id, family_id'
          || call.filters.family_id !== h.family || typeof call.filters.id !== 'string' || Object.keys(call.filters).length !== 2) forbid('Unexpected contact admission query');
        admissions++;
        if (fault === 'throw') throw new Error(PRIVATE);
        if (fault === 'reject') return Promise.reject(new Error(PRIVATE));
        return builder.maybeSingle().then(result => {
        if (fault === 'returned' || fault === 'codeless' || fault === 'data-error') return {
          ...result, data: fault === 'data-error' ? result.data : null,
          error: fault === 'codeless' ? { message: PRIVATE } : failure(),
        };
        return receipt ? { ...result, data: receipt.value } : result;
        });
      };
      if (property === 'then') return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        if (table !== 'contact_interactions' || call.op !== 'insert') forbid('Unexpected write terminal');
        inserts++;
        if (insertFault === 'returned') return Promise.resolve({ data: null, error: failure() }).then(resolve, reject);
        if (insertFault === 'throw') return Promise.reject(new Error(PRIVATE)).then(resolve, reject);
        // INSERT without RETURNING succeeds with no returned rows; preserve it.
        return Promise.resolve(builder).then(result => resolve({ ...result, data: null }), reject);
      };
      const value: unknown = Reflect.get(builder, property, builder);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (property === 'select') call.projection = args[0];
        else if (property === 'eq') {
          call.filters[String(args[0])] = args[1];
          // Declared PostgreSQL UUID input/output contract only. Retain the
          // original request in the recorded filter/payload, normalize solely
          // the model lookup when a named alias witness is explicitly armed.
          const witness = args[0] === 'id' ? alias : args[0] === 'family_id' ? familyAlias : null;
          if (witness && args[1] === witness.requested) args[1] = witness.received;
        } else if (property === 'insert' && table === 'contact_interactions') {
          call.op = 'insert'; call.payload = args[0];
          expect(args[0]).toMatchObject({ family_id: h.family, created_by: 'user-a' });
        } else forbid(`Unexpected method ${table}.${String(property)}`);
        const result: unknown = Reflect.apply(value, builder, args);
        return result === builder ? proxy : result;
      };
    } });
    return proxy;
  } };
}
function form(values: Record<string, string> = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ contact_id: OWN, title: 'Coffee', ...values })) f.set(k, v);
  return f;
}
const rows = () => db.table('contact_interactions');
const safeMessage = () => translate(getMessages(h.locale), 'actions.couldNotLogThatInteraction');
async function refused(values: Record<string, string> = {}) {
  const outcome = await logInteractionAction(form(values)).then(() => null, e => e as Error & { digest?: string });
  expect(rows()).toEqual([]); expect(inserts).toBe(0); expect(h.refresh).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({ message: safeMessage(), digest: 'ACTION_REFUSED:notSaved' });
  expect(outcome?.message).not.toContain(PRIVATE); expect(admissions).toBe(1);
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T02:00:00Z'));
  h.family = 'family-a'; h.role = 'parent'; h.locale = 'en-US'; h.authError = null; h.clientError = null;
  fault = 'none'; receipt = null; alias = null; familyAlias = null; insertFault = 'none'; calls = []; admissions = 0; inserts = 0; violations = [];
  db = createInMemorySupabase();
  db.seed('family_contacts', [{ id: OWN, family_id: h.family, name: 'Own contact' }, { id: FOREIGN, family_id: 'family-b', name: 'Foreign contact' }]);
  h.db = client();
  network = vi.fn(() => { throw new Error('Unexpected network'); }); vi.stubGlobal('fetch', network);
});
afterEach(() => { expect(violations).toEqual([]); expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('submitted contact references require saved same-family admission', () => {
  it('refuses an existing foreign contact rather than persisting a cross-family reference', async () => { await refused({ contact_id: FOREIGN }); });
  it('refuses a missing contact; this model case is not a claim that native FK permits dangling ids', async () => { await refused({ contact_id: 'missing' }); });
  it.each(['returned', 'codeless', 'data-error', 'throw', 'reject'] as const)('refuses %s lookup failure before insert/cache work', async mode => {
    fault = mode; await refused();
  });
  it.each([
    ['null', null], ['array', [{ id: OWN, family_id: 'family-a' }]], ['scalar', 7], ['empty', {}],
    ['missing-id', { family_id: 'family-a' }], ['blank-id', { id: ' ', family_id: 'family-a' }],
    ['wrong-id', { id: 'other', family_id: 'family-a' }], ['missing-family', { id: OWN }],
    ['wrong-family', { id: OWN, family_id: 'family-b' }], ['nonstring-id', { id: 1, family_id: 'family-a' }],
  ])('refuses malformed/mismatched %s receipt', async (_label, value) => { receipt = { value }; await refused(); });
  it('uses safe existing translated refusal copy for an unavailable lookup', async () => { h.locale = 'de-DE'; fault = 'data-error'; await refused(); });
});

describe('identity spelling and action compatibility', () => {
  it.each([UUID.toUpperCase(), `{${UUID}}`, UUID.replaceAll('-', ''), 'a1b2-c3d4e5f6-4789abcd-0123456789ab'])('preserves PostgreSQL UUID alias %s without rewriting request bytes', async requested => {
    alias = { requested, received: UUID }; db.seed('family_contacts', [{ id: UUID, family_id: h.family }]);
    await expect(logInteractionAction(form({ contact_id: requested }))).resolves.toBeUndefined();
    expect(admissions).toBe(1); expect(calls[0].filters.id).toBe(requested);
    expect(rows()[0].contact_id).toBe(requested); expect(h.refresh).toHaveBeenCalledWith(`/dashboard/contacts/${requested}`);
  });
  it('compares UUID family identity without narrowing existing valid spelling', async () => {
    h.family = UUID.toUpperCase(); familyAlias = { requested: h.family, received: UUID };
    db.table('family_contacts')[0].family_id = UUID;
    await expect(logInteractionAction(form())).resolves.toBeUndefined();
    expect(admissions).toBe(1); expect(calls[0].filters.family_id).toBe(h.family); expect(rows()[0].family_id).toBe(h.family);
  });
  it.each([`-${UUID}`, `{${UUID}`, `${UUID}}`, `a1-b2c3d4e5f64789abcd0123456789ab`, 'ffffffff-ffff-ffff-ffff-ffffffffffff'])('does not normalize invalid/different requested id %s into admission', async requested => {
    receipt = { value: { id: UUID, family_id: h.family } }; await refused({ contact_id: requested });
  });
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'])('preserves existing %s action role behavior after same-family admission', async role => {
    h.role = role; await expect(logInteractionAction(form())).resolves.toBeUndefined();
    expect(admissions).toBe(1); expect(inserts).toBe(1); expect(rows()).toHaveLength(1);
  });
  it('preserves payload formatting, family-local day and successful no-return INSERT', async () => {
    await expect(logInteractionAction(form({ title: `  ${'x'.repeat(205)}  `, note: '  saved note  ', kind: 'unknown', amount: '12.5' }))).resolves.toBeUndefined();
    expect(admissions).toBe(1); expect(inserts).toBe(1);
    expect(rows()[0]).toMatchObject({ family_id: 'family-a', contact_id: OWN, title: 'x'.repeat(200), note: 'saved note', kind: 'note', amount: 12.5, occurred_on: '2026-10-16', created_by: 'user-a' });
    expect(h.refresh).toHaveBeenCalledExactlyOnceWith(`/dashboard/contacts/${OWN}`);
  });
  it('preserves explicit date/kind and empty optional fields', async () => {
    await logInteractionAction(form({ occurred_on: '2026-02-03', kind: 'gift', note: ' ', amount: 'not-a-number' }));
    expect(rows()[0]).toMatchObject({ occurred_on: '2026-02-03', kind: 'gift', note: null, amount: null }); expect(admissions).toBe(1);
  });
  it('still reaches and refuses the INSERT failure after valid parent admission', async () => {
    insertFault = 'returned';
    await expect(logInteractionAction(form())).rejects.toMatchObject({ digest: 'ACTION_REFUSED:notAllowed' });
    expect(admissions).toBe(1); expect(inserts).toBe(1); expect(rows()).toEqual([]); expect(h.refresh).not.toHaveBeenCalled();
    expect(calls.map(c => [c.table, c.op])).toEqual([['family_contacts', 'select'], ['contact_interactions', 'insert']]);
  });
  it('preserves authentication redirect rather than turning it into a lookup refusal', async () => {
    const redirect = Object.assign(new Error('redirect'), { digest: 'NEXT_REDIRECT' }); h.authError = redirect;
    await expect(logInteractionAction(form())).rejects.toBe(redirect);
    expect(h.client).not.toHaveBeenCalled(); expect(calls).toEqual([]); expect(h.refresh).not.toHaveBeenCalled();
  });
  it('preserves the client-construction boundary and cannot write on its failure', async () => {
    const unavailable = new Error('client unavailable'); h.clientError = unavailable;
    await expect(logInteractionAction(form())).rejects.toBe(unavailable); expect(calls).toEqual([]); expect(h.refresh).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{ contact_id: '' }, { title: ' ' }])('keeps existing empty form %j as an early no-op', async fields => {
    await expect(logInteractionAction(form(fields))).resolves.toBeUndefined(); expect(h.auth).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  });
});

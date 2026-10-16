// SERVICE-EEA0AD263428: editing rights do not establish the household of an
// incoming member reference. Run the actual service, getMember and action with
// explicit synthetic rows. The model enforces filters, not SQL/RLS or live Auth.
// Held 0501 records family_facts as an excluded reference-family lead; this
// application guard does not close direct SQL, create/confirm paths or races.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateFact } from '@/lib/services/memory';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const context = vi.hoisted(() => ({
  db: null as unknown, role: 'parent' as string,
  userId: 'synthetic-user-parent', memberId: 'synthetic-parent',
  revalidate: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: context.revalidate }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => context.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: context.userId },
    active: {
      familyId: 'synthetic-family-a', role: context.role, member: { id: context.memberId },
      family: { name: 'Synthetic family', timezone: 'UTC' },
    },
  }),
}));
const { saveFactAction } = await import('@/app/(app)/dashboard/knowledge/actions');

const FAMILY = 'synthetic-family-a';
const FOREIGN = 'synthetic-family-b';
const FACT = 'synthetic-fact';
const ACTIVE = 'synthetic-active';
const INACTIVE = 'synthetic-inactive';
const NO_LOGIN = 'synthetic-no-login';
const FOREIGN_MEMBER = 'synthetic-foreign-member';
const UUID_MEMBER = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
const UUID_ALIASES = [
  UUID_MEMBER.toUpperCase(), `{${UUID_MEMBER}}`, UUID_MEMBER.replaceAll('-', ''),
  'a1b2-c3d4e5f6-4789abcd-0123456789ab',
];
const PRIVATE_ERROR = 'SYNTHETIC_PROVIDER_PRIVATE_DETAILS';
const NOW = new Date('2026-10-16T12:00:00Z');
type Reply = Awaited<ReturnType<ReturnType<InMemorySupabase['from']>['maybeSingle']>>;
type Fault = 'none' | 'returned' | 'codeless' | 'data-error' | 'throw' | 'reject' | 'missing-id' | 'wrong-id';
type Call = { table: string; op: string; filters: Record<string, unknown>; select?: unknown; payload?: unknown };
let db: InMemorySupabase;
let client: ServiceScope['db'];
let calls: Call[];
let violations: string[];
let fault: Fault;
let updateFault: 'none' | 'empty' | 'error';
let memberFaults: number;
let uuidReceipt: { input: string; received: string } | null;
let network: ReturnType<typeof vi.fn>;

function refuse(message: string): never {
  violations.push(message);
  throw new Error(message);
}

function response(data: unknown, code?: string): Reply {
  return {
    data, error: code === undefined ? null : { code, message: PRIVATE_ERROR, details: null, hint: null },
    count: null, status: code === undefined ? 200 : 400, statusText: code === undefined ? 'OK' : 'Bad Request',
  };
}

// Delegate actual row filtering/writes to the shared model; intercept only the
// exact admitted terminal query. Unknown operations cannot fabricate success,
// and guard violations are asserted after every case even if source catches one.
function recordedClient(): ServiceScope['db'] {
  return {
    from(table: string) {
      if (!['family_facts', 'family_members', 'audit_logs', 'agent_activity'].includes(table)) refuse(`Unexpected table ${table}`);
      const target = db.from(table);
      const call: Call = { table, op: 'select', filters: {} };
      calls.push(call);
      function terminal(method: string): void {
        if (table === 'family_members' || table === 'family_facts') {
          if (method !== 'maybeSingle' || call.select !== '*' || call.filters.family_id !== FAMILY
            || typeof call.filters.id !== 'string' || Object.keys(call.filters).length !== 2
            || (table === 'family_members' ? call.op !== 'select' : !['select', 'update'].includes(call.op))) {
            refuse(`Unexpected scoped query ${JSON.stringify(call)}/${method}`);
          }
        } else if (call.op !== 'insert' || Object.keys(call.filters).length !== 0) {
          refuse(`Unexpected activity query ${JSON.stringify(call)}`);
        }
      }
      const proxy = new Proxy(target, {
        get(builder, key) {
          if (typeof key !== 'string' || !['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'maybeSingle', 'single', 'then'].includes(key)) {
            return refuse(`Unexpected builder method ${String(key)}`);
          }
          return (...args: unknown[]) => {
            if (key === 'eq') call.filters[String(args[0])] = args[1];
            if (key === 'select') call.select = args[0] ?? '*';
            if (['insert', 'update', 'upsert', 'delete'].includes(key)) { call.op = key; call.payload = args[0]; }
            if (['maybeSingle', 'single', 'then'].includes(key)) {
              terminal(key);
              if (table === 'family_members' && uuidReceipt) {
                // A declared PostgreSQL UUID-input/canonical-output contract,
                // not an extension of the shared model's string equality.
                // Resolve only this fixture's seeded same-family member; the
                // original alias must still reach the actual service query.
                if (call.filters.id !== uuidReceipt.input) refuse('UUID input was rewritten');
                const row = db.table('family_members').find((member) => member.id === UUID_MEMBER && member.family_id === FAMILY);
                if (!row) refuse('UUID fixture member was not seeded');
                return Promise.resolve(response({ ...row, id: uuidReceipt.received }));
              }
              if (table === 'family_members' && fault !== 'none') {
                memberFaults++;
                if (fault === 'throw') throw new Error(PRIVATE_ERROR);
                if (fault === 'reject') return Promise.reject(new Error(PRIVATE_ERROR));
                const member = db.table('family_members').find((row) => row.id === call.filters.id)!;
                if (fault === 'returned') return Promise.resolve(response(null, '42501'));
                if (fault === 'codeless') return Promise.resolve(response(null, ''));
                if (fault === 'data-error') return Promise.resolve(response(member, '42501'));
                if (fault === 'missing-id') return Promise.resolve(response({ ...member, id: undefined }));
                if (fault === 'wrong-id') return Promise.resolve(response({ ...member, id: 'synthetic-wrong-receipt' }));
              }
              if (table === 'family_facts' && call.op === 'update' && updateFault !== 'none') {
                return Promise.resolve(response(null, updateFault === 'error' ? '42501' : undefined));
              }
            }
            const method = Reflect.get(builder, key) as (...values: unknown[]) => unknown;
            const result = method.apply(builder, args);
            return result === builder ? proxy : result;
          };
        },
      });
      return proxy;
    },
  } as unknown as ServiceScope['db'];
}

function member(id: string, extra: Row = {}): Row {
  return {
    id, family_id: FAMILY, user_id: `synthetic-user-${id}`, role: 'child',
    display_name: id, is_active: true, birthday: null, color: null, avatar_url: null, ...extra,
  };
}
function scope(role: ServiceScope['role'] = 'parent'): ServiceScope {
  return {
    db: client, familyId: FAMILY, userId: `synthetic-user-${role}`, memberId: `synthetic-${role}`,
    role, actorKind: role === 'system' ? 'system' : 'member', tz: 'UTC', now: NOW,
  };
}
function fact(): Row { return db.table('family_facts').find((row) => row.id === FACT)!; }
function snapshot() {
  return structuredClone({ facts: db.table('family_facts'), members: db.table('family_members') });
}
function unchanged(before: ReturnType<typeof snapshot>) {
  expect(snapshot()).toEqual(before);
  expect(calls.filter((call) => call.op !== 'select')).toEqual([]);
  expect(db.table('audit_logs')).toEqual([]);
  expect(db.table('agent_activity')).toEqual([]);
  expect(context.revalidate).not.toHaveBeenCalled();
}
function lookup(id: string) {
  expect(calls.filter((call) => call.table === 'family_members')).toEqual([
    { table: 'family_members', op: 'select', select: '*', filters: { id, family_id: FAMILY } },
  ]);
}

beforeEach(() => {
  calls = []; violations = []; fault = 'none'; updateFault = 'none'; memberFaults = 0; uuidReceipt = null;
  context.role = 'parent'; context.userId = 'synthetic-user-parent'; context.memberId = 'synthetic-parent';
  context.revalidate.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  network = vi.fn(() => { throw new Error('No network admitted by this fixture'); });
  vi.stubGlobal('fetch', network);
  db = createInMemorySupabase({ defaults: { family_facts: { notes: null, is_pinned: false, source: 'user', expires_at: null } } });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }, { id: FOREIGN, timezone: 'UTC' }]);
  db.seed('family_members', [
    member('synthetic-parent', { role: 'parent', user_id: 'synthetic-user-parent' }),
    member('synthetic-teen', { role: 'teen', user_id: 'synthetic-user-teen' }),
    member(ACTIVE), member(INACTIVE, { is_active: false }), member(NO_LOGIN, { user_id: null }),
    member(UUID_MEMBER),
    member(FOREIGN_MEMBER, { family_id: FOREIGN, user_id: 'synthetic-user-teen' }),
  ]);
  db.seed('family_facts', [{
    id: FACT, family_id: FAMILY, member_id: ACTIVE, category: 'preference',
    label: 'Favourite game', value: 'Cards', created_by: 'synthetic-user-parent',
  }]);
  client = recordedClient(); context.db = client;
});
afterEach(() => {
  expect(violations).toEqual([]);
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('an explicit memory member belongs to the active family', () => {
  it.each(['parent', 'adult', 'system'] as const)('refuses a foreign member even for %s', async (role) => {
    const before = snapshot();
    expect(await updateFact(scope(role), FACT, { memberId: FOREIGN_MEMBER })).toMatchObject({ ok: false, code: 'not_found' });
    lookup(FOREIGN_MEMBER); unchanged(before);
  });
  it('authorship and a second household membership do not admit a foreign reference', async () => {
    fact().created_by = 'synthetic-user-teen';
    const before = snapshot();
    expect(await updateFact(scope('teen'), FACT, { memberId: FOREIGN_MEMBER })).toMatchObject({ ok: false, code: 'not_found' });
    lookup(FOREIGN_MEMBER); unchanged(before);
  });
  it('revalidates an explicit unchanged foreign reference instead of grandfathering it', async () => {
    fact().member_id = FOREIGN_MEMBER;
    const before = snapshot();
    expect(await updateFact(scope(), FACT, { memberId: FOREIGN_MEMBER, value: 'Chess' })).toMatchObject({ ok: false, code: 'not_found' });
    lookup(FOREIGN_MEMBER); unchanged(before);
  });
  it('refuses a missing member before any write', async () => {
    const before = snapshot();
    expect(await updateFact(scope(), FACT, { memberId: 'synthetic-missing' })).toMatchObject({ ok: false, code: 'not_found' });
    lookup('synthetic-missing'); unchanged(before);
  });
  it.each([ACTIVE, INACTIVE, NO_LOGIN])('admits the explicit same-family reference %s', async (memberId) => {
    expect(await updateFact(scope(), FACT, { memberId, value: 'Chess' })).toMatchObject({ ok: true, data: { id: FACT, member_id: memberId } });
    lookup(memberId);
    expect(fact()).toMatchObject({ member_id: memberId, value: 'Chess' });
    expect(calls.filter((call) => call.op === 'update')).toHaveLength(1);
    expect(db.table('audit_logs')).toHaveLength(1);
  });
  it('validates an unchanged inactive historical reference', async () => {
    fact().member_id = INACTIVE;
    expect(await updateFact(scope(), FACT, { memberId: INACTIVE, value: 'Chess' })).toMatchObject({ ok: true });
    lookup(INACTIVE);
  });
  it('preserves a nonmanager author’s legitimate same-family reassignment', async () => {
    fact().created_by = 'synthetic-user-teen';
    expect(await updateFact(scope('teen'), FACT, { memberId: INACTIVE })).toMatchObject({ ok: true });
    lookup(INACTIVE); expect(fact().member_id).toBe(INACTIVE);
  });
  it.each([null, ''])('preserves explicit clear semantics for %j', async (memberId) => {
    expect(await updateFact(scope(), FACT, { memberId })).toMatchObject({ ok: true, data: { member_id: null } });
    expect(fact().member_id).toBeNull();
    expect(calls.filter((call) => call.table === 'family_members')).toEqual([]);
  });
  it.each([{}, { memberId: undefined }])('omission does not newly admit or change a legacy reference: %j', async (input) => {
    fact().member_id = FOREIGN_MEMBER;
    expect(await updateFact(scope(), FACT, { ...input, value: 'Chess' })).toMatchObject({ ok: true });
    expect(fact()).toMatchObject({ member_id: FOREIGN_MEMBER, value: 'Chess' });
    expect(calls.filter((call) => call.table === 'family_members')).toEqual([]);
  });
  it('does not turn a nonempty whitespace id into a clear', async () => {
    const before = snapshot();
    expect(await updateFact(scope(), FACT, { memberId: '   ' })).toMatchObject({ ok: false });
    lookup('   '); unchanged(before);
  });
});

describe('member lookup failures never become permission to update', () => {
  it.each(['returned', 'codeless', 'data-error', 'throw', 'reject', 'missing-id', 'wrong-id'] as const)('refuses %s with safe feedback and no retry', async (failure) => {
    fault = failure;
    const before = snapshot();
    const result = await updateFact(scope(), FACT, { memberId: INACTIVE });
    expect(result).toMatchObject({ ok: false, code: 'db' });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_ERROR);
    expect(memberFaults).toBe(1); lookup(INACTIVE); unchanged(before);
  });
  it.each(['empty', 'error'] as const)('preserves an admitted update’s %s refusal', async (failure) => {
    updateFault = failure;
    const before = snapshot();
    expect(await updateFact(scope(), FACT, { memberId: INACTIVE })).toMatchObject({ ok: false });
    lookup(INACTIVE);
    expect(snapshot()).toEqual(before);
    expect(calls.filter((call) => call.op === 'update')).toHaveLength(1);
    expect(db.table('audit_logs')).toEqual([]);
  });
  it('keeps the existing sibling ownership refusal before member admission', async () => {
    const before = snapshot();
    expect(await updateFact(scope('teen'), FACT, { memberId: INACTIVE })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls.filter((call) => call.table === 'family_members')).toEqual([]); unchanged(before);
  });
  it('keeps the sensitive-content refusal before member admission', async () => {
    fact().created_by = 'synthetic-user-teen';
    const before = snapshot();
    expect(await updateFact(scope('teen'), FACT, { memberId: INACTIVE, category: 'medical' })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls.filter((call) => call.table === 'family_members')).toEqual([]); unchanged(before);
  });
  it('does not admit a foreign fact through a valid local member', async () => {
    fact().family_id = FOREIGN;
    const before = snapshot();
    expect(await updateFact(scope(), FACT, { memberId: INACTIVE })).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls.filter((call) => call.table === 'family_members')).toEqual([]); unchanged(before);
  });
});

describe('PostgreSQL UUID reference identity does not rewrite requested bytes', () => {
  it.each(UUID_ALIASES)('accepts the valid alias %s with a canonical receipt', async (input) => {
    uuidReceipt = { input, received: UUID_MEMBER };
    expect(await updateFact(scope(), FACT, { memberId: input })).toMatchObject({ ok: true });
    lookup(input);
    expect(calls.filter((call) => call.op === 'update')).toEqual([
      { table: 'family_facts', op: 'update', select: '*', filters: { family_id: FAMILY, id: FACT }, payload: { member_id: input } },
    ]);
    expect(db.table('audit_logs')).toHaveLength(1);
  });
  it.each([
    `${UUID_MEMBER}-`, `{${UUID_MEMBER}`, `${UUID_MEMBER} `,
    `a-${UUID_MEMBER.replaceAll('-', '').slice(1)}`,
  ])('refuses invalid UUID grammar despite a forged matching-normalized receipt: %s', async (input) => {
    uuidReceipt = { input, received: UUID_MEMBER };
    const before = snapshot();
    expect(await updateFact(scope(), FACT, { memberId: input })).toMatchObject({ ok: false, code: 'db' });
    lookup(input); unchanged(before);
  });
  it('refuses a different valid UUID receipt', async () => {
    uuidReceipt = { input: UUID_ALIASES[0], received: 'b1b2c3d4-e5f6-4789-abcd-0123456789ab' };
    const before = snapshot();
    expect(await updateFact(scope(), FACT, { memberId: UUID_ALIASES[0] })).toMatchObject({ ok: false, code: 'db' });
    lookup(UUID_ALIASES[0]); unchanged(before);
  });
});

describe('the actual saveFactAction reports the admission result', () => {
  it('refuses the knowledge form’s explicit foreign reference without refreshing', async () => {
    const before = snapshot();
    expect(await saveFactAction(FACT, { memberId: FOREIGN_MEMBER, label: 'Favourite game', value: 'Chess' })).toMatchObject({ ok: false });
    lookup(FOREIGN_MEMBER); unchanged(before);
  });
  it.each(['codeless', 'throw', 'data-error'] as const)('does not expose or refresh a %s lookup failure', async (failure) => {
    fault = failure;
    const before = snapshot();
    const result = await saveFactAction(FACT, { memberId: INACTIVE, label: 'Favourite game', value: 'Chess' });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_ERROR);
    expect(memberFaults).toBe(1); lookup(INACTIVE); unchanged(before);
  });
  it('saves an explicit inactive reference and refreshes both real callers', async () => {
    expect(await saveFactAction(FACT, { memberId: INACTIVE, label: 'Favourite game', value: 'Chess' })).toEqual({ ok: true, id: FACT });
    lookup(INACTIVE); expect(fact().member_id).toBe(INACTIVE);
    expect(context.revalidate.mock.calls).toEqual([['/dashboard/knowledge'], ['/dashboard/life-events']]);
  });
  it('preserves the life-events caller’s omitted-reference edit', async () => {
    expect(await saveFactAction(FACT, { label: 'Favourite game', value: 'Chess' })).toEqual({ ok: true, id: FACT });
    expect(fact()).toMatchObject({ member_id: ACTIVE, value: 'Chess' });
    expect(calls.filter((call) => call.table === 'family_members')).toEqual([]);
    expect(context.revalidate.mock.calls).toEqual([['/dashboard/knowledge'], ['/dashboard/life-events']]);
  });
});

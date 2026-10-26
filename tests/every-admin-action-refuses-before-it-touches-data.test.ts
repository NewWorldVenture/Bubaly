// Every exported admin server action, CALLED, as someone who is not allowed to
// use it: it must refuse, and it must refuse before it touches any data.
//
// tests/admin-actions-reach-a-gate.test.ts proves each action can REACH a gate
// by some call path. That is a reading of the source, and three things pass it
// that are still open endpoints: a gate whose answer is not acted on
// (`await isSuperAdmin();`), a gate reached only after a read or a write, and a
// "gate" that asks about the target instead of the caller (`isSuperAdminEmail`
// was on its list, and is exactly that shape). It also cannot see whether a
// gate asks the second factor. Measured: an action that reads through the
// service client before requireMarketingAdmin, and a guard with its
// superAdminAssurance line deleted, both passed that file and failed this one. A `'use server'` export is a public POST
// endpoint whatever page renders it, so this file asks the endpoints.
//
// The gates run for real: lib/supabase/auth's isSuperAdmin and getUser,
// lib/auth/super-admin-assurance, superAdminGate, requireMarketingAdmin and each
// file's own guard. Only what sits beneath them is replaced: the cookie-bound
// client answers who the caller is and nothing else, and the service-role
// client, any table, any storage call, any other RPC and any network request
// is recorded as a breach.
//
// Three callers are refused everywhere:
//   - a signed-in family member (a household's "Parent / Admin" is still not a
//     platform admin; nothing here may read the family role as one),
//   - a signed-out request,
//   - a real super-admin whose password-only session still owes the code of an
//     authenticator they enrolled (lib/auth/super-admin-assurance.ts).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Caller = 'member' | 'signed_out' | 'admin_owes_code';

const h = vi.hoisted(() => ({
  caller: 'member' as 'member' | 'signed_out' | 'admin_owes_code',
  /** Anything beyond "who is calling": each entry is a breach. */
  breaches: [] as string[],
  /** Identity questions asked, so a refusal can be traced to the gate. */
  asked: [] as string[],
}));

/** A chainable stand-in that records it was used and answers nothing. */
function recorder(label: string): unknown {
  const answer = Promise.resolve({ data: null, error: { message: 'not in this test' } });
  const fn = function () { /* callable */ };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return answer.then.bind(answer);
      if (prop === 'catch') return answer.catch.bind(answer);
      if (prop === 'finally') return answer.finally.bind(answer);
      if (typeof prop === 'symbol') return undefined;
      h.breaches.push(`${label}.${prop}`);
      return recorder(`${label}.${prop}`);
    },
    apply() { return recorder(`${label}()`); },
  });
}

const USERS = {
  member: { id: '11111111-1111-4111-8111-111111111111', email: 'parent@family.example', aud: 'authenticated', app_metadata: { role: 'admin' }, user_metadata: { role: 'admin', full_name: 'A Parent' } },
  admin: { id: '22222222-2222-4222-8222-222222222222', email: 'second.admin@example.com', aud: 'authenticated', app_metadata: {}, user_metadata: {} },
};

function cookieClient() {
  const user = h.caller === 'signed_out' ? null : h.caller === 'member' ? USERS.member : USERS.admin;
  const auth = {
    getUser: async () => { h.asked.push('getUser'); return { data: { user }, error: null }; },
    getSession: async () => { h.asked.push('getSession'); return { data: { session: user ? { access_token: 'token', user } : null }, error: null }; },
    mfa: {
      getAuthenticatorAssuranceLevel: async () => {
        h.asked.push('assurance');
        // A password-only session of an account that has an authenticator.
        return { data: { currentLevel: 'aal1', nextLevel: h.caller === 'admin_owes_code' ? 'aal2' : 'aal1', currentAuthenticationMethods: [] }, error: null };
      },
    },
  };
  return new Proxy({ auth } as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'auth') return new Proxy(target.auth as Record<string | symbol, unknown>, {
        get(a, p) { if (p in a) return a[p]; if (typeof p === 'symbol') return undefined; h.breaches.push(`cookie.auth.${p}`); return recorder(`cookie.auth.${p}`); },
      });
      if (prop === 'rpc') {
        return async (name: string) => {
          if (name === 'is_super_admin') { h.asked.push('is_super_admin'); return { data: h.caller === 'admin_owes_code', error: null }; }
          h.breaches.push(`cookie.rpc(${name})`);
          return { data: null, error: { message: 'not in this test' } };
        };
      }
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      h.breaches.push(`cookie.${String(prop)}`);
      return recorder(`cookie.${String(prop)}`);
    },
  });
}

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {}, has: () => false }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/supabase/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createServer: async () => cookieClient(),
  createServiceClient: () => { h.breaches.push('createServiceClient()'); return recorder('service'); },
}));
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTranslations: async () => (key: string) => key,
}));
vi.mock('next/cache', () => ({
  revalidatePath: () => { h.breaches.push('revalidatePath'); },
  revalidateTag: () => { h.breaches.push('revalidateTag'); },
  unstable_cache: <T,>(fn: T) => fn,
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

const ROOT = join('app', '(app)', 'admin');
const USE_SERVER = /^\s*(['"])use server\1\s*;?\s*$/m;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith('.ts') || entry.endsWith('.tsx') ? [full] : [];
  });
}

/** Every file under the admin tree that can export a server action. */
const FILES = sourceFiles(ROOT).filter((f) => USE_SERVER.test(readFileSync(f, 'utf8'))).sort();

/** Exported functions the source declares, so the import cannot quietly miss one. */
function declaredActions(source: string): string[] {
  const names = [
    ...source.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/gm),
    ...source.matchAll(/^export\s+(?:const|let)\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\b|\(|function\b)/gm),
  ].map((m) => m[1]);
  return [...new Set(names)].sort();
}

/** Arguments with the right shape and no meaning: what a forged POST could send. */
function junkArgs(count: number): unknown[] {
  const fd = new FormData();
  for (const key of ['id', 'email', 'name', 'title', 'key', 'value', 'status', 'admin_role', 'url', 'subject', 'body', 'published'])
    fd.set(key, key === 'email' ? 'someone@example.com' : 'x');
  return Array.from({ length: Math.max(count, 2) }, () => fd);
}

// Three actions check a status argument against a fixed list before the gate
// and return without touching anything when it is not on it. That is harmless,
// but junk arguments would stop there and the gate would never be asked, so
// these are given a status that passes, and the gate is what answers.
const VALID_ARGS: Record<string, unknown[]> = {
  'app/(app)/admin/marketing/crm/actions.ts :: setDealStageAction': ['deal-1', 'won'],
  'app/(app)/admin/marketing/proposals/actions.ts :: setQuoteStatusAction': ['quote-1', 'sent'],
  'app/(app)/admin/marketing/reviews/actions.ts :: moderateReviewAction': ['review-1', 'approved'],
};

function refused(outcome: { threw: boolean; value: unknown }): boolean {
  if (outcome.threw) return true;
  const v = outcome.value as { ok?: unknown; error?: unknown } | null | undefined;
  return !!v && typeof v === 'object' && (v.ok === false || (typeof v.error === 'string' && v.error.length > 0));
}

type Action = { file: string; name: string; fn: (...args: unknown[]) => Promise<unknown> };
const actions: Action[] = [];
let fetchCalls: string[] = [];

beforeAll(async () => {
  vi.stubEnv('SUPER_ADMIN_EMAILS', '');
  vi.stubGlobal('fetch', async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error('no network in this test');
  });
  for (const file of FILES) {
    const mod = await import(/* @vite-ignore */ `@/${file.split('\\').join('/')}`) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'function') actions.push({ file, name, fn: value as Action['fn'] });
    }
  }
}, 120_000);

beforeEach(() => {
  h.breaches = [];
  h.asked = [];
  fetchCalls = [];
});

async function call(action: Action, caller: Caller) {
  h.caller = caller;
  h.breaches = [];
  h.asked = [];
  fetchCalls = [];
  const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
  let outcome: { threw: boolean; value: unknown };
  try {
    const args = VALID_ARGS[`${action.file.split('\\').join('/')} :: ${action.name}`] ?? junkArgs(action.fn.length);
    outcome = { threw: false, value: await action.fn(...args) };
  } catch (error) {
    outcome = { threw: true, value: error };
  } finally {
    silence.mockRestore();
  }
  return { outcome, breaches: [...h.breaches, ...fetchCalls.map((u) => `fetch ${u}`)], asked: [...h.asked] };
}

describe('every exported admin action refuses an unauthorised caller before it touches data', () => {
  it('finds every \'use server\' file and every action each one declares', () => {
    expect(FILES.length).toBeGreaterThan(25);
    const missed = FILES.flatMap((file) => {
      const imported = new Set(actions.filter((a) => a.file === file).map((a) => a.name));
      return declaredActions(readFileSync(file, 'utf8')).filter((n) => !imported.has(n)).map((n) => `${file} :: ${n}`);
    });
    expect(missed, `declared but not exercised:\n${missed.join('\n')}`).toEqual([]);
    expect(actions.length).toBeGreaterThan(130);
  });

  for (const caller of ['member', 'signed_out', 'admin_owes_code'] as const) {
    it(`refuses ${caller.replace(/_/g, ' ')} in every action, with no data touched`, async () => {
      const offenders: string[] = [];
      for (const action of actions) {
        const { outcome, breaches, asked } = await call(action, caller);
        const label = `${action.file} :: ${action.name}`;
        if (!refused(outcome)) offenders.push(`${label} did not refuse (returned ${JSON.stringify(outcome.value)})`);
        if (breaches.length) offenders.push(`${label} touched ${[...new Set(breaches)].join(', ')}`);
        // The refusal has to be the gate's: an action that crashed on its
        // arguments before asking who called would also "refuse" here.
        const gateAsked = caller === 'admin_owes_code'
          ? asked.includes('assurance')
          : asked.includes('getUser') || asked.includes('is_super_admin');
        if (!gateAsked) offenders.push(`${label} refused without asking ${caller === 'admin_owes_code' ? 'for the second factor' : 'who the caller is'}`);
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    }, 120_000);
  }
});

describe('the harness catches what it is for (sanity)', () => {
  it('reports an action that reads before its gate, and one that ignores its gate', async () => {
    const { createServiceClient } = await import('@/lib/supabase/server');
    const { isSuperAdmin } = await import('@/lib/supabase/auth');
    const readsFirst: Action = {
      file: 'synthetic', name: 'readsFirst',
      fn: async () => { await createServiceClient().from('families').select('*'); if (!(await isSuperAdmin())) return { ok: false, error: 'no' }; return { ok: true }; },
    };
    const ignoresGate: Action = {
      file: 'synthetic', name: 'ignoresGate',
      fn: async () => { await isSuperAdmin(); return { ok: true }; },
    };
    const first = await call(readsFirst, 'member');
    expect(first.breaches).toContain('createServiceClient()');
    const second = await call(ignoresGate, 'member');
    expect(refused(second.outcome)).toBe(false);
  });

  it('reports a gate that never asks for the second factor', async () => {
    const { isSuperAdmin } = await import('@/lib/supabase/auth');
    const emailOnly: Action = {
      file: 'synthetic', name: 'emailOnly',
      fn: async () => { if (!(await isSuperAdmin())) return { ok: false, error: 'no' }; const { createServiceClient } = await import('@/lib/supabase/server'); createServiceClient(); return { ok: true }; },
    };
    const owed = await call(emailOnly, 'admin_owes_code');
    expect(owed.asked).not.toContain('assurance');
    expect(owed.breaches).toContain('createServiceClient()');
  });
});

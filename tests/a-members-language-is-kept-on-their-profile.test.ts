// I18N-001 (the storage half, migration 0466): a member's language is kept on
// their own profile, so it follows them to a new device and is there for what
// Bubaly sends them, while the cookie stays the UI's source and a signed-out
// visitor's switch behaves exactly as before.
//
// Synthetic, through the real setLocale / syncLanguageForSignedInUser /
// getLocaleContext: `next/headers` is a cookie jar per device, and the database
// is a fake `profiles` table that behaves as 0466 + profiles_update_self do —
// an UPDATE reaches only the caller's own row, and the CHECK refuses a language
// the product does not ship. The same rules against real Postgres are
// docs/audit/a-members-language-check.sql.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCALES, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/lib/i18n/locales';
import { at } from './helpers/source-order';
import { LOCALE_PENDING_COOKIE } from '@/lib/i18n/pending-choice';
import { resolveLocale } from '@/lib/i18n/resolve';

type Cookie = { value: string; options?: Record<string, unknown> };

const PARENT = 'user-parent';
const SPOUSE = 'user-spouse';
const OUTSIDER = 'user-other-family';

const MIGRATION = readFileSync(
  join(__dirname, '..', 'supabase/migrations/0466_a_members_language_is_kept_on_their_profile.sql'),
  'utf8',
);
/** The CHECK's list, read from the migration itself. */
const CHECKED = [...MIGRATION.match(/locale in \(([^)]*)\)/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const db = vi.hoisted(() => ({
  /** The caller's session, or null when signed out. */
  user: null as null | { id: string },
  /** profiles: id -> locale. A missing key is a missing row. */
  profiles: new Map<string, string | null>(),
  /** The device the request came from. */
  jar: new Map<string, { value: string; options?: Record<string, unknown> }>(),
  headers: {} as Record<string, string>,
  readError: null as null | { message: string; code: string },
  writeError: null as null | { message: string; code: string },
  throwOnConnect: false,
  /** The identity lookup itself failing (an auth outage), whoever the session is. */
  authError: null as null | { name: string; message: string; status?: number },
  /** A request that never answers unless it is aborted: the slow database of the #705 review. */
  hold: null as null | 'read' | 'write' | 'auth',
  /** A held identity lookup (the SDK's getUser takes no abort signal) answers once this opens. */
  gate: Promise.resolve(),
  open: () => {},
  /** Every UPDATE that reached a row: [caller, row id, locale]. */
  writes: [] as [string, string, string | null][],
  checked: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (db.jar.has(name) ? { name, value: db.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => { db.jar.set(name, { value, options }); },
    delete: (name: string) => { db.jar.delete(name); },
  }),
  headers: async () => new Headers(db.headers),
}));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => false, getUserContext: async () => null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { throw new Error('not used here'); },
  createServer: async () => {
    if (db.throwOnConnect) throw new Error('supabase unreachable');
    return {
      auth: {
        // As the SDK answers: a visitor with no session is an
        // AuthSessionMissingError, and an outage a null user with its own error.
        getUser: async () => (db.hold === 'auth' && await db.gate, db.authError ? { data: { user: null }, error: db.authError }
          : db.user ? { data: { user: db.user }, error: null }
          : { data: { user: null }, error: { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 } }),
      },
      from: (table: string) => {
        if (table !== 'profiles') throw new Error(`unexpected table ${table}`);
        const eqs: [string, unknown][] = [];
        const own = () => [...db.profiles.keys()].filter((id) =>
          eqs.every(([k, v]) => k === 'id' && v === id)
          // profiles_update_self USING (id = auth.uid()) and 0466's restrictive
          // twin: a row that is not the caller's is not there for their UPDATE.
          && id === db.user?.id);
        return {
          select: () => ({
            eq: (k: string, v: unknown) => {
              eqs.push([k, v]);
              let signal: AbortSignal | undefined;
              const read = async () => {
                if (db.hold === 'read') await held(signal);
                if (db.readError) return { data: null, error: db.readError };
                const id = [...db.profiles.keys()].find((r) => r === v);
                return { data: id ? { locale: db.profiles.get(id) ?? null } : null, error: null };
              };
              const q = { maybeSingle: read, abortSignal: (sg: AbortSignal) => { signal = sg; return q; } };
              return q;
            },
          }),
          update: (patch: { locale: string | null }) => {
            const run = () => {
              if (db.writeError) return { data: null, error: db.writeError };
              if (patch.locale !== null && !db.checked.includes(patch.locale)) {
                return { data: null, error: { message: 'violates check constraint "profiles_locale_supported"', code: '23514' } };
              }
              const rows = own();
              for (const id of rows) { db.profiles.set(id, patch.locale); db.writes.push([db.user!.id, id, patch.locale]); }
              return { data: rows.map((id) => ({ id })), error: null };
            };
            let signal: AbortSignal | undefined;
            const write = async () => { if (db.hold === 'write') await held(signal); return run(); };
            return {
              eq: (k: string, v: unknown) => {
                eqs.push([k, v]);
                const selected = {
                  then: (ok: (r: unknown) => void, no?: (e: unknown) => void) => write().then(ok, no),
                  abortSignal: (sg: AbortSignal) => { signal = sg; return write(); },
                };
                return { select: () => selected, then: (ok: (r: unknown) => void, no?: (e: unknown) => void) => write().then(ok, no) };
              },
            };
          },
        };
      },
    };
  },
}));

/** Never settles unless aborted; then rejects as the SDK does. */
function held(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

async function setLocale(code: string) {
  return (await import('@/lib/i18n/actions')).setLocale(code);
}
async function signIn() {
  return (await import('@/lib/i18n/sync')).syncLanguageForSignedInUser();
}
async function renderedIn() {
  return (await import('@/lib/i18n/server')).getLocaleContext().then((c) => [c.locale.code, c.source]);
}
/** A new device: nothing in its cookie jar. */
function freshDevice(headers: Record<string, string> = {}) {
  db.jar = new Map();
  db.headers = headers;
}
const cookie = (): Cookie | undefined => db.jar.get(LOCALE_COOKIE);

const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  db.user = null;
  db.profiles = new Map([[PARENT, null], [SPOUSE, null], [OUTSIDER, 'it-IT']]);
  db.readError = null; db.writeError = null; db.throwOnConnect = false; db.hold = null; db.authError = null;
  db.gate = new Promise<void>((r) => { db.open = r; });
  db.writes = [];
  db.checked = CHECKED;
  freshDevice();
  errors.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('the column only ever holds a language the product ships', () => {
  it('the migration\'s CHECK is exactly LOCALES', () => {
    expect([...CHECKED].sort()).toEqual(LOCALES.map((l) => l.code).sort());
  });

  it('0466 is additive and names the own-row policy it relies on', () => {
    expect(MIGRATION).toMatch(/add column if not exists locale text;/);
    expect(MIGRATION).not.toMatch(/\bnot null\b/i);
    expect(MIGRATION).toMatch(/create policy profiles_update_own_row_only on public\.profiles\s+as restrictive\s+for update\s+to authenticated\s+using \(id = auth\.uid\(\)\)\s+with check \(id = auth\.uid\(\)\);/);
  });
});

describe('an unknown language is refused before anything is written', () => {
  it.each(['xx-XX', 'de', '', 'en-US; path=/admin', '../../etc'])('%j', async (code) => {
    db.user = { id: PARENT };
    expect(await setLocale(code)).toEqual({ ok: false, stored: false });
    expect(cookie()).toBeUndefined();
    expect(db.writes).toEqual([]);
    expect(db.profiles.get(PARENT)).toBeNull();
  });
});

describe('a signed-out visitor: the cookie, exactly as before', () => {
  it('sets the same cookie with the same options and touches no profile', async () => {
    expect(await setLocale('fr-FR')).toEqual({ ok: true, stored: false, profile: 'signed-out' });
    expect(cookie()).toEqual({
      value: 'fr-FR',
      options: { path: '/', maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: 'lax', secure: false },
    });
    expect(db.writes).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps the caller\'s spelling in the cookie, as before (its reader matches any case)', async () => {
    await setLocale('DE-de');
    expect(cookie()?.value).toBe('DE-de');
    expect(await renderedIn()).toEqual(['de-DE', 'cookie']);
  });

  it('marks the cookie secure in production, as before', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await setLocale('fr-FR');
    expect(cookie()?.options?.secure).toBe(true);
  });

  it('the picker\'s `ok` is unchanged for every outcome it can see', async () => {
    expect((await setLocale('nl-NL')).ok).toBe(true);
    expect((await setLocale('nope')).ok).toBe(false);
  });
});

describe('a signed-in member: the cookie AND their own profile', () => {
  it('writes both, the profile in the catalogue\'s spelling', async () => {
    db.user = { id: SPOUSE };
    expect(await setLocale('de-de')).toEqual({ ok: true, stored: true });
    expect(cookie()?.value).toBe('de-de');
    expect(db.profiles.get(SPOUSE)).toBe('de-DE');
  });

  it('writes only the caller\'s row: not a co-member\'s, not another family\'s', async () => {
    db.user = { id: SPOUSE };
    await setLocale('de-DE');
    expect(db.writes).toEqual([[SPOUSE, SPOUSE, 'de-DE']]);
    expect(db.profiles.get(PARENT)).toBeNull();
    expect(db.profiles.get(OUTSIDER)).toBe('it-IT');
  });

  it('two members of one family keep two languages', async () => {
    db.user = { id: PARENT };
    await setLocale('en-GB');
    freshDevice();
    db.user = { id: SPOUSE };
    await setLocale('es-MX');
    expect([db.profiles.get(PARENT), db.profiles.get(SPOUSE)]).toEqual(['en-GB', 'es-MX']);
  });
});

describe('a database that does not take the write is reported, never hidden and never thrown', () => {
  beforeEach(() => { db.user = { id: PARENT }; });

  it('an error from the write -> failed; the cookie still took', async () => {
    db.writeError = { message: 'boom', code: '57014' };
    expect(await setLocale('it-IT')).toEqual({ ok: true, stored: false, profile: 'failed' });
    expect(cookie()?.value).toBe('it-IT');
    expect(db.profiles.get(PARENT)).toBeNull();
    expect(errors).toHaveBeenCalled();
  });

  it('a write that reaches no row (RLS, or no profile yet) -> refused', async () => {
    db.profiles.delete(PARENT);
    expect(await setLocale('it-IT')).toEqual({ ok: true, stored: false, profile: 'refused' });
    expect(errors).toHaveBeenCalled();
  });

  it('the database\'s own CHECK refusing it -> failed, not stored', async () => {
    // A code the product ships but the column does not yet list: the drift the
    // first test above stops, seen from the action.
    db.checked = CHECKED.filter((c) => c !== 'pt-PT');
    expect(await setLocale('pt-PT')).toEqual({ ok: true, stored: false, profile: 'failed' });
    expect(db.profiles.get(PARENT)).toBeNull();
  });

  it('an unreachable database -> failed; the switch still works', async () => {
    db.throwOnConnect = true;
    expect(await setLocale('nl-NL')).toEqual({ ok: true, stored: false, profile: 'failed' });
    expect(cookie()?.value).toBe('nl-NL');
    // Nobody was identified, so no pending choice the next account could adopt.
    expect(db.jar.has(LOCALE_PENDING_COOKIE)).toBe(false);
  });
});

describe('the language follows the person to a new device', () => {
  it('chosen on the laptop, restored on a phone with an empty cookie jar', async () => {
    db.user = { id: SPOUSE };
    await setLocale('de-DE'); // the laptop

    freshDevice({ 'accept-language': 'en-US,en;q=0.9' }); // the phone
    expect(await renderedIn()).toEqual(['en-US', 'accept-language']);
    expect(await signIn()).toEqual({ kind: 'restored', locale: 'de-DE' });
    expect(cookie()).toEqual({
      value: 'de-DE',
      options: { path: '/', maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: 'lax', secure: false },
    });
    expect(await renderedIn()).toEqual(['de-DE', 'cookie']);
    expect(db.writes).toEqual([[SPOUSE, SPOUSE, 'de-DE']]); // the restore wrote nothing
  });

  it('a choice made signed out is stored at sign-in', async () => {
    await setLocale('fr-CA');
    db.user = { id: PARENT };
    expect(await signIn()).toEqual({ kind: 'stored', locale: 'fr-CA' });
    expect(db.profiles.get(PARENT)).toBe('fr-CA');
  });

  it('a choice made signed out, newer than the saved one, replaces it at sign-in', async () => {
    db.profiles.set(PARENT, 'de-DE');
    await setLocale('es-ES'); // signed out: recorded as pending, no owner
    expect(cookie()?.value).toBe('es-ES');
    db.user = { id: PARENT };
    expect(await signIn()).toEqual({ kind: 'stored', locale: 'es-ES' });
    expect(db.profiles.get(PARENT)).toBe('es-ES');
    expect(db.jar.has(LOCALE_PENDING_COOKIE)).toBe(false); // settled
  });

  it('neither: the language the visitor was served is stored (geo before Accept-Language)', async () => {
    freshDevice({ 'x-vercel-ip-country': 'NL', 'accept-language': 'fr-FR' });
    db.user = { id: PARENT };
    expect(await signIn()).toEqual({ kind: 'stored', locale: 'nl-NL' });
    expect(db.profiles.get(PARENT)).toBe('nl-NL');
    expect(cookie()).toBeUndefined(); // a detected language is not made a choice
  });

  it('already in step: nothing is written', async () => {
    db.profiles.set(PARENT, 'it-IT');
    db.jar.set(LOCALE_COOKIE, { value: 'IT-it' });
    db.user = { id: PARENT };
    expect(await signIn()).toEqual({ kind: 'in-step', locale: 'it-IT' });
    expect(db.writes).toEqual([]);
  });

  it('never reads or writes another person\'s row', async () => {
    db.profiles.set(OUTSIDER, 'pt-PT');
    db.user = { id: PARENT };
    expect(await signIn()).toEqual({ kind: 'stored', locale: 'en-US' });
    expect(db.profiles.get(OUTSIDER)).toBe('pt-PT');
    expect(db.writes).toEqual([[PARENT, PARENT, 'en-US']]);
  });
});

describe('sign-in is never failed by a language', () => {
  it('signed out -> none, no reads or writes', async () => {
    expect(await signIn()).toEqual({ kind: 'none' });
    expect(db.writes).toEqual([]);
  });

  it('a failed read -> none; the device keeps its cookie', async () => {
    db.user = { id: PARENT };
    db.readError = { message: 'boom', code: '57014' };
    db.jar.set(LOCALE_COOKIE, { value: 'fr-FR' });
    expect(await signIn()).toEqual({ kind: 'none' });
    expect(cookie()?.value).toBe('fr-FR');
    expect(errors).toHaveBeenCalled();
  });

  it('a failed write -> none, logged', async () => {
    db.user = { id: PARENT };
    db.writeError = { message: 'boom', code: '57014' };
    db.jar.set(LOCALE_COOKIE, { value: 'fr-FR' });
    expect(await signIn()).toEqual({ kind: 'none' });
    expect(db.profiles.get(PARENT)).toBeNull();
    expect(errors).toHaveBeenCalled();
  });

  it('an unreachable database -> none', async () => {
    db.user = { id: PARENT };
    db.throwOnConnect = true;
    expect(await signIn()).toEqual({ kind: 'none' });
  });

  it('a write that reaches no row (no profile yet, or RLS) -> none, not claimed as stored', async () => {
    db.user = { id: PARENT };
    db.profiles.delete(PARENT);
    db.jar.set(LOCALE_COOKIE, { value: 'fr-FR' });
    expect(await signIn()).toEqual({ kind: 'none' });
    expect(db.writes).toEqual([]);
    expect(errors).toHaveBeenCalled();
  });

  it('the sign-in landing step and onboarding both call it before anything can fail on it', () => {
    const auth = readFileSync(join(__dirname, '..', 'app/(auth)/actions.ts'), 'utf8');
    const landing = auth.slice(at(auth, 'export async function resolveLandingPathAction'));
    expect(landing.slice(0, at(landing, '\n}\n'))).toMatch(/^\s*await syncLanguageForSignedInUser\(\);/m);
    const onboarding = readFileSync(join(__dirname, '..', 'app/onboarding/actions.ts'), 'utf8');
    const finalize = onboarding.slice(at(onboarding, 'export async function finalizeOnboardingAction'));
    const sync = at(finalize, 'await syncLanguageForSignedInUser(undefined, { profileOnly: true });');
    expect(sync).toBeGreaterThan(at(finalize, "onboardingFailure('profile save'"));
    expect(sync).toBeLessThan(at(finalize, '// 2. Resolve the family'));
  });
});

describe('a plain cookie never overwrites a saved preference (#705 review 5919814531)', () => {
  it('a phone\'s stale restored cookie does not undo a newer choice made on the laptop', async () => {
    db.user = { id: SPOUSE };
    await setLocale('de-DE'); // the laptop
    const laptop = db.jar;
    freshDevice();
    await signIn(); // the phone restores de-DE
    const phone = db.jar;
    expect(phone.get(LOCALE_COOKIE)?.value).toBe('de-DE');
    db.jar = laptop;
    expect(await setLocale('fr-FR')).toEqual({ ok: true, stored: true }); // a newer explicit choice
    db.jar = phone;
    expect(await signIn()).toEqual({ kind: 'restored', locale: 'fr-FR' }); // the phone signs in again
    expect(db.profiles.get(SPOUSE)).toBe('fr-FR');
    expect(phone.get(LOCALE_COOKIE)?.value).toBe('fr-FR');
  });

  it('on a shared browser, one account\'s language does not become the next account\'s', async () => {
    db.profiles.set(PARENT, 'it-IT');
    db.user = { id: SPOUSE };
    expect(await setLocale('de-DE')).toEqual({ ok: true, stored: true }); // SPOUSE, signed in
    db.user = { id: PARENT }; // then PARENT signs in on the same browser
    expect(await signIn()).toEqual({ kind: 'restored', locale: 'it-IT' });
    expect(db.profiles.get(PARENT)).toBe('it-IT');
    expect(cookie()?.value).toBe('it-IT');
  });

  it('a failed save is retried at that account\'s next sign-in, and only theirs', async () => {
    db.profiles.set(PARENT, 'it-IT');
    db.profiles.set(SPOUSE, 'nl-NL');
    db.user = { id: SPOUSE };
    db.writeError = { message: 'boom', code: '57014' };
    expect(await setLocale('fr-FR')).toEqual({ ok: true, stored: false, profile: 'failed' });
    expect(db.jar.get(LOCALE_PENDING_COOKIE)?.value).toBe(`fr-FR@${SPOUSE}`);
    expect(db.jar.get(LOCALE_PENDING_COOKIE)?.options?.httpOnly).toBe(true);
    db.writeError = null;
    // Someone else signing in on this browser ignores SPOUSE's pending choice.
    db.user = { id: PARENT };
    expect(await signIn()).toEqual({ kind: 'restored', locale: 'it-IT' });
    expect(db.profiles.get(PARENT)).toBe('it-IT');
    expect(db.jar.has(LOCALE_PENDING_COOKIE)).toBe(true);
    // SPOUSE's own next sign-in stores it.
    db.user = { id: SPOUSE };
    expect(await signIn()).toEqual({ kind: 'stored', locale: 'fr-FR' });
    expect(db.profiles.get(SPOUSE)).toBe('fr-FR');
    expect(db.jar.has(LOCALE_PENDING_COOKIE)).toBe(false);
  });

  it.each([
    ['stored', 'it-IT'],
    ['in-step', 'fr-FR'], // SPOUSE saved fr-FR on another device meanwhile
  ] as const)('a returning owner\'s pending choice is shown again, not just saved (%s; #705 comment 5921554978)', async (kind, savedMeanwhile) => {
    db.profiles.set(PARENT, 'it-IT');
    db.profiles.set(SPOUSE, 'nl-NL');
    db.user = { id: SPOUSE };
    db.writeError = { message: 'boom', code: '57014' };
    await setLocale('fr-FR'); // fr-FR@SPOUSE pending
    db.writeError = null;
    db.user = { id: PARENT }; // PARENT signs in on the shared browser, restores it-IT
    expect(await signIn()).toEqual({ kind: 'restored', locale: 'it-IT' });
    expect(await renderedIn()).toEqual(['it-IT', 'cookie']);
    db.profiles.set(SPOUSE, kind === 'stored' ? 'nl-NL' : savedMeanwhile);
    db.user = { id: SPOUSE }; // SPOUSE comes back
    expect(await signIn()).toEqual({ kind, locale: 'fr-FR' });
    expect(db.profiles.get(SPOUSE)).toBe('fr-FR');
    expect(db.profiles.get(PARENT)).toBe('it-IT');
    expect(db.jar.has(LOCALE_PENDING_COOKIE)).toBe(false);
    expect(await renderedIn()).toEqual(['fr-FR', 'cookie']);
  });

  it('a pending choice that could not be saved yet is still what the owner sees', async () => {
    db.profiles.set(PARENT, 'it-IT');
    db.profiles.set(SPOUSE, 'nl-NL');
    db.jar.set(LOCALE_COOKIE, { value: 'it-IT' });
    db.jar.set(LOCALE_PENDING_COOKIE, { value: `fr-FR@${SPOUSE}` });
    db.user = { id: SPOUSE };
    db.writeError = { message: 'boom', code: '57014' };
    expect(await signIn()).toEqual({ kind: 'none' });
    expect(db.jar.get(LOCALE_PENDING_COOKIE)?.value).toBe(`fr-FR@${SPOUSE}`); // kept for a retry
    expect(await renderedIn()).toEqual(['fr-FR', 'cookie']);
  });

  it('a cookie from before the profile kept a language is adopted when nothing is saved', async () => {
    db.jar.set(LOCALE_COOKIE, { value: 'pt-PT' });
    db.user = { id: PARENT };
    expect(await signIn()).toEqual({ kind: 'stored', locale: 'pt-PT' });
  });
});

describe('an identity outage is not a signed-out choice (#705 comment 5921554978)', () => {
  const outage = { name: 'AuthRetryableFetchError', message: 'Service Unavailable', status: 503 };

  it('the switch still works, but no pending choice anyone could claim is left', async () => {
    db.user = { id: SPOUSE }; // SPOUSE's session is there; the lookup fails
    db.authError = outage;
    expect(await setLocale('de-DE')).toEqual({ ok: true, stored: false, profile: 'unverified' });
    expect(cookie()?.value).toBe('de-DE');
    expect(db.jar.has(LOCALE_PENDING_COOKIE)).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it('the next account on the browser keeps its saved language', async () => {
    db.profiles.set(PARENT, 'it-IT');
    db.user = { id: SPOUSE };
    db.authError = outage;
    await setLocale('de-DE');
    db.authError = null;
    db.user = { id: PARENT }; // logout, then PARENT logs in
    expect(await signIn()).toEqual({ kind: 'restored', locale: 'it-IT' });
    expect(db.profiles.get(PARENT)).toBe('it-IT');
    expect(db.writes).toEqual([]);
  });

  it('an older pending choice is not left to outrank the newer one', async () => {
    db.jar.set(LOCALE_PENDING_COOKIE, { value: 'fr-FR' });
    db.user = { id: SPOUSE };
    db.authError = outage;
    await setLocale('de-DE');
    expect(db.jar.has(LOCALE_PENDING_COOKIE)).toBe(false);
  });

  it('control: genuinely signed out still leaves a choice the next sign-in adopts', async () => {
    db.profiles.set(PARENT, 'it-IT');
    expect(await setLocale('de-DE')).toEqual({ ok: true, stored: false, profile: 'signed-out' });
    expect(db.jar.get(LOCALE_PENDING_COOKIE)?.value).toBe('de-DE');
    db.user = { id: PARENT };
    expect(await signIn()).toEqual({ kind: 'stored', locale: 'de-DE' });
    expect(db.profiles.get(PARENT)).toBe('de-DE');
  });
});

describe('sign-in never waits on a slow language (#705 review 5919831949)', () => {
  it.each(['read', 'write'] as const)('a %s that never answers is abandoned within the budget, writing nothing', async (hold) => {
    db.user = { id: PARENT };
    db.jar.set(LOCALE_PENDING_COOKIE, { value: 'fr-FR' });
    db.hold = hold;
    const { syncLanguageForSignedInUser } = await import('@/lib/i18n/sync');
    const started = Date.now();
    expect(await syncLanguageForSignedInUser(50)).toEqual({ kind: 'none' });
    expect(Date.now() - started).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 20)); // anything left running settles
    expect(db.profiles.get(PARENT)).toBeNull();
    expect(db.jar.get(LOCALE_PENDING_COOKIE)?.value).toBe('fr-FR'); // kept for the next try
    expect(db.writes).toEqual([]);
  });

  it.each(['read', 'write'] as const)('the real landing step still lands when the language %s hangs', async (hold) => {
    db.user = { id: PARENT };
    db.jar.set(LOCALE_PENDING_COOKIE, { value: 'fr-FR' });
    db.hold = hold;
    const { resolveLandingPathAction } = await import('@/app/(auth)/actions');
    const { LANGUAGE_SYNC_BUDGET_MS } = await import('@/lib/i18n/sync');
    const started = Date.now();
    expect(await resolveLandingPathAction()).toBe('/home');
    expect(Date.now() - started).toBeLessThan(LANGUAGE_SYNC_BUDGET_MS + 1000);
  });

  it('control: an answering database is not cut short', async () => {
    db.user = { id: PARENT };
    db.jar.set(LOCALE_PENDING_COOKIE, { value: 'fr-FR' });
    const { resolveLandingPathAction } = await import('@/app/(auth)/actions');
    expect(await resolveLandingPathAction()).toBe('/home');
    expect(db.profiles.get(PARENT)).toBe('fr-FR');
  });

  it('onboarding uses the same bounded sync', () => {
    const onboarding = readFileSync(join(__dirname, '..', 'app/onboarding/actions.ts'), 'utf8');
    expect(onboarding).toContain('await syncLanguageForSignedInUser(undefined, { profileOnly: true });');
  });
});

describe('the picker\'s save never waits on a slow profile either (#705 comment 5921693652)', () => {
  const within = async <T>(work: Promise<T>) => {
    const { LANGUAGE_SYNC_BUDGET_MS } = await import('@/lib/i18n/sync');
    const started = Date.now();
    const result = await work;
    expect(Date.now() - started).toBeLessThan(LANGUAGE_SYNC_BUDGET_MS + 1000);
    return result;
  };

  it('a profile write that never answers: the switch finishes, not stored, and the owner\'s retry is kept', async () => {
    db.profiles.set(PARENT, 'it-IT');
    db.user = { id: PARENT };
    db.hold = 'write';
    expect(await within(setLocale('fr-FR'))).toEqual({ ok: true, stored: false, profile: 'timed-out' });
    expect(cookie()?.value).toBe('fr-FR');
    expect(db.jar.get(LOCALE_PENDING_COOKIE)?.value).toBe(`fr-FR@${PARENT}`);
    expect(db.writes).toEqual([]); // the held request was aborted
    db.hold = null;
    expect(await signIn()).toEqual({ kind: 'stored', locale: 'fr-FR' });
    expect(db.profiles.get(PARENT)).toBe('fr-FR');
  });

  it('an identity lookup that never answers: the switch finishes, and nobody is handed a pending choice', async () => {
    db.user = { id: PARENT };
    db.hold = 'auth';
    expect(await within(setLocale('fr-FR'))).toEqual({ ok: true, stored: false, profile: 'unverified' });
    expect(cookie()?.value).toBe('fr-FR');
    expect(db.jar.has(LOCALE_PENDING_COOKIE)).toBe(false);
  });

  it('abandoned work never writes, so it cannot overwrite a newer choice', async () => {
    db.profiles.set(PARENT, 'it-IT');
    db.user = { id: PARENT };
    db.hold = 'auth';
    await within(setLocale('fr-FR')); // abandoned while looking up who is asking
    db.hold = null;
    expect(await setLocale('de-DE')).toEqual({ ok: true, stored: true }); // the newer choice
    db.open(); // the old lookup answers late
    await new Promise((r) => setTimeout(r, 20));
    expect(db.profiles.get(PARENT)).toBe('de-DE');
    expect(db.writes).toEqual([[PARENT, PARENT, 'de-DE']]);
  });

  it('control: an answering database is not cut short', async () => {
    db.user = { id: PARENT };
    expect(await setLocale('fr-FR')).toEqual({ ok: true, stored: true });
    expect(db.profiles.get(PARENT)).toBe('fr-FR');
  });

  it('the client cannot choose the budget: the action takes only the code', async () => {
    const { setLocale: action } = await import('@/lib/i18n/actions');
    expect(action.length).toBe(1);
  });
});

describe('a sign-in that picks its own destination still syncs the language (#705 comment 5922299372)', () => {
  const action = async () => (await import('@/app/(auth)/actions')).syncLanguageAfterSignInAction();

  it('restores the saved language on a new device', async () => {
    db.profiles.set(PARENT, 'de-DE');
    db.user = { id: PARENT };
    await action();
    expect(cookie()?.value).toBe('de-DE');
    expect(await renderedIn()).toEqual(['de-DE', 'cookie']);
  });

  it('does nothing for a caller with no session: no read, no write', async () => {
    db.readError = { message: 'must not be read', code: 'XX000' };
    await action();
    expect(db.writes).toEqual([]);
    expect(db.jar.size).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('a slow profile is abandoned within the budget', async () => {
    db.user = { id: PARENT };
    db.hold = 'read';
    const { LANGUAGE_SYNC_BUDGET_MS } = await import('@/lib/i18n/sync');
    const started = Date.now();
    await action();
    expect(Date.now() - started).toBeLessThan(LANGUAGE_SYNC_BUDGET_MS + 1000);
  });

  it.each([
    ['components/auth/login-form.tsx', 'await waitForOptionalStep(syncLanguageAfterSignInAction).then(() => redirectDest)', 'router.push(destination)'],
    ['components/auth/kid-login-form.tsx', 'await waitForOptionalStep(syncLanguageAfterSignInAction);', "router.push('/home')"],
    ['components/auth/phone-auth.tsx', 'await waitForOptionalStep(syncLanguageAfterSignInAction);', 'router.push(destination)'],
  ])('%s syncs before it navigates', (file, call, push) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(at(src, call)).toBeLessThan(at(src, push));
  });
});

describe('a sign-in form never waits on the language step for long (#705 comment 5923116178)', () => {
  it('the client deadline is longer than the server budget, so an answering server is not cut short', async () => {
    const { SIGN_IN_LANGUAGE_WAIT_MS } = await import('@/lib/i18n/sign-in-language');
    const { LANGUAGE_SYNC_BUDGET_MS } = await import('@/lib/i18n/sync');
    expect(SIGN_IN_LANGUAGE_WAIT_MS).toBeGreaterThan(LANGUAGE_SYNC_BUDGET_MS);
  });

  it('a step that never answers is waited for at most the deadline', async () => {
    const { waitForOptionalStep } = await import('@/lib/i18n/sign-in-language');
    const started = Date.now();
    await waitForOptionalStep(() => new Promise(() => {}), 40);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each([
    ['resolves', () => Promise.resolve('x')],
    ['rejects', () => Promise.reject(new Error('network'))],
    ['throws', () => { throw new Error('sync throw'); }],
  ] as const)('a step that %s settles at once, and never rejects', async (_, step) => {
    const { waitForOptionalStep } = await import('@/lib/i18n/sign-in-language');
    const started = Date.now();
    await expect(waitForOptionalStep(step as () => Promise<unknown>, 5_000)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('onboarding stores the language but writes no cookie (#705 CI: a cookie re-renders /onboarding past "all set")', () => {
  const finalizeSync = async () => (await import('@/lib/i18n/sync')).syncLanguageForSignedInUser(undefined, { profileOnly: true });

  it('a saved language this device lacks is not restored by onboarding: no cookie written', async () => {
    db.profiles.set(PARENT, 'de-DE');
    db.user = { id: PARENT };
    expect(await finalizeSync()).toEqual({ kind: 'restored', locale: 'de-DE' });
    expect(db.jar.size).toBe(0);
    expect(db.writes).toEqual([]);
  });

  it('a choice made signed out is stored on the profile, and its marker is left for the next sign-in', async () => {
    await setLocale('fr-FR'); // signed out: visible cookie + unowned pending marker
    const before = new Map(db.jar);
    db.user = { id: PARENT };
    expect(await finalizeSync()).toEqual({ kind: 'stored', locale: 'fr-FR' });
    expect(db.profiles.get(PARENT)).toBe('fr-FR');
    expect(db.jar).toEqual(before); // nothing set, nothing deleted
    // The next ordinary sign-in settles the device.
    expect(await signIn()).toEqual({ kind: 'in-step', locale: 'fr-FR' });
    expect(db.jar.has(LOCALE_PENDING_COOKIE)).toBe(false);
  });

  it('the language the wizard was read in is stored for a new member, cookie-free', async () => {
    freshDevice({ 'x-vercel-ip-country': 'DE' });
    db.user = { id: PARENT };
    const out = await finalizeSync();
    expect(out.kind).toBe('stored');
    expect(db.profiles.get(PARENT)).toBe((out as { locale: string }).locale);
    expect(db.jar.size).toBe(0);
  });

  it('sign-in, by contrast, still restores the device', async () => {
    db.profiles.set(PARENT, 'de-DE');
    db.user = { id: PARENT };
    expect(await signIn()).toEqual({ kind: 'restored', locale: 'de-DE' });
    expect(cookie()?.value).toBe('de-DE');
  });
});

describe('the decision, pinned', () => {
  it.each([
    [{ cookie: 'de-DE', stored: null }, { kind: 'stored', locale: 'de-DE' }],
    [{ cookie: 'de-DE', stored: 'fr-FR' }, { kind: 'restored', locale: 'fr-FR' }],
    [{ cookie: 'de-de', stored: 'de-DE' }, { kind: 'in-step', locale: 'de-DE' }],
    [{ cookie: null, stored: 'fr-FR' }, { kind: 'restored', locale: 'fr-FR' }],
    [{ cookie: 'xx-XX', stored: 'fr-FR' }, { kind: 'restored', locale: 'fr-FR' }],
    [{ cookie: undefined, stored: null }, { kind: 'stored', locale: 'es-US' }],
    [{ cookie: null, stored: 'xx-XX' }, { kind: 'stored', locale: 'es-US' }],
    [{ cookie: 'de-DE', stored: 'fr-FR', pending: { locale: 'de-DE', owner: null } }, { kind: 'stored', locale: 'de-DE' }],
    [{ cookie: 'de-DE', stored: 'fr-FR', pending: { locale: 'de-DE', owner: 'u1' } }, { kind: 'stored', locale: 'de-DE' }],
    [{ cookie: 'de-DE', stored: 'fr-FR', pending: { locale: 'de-DE', owner: 'someone-else' } }, { kind: 'restored', locale: 'fr-FR' }],
  ] as const)('%j -> %j', async (input, expected) => {
    const { decideLanguageSync } = await import('@/lib/i18n/sync');
    expect(decideLanguageSync({ ...input, resolved: 'es-US', userId: 'u1' } as never)).toEqual(expected);
  });
});

describe('the UI still resolves the language the way it did', () => {
  it('cookie, then geo, then Accept-Language, then en-US — the profile is not a signal', () => {
    const all = { cookie: 'fr-FR', country: 'DE', acceptLanguage: 'es-MX,es;q=0.9' };
    expect(resolveLocale(all)).toMatchObject({ locale: { code: 'fr-FR' }, source: 'cookie' });
    expect(resolveLocale({ ...all, cookie: undefined })).toMatchObject({ locale: { code: 'de-DE' }, source: 'geo' });
    expect(resolveLocale({ ...all, cookie: undefined, country: undefined })).toMatchObject({ locale: { code: 'es-MX' }, source: 'accept-language' });
    expect(resolveLocale({})).toMatchObject({ locale: { code: 'en-US' }, source: 'default' });
    // Passing a stored language changes nothing: it reaches the UI only as the
    // cookie sign-in restores.
    expect(resolveLocale({ stored: 'it-IT' } as never)).toMatchObject({ locale: { code: 'en-US' }, source: 'default' });
  });
});

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
  /** Every UPDATE that reached a row: [caller, row id, locale]. */
  writes: [] as [string, string, string | null][],
  checked: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (db.jar.has(name) ? { name, value: db.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => { db.jar.set(name, { value, options }); },
  }),
  headers: async () => new Headers(db.headers),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => {
    if (db.throwOnConnect) throw new Error('supabase unreachable');
    return {
      auth: { getUser: async () => ({ data: { user: db.user }, error: null }) },
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
              return {
                maybeSingle: async () => {
                  if (db.readError) return { data: null, error: db.readError };
                  const id = [...db.profiles.keys()].find((r) => r === v);
                  return { data: id ? { locale: db.profiles.get(id) ?? null } : null, error: null };
                },
              };
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
            return {
              eq: (k: string, v: unknown) => {
                eqs.push([k, v]);
                const result = { select: async () => run(), then: (ok: (r: unknown) => void, no?: (e: unknown) => void) => Promise.resolve().then(run).then(ok, no) };
                return result;
              },
            };
          },
        };
      },
    };
  },
}));

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
  db.readError = null; db.writeError = null; db.throwOnConnect = false;
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

  it('a device choice newer than the stored one wins, and is stored', async () => {
    db.profiles.set(PARENT, 'de-DE');
    db.jar.set(LOCALE_COOKIE, { value: 'es-ES' });
    db.user = { id: PARENT };
    expect(await signIn()).toEqual({ kind: 'stored', locale: 'es-ES' });
    expect(db.profiles.get(PARENT)).toBe('es-ES');
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
    const sync = at(finalize, 'await syncLanguageForSignedInUser();');
    expect(sync).toBeGreaterThan(at(finalize, "onboardingFailure('profile save'"));
    expect(sync).toBeLessThan(at(finalize, '// 2. Resolve the family'));
  });
});

describe('the decision, pinned', () => {
  it.each([
    [{ cookie: 'de-DE', stored: null }, { kind: 'stored', locale: 'de-DE' }],
    [{ cookie: 'de-DE', stored: 'fr-FR' }, { kind: 'stored', locale: 'de-DE' }],
    [{ cookie: 'de-de', stored: 'de-DE' }, { kind: 'in-step', locale: 'de-DE' }],
    [{ cookie: null, stored: 'fr-FR' }, { kind: 'restored', locale: 'fr-FR' }],
    [{ cookie: 'xx-XX', stored: 'fr-FR' }, { kind: 'restored', locale: 'fr-FR' }],
    [{ cookie: undefined, stored: null }, { kind: 'stored', locale: 'es-US' }],
    [{ cookie: null, stored: 'xx-XX' }, { kind: 'stored', locale: 'es-US' }],
  ] as const)('%j -> %j', async (input, expected) => {
    const { decideLanguageSync } = await import('@/lib/i18n/sync');
    expect(decideLanguageSync({ ...input, resolved: 'es-US' })).toEqual(expected);
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

// A failed read used to reach the social-links admin page as `{}` — the exact
// value that means "the operator has configured nothing". The page drew six
// empty inputs under a preview captioned "Dimmed icons are using the default URL
// — save your own to replace them", so the screen said, in words, that nothing
// was set. One Save then replaced the WHOLE app_settings.value jsonb with `{}`
// (a whole-object upsert on onConflict:'key', no merge) and the form toasted
// "Social links updated". app_settings has no history column and no audit row
// (supabase/migrations/0023_admin_console.sql), so the six profile URLs were
// gone except from a database backup, and the homepage's Organization JSON-LD
// `sameAs` — which deliberately publishes configured links only — went empty on
// the spot via revalidateTag + revalidatePath('/', 'layout').
//
// Reproduced here the two ways a read can fail to answer:
//   - a RESOLVED { data: null, error } — the production shape. A statement
//     timeout, a missing relation, and ALSO a transport failure or the 1.5 s
//     abort: with shouldThrowOnError unset, @supabase/postgrest-js catches
//     fetch/abort errors and resolves them into this same object. It is
//     invisible to code that only looks at `data`.
//   - a REJECTED promise — not what PostgREST does for a transport failure, but
//     what a throw from the client layer looks like (a client built without a
//     URL, say). Covered so neither path can reach the write.
//
// The guard is in two places, because the page is force-dynamic and a client can
// post whatever it likes:
//   1. the page refuses to render an editable form over a read that did not
//      answer, so there are no blanks to save
//   2. the write is a compare-and-set: the server re-reads the row itself and
//      refuses a submission built on anything else, and a re-read that fails
//      writes nothing at all
//
// Six blank fields are still a legitimate submission — clearing every field is
// the documented way to remove every icon — so the last cases pin that the fix
// did not buy safety by breaking it, and that what a save replaced is kept in
// audit_logs, the only history app_settings has.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { translate } from '@/lib/i18n/translate';

// The page, the form and the action translate through the REAL en-US catalogue,
// with production's behaviour for a missing key: the key itself is what renders.
const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>) => translate(EN_US, key, params);

// And the assertions are the English an operator reads, typed out here — never
// looked up — so a missing catalogue entry fails them instead of matching the
// key it fell back to. The last five are new with this fix and reach en-US.json
// through the catalogue merge that lands in the same commit; UNTIL THAT MERGE
// LANDS, every case that reads them is red, which is the point: without it the
// failure screen says `socialLinks.couldNotLoadSavedLinks` and nothing else.
const SAVE_BUTTON = 'Save social links';
const DEFAULTS_DIMMED = 'Dimmed icons are using the default URL — save your own to replace them.';
const MUST_BE_HTTPS = 'Must be a full https:// URL to be published.';
const READ_FAILED =
  'We could not load the saved social links, so there is nothing to edit here yet. Reload the page — an ' +
  'empty form would look like “no links configured” and saving it would replace every stored link.';
const CONFLICT =
  'The saved social links changed since this page loaded, so nothing was saved. Reload to see what is ' +
  'stored now, then save again.';
const NO_REVISION =
  'This form did not say which saved links it was showing, so nothing was saved. Reload the page and try again.';
const RELOAD = 'Reload this page';

/** What the operator actually has stored. None of it is recoverable if wiped. */
const STORED = {
  facebook: 'https://www.facebook.com/bubaly.family',
  youtube: 'https://www.youtube.com/@bubalyhq',
  x: 'https://x.com/bubalyhq',
  instagram: 'https://www.instagram.com/bubaly.family',
  linkedin: 'https://www.linkedin.com/company/bubaly-inc',
  tiktok: 'https://www.tiktok.com/@bubalyhq',
};

// The fingerprints below are LITERALS on purpose. A save is refused because
// the fingerprint it posted is not the row's, and "not the row's" has to be a
// value the test states for itself — computing it from the module under test
// would make these cases collapse into "the helper is missing" the moment the
// fix is reverted, instead of "the six URLs were replaced with {}". The last
// test in the file pins every literal against the real function, so they
// cannot drift away from what the page actually renders.
//
/** What a form that read nothing posts — the old blank render, exactly. */
const BLANK_FORM = '5e66fdea46b633d2ec30ea3777be62b6';
/** What a form that actually loaded STORED posts. */
const STORED_FORM = 'ce1fea9be01f7f402fc73eb49b96b031';
/** What the row holds after a save that kept Facebook only. */
const FACEBOOK_ONLY_FORM = 'e60bee67462cccaa0693352f1df01e69';
/** STORED without X — what a form that hid an unpublishable X would post. */
const NO_X_FORM = '2f11e2c7998b95a2e4b26ff43bf8ba1d';
/** STORED with X saved as http:// — what a form that SHOWS that X posts. */
const HTTP_X_FORM = 'dc3673ec30438907f567543b337330d3';

type Resolved = { data: unknown; error: unknown };
let read: Resolved;
/** Non-null makes the read REJECT instead of resolving. */
let readRejectsWith: unknown;
let upserts: { table: string; row: Record<string, unknown>; options: unknown }[];
let inserts: { table: string; row: Record<string, unknown> }[];
/** The abort signal each read was given — the read budget, observed. */
let signals: unknown[];

/** Chainable PostgREST stub covering both shapes this module issues. */
function from(table: string) {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: () => query,
    eq: () => query,
    abortSignal: (signal: unknown) => {
      signals.push(signal);
      return query;
    },
    maybeSingle: async () => {
      if (readRejectsWith) throw readRejectsWith;
      return read;
    },
    upsert: async (row: Record<string, unknown>, options: unknown) => {
      upserts.push({ table, row, options });
      return { data: null, error: null };
    },
    insert: async (row: Record<string, unknown>) => {
      inserts.push({ table, row });
      return { data: null, error: null };
    },
  });
  return query;
}

// The admin gates also ask lib/auth/super-admin-assurance whether the session
// proved its authenticator; this file is not about step-up, so it says yes.
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('next/cache', () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: () => {},
  revalidatePath: () => {},
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from }) }));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'super-admin-1' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => t }));
// The form is a client component; give it the two hooks it needs so the REAL
// inputs render and "are there six blank boxes on screen" is a real question.
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useFamilyTimeZone: () => undefined, useTranslations: () => t }));

const { socialLinksRevision } = await import('@/lib/server/social-links');
const { saveSocialLinksAction } = await import('@/app/(app)/admin/settings/social-links/actions');
const { default: SocialLinksPage } = await import('@/app/(app)/admin/settings/social-links/page');

const render = async () => renderToStaticMarkup(await SocialLinksPage());

/** The submission a form makes: one value per platform, plus what it loaded. */
function submission(fields: Partial<Record<string, string>>, revision: string | null) {
  const fd = new FormData();
  for (const key of ['facebook', 'youtube', 'x', 'instagram', 'linkedin', 'tiktok']) {
    fd.set(key, fields[key] ?? '');
  }
  if (revision !== null) fd.set('revision', revision);
  return fd;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  read = { data: { value: { ...STORED } }, error: null };
  readRejectsWith = undefined;
  upserts = [];
  inserts = [];
  signals = [];
});

describe('the social-links admin page when the read does not answer', () => {
  it('shows no editable form at all when the read returns an error', async () => {
    read = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };

    const html = await render();

    // The defect was six blank boxes and a Save button. Neither may be here.
    expect(html, 'a failed read must not render an empty facebook field').not.toContain('name="facebook"');
    expect(html, 'nothing to save means no save button').not.toContain(SAVE_BUTTON);
    // And it must not repeat the lie that made the wipe look reasonable.
    expect(html).not.toContain(DEFAULTS_DIMMED);
    expect(html, 'the operator is told the read failed').toContain(READ_FAILED);
    // …and given the way out, not just a paragraph: a full load re-runs the read.
    expect(html).toContain(`href="/admin/settings/social-links"`);
    expect(html).toContain(RELOAD);
  });

  it('shows no editable form when the read REJECTS — a throw from the client layer', async () => {
    readRejectsWith = new Error('supabaseUrl is required.');

    const html = await render();

    expect(html).not.toContain('name="facebook"');
    expect(html).not.toContain(SAVE_BUTTON);
    expect(html).toContain(READ_FAILED);
  });

  it('renders the saved URLs, and what it loaded, when the read succeeds', async () => {
    const html = await render();

    expect(html).not.toContain(READ_FAILED);
    expect(html).toContain(SAVE_BUTTON);
    expect(html).toContain(`value="${STORED.facebook}"`);
    expect(html).toContain(`value="${STORED.tiktok}"`);
    // The fingerprint travels with the form, which is what lets the server
    // refuse a submission built on a different value.
    expect(html).toContain(`name="revision" value="${STORED_FORM}"`);
  });

  it('treats a genuinely unconfigured install as empty, not as a failure', async () => {
    read = { data: null, error: null };

    const html = await render();

    expect(html, 'no row is not an outage').not.toContain(READ_FAILED);
    expect(html).toContain('name="facebook"');
    expect(html).toContain(SAVE_BUTTON);
  });

  it('shows a stored URL the footer will not publish, so a Save cannot remove it unseen', async () => {
    // Typed into the Supabase dashboard. The footer and the Organization schema
    // drop it; the row still holds it, and Save replaces the whole row.
    read = { data: { value: { ...STORED, x: 'http://x.com/bubalyhq' } }, error: null };

    const html = await render();

    expect(html, 'the field shows what is stored, not a blank').toContain('value="http://x.com/bubalyhq"');
    expect(html, 'and says why it is not published').toContain(MUST_BE_HTTPS);
    expect(html).toContain(`name="revision" value="${HTTP_X_FORM}"`);
  });
});

describe('saving over social links the server could not confirm', () => {
  it('writes NOTHING when the re-read runs out its 1.5 s budget — as PostgREST actually reports it', async () => {
    // The production shape of the abort. @supabase/postgrest-js does not reject
    // on a fetch or abort failure with shouldThrowOnError off: the catch after
    // executeWithRetry (dist/index.cjs) turns it into a RESOLVED
    // { data: null, error: { message: '<name>: <message>', details, hint, code: '' } },
    // status 0 — the same shape as a statement timeout, and invisible to code
    // that only looks at `data`.
    read = {
      data: null,
      error: { message: 'TimeoutError: The operation was aborted due to timeout', details: '', hint: '', code: '' },
    };

    const result = await saveSocialLinksAction(submission({}, STORED_FORM));

    expect(upserts, 'a save that cannot see what it replaces must replace nothing').toEqual([]);
    expect(inserts).toEqual([]);
    expect(result.ok).toBe(false);
    // A database that did not answer may answer the next click; this form is
    // not stale, so it is not told to reload.
    expect(result).not.toHaveProperty('mustReload');
  });

  it('writes NOTHING when the re-read REJECTS — a throw from the client layer', async () => {
    // Not a transport failure (those resolve, above); what a throw from the
    // client itself looks like. Covered so neither shape can reach the write.
    readRejectsWith = new Error('supabaseUrl is required.');

    const result = await saveSocialLinksAction(submission({}, STORED_FORM));

    expect(upserts).toEqual([]);
    expect(inserts).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result, 'a throw is transient too; the form is not stale').not.toHaveProperty('mustReload');
  });

  it('writes NOTHING when the row is not what the submitting form was shown', async () => {
    // Precisely the old blank render: a form that believed nothing was stored.
    const result = await saveSocialLinksAction(submission({}, BLANK_FORM));

    expect(upserts, 'the six stored URLs survive a blank submission built on {}').toEqual([]);
    expect(inserts, 'nothing was replaced, so there is no history to write').toEqual([]);
    // Every further click from this form is refused the same way, so it is told
    // to reload rather than left to retry into the same wall.
    expect(result).toEqual({ ok: false, error: CONFLICT, mustReload: true });
  });

  it('writes NOTHING over a stored URL the submitting form did not show', async () => {
    read = { data: { value: { ...STORED, x: 'http://x.com/bubalyhq' } }, error: null };
    const { x: _hidden, ...shown } = STORED;

    // What the form posted when it drew the SANITIZED links: X blank, and a
    // fingerprint of a row with no X in it.
    const result = await saveSocialLinksAction(submission(shown, NO_X_FORM));

    expect(upserts, 'the stored http:// X is not removed by a form that never showed it').toEqual([]);
    expect(result).toEqual({ ok: false, error: CONFLICT, mustReload: true });
  });

  it('does not let a single retyped link delete the other five', async () => {
    const result = await saveSocialLinksAction(
      submission({ facebook: 'https://www.facebook.com/bubaly' }, BLANK_FORM),
    );

    expect(upserts).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('writes NOTHING when the submission does not say what it loaded', async () => {
    const result = await saveSocialLinksAction(submission({ facebook: STORED.facebook }, null));

    expect(upserts).toEqual([]);
    expect(result).toEqual({ ok: false, error: NO_REVISION, mustReload: true });
  });

  it('never reports a refused save as an update', async () => {
    read = { data: null, error: { message: 'relation "public.app_settings" does not exist' } };

    const result = await saveSocialLinksAction(submission({}, STORED_FORM));

    expect(result.ok, 'the green "Social links updated" toast is the success branch').toBe(false);
    expect(upserts).toEqual([]);
    // A database fault is not a stale form: the same submission may go through
    // once the database answers, so it must not be told to reload.
    expect(result).not.toHaveProperty('mustReload');
  });
});

describe('saving social links the operator really did edit', () => {
  it('still removes one link by clearing its field', async () => {
    const { x: _dropped, ...kept } = STORED;

    const result = await saveSocialLinksAction(submission(kept, STORED_FORM));

    expect(result.ok).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe('app_settings');
    expect(upserts[0].row.value, 'X is gone, the other five are not').toEqual(kept);
    expect(upserts[0].row.updated_by).toBe('super-admin-1');
    // The confirmation read before the write is bounded like the page's read:
    // a database that cannot answer in 1.5 s gets the save refused, not waited on.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('still lets the operator clear every link deliberately — and keeps what it cleared', async () => {
    const result = await saveSocialLinksAction(submission({}, STORED_FORM));

    expect(result.ok).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].row.value).toEqual({});
    // app_settings keeps only the current value. This row is the only undo.
    expect(inserts).toEqual([
      {
        table: 'audit_logs',
        row: expect.objectContaining({
          family_id: null,
          actor_id: 'super-admin-1',
          action: 'update',
          resource: 'app_settings',
          // `via: 'site_admin'` is what /admin/audit and /admin/security classify
          // on: the Scope=Admin filter, the red badge and the "site admin
          // actions" count all read it. Without it a super-admin replacing the
          // SITE-WIDE links is filed as in-family activity and hidden from the
          // admin view — the undo row exists, but not where anyone would look.
          metadata: { key: 'social_links', previous: STORED, saved: {}, via: 'site_admin' },
        }),
      },
    ]);
  });

  it('saves over an unpublishable URL the form DID show, and says it was rejected', async () => {
    read = { data: { value: { ...STORED, x: 'http://x.com/bubalyhq' } }, error: null };

    // The operator saw X marked invalid and saved without fixing it.
    const result = await saveSocialLinksAction(
      submission({ ...STORED, x: 'http://x.com/bubalyhq' }, HTTP_X_FORM),
    );

    expect(result).toMatchObject({ ok: true, rejected: ['x'] });
    const { x: _dropped, ...published } = STORED;
    expect(upserts[0].row.value).toEqual(published);
    // The history row keeps the http:// value the replace removed.
    expect(inserts[0].row.metadata).toEqual({
      key: 'social_links',
      previous: { ...STORED, x: 'http://x.com/bubalyhq' },
      saved: published,
      via: 'site_admin',
    });
  });

  it('hands back a fingerprint of what it wrote, so a second save is checked against it', async () => {
    const first = await saveSocialLinksAction(
      submission({ facebook: STORED.facebook }, STORED_FORM),
    );
    expect(first).toMatchObject({ ok: true, revision: FACEBOOK_ONLY_FORM });

    // The row now holds only Facebook; the stale page-load fingerprint is dead.
    read = { data: { value: { facebook: STORED.facebook } }, error: null };
    upserts = [];
    const stale = await saveSocialLinksAction(submission({}, STORED_FORM));
    expect(stale.ok, 'a second save must be checked against what the first wrote').toBe(false);
    expect(upserts).toEqual([]);
  });

  it('pins the literal fingerprints above to the ones the page really renders', () => {
    const { x: _x, ...noX } = STORED;
    expect(socialLinksRevision({})).toBe(BLANK_FORM);
    expect(socialLinksRevision(null)).toBe(BLANK_FORM);
    expect(socialLinksRevision(STORED)).toBe(STORED_FORM);
    expect(socialLinksRevision({ facebook: STORED.facebook })).toBe(FACEBOOK_ONLY_FORM);
    expect(socialLinksRevision(noX)).toBe(NO_X_FORM);
    expect(socialLinksRevision({ ...STORED, x: 'http://x.com/bubalyhq' })).toBe(HTTP_X_FORM);
    // Different stored sets must not share a fingerprint, or the refusals above
    // would be luck rather than a check. NO_X vs HTTP_X is the one sanitizing
    // used to collapse.
    const all = [BLANK_FORM, STORED_FORM, FACEBOOK_ONLY_FORM, NO_X_FORM, HTTP_X_FORM];
    expect(new Set(all).size).toBe(all.length);
    // A newline in a stored string cannot make two different rows canonicalise
    // to the same text.
    expect(socialLinksRevision({ facebook: 'a\nyoutube=b' })).not.toBe(
      socialLinksRevision({ facebook: 'a', youtube: 'b' }),
    );
  });
});

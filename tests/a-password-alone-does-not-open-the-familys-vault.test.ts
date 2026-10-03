// O-03, the document half. A parent enrols a TOTP authenticator so that a
// stolen password cannot open the family's vault — the stored passwords, the
// binder (alarm codes, Wi-Fi keys), the tax documents, the paperwork inbox.
// Eight document pages send an `aal1` session (password only) to
// /auth/step-up, and until 0391 that was the whole enforcement: every policy
// on the tables behind them was a membership or role check that a parent on an
// aal1 session satisfies, so someone with the password and not the
// authenticator was bounced by /dashboard/passwords and could still read every
// stored password with `GET /rest/v1/family_credentials` and the anon key.
//
// The database half is 0391, probed on a real Postgres by
// docs/audit/a-password-alone-does-not-open-the-familys-vault-check.sql. This
// file pins what a unit test can hold:
//
//   1. the paperwork server actions — the one document writer that is a
//      Next-Action endpoint rather than a browser-direct write — refuse an
//      aal1 session of an enrolled parent WITHOUT writing, and say where the
//      code goes; the same clicks work at aal2, for a never-enrolled family,
//      and for an enrolled CHILD (needsStepUp asks only managers); and a write
//      the database FILTERED — a status change, the calendar/reminder
//      stamp-back — is answered in words, never as `{ ok: true }`;
//   2. the paperwork module hands that refusal to reportRefusal, so the family
//      is taken to the code page rather than shown a dead-end toast;
//   3. the migration guards exactly the tables whose every writer sits behind
//      the step-up, reuses 0382's helper with needsStepUp's role half
//      (`… or not can_manage_family(family_id)`) in every clause, and leaves
//      `documents` and the paperwork SELECT alone on purpose;
//   4. those tables are STILL written only from behind the step-up — the
//      condition that made them safe to guard — so a writer added tomorrow
//      from a page without requireAal2 fails here before it fails a family.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// F19: these user-requested AI actions now check the family's monthly allowance
// before the model. This file is about other behaviour, so the family is on
// Basic, whose allowance is unlimited: the real check runs and passes.
vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => 1,
}));
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const STEP_UP = '/auth/step-up?next=%2Fdashboard%2Fpaperwork';

const h = vi.hoisted(() => ({
  getAal: vi.fn(),
  db: null as unknown,
  reached: { ai: 0, reminders: 0 },
  // The caller's role in the active family. A parent unless a case says
  // otherwise: needsStepUp asks only managers for a code, and 0391's guards
  // carry the same role clause.
  role: 'parent' as string,
  // What the AI draft provider answers; null = AI not configured.
  aiDraft: null as string | null,
}));

// The sentences the family reads, asserted against the REAL en-US catalogue
// with nothing laid over it — so a key missing from the catalogue fails here
// instead of reaching a family as `actions.paperwork…`. The first three are
// queued in scratchpad/i18n-asks/o03.json: RED UNTIL THE CATALOGUE MERGE
// LANDS, and meant to be.
const NEEDS_CODE = "Enter your two-step code before changing the family's paperwork.";
const ON_CALENDAR_NOT_MARKED = "It's on your calendar, but this paperwork couldn't be marked as handled. Check your calendar before adding it again.";
const REMINDER_SET_NOT_MARKED = "The reminder is set, but this paperwork couldn't be marked as handled. Check your reminders before adding it again.";
const NOT_SAVED = "That change wasn't saved — you may not have permission. Refresh and try again.";

// The session's assurance level, as `readAssurance` sees it.
const NEVER_ENROLLED = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
const ENROLLED_NO_CODE_YET = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
const CODE_ENTERED = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'p@example.com' },
    memberships: [],
    // A PARENT unless the case says otherwise: the role boundary waves this
    // caller through; assurance is the whole question.
    active: { familyId: 'fam-1', role: h.role, member: { id: 'mem-1' }, family: { id: 'fam-1', timezone: 'UTC' } },
  }),
}));
// One client, as in production: the tables the actions write and the session
// whose assurance level the gate reads are the same object.
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { readFileSync } = await import('node:fs');
  const { translate } = await import('@/lib/i18n/translate');
  // The real catalogue and nothing else — see NEEDS_CODE above.
  const messages = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default', messages }),
  };
});
// Not on trial: the AI draft provider, the reminder service and the untrusted-
// text fence the actions reach AFTER the gate. Each records that it was reached
// at all — which, with the password alone, it must not be.
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => { h.reached.ai += 1; return h.aiDraft !== null; },
  resolveProvider: async () => ({ model: 'fake', complete: async () => ({ text: h.aiDraft ?? '', usage: {} }) }),
  describeAIError: (e: unknown) => ({ message: String(e) }),
}));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (_scope: unknown, _meta: unknown, fn: (obs: unknown) => Promise<unknown>) => fn({ used() {}, failed() {} }),
}));
vi.mock('@/lib/services/reminders', () => ({
  createReminder: async () => { h.reached.reminders += 1; return { ok: true, data: { id: 'rem-1' } }; },
}));
vi.mock('@/lib/ai/safety/untrusted', () => ({ fenceUntrustedBlock: (_kind: string, text: string) => text, UNTRUSTED_CONTENT_RULE: '' }));
// The draft path carries the AI rate-limit budget (C3-S4-01, merged from main);
// this suite is about the step-up gate, so the budget always has room.
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));

const actions = await import('@/app/(app)/dashboard/paperwork/actions');

// One slip in the inbox, with one extracted "schedule" action not yet on the
// calendar. Everything below asks what happened to THIS row.
const SLIP = {
  id: 'paper-1', family_id: 'fam-1', title: 'Field trip slip', kind: 'permission_slip', status: 'needs_action', urgency: 'normal',
  summary: null, raw_text: 'Sign and return by Friday. Trip to the science museum on 12 Oct.', sender: 'school@example.com',
  due_on: '2026-10-12', amount: null, created_by: 'user-1', created_at: '2026-09-20T09:00:00Z', updated_at: '2026-09-20T09:00:00Z',
  actions: [{ kind: 'schedule', label: 'Museum trip', due_on: '2026-10-12', amount: null, materialized_as: null, materialized_id: null }],
  meta: {},
};

let db: InMemorySupabase;

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  h.getAal.mockReset();
  h.role = 'parent';
  h.aiDraft = null;
  h.reached.ai = 0;
  h.reached.reminders = 0;
  db = createInMemorySupabase({
    rpc: {
      // 0415's paperwork_stamp_action, modelled: stamp ONE element unless it is
      // already stamped, recompute the status, answer whether it stamped. It is
      // SECURITY INVOKER, so the write goes through the same row-level security
      // a direct update does — here, through `db.from`, which filterUpdatesTo
      // below replaces — and a filtered update stamps nothing and answers false.
      paperwork_stamp_action: async (args, inner) => {
        const row = (inner.table('paperwork_items') as Record<string, unknown>[]).find((r) => r.id === args.p_item_id);
        if (!row || !Array.isArray(row.actions)) return false;
        const list = structuredClone(row.actions) as Record<string, unknown>[];
        const target = list[args.p_index as number];
        if (!target || target.materialized_id) return false;
        target.materialized_id = args.p_id;
        target.materialized_as = args.p_as;
        const status = row.status === 'archived' ? row.status : (list.every((a) => a.materialized_id) ? 'done' : 'in_progress');
        const { data } = await inner.from('paperwork_items').update({ actions: list, status } as never).eq('id', args.p_item_id as string).select('id');
        return Array.isArray(data) && data.length > 0;
      },
    },
  });
  db.seed('paperwork_items', [structuredClone(SLIP)]);
  Object.assign(db, { auth: { mfa: { getAuthenticatorAssuranceLevel: h.getAal } } });
  h.db = db;
});

describe('the paperwork inbox, reached with the password alone', () => {
  beforeEach(() => h.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET));

  it('files nothing, changes nothing, creates nothing — and says where the code goes', async () => {
    const added = await actions.addPaperworkAction(fd({ text: 'Permission slip: sign and return by Friday.' }));
    const archived = await actions.setPaperworkStatusAction({ itemId: 'paper-1', status: 'archived' });
    const scheduled = await actions.materializePaperworkActionAction({ itemId: 'paper-1', actionIndex: 0 });
    const drafted = await actions.draftPaperworkReplyAction('paper-1');

    // The inbox is exactly as it was: no second row, the slip still needing
    // action, its trip not on the calendar, no reminder, no draft, no AI call.
    expect(db.table('paperwork_items')).toEqual([SLIP]);
    expect(db.table('calendar_events')).toHaveLength(0);
    expect(h.reached.reminders).toBe(0);
    expect(h.reached.ai).toBe(0);

    // And the family is told, in words, that the code is what is missing — and
    // the answer carries where it goes (reportRefusal acts on it, below).
    for (const res of [added, archived, scheduled, drafted]) {
      expect(res).toEqual({ ok: false, error: NEEDS_CODE, stepUp: STEP_UP });
      expect((res as { error: string }).error).not.toMatch(/^actions\./);
    }
  });
});

describe('once the code is entered', () => {
  beforeEach(() => h.getAal.mockResolvedValue(CODE_ENTERED));

  it('the same clicks file the slip and archive it, as they always did', async () => {
    expect(await actions.addPaperworkAction(fd({ text: 'Permission slip: sign and return by Friday.', sender: 'School' }))).toEqual({ ok: true });
    expect(db.table('paperwork_items')).toHaveLength(2);

    expect(await actions.setPaperworkStatusAction({ itemId: 'paper-1', status: 'archived' })).toEqual({ ok: true });
    expect(db.table('paperwork_items').find((r) => r.id === 'paper-1')?.status).toBe('archived');
  });

  it('and "Add to calendar" puts the trip on the calendar and stamps the slip', async () => {
    expect(await actions.materializePaperworkActionAction({ itemId: 'paper-1', actionIndex: 0 })).toEqual({ ok: true });
    expect(db.table('calendar_events')).toHaveLength(1);
    const slip = db.table('paperwork_items')[0] as { actions: { materialized_as: string | null; materialized_id: string | null }[]; status: string };
    expect(slip.actions[0].materialized_as).toBe('calendar_event');
    expect(slip.actions[0].materialized_id).toBe(db.table('calendar_events')[0].id);
    expect(slip.status).toBe('done');
  });
});

describe('a family that never set up an authenticator', () => {
  it('is not asked for a code it does not have — nothing changes for them', async () => {
    h.getAal.mockResolvedValue(NEVER_ENROLLED);
    expect(await actions.setPaperworkStatusAction({ itemId: 'paper-1', status: 'done' })).toEqual({ ok: true });
    expect(db.table('paperwork_items')[0].status).toBe('done');
  });
});

describe('a child who enrolled an authenticator for their own account', () => {
  // needsStepUp asks only managers for a code, and 0391's guards carry the
  // same role clause (`… or not can_manage_family(family_id)`), probed for an
  // enrolled child in docs/audit/a-password-alone-does-not-open-the-familys-
  // vault-check.sql step 5b. The two halves must agree: an app that let the
  // child through over a database that filtered them is the silent no-op this
  // pins against.
  it('is not asked for a code on a password-only session — the slip changes', async () => {
    h.role = 'child';
    h.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);
    expect(await actions.setPaperworkStatusAction({ itemId: 'paper-1', status: 'done' })).toEqual({ ok: true });
    expect(db.table('paperwork_items')[0].status).toBe('done');
  });
});

/**
 * What a RESTRICTIVE policy does to an UPDATE it refuses: it FILTERS it. The
 * statement matches no row and succeeds with no error — measured on Postgres
 * in lib/supabase/errors.ts (wroteNoRows). Reads and inserts are untouched.
 */
function filterUpdatesTo(table: string): void {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((name: string) => {
    const query = from(name);
    if (name !== table) return query;
    const update = query.update.bind(query);
    return Object.assign(query, {
      update: (...args: Parameters<typeof update>) => update(...args).eq('id', 'no row a refused update can see'),
    });
  });
}

describe('a write the database filtered is not a success', () => {
  beforeEach(() => h.getAal.mockResolvedValue(CODE_ENTERED));

  it('"Archive" that changed no row answers that it was not saved — never { ok: true }', async () => {
    filterUpdatesTo('paperwork_items');
    const res = await actions.setPaperworkStatusAction({ itemId: 'paper-1', status: 'archived' });
    expect(db.table('paperwork_items')[0].status).toBe('needs_action');
    expect(res).toEqual({ ok: false, error: NOT_SAVED });
  });

  it('"Add to calendar" whose stamp-back did not land says the event exists and the slip is not marked', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    filterUpdatesTo('paperwork_items');
    const res = await actions.materializePaperworkActionAction({ itemId: 'paper-1', actionIndex: 0 });

    // The event WAS created — that part of the tap happened …
    expect(db.table('calendar_events')).toHaveLength(1);
    // … and the slip was not stamped, so a second tap would create another.
    const slip = db.table('paperwork_items')[0] as { actions: { materialized_id: string | null }[]; status: string };
    expect(slip.actions[0].materialized_id).toBeNull();
    expect(slip.status).toBe('needs_action');
    // So the family is told both halves, in words, rather than `{ ok: true }`.
    expect(res).toEqual({ ok: false, error: ON_CALENDAR_NOT_MARKED });
    expect(errorSpy).toHaveBeenCalledWith('[paperwork] materialization stamp-back did not land', expect.objectContaining({ itemId: 'paper-1', materializedAs: 'calendar_event' }));
    errorSpy.mockRestore();
  });

  it('and "Remind me" whose stamp-back did not land says the reminder is set and the slip is not marked', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.replace('paperwork_items', []);
    db.seed('paperwork_items', [{
      ...structuredClone(SLIP),
      actions: [{ kind: 'sign', label: 'Sign the slip', due_on: '2026-10-10', amount: null, materialized_as: null, materialized_id: null }],
    }]);
    filterUpdatesTo('paperwork_items');
    const res = await actions.materializePaperworkActionAction({ itemId: 'paper-1', actionIndex: 0 });

    expect(h.reached.reminders).toBe(1);
    expect((db.table('paperwork_items')[0] as { actions: { materialized_id: string | null }[] }).actions[0].materialized_id).toBeNull();
    expect(res).toEqual({ ok: false, error: REMINDER_SET_NOT_MARKED });
    errorSpy.mockRestore();
  });
});

describe('a best-effort write the database filtered is still not invisible', () => {
  it('a drafted reply whose persist changed no row is returned, and the lost persist is logged', async () => {
    h.getAal.mockResolvedValue(CODE_ENTERED);
    h.aiDraft = 'We will return the signed slip on Friday.';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    filterUpdatesTo('paperwork_items');

    expect(await actions.draftPaperworkReplyAction('paper-1')).toEqual({ ok: true, draft: h.aiDraft });
    expect((db.table('paperwork_items')[0].meta as Record<string, unknown>).draft_reply).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[paperwork] draft_reply persist failed', expect.objectContaining({ itemId: 'paper-1' }));
    errorSpy.mockRestore();
  });
});

describe('when the assurance level cannot be read at all', () => {
  it('the inbox stays as it is — an unreadable level is not a cleared one', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.getAal.mockResolvedValue({ data: null, error: { message: 'session missing' } });

    const res = await actions.setPaperworkStatusAction({ itemId: 'paper-1', status: 'archived' });
    expect(res.ok).toBe(false);
    expect(db.table('paperwork_items')[0].status).toBe('needs_action');
    errorSpy.mockRestore();
  });
});

describe('what the family SEES when the inbox refuses for the code', () => {
  it('every call site in the paperwork module hands its refusal to reportRefusal', () => {
    const src = readFileSync('components/modules/paperwork-module.tsx', 'utf8');
    expect(src).toContain("from '@/lib/auth/step-up-client'");
    // The old shape: the message shown and `stepUp` dropped on the floor.
    expect(src).not.toMatch(/toastError\(res\.error\)/);
    // Four actions, four call sites.
    expect(src.match(/reportRefusal\(res, toastError\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

// ── the database half, as far as a unit test can see it ─────────────────────

const MIGRATIONS = 'supabase/migrations';

function migration(version: string): string {
  const name = readdirSync(MIGRATIONS).find((f) => f.startsWith(`${version}_`) && f.endsWith('.sql'));
  if (!name) throw new Error(`no ${version} migration in ${MIGRATIONS}`);
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

describe('0391 — the guard set, in the database', () => {
  const sql = migration('0391');

  it("reuses 0382's helper, refuses to run without it, and defines no second one", () => {
    expect(sql).toContain("to_regprocedure('public.session_cleared_step_up()')");
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\.session_cleared_step_up/i);
    // 0382 still owns the definition — one rule for money and documents alike.
    expect(migration('0382')).toMatch(/create or replace function public\.session_cleared_step_up\(\)/);
  });

  it('guards writes on exactly the four tables written only from behind the step-up', () => {
    expect(sql).toMatch(/vault_tables\s+text\[\]\s*:=\s*array\['family_credentials',\s*'household_info',\s*'tax_documents',\s*'paperwork_items'\]/);
    for (const verb of ['insert', 'update', 'delete']) {
      expect(sql).toContain(`drop policy if exists %1$s_step_up_${verb}_guard on public.%1$I`);
      expect(sql).toContain(`create policy %1$s_step_up_${verb}_guard on public.%1$I as restrictive for ${verb} to authenticated`);
    }
    // An update guard with only one half lets a row be moved into or out of
    // the guarded state.
    expect(sql).toContain('for update to authenticated using (%2$s) with check (%2$s)');
  });

  it('guards reads on the three that hold secrets, and not on the paperwork inbox', () => {
    expect(sql).toMatch(/secret_tables\s+text\[\]\s*:=\s*array\['family_credentials',\s*'household_info',\s*'tax_documents'\]/);
    expect(sql).toContain('create policy %1$s_step_up_select_guard on public.%1$I as restrictive for select to authenticated using (%2$s)');
  });

  it('asks both halves of needsStepUp — the assurance helper OR not a manager — in every guard', () => {
    // needsStepUp (lib/auth/mfa.ts) asks only a parent or adult for a code. A
    // guard on the helper alone refused an enrolled CHILD at aal1 on three
    // is_family_member tables the pages never ask them a code for.
    expect(sql).toContain("cleared constant text := 'public.session_cleared_step_up() or not public.can_manage_family(family_id)';");
    const creates = [...sql.matchAll(/'create policy %1\$s_step_up_(\w+)_guard [^']*'/g)];
    expect(creates.map((m) => m[1]).sort()).toEqual(['delete', 'insert', 'select', 'update']);
    for (const [statement] of creates) {
      // Every clause is the shared rule, and none asks the helper on its own.
      expect(statement).toMatch(/\((%2\$s)\)/);
      expect(statement).not.toContain('session_cleared_step_up');
    }
    // Each create interpolates the rule it names.
    expect(sql.match(/,\s*t, cleared\);/g)).toHaveLength(4);
  });

  it('leaves `documents` alone — /dashboard/home writes it with no step-up — and says so', () => {
    expect(sql).not.toMatch(/array\[[^\]]*'documents'/);
    expect(sql).toMatch(/home-module\.tsx/);
  });
});

// ── the condition that made those four tables safe to guard ─────────────────

const WRITE = /\.from\('([a-z_]+)'\)\s*\.(insert|update|upsert|delete)\(/g;
const GUARDED = ['family_credentials', 'household_info', 'tax_documents', 'paperwork_items'] as const;
type Guarded = (typeof GUARDED)[number];

/**
 * Every writer of a guarded table, and why each sits behind the step-up.
 *   module        a browser-direct writer rendered only by a page that calls
 *                 requireAal2(ctx, 'documents', …)
 *   action        a server action gated on aal2Verdict
 *   service       reached only through a route gated on aal2Verdict, or with
 *                 the service role
 *   service-role  the inbound-email webhook, on createServiceClient(), which
 *                 RLS exempts
 * A new file here means a new writer: it must be one of these, or the table
 * must leave 0391's list.
 */
const WRITERS: Record<Guarded, Record<string, 'module' | 'action' | 'service' | 'service-role'>> = {
  family_credentials: { 'components/modules/passwords-module.tsx': 'module' },
  household_info: { 'components/modules/binder-module.tsx': 'module' },
  tax_documents: { 'components/modules/tax-vault-module.tsx': 'module' },
  paperwork_items: {
    'app/(app)/dashboard/paperwork/actions.ts': 'action',
    'lib/services/paperwork/capture.ts': 'service',
    'lib/services/paperwork/link.ts': 'service',
    'lib/services/paperwork/index.ts': 'service',
    'lib/services/paperwork/email-attachments.ts': 'service-role',
    'lib/contact-center/server.ts': 'service-role',
  },
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (['.ts', '.tsx'].includes(extname(p))) out.push(p);
  }
  return out;
}

describe('the guarded tables are written only from behind the step-up', () => {
  const files = ['app', 'components', 'lib'].flatMap((root) => sourceFiles(root));
  const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')] as const));
  const found: Record<Guarded, Set<string>> = { family_credentials: new Set(), household_info: new Set(), tax_documents: new Set(), paperwork_items: new Set() };
  for (const [file, src] of sources) {
    for (const m of src.matchAll(WRITE)) {
      if ((GUARDED as readonly string[]).includes(m[1])) found[m[1] as Guarded].add(file);
    }
  }

  it('scans the application', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it.each(GUARDED)('%s has no writer this file does not account for', (table) => {
    expect([...found[table]].sort()).toEqual(Object.keys(WRITERS[table]).sort());
  });

  it('each browser module is rendered by exactly one page, and that page calls requireAal2 for documents', () => {
    const pages = files.filter((f) => f.startsWith('app/') && f.endsWith('page.tsx'));
    for (const [table, writers] of Object.entries(WRITERS)) {
      for (const [file, kind] of Object.entries(writers)) {
        if (kind !== 'module') continue;
        const component = /export function (\w+Module)\(/.exec(sources.get(file) ?? '')?.[1];
        expect(component, file).toBeTruthy();
        const rendering = pages.filter((p) => (sources.get(p) ?? '').includes(`<${component}`));
        expect(rendering, `${table}: pages rendering <${component}>`).toHaveLength(1);
        expect(sources.get(rendering[0]), rendering[0]).toMatch(/requireAal2\(ctx, 'documents'/);
      }
    }
  });

  it('every paperwork server action goes through the assurance gate, and none reaches for the session client on its own', () => {
    const src = sources.get('app/(app)/dashboard/paperwork/actions.ts') ?? '';
    expect(src).toContain("aal2Verdict(ctx, 'documents'");
    expect(src.match(/await paperworkScope\(\)/g)?.length).toBe(4);
    expect(src.match(/await createServer\(\)/g)?.length).toBe(1);
    expect(src.match(/await requireUserContext\(\)/g)?.length).toBe(1);
  });

  it('the capture services are reached only through the two gated routes', () => {
    const cases = [
      ['@/lib/services/paperwork/capture', 'app/api/paperwork/capture/route.ts'],
      ['@/lib/services/paperwork/link', 'app/api/paperwork/link/route.ts'],
    ] as const;
    for (const [service, route] of cases) {
      const importers = files.filter((f) => (sources.get(f) ?? '').includes(`'${service}'`) && !f.startsWith('lib/services/paperwork/'));
      // /capture/link/page.tsx imports the link service for a READ
      // (linkedDocumentSource), and is itself behind requireAal2 — pinned below.
      expect(importers.filter((f) => f !== 'app/(app)/capture/link/page.tsx'), service).toEqual([route]);
      expect(sources.get(route), route).toContain("aal2Verdict(ctx, 'documents'");
    }
    expect(sources.get('app/(app)/capture/link/page.tsx')).toMatch(/requireAal2\(ctx, 'documents'/);
  });

  it('the inbound-email writers hold the service role, which RLS exempts', () => {
    expect(sources.get('lib/contact-center/server.ts')).toMatch(/fileInboundPaperwork\(\s*admin: Admin/);
    const email = sources.get('app/api/contact-center/email/route.ts') ?? '';
    expect(email).toContain('const admin = createServiceClient();');
    expect(email).toMatch(/fileEmailAttachments\(admin,/);
    expect(email).toMatch(/fileInboundPaperwork\(admin,/);
  });
});

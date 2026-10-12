// AUD-1028-M2 — an opt-out clicked in a mail to an ALIAS stopped that alias
// and nothing else.
//
// The automation sender looks an address up under its spelling and its
// canonical inbox (lib/marketing/automation-steps.ts). The unsubscribe route
// stored only the spelling the mail went to. So a reader mailed as
// `victim+news@gmail.com` who clicked Unsubscribe left a row for that spelling
// alone, and the next day a public form reached the same inbox as
// `victim@gmail.com` or `victim+other@gmail.com` — neither lookup names the
// alias row.
//
// Now the signed unsubscribe records the inbox beside the spelling, and the
// lookup also honours rows written BEFORE that (alias only), by reading the
// stored spellings that could be the same inbox and comparing their canonical
// form. Nothing is rewritten or cleaned up; existing typed rows suppress as
// they always did.
//
// Driven through the real contact route, the real unsubscribe route (the
// one-click POST, with the signed link taken from the mail's own
// List-Unsubscribe header), the real dispatcher and step runner, and the real
// scheduled runner, over an in-memory database. Only the provider is fake.
// Negative controls: before the fix the base and other-alias mails below are
// sent, and so are the mails to the inbox of a legacy alias row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as Record<string, unknown>[],
  customers: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/email', () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock('@/lib/marketing/customers', () => ({
  getMarketingCustomersWithError: async () => ({ customers: h.customers, error: null }),
}));
vi.mock('@/lib/email', () => ({
  getResend: () => ({
    emails: {
      send: async (message: Record<string, unknown>) => {
        h.sent.push(message);
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  APP_URL: 'https://bubaly.test',
}));

function limiter(args: Record<string, unknown>, store: InMemorySupabase) {
  const seconds = Number(args.p_window_seconds);
  const windowStart = Math.floor(Date.now() / 1000 / seconds) * seconds;
  const key = String(args.p_key);
  const rows = store.table('rate_limits');
  let row = rows.find((r) => r.bucket_key === key && r.window_start === windowStart);
  if (!row) { row = { bucket_key: key, window_start: windowStart, count: 0 }; rows.push(row); }
  row.count = Number(row.count) + 1;
  const allowed = Number(row.count) <= Number(args.p_limit);
  return [{ allowed, retry_after: allowed ? 0 : seconds }];
}

let db: InMemorySupabase;
let day = 0;

function seed(suppressions: Row[] = []) {
  db = createInMemorySupabase({
    // `email` is marketing_suppressions' primary key (0021).
    uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']], marketing_suppressions: [['email']] },
    rpc: { rate_limit_hit: limiter, rate_limit_prune: () => null },
  });
  db.seed('marketing_automation_workflows', [
    { id: 'wf-ack', trigger: 'form_submitted', status: 'active', deleted_at: null, run_count: 0, steps: [{ action: 'send_email' }] },
    { id: 'wf-welcome', trigger: 'customer_created', status: 'active', deleted_at: null, run_count: 0, steps: [{ action: 'send_email' }] },
  ]);
  db.seed('marketing_suppressions', suppressions);
  h.db = db;
}

/** A new day for each submission, so only an opt-out — never the daily allowance — can stop the mail. */
async function contact(email: string) {
  day += 1;
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 12 + day, 10, 5)));
  const { POST } = await import('@/app/api/contact/route');
  const res = await POST(new Request('https://bubaly.com/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${day}` },
    body: JSON.stringify({ name: 'Jordan', email, topic: 'general', message: 'Hello there, I have a question.' }),
  }));
  expect(res.status, email).toBe(200);
}

/** The one-click POST to the signed link the mail itself carried (RFC 8058). */
async function unsubscribeFrom(mail: Record<string, unknown>) {
  const header = (mail.headers as Record<string, string>)['List-Unsubscribe'];
  const url = /^<(.+)>$/.exec(header)![1];
  const { POST } = await import('@/app/api/marketing/unsubscribe/route');
  const { NextRequest } = await import('next/server');
  return POST(new NextRequest(url, { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.99' } }));
}

async function cron() {
  const { GET } = await import('@/app/api/cron/automations/route');
  const { NextRequest } = await import('next/server');
  return GET(new NextRequest('https://bubaly.test/api/cron/automations', {
    headers: { authorization: 'Bearer cron-fixture-secret' },
  }));
}

const mailedTo = () => h.sent.map((m) => String(m.to));
const customer = (familyId: string, ownerEmail: string) => ({
  familyId, name: 'Rivera', ownerEmail, memberCount: 2, plan: 'free', planLabel: 'Free', status: 'free',
  lifecycle: 'new', estLtvCents: 0, createdAt: '2026-10-01T00:00:00Z', lastActivityAt: '2026-10-11T00:00:00Z',
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
  vi.resetModules();
  day = 0;
  h.sent = [];
  h.customers = [];
  vi.stubEnv('CRON_SECRET', 'cron-fixture-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seed();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('an unsubscribe clicked in a mail to an alias opts the inbox out', () => {
  it('the base address and another alias are not mailed after it', async () => {
    await contact('victim+news@gmail.com');
    expect(mailedTo()).toEqual(['victim+news@gmail.com']);

    const res = await unsubscribeFrom(h.sent[0]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('victim+news@gmail.com will no longer receive marketing emails');

    for (const spelling of ['victim@gmail.com', 'victim+other@gmail.com', 'V.ictim@googlemail.com']) await contact(spelling);
    expect(mailedTo(), 'the inbox that opted out was reached under another spelling').toEqual(['victim+news@gmail.com']);
  });

  it('records the inbox beside the spelling, and leaves an existing inbox row as it was', async () => {
    seed([{ email: 'victim@gmail.com', reason: 'bounce' }]);
    await contact('fresh+news@example.com');
    await unsubscribeFrom(h.sent[0]);
    expect(db.table('marketing_suppressions').map((r) => [r.email, r.reason])).toEqual([
      ['victim@gmail.com', 'bounce'],
      ['fresh+news@example.com', 'unsubscribe'],
      ['fresh@example.com', 'unsubscribe'],
    ]);

    // The signed link for an alias of an inbox that bounced does not relabel the bounce.
    const { unsubUrl } = await import('@/lib/marketing/unsubscribe');
    await unsubscribeFrom({ headers: { 'List-Unsubscribe': `<${unsubUrl('https://bubaly.test', 'victim+x@gmail.com')}>` } });
    expect(db.table('marketing_suppressions').filter((r) => r.email === 'victim@gmail.com')).toEqual([
      expect.objectContaining({ reason: 'bounce' }),
    ]);
  });

  it('a scheduled automation to the account owner’s base address honours the alias opt-out', async () => {
    await contact('owner+promo@example.com');
    await unsubscribeFrom(h.sent[0]);
    h.customers = [customer('fam-owner', 'Owner@Example.com'), customer('fam-other', 'someone@example.com')];
    expect((await cron()).status).toBe(200);
    expect(mailedTo()).toEqual(['owner+promo@example.com', 'someone@example.com']);
  });

  it('an ordinary unsubscribe works and writes one row (positive control)', async () => {
    await contact('plain@example.com');
    const res = await unsubscribeFrom(h.sent[0]);
    expect(res.status).toBe(200);
    expect(db.table('marketing_suppressions').map((r) => r.email)).toEqual(['plain@example.com']);
    await contact('plain@example.com');
    expect(mailedTo()).toEqual(['plain@example.com']);
  });
});

describe('rows written before the inbox was recorded still hold', () => {
  it('a legacy alias row suppresses the base, another alias, and itself', async () => {
    seed([{ email: 'legacy+promo@example.com', reason: 'unsubscribe' }]);
    for (const spelling of ['legacy@example.com', 'legacy+other@example.com', 'LEGACY+promo@example.com']) await contact(spelling);
    expect(h.sent).toEqual([]);
    // Honoured as it is: nothing was rewritten or added.
    expect(db.table('marketing_suppressions').map((r) => r.email)).toEqual(['legacy+promo@example.com']);
  });

  // AUD-1028-M2-LEGACY-DOT: the old signed-unsubscribe writer stored the address
  // as typed, trailing domain dot included, and canonicalMailbox folds that dot.
  // The scan for such rows once required a `+` in the local part, so this row
  // was never read and its inbox kept getting mail.
  it('a legacy row with a trailing domain dot suppresses the base address and an alias', async () => {
    seed([{ email: 'legacy@example.com.', reason: 'unsubscribe' }]);
    for (const spelling of ['legacy@example.com', 'legacy+new@example.com']) await contact(spelling);
    expect(h.sent, 'each spelling is submitted on its own day, so only the opt-out can stop it').toEqual([]);
    expect(db.table('marketing_suppressions').map((r) => r.email)).toEqual(['legacy@example.com.']);
  });

  it('that trailing-dot row does not reach a neighbouring inbox (positive control)', async () => {
    seed([{ email: 'legacy@example.com.', reason: 'unsubscribe' }]);
    await contact('legacyx@example.com');
    expect(mailedTo()).toEqual(['legacyx@example.com']);
  });

  it('a legacy Gmail row with dots and a tag suppresses the inbox', async () => {
    seed([{ email: 'j.doe.smith+shop@googlemail.com', reason: 'complaint' }]);
    for (const spelling of ['jdoesmith@gmail.com', 'jdoe.smith+x@gmail.com']) await contact(spelling);
    expect(h.sent).toEqual([]);
  });

  it('an exact typed row still suppresses its own spelling (positive control: nothing regressed)', async () => {
    seed([{ email: 'left@example.com', reason: 'unsubscribe' }]);
    await contact('Left@Example.com');
    expect(h.sent).toEqual([]);
  });

  it('a neighbouring inbox the LIKE also reads is still mailed, once (positive control)', async () => {
    seed([
      { email: 'legacy+promo@example.com', reason: 'unsubscribe' },
      { email: 'victim+news@gmail.com', reason: 'unsubscribe' },
    ]);
    for (const spelling of ['legacyx@example.com', 'vic@gmail.com', 'victim2@gmail.com']) await contact(spelling);
    expect(mailedTo()).toEqual(['legacyx@example.com', 'vic@gmail.com', 'victim2@gmail.com']);
  });

  it('fails closed when the spellings cannot all be read', async () => {
    seed(Array.from({ length: 500 }, (_, i) => ({ email: `a${'x'.repeat(i % 7)}${i}b@gmail.com`, reason: 'bounce' })));
    await contact('ab@gmail.com');
    expect(h.sent, 'a ledger read that was cut short is not consent').toEqual([]);
    const [run] = db.table('marketing_automation_runs');
    expect((run.metadata as { actions: string[] }).actions).toEqual(['send_email:failed']);
  });
});

// POST /api/contact, driven end to end (Register B API-1B0FCD08C0B2).
//
// A public endpoint: anyone may write to support, so member roles and super
// admins are n/a and the caller is anonymous throughout. The real route, the
// real per-IP limiter (local and durable, over rate_limit_hit) and the real
// admin notifier run over an in-memory database seeded with two households,
// to show a contact message lands in platform tables and in neither family.
// Stubbed at the seams the neighbours use: `@/lib/server/email` sendEmail (the
// support-inbox mail) and the form_submitted automation, which
// tests/a-public-form-cannot-aim-automation-mail.test.ts and
// a-public-form-inbox-allowance-holds-at-every-send.test.ts drive for real.
//
// Already proven elsewhere and not repeated: the automation's per-inbox bound,
// suppressions and greeting (the two files above); the ticket-or-mail honesty
// rule, as a source scan (inbound-and-contact-honesty); the limiter being the
// shared durable one, as a source scan (public-side-effect-rate-limit); the
// topic routing, as a source scan (contact-topic-feedback); empty/malformed
// bodies (request-body-boundaries and the 2026-09-27 sweep).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, send: vi.fn(), automation: vi.fn() }));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/email', () => ({ sendEmail: h.send }));
vi.mock('@/lib/marketing/public-form-automation', () => ({ firePublicFormSubmitted: h.automation }));

const FAMILY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const IP = '203.0.113.7';
const VALID = { name: 'Jordan <b>Lee</b>', email: 'jordan@example.com', topic: 'bug', message: 'The calendar shows Tuesday twice <script>x</script>.' };

let db: InMemorySupabase;

function boot() {
  db = createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } });
  db.seed('families', [{ id: FAMILY_A, name: 'Rivera family' }, { id: FAMILY_B, name: 'Okafor family' }]);
  db.seed('support_tickets', [{ id: 'bbbbbbbb-0000-4000-8000-000000000501', family_id: FAMILY_B, ticket_number: 'B-1', subject: 'B\'s own ticket', status: 'open' }]);
  h.db = db;
}

async function contact(body: Record<string, unknown> = VALID, ip = IP) {
  const { POST } = await import('@/app/api/contact/route');
  return POST(new Request('https://www.bubaly.com/api/contact', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body),
  }));
}

const webTickets = () => db.table('support_tickets').filter((r) => String(r.ticket_number).startsWith('WEB-'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
  vi.resetModules(); // a fresh per-instance limiter for every case
  h.send.mockReset().mockResolvedValue({ ok: true });
  h.automation.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('CONTACT_INBOX', 'support-fixture@example.com');
  boot();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('an anonymous contact message (member roles and admin: n/a, public)', () => {
  it('API-1B0FCD08C0B2 a valid message answers ok, files one open ticket, notifies admins and mails support with every value escaped', async () => {
    const res = await contact();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const tickets = webTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      subject: '[Bug report — something’s broken] Contact from Jordan <b>Lee</b>',
      description: VALID.message,
      category: 'bug', priority: 'high', status: 'open',
      requester_name: VALID.name, requester_email: 'jordan@example.com',
      tags: ['contact-form', 'topic:bug'],
    });
    expect(String(tickets[0].ticket_number)).toMatch(/^WEB-\d+-[0-9A-F-]{8}$/);
    // Platform rows only: no household is attached to a stranger's message.
    expect(tickets[0].family_id).toBeUndefined();
    expect(db.table('admin_notifications')).toEqual([expect.objectContaining({
      kind: 'support_ticket', title: 'Bug report — something’s broken — Jordan <b>Lee</b>', url: '/admin/support-tickets?tab=open', related_type: 'support_ticket',
    })]);

    expect(h.send).toHaveBeenCalledTimes(1);
    const [mail] = h.send.mock.calls[0] as [{ to: string; replyTo: string; subject: string; html: string }];
    expect(mail.to).toBe('support-fixture@example.com');
    expect(mail.replyTo).toBe('jordan@example.com');
    expect(mail.html).toContain('Jordan &lt;b&gt;Lee&lt;/b&gt;');
    expect(mail.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<b>Lee');

    expect(h.automation).toHaveBeenCalledTimes(1);
    expect(h.automation.mock.calls[0][0]).toMatchObject({ email: 'jordan@example.com', name: VALID.name, context: { source: 'contact-form' } });
  });

  it('API-1B0FCD08C0B2 the sixth message from one address in a minute is refused 429 with Retry-After; it files, notifies and mails nothing', async () => {
    for (let i = 0; i < 5; i++) expect((await contact()).status).toBe(200);
    const res = await contact();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: 'contact.tooManyMessagesPleaseTry' });
    expect(webTickets()).toHaveLength(5);
    expect(db.table('admin_notifications')).toHaveLength(5);
    expect(h.send).toHaveBeenCalledTimes(5);
    expect(h.automation).toHaveBeenCalledTimes(5);
    // The limiter's bucket is keyed on a digest, never on the visitor's IP.
    expect(JSON.stringify(db.table('rate_limits'))).not.toContain(IP);
  });

  it('API-1B0FCD08C0B2 another address is not charged for the first one\'s budget (control)', async () => {
    for (let i = 0; i < 5; i++) await contact();
    expect((await contact(VALID, '198.51.100.9')).status).toBe(200);
  });

  it('API-1B0FCD08C0B2 a body that fails the schema is refused 422 and writes, notifies and mails nothing', async () => {
    const res = await contact({ ...VALID, message: 'short' });
    expect(res.status).toBe(422);
    expect(webTickets()).toHaveLength(0);
    expect(db.table('admin_notifications')).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.automation).not.toHaveBeenCalled();
  });
});

describe('another household\'s ids: n/a (a contact message names no household)', () => {
  it('API-1B0FCD08C0B2 a family id smuggled into the body is not stored, B\'s tickets are untouched and nothing of B is returned', async () => {
    const before = JSON.stringify(db.table('support_tickets').filter((r) => r.family_id === FAMILY_B));
    const res = await contact({ ...VALID, family_id: FAMILY_B, familyId: FAMILY_B });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ ok: true }));
    expect(webTickets()[0].family_id).toBeUndefined();
    expect(JSON.stringify(db.table('support_tickets').filter((r) => r.family_id === FAMILY_B))).toBe(before);
  });
});

describe('failure', () => {
  it('API-1B0FCD08C0B2 a refused ticket write with no mail provider answers 502, not ok, and leaks no database text', async () => {
    h.db = withFaults(db, (table) => (table === 'support_tickets' ? { code: '42501', message: 'new row violates row-level security policy for table "support_tickets"' } : null));
    h.send.mockResolvedValue({ ok: true, skipped: true });
    const res = await contact();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'contact.weCouldnTSendYour' });
    expect(text).not.toContain('row-level security');
    expect(webTickets()).toHaveLength(0);
  });

  it('API-1B0FCD08C0B2 a refused ticket write still answers ok when the mail did go (the mail is the primary path)', async () => {
    h.db = withFaults(db, (table) => (table === 'support_tickets' ? { code: '42501', message: 'denied' } : null));
    const res = await contact();
    expect(res.status).toBe(200);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('API-1B0FCD08C0B2 a filed ticket with no mail provider answers ok, because a human will find the ticket', async () => {
    h.send.mockResolvedValue({ ok: true, skipped: true });
    const res = await contact();
    expect(res.status).toBe(200);
    expect(webTickets()).toHaveLength(1);
  });

  it('API-1B0FCD08C0B2 a provider that refuses the mail answers 502 even though the ticket was filed', async () => {
    h.send.mockResolvedValue({ ok: false });
    const res = await contact();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'contact.weCouldnTSendYour' });
    expect(webTickets()).toHaveLength(1);
  });

  it('API-1B0FCD08C0B2 a limiter that cannot be evaluated refuses 429 and files, notifies and mails nothing (fails closed)', async () => {
    db = createInMemorySupabase(); // no rate_limit_hit: the RPC answers an error
    h.db = db;
    const res = await contact();
    expect(res.status).toBe(429);
    expect(webTickets()).toHaveLength(0);
    expect(db.table('admin_notifications')).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.automation).not.toHaveBeenCalled();
  });

  it('API-1B0FCD08C0B2 an automation that throws does not turn a delivered message into a failure', async () => {
    h.automation.mockRejectedValue(new Error('automation down'));
    const res = await contact();
    expect(res.status).toBe(200);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

// SEC-002. /api/blog/subscribe is unauthenticated, holds a service-role client,
// and answered three different things:
//
//   { ok: true, already: true }   → this address is a subscriber
//   { ok: true, already: false }  → this address subscribed once and OPTED OUT
//   { ok: true }                  → never seen it
//
// So a public form was a lookup for other people's email addresses, 20 a minute
// per IP, and the middle answer — someone deliberately left — is the one worth
// stealing. The honeypot leaked from the other side: it answered a bare
// { ok: true }, which is indistinguishable from a fresh subscribe but NOT from
// the `already` answer, so submitting one known address twice, once with
// `website` filled and once without, named the trap field.
//
// What this file pins is the property, not the lines: for an address the list
// knows and an address it has never seen, the caller gets THE SAME BYTES — same
// status, same body, same headers. The welcome-back sentence is not gone; it is
// mailed to the address (lib/blog/subscribe-notice.ts), where only its owner can
// read it. So the cases below assert both halves: nothing in the HTTP answer,
// everything in the mail.
//
// A negative control is included, because an equality assertion between two
// values a bug would make equal proves nothing on its own: it rebuilds the old
// two-answer shape and shows this file's comparison rejects it.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (k: string) => k }));

const createServiceClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClient(),
  createServer: async () => createServiceClient(),
}));

const enforceRequestRateLimit = vi.fn();
vi.mock('@/lib/server/request-rate-limit', () => ({
  enforceRequestRateLimit: (...args: unknown[]) => enforceRequestRateLimit(...args),
}));

const sendEmail = vi.fn();
vi.mock('@/lib/server/email', () => ({ sendEmail: (args: unknown) => sendEmail(args) }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://bubaly.test' }));

const ROUTE = 'app/api/blog/subscribe/route.ts';
const FORM = 'components/blog/subscribe-form.tsx';

const KNOWN = 'reader@example.com';
const UNKNOWN = 'nobody@example.com';
const EXISTING_TOKEN = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const FRESH_TOKEN = '9f8b2c11-1d2e-4a3b-8c4d-5e6f70819a2b';

type Row = { id: string; status: string; unsubscribe_token: string };
type Write = { kind: 'update' | 'insert'; payload: Record<string, unknown>; id?: string };

/** A blog_subscribers table that answers the lookup and the write as told. */
function subscribersClient(opts: {
  existing?: Row | null;
  lookupError?: unknown;
  updateError?: unknown;
  insertError?: unknown;
} = {}) {
  const writes: Write[] = [];
  const from = () => {
    let mode: 'select' | 'update' | 'insert' = 'select';
    let payload: Record<string, unknown> = {};
    let id = '';
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (p: Record<string, unknown>) => { mode = 'update'; payload = p; return chain; },
      insert: (p: Record<string, unknown>) => { mode = 'insert'; payload = p; return chain; },
      eq: (column: string, value: unknown) => { if (column === 'id') id = String(value); return chain; },
      maybeSingle: () => Promise.resolve({ data: opts.existing ?? null, error: opts.lookupError ?? null }),
      single: () => {
        writes.push({ kind: 'insert', payload });
        return Promise.resolve(opts.insertError
          ? { data: null, error: opts.insertError }
          : { data: { unsubscribe_token: FRESH_TOKEN }, error: null });
      },
      then: (onFulfilled: (v: unknown) => unknown) => {
        if (mode === 'update') writes.push({ kind: 'update', payload, id });
        return Promise.resolve({ data: null, error: opts.updateError ?? null }).then(onFulfilled);
      },
    };
    return chain;
  };
  return { client: { from }, writes };
}

const post = async (body: Record<string, unknown>, ip = '203.0.113.9') => {
  const { POST } = await import('@/app/api/blog/subscribe/route');
  const { NextRequest } = await import('next/server');
  return POST(new NextRequest('https://bubaly.com/api/blog/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }));
};

/**
 * Everything a caller can actually observe in the answer. `date` is dropped
 * because it is a clock, not a signal about the address.
 */
async function observable(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    headers: [...res.headers.entries()]
      .filter(([k]) => k.toLowerCase() !== 'date')
      .map(([k, v]) => `${k.toLowerCase()}: ${v}`)
      .sort(),
  };
}

/** The exact bytes. Spelled out so a second field cannot be added quietly. */
const ACCEPTED_BODY = '{"ok":true}';

const active = (): Row => ({ id: 'sub-1', status: 'active', unsubscribe_token: EXISTING_TOKEN });
const unsubscribed = (): Row => ({ id: 'sub-2', status: 'unsubscribed', unsubscribe_token: EXISTING_TOKEN });

/** The last thing handed to sendEmail, or null when nothing was sent. */
const lastMail = () =>
  (sendEmail.mock.calls.at(-1)?.[0] ?? null) as { to: string; subject: string; html: string } | null;

beforeEach(() => {
  vi.resetModules();
  enforceRequestRateLimit.mockResolvedValue({ ok: true });
  sendEmail.mockResolvedValue({ ok: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('the subscribe answer is the same for every address', () => {
  it('cannot tell a subscriber, an opt-out and a stranger apart', async () => {
    const answers: Record<string, Awaited<ReturnType<typeof observable>>> = {};

    for (const [label, opts, email] of [
      ['already subscribed', { existing: active() }, KNOWN],
      ['subscribed once, then opted out', { existing: unsubscribed() }, KNOWN],
      ['never seen', { existing: null }, UNKNOWN],
    ] as const) {
      createServiceClient.mockReturnValue(subscribersClient(opts).client);
      answers[label] = await observable(await post({ email, source: 'blog-sidebar' }));
    }

    const [first, ...rest] = Object.values(answers);
    for (const other of rest) expect(other, JSON.stringify(answers, null, 2)).toEqual(first);

    // …and pin what that one answer IS, so "identical" cannot be satisfied by
    // making every branch leak the same extra field.
    expect(first.status).toBe(200);
    expect(first.body).toBe(ACCEPTED_BODY);
  });

  it('answers the honeypot with those same bytes too', async () => {
    // The honeypot's whole value is being indistinguishable from success. It
    // was indistinguishable from the UNKNOWN-address success only, which is
    // what let a bot identify the field.
    createServiceClient.mockReturnValue(subscribersClient({ existing: active() }).client);
    const known = await observable(await post({ email: KNOWN }));

    const trapped = subscribersClient({ existing: null });
    createServiceClient.mockReturnValue(trapped.client);
    const bot = await observable(await post({ email: KNOWN, website: 'http://spam.example' }));

    expect(bot).toEqual(known);
    expect(bot.body).toBe(ACCEPTED_BODY);
    expect(trapped.writes, 'a honeypot submission must never be written').toEqual([]);
  });

  it('NEGATIVE CONTROL: this comparison rejects the shape the route used to return', async () => {
    // Without this, the case above could pass because the comparison is blind
    // rather than because the oracle is closed. These are the two answers the
    // handler gave before the fix, rebuilt here.
    const { NextResponse } = await import('next/server');
    const wasKnown = await observable(NextResponse.json({ ok: true, already: true }));
    const wasOptedOut = await observable(NextResponse.json({ ok: true, already: false }));
    const wasUnknown = await observable(NextResponse.json({ ok: true }));

    expect(wasKnown).not.toEqual(wasUnknown);
    expect(wasOptedOut).not.toEqual(wasUnknown);
    expect(wasKnown).not.toEqual(wasOptedOut);
    for (const old of [wasKnown, wasOptedOut]) expect(old.body).not.toBe(ACCEPTED_BODY);
    // The same three would also be caught by a status-only or header-only
    // comparison never firing, so the body is compared too — that is the field
    // the old shape differed in.
    expect(wasUnknown.body).toBe(ACCEPTED_BODY);
  });

  it('still records a genuinely new subscriber', async () => {
    // The uniform answer is worthless if it is uniform because nothing happens.
    const store = subscribersClient({ existing: null });
    createServiceClient.mockReturnValue(store.client);

    const res = await post({ email: ` ${UNKNOWN.toUpperCase()} `, source: 'article', visitorId: 'vid-12345678' });

    expect((await observable(res)).body).toBe(ACCEPTED_BODY);
    expect(store.writes).toEqual([
      { kind: 'insert', payload: { email: UNKNOWN, source: 'article', visitor_id: 'vid-12345678' } },
    ]);
  });

  it('still re-activates an address that had unsubscribed', async () => {
    const store = subscribersClient({ existing: unsubscribed() });
    createServiceClient.mockReturnValue(store.client);

    expect((await observable(await post({ email: KNOWN, source: 'blog-footer' }))).body).toBe(ACCEPTED_BODY);
    expect(store.writes).toEqual([{
      kind: 'update',
      id: 'sub-2',
      payload: { status: 'active', source: 'blog-footer', unsubscribed_at: null },
    }]);
  });

  it('does not rewrite a live subscriber’s attribution from an anonymous request', async () => {
    // The row is re-asserted, not repainted: `source` and `visitor_id` on an
    // ACTIVE subscriber would otherwise be editable by anyone who guessed the
    // address. The write stays unconditional so both existing states do the
    // same amount of work.
    const store = subscribersClient({ existing: active() });
    createServiceClient.mockReturnValue(store.client);

    await post({ email: KNOWN, source: 'blog-footer', visitorId: 'attacker-999' });

    expect(store.writes).toEqual([{ kind: 'update', id: 'sub-1', payload: { status: 'active' } }]);
  });
});

describe('what the caller is not told, the address is', () => {
  it('mails “already on the list” to the address instead of answering it', async () => {
    createServiceClient.mockReturnValue(subscribersClient({ existing: active() }).client);

    const res = await post({ email: KNOWN });

    expect((await observable(res)).body).toBe(ACCEPTED_BODY);
    const mail = lastMail();
    expect(mail?.to).toBe(KNOWN);
    expect(mail?.subject).toMatch(/already/i);
    // And a one-click way out, because the case this mail exists for is
    // somebody else typing this address into a public form.
    expect(mail?.html).toContain(`https://bubaly.test/api/blog/unsubscribe?token=${EXISTING_TOKEN}`);
  });

  it('mails a different notice for each state, all behind the same answer', async () => {
    const seen: Record<string, string> = {};
    for (const [label, opts] of [
      ['already', { existing: active() }],
      ['reactivated', { existing: unsubscribed() }],
      ['created', { existing: null }],
    ] as const) {
      createServiceClient.mockReturnValue(subscribersClient(opts).client);
      sendEmail.mockClear();
      const res = await post({ email: KNOWN });
      expect((await observable(res)).body, label).toBe(ACCEPTED_BODY);
      expect(sendEmail, `${label}: exactly one notice per accepted submission`).toHaveBeenCalledTimes(1);
      seen[label] = `${lastMail()?.subject} :: ${lastMail()?.html}`;
    }
    expect(new Set(Object.values(seen)).size, 'three states, three notices').toBe(3);
    expect(seen.created).toContain(FRESH_TOKEN);
    expect(seen.already).toContain(EXISTING_TOKEN);
  });

  it('never puts the address in the answer', async () => {
    createServiceClient.mockReturnValue(subscribersClient({ existing: active() }).client);
    const { body } = await observable(await post({ email: KNOWN }));
    expect(body).not.toContain(KNOWN);
    expect(body).not.toContain('already');
    expect(body).not.toContain('token');
  });

  it('does not mail a honeypot submission', async () => {
    createServiceClient.mockReturnValue(subscribersClient({ existing: active() }).client);
    await post({ email: KNOWN, website: 'x' });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('the abuse controls do not become the oracle', () => {
  it('throttles per IP and per address, with the existing helper', async () => {
    createServiceClient.mockReturnValue(subscribersClient({ existing: null }).client);
    await post({ email: UNKNOWN }, '198.51.100.7');

    const keys = enforceRequestRateLimit.mock.calls.map((c) => c[1]);
    expect(keys).toContain('blogsub:198.51.100.7');
    // Without a per-address key, one IP could mail 20 strangers a minute, and
    // rotating IPs lifted the bound entirely.
    expect(keys).toContain(`blogsub:addr:${UNKNOWN}`);
  });

  it('keys the address throttle identically for a known and an unknown address', async () => {
    // If the second key were derived from the row rather than from the
    // submitted string, the limiter itself would answer the question the body
    // no longer does.
    const keysFor = async (existing: Row | null, email: string) => {
      enforceRequestRateLimit.mockClear();
      createServiceClient.mockReturnValue(subscribersClient({ existing }).client);
      await post({ email });
      return enforceRequestRateLimit.mock.calls.map((c) => [c[1], JSON.stringify(c[2])]);
    };
    expect(await keysFor(active(), KNOWN)).toEqual(await keysFor(null, KNOWN));
  });

  it('suppresses the notice without changing the answer when the address is hammered', async () => {
    createServiceClient.mockReturnValue(subscribersClient({ existing: active() }).client);
    const normal = await observable(await post({ email: KNOWN }));

    enforceRequestRateLimit.mockImplementation(async (_c: unknown, key: string) =>
      (String(key).startsWith('blogsub:addr:') ? { ok: false, retryAfter: 42 } : { ok: true }));
    sendEmail.mockClear();
    createServiceClient.mockReturnValue(subscribersClient({ existing: active() }).client);
    const throttled = await observable(await post({ email: KNOWN }));

    expect(throttled, 'a per-address 429 would say how often that address is submitted').toEqual(normal);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('still refuses the request when the IP limit is spent', async () => {
    enforceRequestRateLimit.mockResolvedValue({ ok: false, retryAfter: 30 });
    createServiceClient.mockReturnValue(subscribersClient({ existing: null }).client);

    const res = await post({ email: UNKNOWN });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
  });
});

describe('a uniform answer is not a blanket yes', () => {
  it('reports the same failure whichever write was refused', async () => {
    createServiceClient.mockReturnValue(
      subscribersClient({ existing: unsubscribed(), updateError: { message: 'permission denied' } }).client);
    const onUpdate = await observable(await post({ email: KNOWN }));

    createServiceClient.mockReturnValue(
      subscribersClient({ existing: null, insertError: { message: 'permission denied' } }).client);
    const onInsert = await observable(await post({ email: UNKNOWN }));

    expect(onUpdate.status).toBe(500);
    expect(onUpdate, 'even the failure must not say which row it was looking at').toEqual(onInsert);
    expect(onUpdate.body).not.toBe(ACCEPTED_BODY);
  });

  it('does not read a refused lookup as “no such subscriber”', async () => {
    // Discarding the lookup error sent the handler to the insert, where the
    // unique violation reads as success — an opt-out asking to come back would
    // be told yes over a row still marked unsubscribed.
    const store = subscribersClient({ existing: null, lookupError: { message: 'connection reset' } });
    createServiceClient.mockReturnValue(store.client);

    const res = await post({ email: KNOWN });
    expect(res.status).toBe(500);
    expect(store.writes, 'nothing may be written over a read that failed').toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('treats a racing insert as the subscriber existing, not as an error', async () => {
    createServiceClient.mockReturnValue(
      subscribersClient({ existing: null, insertError: { code: '23505' } }).client);
    expect((await observable(await post({ email: KNOWN }))).body).toBe(ACCEPTED_BODY);
  });

  it('still refuses an address that is not plausibly one', async () => {
    createServiceClient.mockReturnValue(subscribersClient({ existing: null }).client);
    const res = await post({ email: 'not-an-address' });
    expect(res.status).toBe(400);
    // Safe to differ: it is a property of the string the caller just typed,
    // computable without asking us.
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('the shape cannot drift back', () => {
  const code = (path: string) => readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('builds every accepted answer from one frozen literal', () => {
    const source = code(ROUTE);
    expect(source).toMatch(/const ACCEPTED = Object\.freeze\(\{ ok: true \}\);/);
    // Exactly one `ok: true` in the whole handler. Re-adding a branch that
    // answers `{ ok: true, already }` adds a second one.
    expect(source.match(/ok:\s*true/g) ?? []).toHaveLength(1);
    expect(source, 'the row state must not reach the response').not.toMatch(/already:/);
  });

  it('answers the honeypot with that same helper', () => {
    const source = code(ROUTE);
    expect(source).toMatch(/body\.website[\s\S]{0,200}?return accepted\(\);/);
  });

  it('leaves the form with one success message and nothing to branch on', () => {
    const source = code(FORM);
    expect(source, 'the client must not read a field the server must not send').not.toMatch(/\balready\b/);
    expect(source).toMatch(/setMessage\(t\('subscribe\.thanksThatAddressIsOn'\)\)/);
  });

  it('ships that message in the catalogue rather than as a literal', () => {
    const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
    const copy = en['subscribe.thanksThatAddressIsOn'];
    expect(copy, 'the two strings it replaces were hardcoded English').toBeTruthy();
    // It has to stay true of all three states, so it may not promise newness or
    // recognise a returning reader.
    expect(copy).not.toMatch(/already|welcome back|you’re in|you're in/i);
  });
});

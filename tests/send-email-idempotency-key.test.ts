// lib/server/email.ts `sendEmail` accepts an OPTIONAL caller-supplied idempotency
// key and forwards it, unchanged, as Resend's `Idempotency-Key` header.
//
// Resend's documented contract (https://resend.com/docs/dashboard/emails/idempotency-keys,
// "Possible responses", checked 2026-09-30):
//   - the key is 1–256 characters, otherwise 400 `invalid_idempotency_key`;
//   - keys are kept for 24 hours;
//   - the same key with the same payload returns the original response (the
//     same email id) and sends nothing new;
//   - the same key with a different payload is 409 `invalid_idempotent_request`;
//   - a concurrent request with the same key is 409 `concurrent_idempotent_requests`.
//
// What this helper does, and deliberately does not do:
//   - it forwards the CALLER's key. It never generates one, so a caller that
//     retries with the same key sends the same key every time;
//   - it never re-sends on its own account: a 500, a 429, a network error, a
//     timeout are one request and the caller's decision. The one answer it
//     does not take as final is 409 `concurrent_idempotent_requests`: another
//     request under the SAME key is in flight at the provider, and its outcome
//     decides this one's. The helper waits (CONCURRENT_KEY_RETRY_DELAYS_MS, in
//     turn) and asks again with the same key and bytes: folded if the other was
//     accepted, sent if the other failed and freed the key, and
//     `{ ok: false, reason: 'in_progress' }` if it never settled while we waited
//     (review on #946: the mirrored cron tick, where reporting the 409 as a
//     failure left the recipient's delivery to the OTHER request, which could
//     itself fail — nobody sent, nothing retried until the next tick);
//   - it rejects a malformed key BEFORE any network call (and before the
//     no-RESEND_API_KEY skip), so a bad key is a visible bug, not a 400 later;
//   - every other non-2xx is `{ ok: false }` with a reason: 409
//     `invalid_idempotent_request` is `payload_conflict` (this key was used for
//     other bytes; nothing was sent and re-keying is not the answer), anything
//     else `rejected`. A 409 is never evidence that the message was accepted;
//   - without a key, the request is byte-for-byte what it was before, and a 409
//     is not asked again (there is no key for another request to hold).
// Nothing here makes delivery exactly-once: the provider keeps a key for 24 h,
// and a durable per-recipient record is still the caller's job.
//
// Hermetic: global fetch is a stub; nothing is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONCURRENT_KEY_RETRY_DELAYS_MS, sendEmail } from '@/lib/server/email';
import { FROM_EMAIL } from '@/lib/email';

type Seen = { url: string; headers: Record<string, string>; body: string; hasSignal: boolean };
type Mode = 'accept' | 'accept-then-timeout' | 'network-error' | 'concurrent' | 500 | 400 | 409 | 'resend';

let seen: Seen[];
let mode: Mode[];
/** Fake Resend: remembers keys it ACCEPTED, and answers a reused key the way the docs say. */
let accepted: Map<string, { body: string; id: string }>;
let delivered: number;

const RESEND_KEY = 'test-resend-key-not-real';
const saved = process.env.RESEND_API_KEY;
const args = { to: 'someone@example.test', subject: 'Hello', html: '<p>Hi</p>' };

beforeEach(() => {
  seen = []; mode = []; accepted = new Map(); delivered = 0;
  process.env.RESEND_API_KEY = RESEND_KEY;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = String(init?.body);
    seen.push({ url: String(input), headers, body, hasSignal: init?.signal instanceof AbortSignal });
    const m = mode.shift() ?? 'resend';
    const key = headers['idempotency-key'];
    if (m === 'network-error') throw new TypeError('fetch failed');
    // Another request under this key is in flight at the provider.
    if (m === 'concurrent') return new Response(JSON.stringify({ name: 'concurrent_idempotent_requests', message: 'synthetic' }), { status: 409 });
    if (typeof m === 'number') return new Response(JSON.stringify({ name: 'provider_error' }), { status: m });
    // 'resend' and 'accept*': the documented key semantics.
    if (key) {
      const prior = accepted.get(key);
      if (prior && prior.body !== body) return new Response(JSON.stringify({ name: 'invalid_idempotent_request' }), { status: 409 });
      if (prior) return new Response(JSON.stringify({ id: prior.id }), { status: 200 });
    }
    delivered += 1;
    const id = `msg_${delivered}`;
    if (key) accepted.set(key, { body, id });
    if (m === 'accept-then-timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response(JSON.stringify({ id }), { status: 200 });
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved;
});

const expectedBody = JSON.stringify({ from: FROM_EMAIL, to: args.to, subject: args.subject, html: args.html, reply_to: undefined });

describe('sendEmail without a key: unchanged', () => {
  it('sends exactly the request it always sent, with no Idempotency-Key header', async () => {
    await expect(sendEmail(args)).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://api.resend.com/emails');
    expect(seen[0].headers).toEqual({ authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' });
    expect(seen[0].body).toBe(expectedBody);
    expect(seen[0].hasSignal).toBe(true);
  });

  it('with no RESEND_API_KEY it still skips without a request', async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendEmail(args)).resolves.toEqual({ ok: true, skipped: true });
    expect(seen).toHaveLength(0);
  });
});

describe('sendEmail with a caller-supplied key', () => {
  it('forwards the key verbatim as Idempotency-Key, and the payload is unchanged by it', async () => {
    const key = 'admin-digest/2026-09-30T12:30:00.000Z/someone@example.test';
    await expect(sendEmail({ ...args, idempotencyKey: key })).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers).toEqual({ authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json', 'idempotency-key': key });
    expect(seen[0].body).toBe(expectedBody);
  });

  it('a caller retry after a 500 sends the SAME key and payload; each call makes exactly one request', async () => {
    const key = 'retry/1';
    mode = [500];
    await expect(sendEmail({ ...args, idempotencyKey: key })).resolves.toEqual({ ok: false, reason: 'rejected' });
    expect(seen).toHaveLength(1); // no automatic retry inside the helper
    await expect(sendEmail({ ...args, idempotencyKey: key })).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.headers['idempotency-key'])).toEqual([key, key]);
    expect(seen[1].body).toBe(seen[0].body);
  });

  it('accepted, then the client timed out: the call rejects, the caller retries with the same key and payload, and the fake provider folds it (one message)', async () => {
    const key = 'ambiguous/1';
    mode = ['accept-then-timeout'];
    await expect(sendEmail({ ...args, idempotencyKey: key })).rejects.toThrow(/timeout/i);
    expect(seen).toHaveLength(1);
    await expect(sendEmail({ ...args, idempotencyKey: key })).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(seen[1].headers['idempotency-key']).toBe(seen[0].headers['idempotency-key']);
    expect(seen[1].body).toBe(seen[0].body);
    expect(delivered).toBe(1); // the FAKE provider's count; not a claim about real delivery
  });

  it('the same retry WITHOUT a key is a second message at the fake provider (why the key exists)', async () => {
    mode = ['accept-then-timeout'];
    await expect(sendEmail(args)).rejects.toThrow(/timeout/i);
    await expect(sendEmail(args)).resolves.toEqual({ ok: true });
    expect(delivered).toBe(2);
  });

  it('a network error rejects after exactly one request; the helper does not retry', async () => {
    mode = ['network-error'];
    await expect(sendEmail({ ...args, idempotencyKey: 'net/1' })).rejects.toThrow(/fetch failed/);
    expect(seen).toHaveLength(1);
  });

  it('every other non-2xx is { ok: false } with its reason, and a 409 is never treated as accepted', async () => {
    // 409 invalid_idempotent_request: the same key with a different payload. Nothing to wait for; asked once.
    await expect(sendEmail({ ...args, idempotencyKey: 'conflict/1' })).resolves.toEqual({ ok: true });
    await expect(sendEmail({ ...args, html: '<p>Changed</p>', idempotencyKey: 'conflict/1' })).resolves.toEqual({ ok: false, reason: 'payload_conflict' });
    // A 409 of another name, a 400 invalid_idempotency_key: rejected, asked once.
    mode = [409, 400];
    await expect(sendEmail({ ...args, idempotencyKey: 'other/1' })).resolves.toEqual({ ok: false, reason: 'rejected' });
    await expect(sendEmail({ ...args, idempotencyKey: 'bad/1' })).resolves.toEqual({ ok: false, reason: 'rejected' });
    expect(seen).toHaveLength(4);
  });

  describe('409 concurrent_idempotent_requests: another request under this key is in flight (review on #946)', () => {
    // Fake timers for the waits, so the schedule is asserted, not slept through.
    const key = 'admin-digest/occurrence-1/someone';
    const asking = (p: Promise<unknown>) => { p.catch(() => {}); return p; };

    it('waits, asks again with the same key and bytes, and is folded once the other request was accepted', async () => {
      vi.useFakeTimers();
      // The other request is accepted between our first ask and our second.
      mode = ['concurrent'];
      const p = asking(sendEmail({ ...args, idempotencyKey: key }));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toHaveLength(1);
      accepted.set(key, { body: seen[0].body, id: 'msg_other' }); // the other request settled: accepted
      await vi.advanceTimersByTimeAsync(CONCURRENT_KEY_RETRY_DELAYS_MS[0] - 1);
      expect(seen, 'not before the first wait is up').toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toEqual({ ok: true });
      expect(seen).toHaveLength(2);
      expect(seen[1].headers['idempotency-key']).toBe(key);
      expect(seen[1].body).toBe(seen[0].body);
      expect(delivered, 'folded onto the other request: nothing sent by this one').toBe(0);
    });

    it('is SENT on the second ask when the other request failed and freed the key — the recipient is not left to a later tick', async () => {
      vi.useFakeTimers();
      mode = ['concurrent']; // the other request then fails: no key is stored, so our second ask is a plain send
      const p = asking(sendEmail({ ...args, idempotencyKey: key }));
      await vi.advanceTimersByTimeAsync(CONCURRENT_KEY_RETRY_DELAYS_MS[0]);
      await expect(p).resolves.toEqual({ ok: true });
      expect(seen).toHaveLength(2);
      expect(delivered).toBe(1);
      expect(accepted.get(key)?.body).toBe(seen[0].body);
    });

    it('asks once per wait in the schedule and then gives up as in_progress, never re-keying and never sending', async () => {
      vi.useFakeTimers();
      mode = Array<Mode>(CONCURRENT_KEY_RETRY_DELAYS_MS.length + 1).fill('concurrent');
      const p = asking(sendEmail({ ...args, idempotencyKey: key }));
      await vi.advanceTimersByTimeAsync(0);
      let asks = 1;
      for (const wait of CONCURRENT_KEY_RETRY_DELAYS_MS) {
        expect(seen).toHaveLength(asks);
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(seen, `no ask before the ${wait} ms wait is up`).toHaveLength(asks);
        await vi.advanceTimersByTimeAsync(1);
        asks += 1;
        expect(seen).toHaveLength(asks);
      }
      await expect(p).resolves.toEqual({ ok: false, reason: 'in_progress' });
      expect(seen).toHaveLength(CONCURRENT_KEY_RETRY_DELAYS_MS.length + 1);
      expect(new Set(seen.map((x) => x.headers['idempotency-key']))).toEqual(new Set([key]));
      expect(new Set(seen.map((x) => x.body)).size).toBe(1);
      expect(delivered).toBe(0);
    });

    it('is bounded to about four seconds in all, inside a scheduler tick\'s deadline', () => {
      expect(CONCURRENT_KEY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4_000);
      expect(CONCURRENT_KEY_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
    });

    it('without a key a 409 of that name is asked once and rejected: there is no key for another request to hold', async () => {
      vi.useFakeTimers();
      mode = ['concurrent'];
      const p = asking(sendEmail(args));
      await vi.advanceTimersByTimeAsync(CONCURRENT_KEY_RETRY_DELAYS_MS[0]);
      await expect(p).resolves.toEqual({ ok: false, reason: 'rejected' });
      expect(seen).toHaveLength(1);
    });
  });

  it('accepts keys of 1 and of 256 characters, sent verbatim', async () => {
    const long = 'k'.repeat(256);
    await sendEmail({ ...args, idempotencyKey: 'k' });
    await sendEmail({ ...args, idempotencyKey: long });
    expect(seen.map((s) => s.headers['idempotency-key'])).toEqual(['k', long]);
  });
});

describe('sendEmail rejects a malformed key before any network call', () => {
  const bad: [string, unknown][] = [
    ['empty', ''],
    ['257 characters', 'k'.repeat(257)],
    ['leading space', ' key'],
    ['trailing space', 'key '],
    ['newline', 'a\nb'],
    ['carriage return', 'a\rb'],
    ['tab', 'a\tb'],
    ['NUL', 'a\u0000b'],
    ['non-ASCII letters', 'ключ'],
    ['emoji', 'key-🔑'],
    ['a number', 123],
    ['null', null],
  ];
  for (const [label, key] of bad) {
    it(`rejects ${label}, and sends nothing`, async () => {
      await expect(sendEmail({ ...args, idempotencyKey: key as string })).rejects.toThrow(/idempotencyKey/);
      expect(seen).toHaveLength(0);
    });
  }

  it('rejects a malformed key even when email is disabled (no RESEND_API_KEY)', async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendEmail({ ...args, idempotencyKey: 'a\nb' })).rejects.toThrow(/idempotencyKey/);
    expect(seen).toHaveLength(0);
  });
});

// The two pieces the route adds around the delivery engine, tested alone:
//   - which occurrence a request belongs to (the owner's decided policy; see
//     docs/admin-digest-route-integration.md §2), and how the recipient list is
//     normalised before the engine sees it;
//   - the Resend adapter: stored bytes verbatim under the stored key, the engine's
//     abort signal honoured, and every answer classified by the tested classifier.
// Synthetic only: fetch is a stub, nothing is sent.
import { describe, expect, it, vi } from 'vitest';
import { freezePlan } from '@/lib/admin/digest-delivery';
import { ADMIN_DIGEST_SCHEDULE, adminDigestSlot, normalizeDigestRecipients } from '@/lib/admin/digest-occurrence';
import { RESEND_EMAILS_ENDPOINT, createResendDigestProvider } from '@/lib/admin/digest-provider';
import { contractPlan } from './helpers/digest-delivery-store-contract';

describe('the occurrence a request belongs to (decided policy)', () => {
  it('matches the schedule in vercel.json and the GitHub dispatcher', async () => {
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync('vercel.json', 'utf8')).crons.find((c: { path: string }) => c.path === '/api/cron/admin-digest').schedule)
      .toBe(`${ADMIN_DIGEST_SCHEDULE.minuteUtc} ${ADMIN_DIGEST_SCHEDULE.hourUtc} * * *`);
    expect(readFileSync('scripts/cron-dispatch.mjs', 'utf8')).toContain(`'/api/cron/admin-digest': '${ADMIN_DIGEST_SCHEDULE.minuteUtc} ${ADMIN_DIGEST_SCHEDULE.hourUtc} * * *'`);
  });

  it('every tick for one slot names the same occurrence: on time, late, and just before the next slot', () => {
    const ids = ['2026-09-30T12:30:00.000Z', '2026-09-30T12:31:07.000Z', '2026-09-30T18:48:37.869Z', '2026-10-01T12:29:59.999Z']
      .map((t) => adminDigestSlot(new Date(t)));
    expect(new Set(ids.map((s) => s.occurrenceId))).toEqual(new Set(['admin-digest:2026-09-30T12:30:00.000Z']));
    expect(ids[0].window).toEqual({ start: '2026-09-29T12:30:00.000Z', end: '2026-09-30T12:30:00.000Z' });
  });

  it('the next slot is a new occurrence whose window starts where the last one ended', () => {
    const a = adminDigestSlot(new Date('2026-09-30T12:31:00Z'));
    const b = adminDigestSlot(new Date('2026-10-01T12:30:00Z'));
    expect(b.occurrenceId).toBe('admin-digest:2026-10-01T12:30:00.000Z');
    expect(b.window.start).toBe(a.window.end);
  });

  it('crosses month and year boundaries in UTC', () => {
    expect(adminDigestSlot(new Date('2027-01-01T00:05:00Z')).occurrenceId).toBe('admin-digest:2026-12-31T12:30:00.000Z');
    expect(adminDigestSlot(new Date('2026-03-01T01:00:00Z')).window).toEqual({ start: '2026-02-27T12:30:00.000Z', end: '2026-02-28T12:30:00.000Z' });
  });

  it('refuses an invalid clock', () => {
    expect(() => adminDigestSlot(new Date(Number.NaN))).toThrow(TypeError);
  });

  it('its occurrence and window are accepted by the engine', () => {
    const s = adminDigestSlot(new Date('2026-09-30T12:31:00Z'));
    expect(() => freezePlan(contractPlan({ occurrenceId: s.occurrenceId, window: s.window }), new Date('2026-09-30T12:31:00Z'))).not.toThrow();
  });
});

describe('recipient normalisation before the engine', () => {
  it('trims, lowercases and de-duplicates what readSuperAdminRecipients returns (it lowercases but does not trim)', () => {
    expect(normalizeDigestRecipients(['admin-one@example.test', ' admin-one@example.test ', 'Admin-Two@Example.test', 'admin-two@example.test']))
      .toEqual(['admin-one@example.test', 'admin-two@example.test']);
  });

  it('drops nothing: an address the engine cannot use still reaches it, and is refused there', () => {
    expect(normalizeDigestRecipients(['Ops <ops@example.test>', 'admin-one@example.test'])).toEqual(['ops <ops@example.test>', 'admin-one@example.test']);
  });
});

describe('the Resend adapter', () => {
  const request = () => {
    const { deliveries } = freezePlan(contractPlan({ recipients: ['admin-one@example.test'] }), new Date('2026-09-30T12:31:00Z'));
    const d = deliveries[0];
    return { idempotencyKey: d.idempotencyKey, payload: d.payload, payloadJson: d.payloadJson, signal: new AbortController().signal };
  };
  const answering = (status: number, body: unknown, raw?: string) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(raw ?? JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { provider: createResendDigestProvider({ apiKey: 're_synthetic_not_real', fetchImpl }), calls };
  };

  it('posts the stored bytes verbatim, under the stored key, with the engine\'s abort signal', async () => {
    const { provider, calls } = answering(200, { id: 'msg-1' });
    const req = request();
    expect(await provider.send(req)).toEqual({ kind: 'accepted', messageId: 'msg-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESEND_EMAILS_ENDPOINT);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(req.payloadJson);
    expect(calls[0].init.signal).toBe(req.signal);
    const h = new Headers(calls[0].init.headers);
    expect(h.get('idempotency-key')).toBe(req.idempotencyKey);
    expect(h.get('authorization')).toBe('Bearer re_synthetic_not_real');
    expect(h.get('content-type')).toBe('application/json');
  });

  it.each<[string, number, unknown, unknown]>([
    ['a 2xx without an id is not a receipt', 200, {}, { kind: 'unknown', reason: 'unreadable_response' }],
    ['a payload conflict is never a receipt', 409, { name: 'invalid_idempotent_request' }, { kind: 'payload_conflict' }],
    ['a concurrent request under the key is in progress', 409, { name: 'concurrent_idempotent_requests' }, { kind: 'in_progress' }],
    ['a rate limit is a retryable refusal', 429, { name: 'rate_limit_exceeded' }, { kind: 'rejected', httpStatus: 429, code: 'rate_limit_exceeded', retryable: true }],
    ['a validation error is a final refusal', 422, { name: 'validation_error' }, { kind: 'rejected', httpStatus: 422, code: 'validation_error', retryable: false }],
    ['a 5xx settles nothing', 500, { name: 'internal_server_error' }, { kind: 'unknown', reason: 'server_error' }],
  ])('%s', async (_n, status, body, expected) => {
    expect(await answering(status, body).provider.send(request())).toEqual(expected);
  });

  it('an unreadable body is classified by status alone, and a 2xx one is never a receipt', async () => {
    expect(await answering(200, null, '<html>not json').provider.send(request())).toEqual({ kind: 'unknown', reason: 'unreadable_response' });
    expect(await answering(429, null, 'not json').provider.send(request())).toMatchObject({ kind: 'rejected', retryable: true });
  });

  it('an oversized answer is not read into memory, and a 2xx one is still no receipt', async () => {
    expect(await answering(200, null, JSON.stringify({ id: 'msg-1', pad: 'x'.repeat(70 * 1024) })).provider.send(request())).toEqual({ kind: 'unknown', reason: 'unreadable_response' });
  });

  describe('an answer the adapter will not read is released, not left open (review P2)', () => {
    // A native stream that never ends, so nothing but an explicit cancel can release it.
    const unending = (declaredLength?: number) => {
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode('{"id":"msg-1","pad":"')); },
        pull() { /* never closes */ },
        cancel() { cancelled += 1; },
      });
      const headers = declaredLength === undefined ? undefined : { 'content-length': String(declaredLength) };
      return { body, headers, cancelled: () => cancelled };
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it.each([200, 500])('a %s whose declared length exceeds the bound: unknown, and the body is cancelled once', async (status) => {
      const u = unending(64 * 1024 + 1);
      const fetchImpl = vi.fn(async () => new Response(u.body, { status, headers: u.headers })) as unknown as typeof fetch;
      expect(await createResendDigestProvider({ apiKey: 'k', fetchImpl }).send(request())).toEqual({ kind: 'unknown', reason: status === 200 ? 'unreadable_response' : 'server_error' });
      await tick();
      expect(u.cancelled()).toBe(1);
    });

    it('control: a body that overflows while streaming is cancelled once (by the bounded reader), not twice', async () => {
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) { c.enqueue(new Uint8Array(16 * 1024).fill(0x61)); },
        cancel() { cancelled += 1; },
      });
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
      expect(await createResendDigestProvider({ apiKey: 'k', fetchImpl }).send(request())).toEqual({ kind: 'unknown', reason: 'unreadable_response' });
      await tick();
      expect(cancelled).toBe(1);
    });
  });

  it('a network failure or an abort propagates, which the engine records as unknown', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(createResendDigestProvider({ apiKey: 'k', fetchImpl }).send(request())).rejects.toThrow('fetch failed');
  });

  it('refuses to exist without an API key', () => {
    expect(() => createResendDigestProvider({ apiKey: '' })).toThrow(TypeError);
    expect(() => createResendDigestProvider({ apiKey: '   ' })).toThrow(TypeError);
  });
});

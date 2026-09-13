// A Guardian callback must be able to tell a duplicate from an outage.
//
// `claimGuardianCallback` used to answer a boolean, and that one bit carried two
// answers that call for opposite responses: "someone else has this" and "the
// claim could not be written". Every caller read the false as the first and
// answered the provider 200 — and Twilio does not retry a 200, so a brief
// database outage silently discarded emergency escalations, inbound messages and
// voicemail notifications. On the voice and screening routes it hung up on a
// live caller while doing it.
//
// The audit reproduced this against a real signed Guardian POST on an installed
// PostgREST: claim 503, profile 503 and communication 503 each answered 200 with
// nothing saved.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { claimGuardianCallback } from '@/lib/guardian/callbacks';

type Result = { data?: unknown; error?: { code?: string; message: string } | null };

/** A client whose insert and reclaim-update answers are scripted per call. */
function client(insert: Result, reclaim: Result = { data: null, error: null }) {
  const calls: string[] = [];
  const from = () => {
    let op = 'select';
    const q: Record<string, unknown> = {
      insert: () => { op = 'insert'; calls.push('insert'); return Promise.resolve(insert); },
      update: () => { op = 'update'; calls.push('update'); return q; },
      eq: () => q, in: () => q, lt: () => q, select: () => q,
      maybeSingle: () => Promise.resolve(op === 'update' ? reclaim : { data: null, error: null }),
    };
    return q;
  };
  return { client: { from } as unknown as Parameters<typeof claimGuardianCallback>[0], calls };
}

const EVENT = 'SM00000000000000000000000000000001';

describe('claimGuardianCallback says which of the two things happened', () => {
  it('claims a first-seen event', async () => {
    const { client: c } = client({ error: null });
    expect(await claimGuardianCallback(c, 'inbound_sms', EVENT)).toBe('claimed');
  });

  it('reports a storage failure as unavailable, never as settled', async () => {
    // The whole defect in one assertion. A 'settled' here becomes a 200, and the
    // provider never comes back.
    const { client: c } = client({ error: { code: '42501', message: 'permission denied' } });
    expect(await claimGuardianCallback(c, 'emergency_escalation', EVENT)).toBe('unavailable');
  });

  it('treats only a unique violation as somebody else already having it', async () => {
    const { client: c } = client({ error: { code: '23505', message: 'duplicate key' } });
    expect(await claimGuardianCallback(c, 'inbound_sms', EVENT)).toBe('settled');
  });

  it('reclaims a stale claim abandoned by a crashed worker', async () => {
    const { client: c } = client(
      { error: { code: '23505', message: 'duplicate key' } },
      { data: { event_id: EVENT }, error: null },
    );
    expect(await claimGuardianCallback(c, 'inbound_voice', EVENT)).toBe('claimed');
  });

  it('reports a failed reclaim as unavailable rather than as another worker', async () => {
    // The same mistake one level down: this branch used to destructure only
    // `data` and throw the error away.
    const { client: c } = client(
      { error: { code: '23505', message: 'duplicate key' } },
      { data: null, error: { code: '08006', message: 'connection failure' } },
    );
    expect(await claimGuardianCallback(c, 'inbound_voice', EVENT)).toBe('unavailable');
  });

  it('settles a malformed id without asking the provider to retry', async () => {
    // A retry cannot make an id well-formed, so stopping is right here.
    const { client: c, calls } = client({ error: null });
    expect(await claimGuardianCallback(c, 'inbound_sms', 'sid with spaces')).toBe('settled');
    expect(calls, 'and it never reaches storage').toEqual([]);
  });
});

describe('every Guardian callback route acts on the distinction', () => {
  const routes = [
    'app/api/guardian/escalate/route.ts',
    'app/api/guardian/inbound/sms/route.ts',
    'app/api/guardian/inbound/whatsapp/route.ts',
    'app/api/guardian/inbound/voice/route.ts',
    'app/api/guardian/screen/route.ts',
    'app/api/guardian/status/voicemail/route.ts',
  ];

  it.each(routes)('%s asks for a retry when the claim is unavailable', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(source, 'a truthiness check passes for every outcome now').not.toMatch(/if \(!(eventClaimed|claimed)\)/);
    expect(source).toContain("=== 'unavailable'");
    expect(source).toContain('503');
    expect(source, 'and still acknowledges a settled one').toContain("!== 'claimed'");
  });
});

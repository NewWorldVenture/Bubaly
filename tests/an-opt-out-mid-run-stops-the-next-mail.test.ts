// An opt-out that lands DURING an automation run stops the rest of that run.
//
// runSteps used to read the opt-out once per run (`consent ??= …`) and reuse
// that answer for every later send_email step. A reader who unsubscribed while
// the first mail was in flight still got the second, and an unsubscribe that
// landed while a public form's send admission was being decided was ignored for
// the send that admission let through. Review on #1028 (consent staleness).
//
// The opt-out is now read for every send, and read again right before the
// provider is called whenever an admission was awaited. Driven through the real
// runSteps over an in-memory ledger; only the provider is fake.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  onSend: null as null | (() => void),
}));

vi.mock('@/lib/email', () => ({
  getResend: () => ({
    emails: {
      send: async (message: Record<string, unknown>) => {
        h.sent.push(message);
        h.onSend?.();
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  APP_URL: 'https://bubaly.test',
}));

const READER = 'reader@example.com';
const TWO_SENDS = [{ action: 'send_email' }, { action: 'send_email' }];
const FALLBACK = { subject: 'Hello', body: 'A note from Bubaly.' };

let db: InMemorySupabase;
const optOut = () => db.seed('marketing_suppressions', [{ email: READER, reason: 'unsubscribe' }]);

async function run(steps = TWO_SENDS, admit?: () => Promise<boolean>, client: unknown = db) {
  const { runSteps } = await import('@/lib/marketing/automation-steps');
  return runSteps(steps, { email: READER, name: 'Ana' }, FALLBACK, client as never, admit);
}

beforeEach(() => {
  vi.stubEnv('INTERNAL_SECRET', 'opt-out-mid-run-fixture');
  h.sent = [];
  h.onSend = null;
  db = createInMemorySupabase();
});

describe('an opt-out that lands mid-run stops the rest of the run', () => {
  it('a reader who unsubscribes while the first mail is in flight does not get the second', async () => {
    h.onSend = () => { if (h.sent.length === 1) optOut(); };
    expect(await run()).toEqual(['send_email', 'send_email:suppressed']);
    expect(h.sent).toHaveLength(1);
  });

  it('an opt-out committed while the send admission is decided stops that send', async () => {
    const admit = async () => { optOut(); return true; };
    expect(await run([{ action: 'send_email' }], admit)).toEqual(['send_email:suppressed']);
    expect(h.sent).toEqual([]);
  });

  it('an inbox already opted out never spends its admission (positive control)', async () => {
    optOut();
    const admit = vi.fn(async () => true);
    expect(await run(TWO_SENDS, admit)).toEqual(['send_email:suppressed', 'send_email:suppressed']);
    expect(admit).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it('a reader who did not opt out gets every step (positive control)', async () => {
    expect(await run()).toEqual(['send_email', 'send_email']);
    expect(h.sent).toHaveLength(2);
  });

  it('fails closed when the opt-out cannot be read after the admission', async () => {
    let reads = 0;
    const faulty = withFaults(db, (table) => {
      if (table !== 'marketing_suppressions') return null;
      reads += 1;
      // The reads before admission (exact, then the spelling scan) succeed;
      // every read after it fails.
      return reads > 2 ? { message: 'statement timeout' } : null;
    });
    expect(await run([{ action: 'send_email' }], async () => true, faulty)).toEqual(['send_email:failed']);
    expect(h.sent, 'an opt-out that could not be read is still an opt-out').toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `sendReactEmail` answers `{ ok }` — always. Every caller is built on that:
// the weekly digest counts a failure per family and moves on, onboarding logs
// and continues. The Resend SDK reports a rejected address through `{ error }`
// but can also THROW (a network failure, or a malformed API key, which surfaces
// from inside the client as a bare TypeError). That exception used to escape,
// and /api/cron/weekly-digest answered 500 part-way through a run, abandoning
// every family after the first.
const send = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));

const ORIGINAL_KEY = process.env.RESEND_API_KEY;

async function freshModule() {
  // The module memoises its client, so each case needs its own instance.
  vi.resetModules();
  return import('@/lib/email');
}

beforeEach(() => {
  send.mockReset();
  process.env.RESEND_API_KEY = 're_test_key';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

const args = { to: 'someone@example.test', subject: 'Hello', react: null as never };

describe('sendReactEmail always answers { ok }', () => {
  it('reports success', async () => {
    send.mockResolvedValue({ error: null });
    const { sendReactEmail } = await freshModule();
    await expect(sendReactEmail(args)).resolves.toEqual({ ok: true });
  });

  it('reports a rejected address without throwing', async () => {
    send.mockResolvedValue({ error: { message: 'Invalid `to` field' } });
    const { sendReactEmail } = await freshModule();
    await expect(sendReactEmail(args)).resolves.toEqual({ ok: false });
  });

  it('does not let a thrown provider error escape', async () => {
    // The exact shape observed with a placeholder API key.
    send.mockRejectedValue(new TypeError('b is not a function'));
    const { sendReactEmail } = await freshModule();
    await expect(sendReactEmail(args)).resolves.toEqual({ ok: false });
    expect(console.error).toHaveBeenCalled();
  });

  it('does not let a network failure escape either', async () => {
    send.mockRejectedValue(new Error('fetch failed'));
    const { sendReactEmail } = await freshModule();
    await expect(sendReactEmail(args)).resolves.toEqual({ ok: false });
  });

  it('skips cleanly when no key is configured', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendReactEmail } = await freshModule();
    await expect(sendReactEmail(args)).resolves.toEqual({ ok: true, skipped: true });
    expect(send).not.toHaveBeenCalled();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Audit C1-S9-13 — a capability that exists and is never called.
 *
 * Long-running cron drains run under a `maxDuration`. When the platform reaches
 * it the invocation is killed; whether that is survivable depends on whether the
 * work was cancelled cooperatively or simply severed. Each of these drains wires
 * an `AbortSignal` through to every database call it makes, so a cancelled run
 * aborts in a state its receipt machine can record.
 *
 * `guardian-sms-recovery` passed `req.signal`. `social-publish` did not, though
 * `runScheduledPublishDrain` accepts one and threads it through every query —
 * the same shape as the push SSRF helper in C1-S9-01, where the control existed,
 * was exported, and nothing called it.
 *
 * This pins the rule for both directions: a drain that ACCEPTS a signal must be
 * GIVEN one.
 */
const drains = [
  {
    route: 'app/api/cron/social-publish/route.ts',
    lib: 'lib/social/scheduled-publish.ts',
    fn: 'runScheduledPublishDrain',
  },
  {
    route: 'app/api/cron/guardian-sms-recovery/route.ts',
    lib: 'lib/guardian/sms-recovery.ts',
    fn: 'drainGuardianSmsReceipts',
  },
] as const;

describe('a drain that can be cancelled is given the request signal (C1-S9-13)', () => {
  it.each(drains)('$fn accepts a signal and its cron route passes one', ({ route, lib, fn }) => {
    const source = readFileSync(lib, 'utf8');
    const decl = source.slice(source.indexOf(`export async function ${fn}`));
    // The signature, not the body. Cutting at the first `{` would stop at the
    // options object's own brace — before the parameter being asserted — and
    // fail against code that is correct, which is how a guard teaches the next
    // reader to delete it. The signature ends at the line's newline.
    const head = decl.slice(0, decl.indexOf('\n'));
    expect(head, `${fn} should accept an AbortSignal`).toContain('signal?: AbortSignal');

    const caller = readFileSync(route, 'utf8');
    expect(caller).toContain(`${fn}(`);
    // The call must carry the request's signal, not just mention it.
    //
    // Bounded to the call STATEMENT, ending at its semicolon. An earlier
    // version cut at the first `)`, which closes `createServiceClient()` in the
    // argument list and failed against a route that was already correct — the
    // same wrong-slice-bound class as C1-S9-07, written into the guard for
    // C1-S9-13 while C1-S9-07's ink was still wet. The lesson takes more than
    // one telling.
    const from = caller.indexOf(`await ${fn}(`);
    expect(from, `${route} must call ${fn}`).toBeGreaterThan(-1);
    const call = caller.slice(from, caller.indexOf(';', from) + 1);
    expect(
      /signal:\s*req\.signal/.test(call),
      `${route} must pass req.signal into ${fn}`,
    ).toBe(true);
  });

  it.each(drains)('$fn threads the signal into its database calls', ({ lib }) => {
    // A signal accepted and then dropped on the floor would satisfy the check
    // above while cancelling nothing.
    expect(readFileSync(lib, 'utf8')).toContain('abortSignal(');
  });
});

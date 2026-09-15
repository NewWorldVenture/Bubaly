// One shape, found a fourth, fifth and sixth time: a write whose result is
// discarded, followed by something that claims it happened.
//
// The earlier instances are already fixed and guarded — the Guardian escalation
// writing push_sent = true after an insert nobody checked
// (tests/audit-write-failures-are-visible.test.ts), and the sync disconnect
// redirecting to "Account disconnected and access revoked" after a delete nobody
// checked (tests/sync-write-failures-are-visible.test.ts). These three are the
// same thing in three more places:
//
//   lib/server/push.ts          `result.pruned++` ran after a delete whose error
//                               was discarded, so a dead endpoint that could not
//                               be removed was counted as pruned — and being
//                               undeletable means it is retried on every future
//                               notification, reporting itself cleaned up again
//                               each time.
//   lib/trust/server.ts         the comment said "always recorded" and the insert
//                               discarded its result. That table is what
//                               dashboard/trust renders and what
//                               api/privacy/export cites, so a lost row is a
//                               decision the family cannot see.
//   lib/stripe/webhook.ts       a card approve/decline was recorded "best-effort"
//                               and silently. Best-effort is correct there —
//                               Stripe has already been told and a retry would
//                               re-decide a decided authorization — but silence
//                               is not, because the admin page and the assistant
//                               both answer "why was it declined" from those rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ send: vi.fn(), setVapid: vi.fn() }));
vi.mock('web-push', () => ({
  default: { sendNotification: mocks.send, setVapidDetails: mocks.setVapid },
}));

type DeleteOutcome = { error: { code: string; message: string } | null };

/** A client that serves one web-push device and fails (or not) on delete. */
function pushClient(outcome: DeleteOutcome) {
  const deletes: string[] = [];
  const device = {
    id: 'device-1', platform: 'web', provider: 'webpush',
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'p'.repeat(20), auth: 'a'.repeat(20), token: null,
  };
  const client = {
    from: () => {
      const b: Record<string, unknown> = {};
      let mode: 'select' | 'delete' = 'select';
      Object.assign(b, {
        select: () => { mode = 'select'; return b; },
        delete: () => { mode = 'delete'; return b; },
        eq: (col: string, v: unknown) => { if (mode === 'delete' && col === 'id') deletes.push(String(v)); return b; },
        then: (resolve: (v: unknown) => void) =>
          resolve(mode === 'delete' ? { data: null, ...outcome } : { data: [device], error: null }),
      });
      return b;
    },
  };
  return { client, deletes };
}

let logged: unknown[][];
beforeEach(() => {
  logged = [];
  vi.resetModules();
  mocks.send.mockReset();
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'BPublicKeyForTestsOnly');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'PrivateKeyForTestsOnly');
  vi.stubEnv('VAPID_SUBJECT', 'mailto:test@bubaly.test');
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('a dead push device is only counted as pruned when it was pruned', () => {
  /** web-push signals a gone subscription with 404/410 — the prune trigger. */
  const gone = Object.assign(new Error('Gone'), { statusCode: 410 });

  it('counts a failure, not a prune, when the delete is refused', async () => {
    const { client, deletes } = pushClient({ error: { code: '42501', message: 'permission denied' } });
    mocks.send.mockRejectedValue(gone);
    const { sendPushToUser } = await import('@/lib/server/push');

    const result = await sendPushToUser(client as never, 'user-1', { title: 'Dinner in 10' });

    // It did try to remove the row.
    expect(deletes).toEqual(['device-1']);
    expect(result.pruned, 'counted a device as pruned while its row stayed').toBe(0);
    expect(result.failed).toBe(1);
    expect(logged.length, 'a refused prune produced no output at all').toBeGreaterThan(0);
    expect(String(logged[0][0])).toContain('[push]');
  });

  it('counts a prune when the delete lands', async () => {
    const { client, deletes } = pushClient({ error: null });
    mocks.send.mockRejectedValue(gone);
    const { sendPushToUser } = await import('@/lib/server/push');

    const result = await sendPushToUser(client as never, 'user-1', { title: 'Dinner in 10' });

    expect(deletes).toEqual(['device-1']);
    expect(result.pruned).toBe(1);
    expect(result.failed).toBe(0);
    expect(logged).toEqual([]);
  });

  it('does not prune on a failure that is not 404/410', async () => {
    const { client, deletes } = pushClient({ error: null });
    mocks.send.mockRejectedValue(Object.assign(new Error('Server error'), { statusCode: 500 }));
    const { sendPushToUser } = await import('@/lib/server/push');

    const result = await sendPushToUser(client as never, 'user-1', { title: 'Dinner in 10' });

    // A transient provider error is not evidence the subscription is gone, so
    // the row must survive for the next attempt.
    expect(deletes, 'deleted a device over a transient provider error').toEqual([]);
    expect(result).toMatchObject({ pruned: 0, failed: 1 });
  });
});

// evaluateTrust and the Stripe issuing webhook both need a great deal of fixture
// to drive end to end, and what went wrong in each is a single line. These assert
// that line, and each is proved load-bearing by reverting it.
describe('the trust decision and the card decision are recorded audibly', () => {
  it('lib/trust/server.ts reads its audit insert and says what was lost', () => {
    const source = readFileSync('lib/trust/server.ts', 'utf8');
    expect(source).toMatch(/const \{ error: auditError \} = await writer\.from\('trust_audit_logs'\)\.insert/);
    expect(source).toMatch(/if \(auditError\)[\s\S]{0,200}console\.error\(/);
    // The message has to name the decision, or the log cannot be matched back to
    // the row that is missing from the family's Trust Center.
    expect(source).toMatch(/decision was made but not recorded/);
    expect(source).toMatch(/decision: decision\.effect/);
    // And it must NOT throw: callers act on the returned decision, and refusing
    // one because its explanation failed to log would take the AI layer down,
    // denials included.
    const block = source.slice(source.indexOf('if (auditError)'));
    expect(block.slice(0, block.indexOf('\n  }')), 'a failed audit row must not fail the decision')
      .not.toContain('throw');
    // The comment that used to promise this can never fail has to be gone.
    expect(source).not.toContain('Explainable audit trail — always recorded.');
  });

  it('lib/stripe/webhook.ts reads its authorization insert without failing the webhook', () => {
    const source = readFileSync('lib/stripe/webhook.ts', 'utf8');
    expect(source).toMatch(/const \{ error: auditError \} = await supabase\.from\('stripe_authorizations'\)\.insert/);
    expect(source).toMatch(/if \(auditError\)[\s\S]{0,300}console\.error\(/);
    expect(source).toMatch(/was decided but not recorded/);
    // It has to record WHICH authorization, since the whole value of the row is
    // answering "why was this one declined".
    expect(source).toMatch(/authorizationId: auth\.id/);
    const block = source.slice(source.indexOf('if (auditError)'));
    expect(block.slice(0, block.indexOf('\n  }')), 'throwing here makes Stripe re-decide a decided authorization')
      .not.toContain('throw');
  });
});

// The guard. Scoped to the tables whose readers are established above rather than
// to every table in the schema: a sweep nobody can justify line by line is one
// that gets an exemption added instead of a fix.
describe('no claimed write discards its result', () => {
  const WATCHED: Record<string, string> = {
    marketing_suppressions: 'send.ts excludes an address only by finding its row',
    trust_audit_logs: 'dashboard/trust and api/privacy/export are answered from it',
    stripe_authorizations: 'the admin page and the assistant explain declines from it',
    push_devices: 'an unpruned dead endpoint is retried on every later notification',
    // The seventh through thirteenth instances of the same shape. Each of these
    // sat inside a try/catch whose message named this very write — and a
    // PostgREST call RESOLVES with { data, error }, rejecting only under
    // .throwOnError(), so those catches saw a client that could not be built and
    // nothing else. The handler existed and could not fire.
    feedback_ideas: 'it is the only record that a GitHub issue exists, so a lost write files a SECOND one next sync',
    admin_notifications: 'the /admin feed is where a super admin finds out at all',
    mkt_consent_events: 'the consent ledger is what api/privacy/export cites',
    expense_splits: 'the rollback is what keeps "never leave a parent without shares" true',
    onboarding_progress: 'the onboarding funnel is read from it',
    crm_contacts: 'the contact its owner and lifecycle are read from',
    mkt_visitors: 'the visitor spine that attributes a person to a contact',
  };

  it.each(Object.entries(WATCHED))('%s is never written in statement position', async (table) => {
    const { readdirSync } = await import('node:fs');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.next', '.git', '.claude', 'mobile'].includes(entry.name)) continue;
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(`${dir}/${entry.name}`);
      }
      return out;
    };
    // components/ too: the expense rollback is a client component, and a
    // discarded write is no less discarded for running in a browser.
    const files = [...walk('app'), ...walk('lib'), ...walk('components')];
    expect(files.length, 'the walk found nothing, so it proves nothing').toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Statement position: the line begins with `await`, so whatever the call
        // resolved with goes nowhere at all.
        if (!new RegExp(`^\\s*(?:void\\s+)?await\\s+[\\w.]*\\.from\\('${table}'\\)`).test(line)) return;
        const chunk = lines.slice(i, i + 4).join('\n');
        if (/\.(insert|update|upsert|delete)\s*\(/.test(chunk)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders, `read the result — ${WATCHED[table]}`).toEqual([]);
  });
});

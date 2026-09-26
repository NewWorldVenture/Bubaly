import { describe, expect, it } from 'vitest';
import { NON_ACTION_FILES, perFile, unconfirmedWritesIn } from './helpers/unconfirmed-writes';

/**
 * Audit C1-S9-61 — the unconfirmed-write class OUTSIDE server actions.
 *
 * `an-unconfirmed-write-ratchet.test.ts` scanned `'use server'` files only,
 * because that is where C1-S9-46 went looking: an action returns straight to a
 * person, so a success it cannot see is a lie told to someone. It burned that
 * set down from 102 to its deliberate members. It never looked anywhere else —
 * and API routes answer people too, while `lib/` holds the writes that crons,
 * webhooks and the actions themselves delegate to.
 *
 * Same scanner (`tests/helpers/unconfirmed-writes.ts`), same rule as the first
 * ratchet had before it was burned down: **only remove or decrease entries as
 * they are fixed — never add.** A count per file, never a line number, so an
 * unrelated edit cannot redden it.
 *
 * This baseline is a starting inventory, NOT a list of defects. Many of these
 * will be the ordinary case — a cron sweeping rows that may not be there, a
 * lease reclaim that is meant to lose a race — and those will stay, with their
 * reasons written beside them, exactly as the first ratchet's did.
 */
// Known unconfirmed writes as of C1-S9-61. ONLY REMOVE or DECREASE entries.
const BASELINE = new Map<string, number>([
  ['app/api/ai/briefing/route.ts', 1],
  ['app/api/ai/chat/route.ts', 1],
  ['app/api/billing/cancel/route.ts', 1],
  ['app/api/billing/change-plan/route.ts', 1],
  ['app/api/blog/like/route.ts', 1],
  ['app/api/blog/save/route.ts', 1],
  ['app/api/blog/subscribe/route.ts', 1],
  ['app/api/blog/unsubscribe/route.ts', 1],
  ['app/api/concierge-calls/place/route.ts', 1],
  ['app/api/cron/ai-runs/route.ts', 1],
  ['app/api/cron/checkout-abandoned/route.ts', 1],
  ['app/api/cron/family-routines/route.ts', 8],
  ['app/api/cron/guardian-learning/route.ts', 1],
  ['app/api/cron/return-reminders/route.ts', 2],
  ['app/api/cron/wallet-allowance/route.ts', 1],
  ['app/api/guardian/inbound/whatsapp/route.ts', 1],
  ['app/api/guardian/screen/route.ts', 4],
  ['app/api/guardian/status/voicemail/route.ts', 1],
  ['app/api/mkt/track/route.ts', 1],
  ['app/api/push/unsubscribe/route.ts', 1],
  ['app/api/sync/[provider]/disconnect/route.ts', 1],
  ['app/api/sync/google/disconnect/route.ts', 1],
  ['app/api/vacations/ai/route.ts', 3],
  ['app/api/weekend/discover/route.ts', 1],
  ['lib/ai/assistant-engine.ts', 1],
  ['lib/ai/context/builder.ts', 1],
  ['lib/ai/runs/controls.ts', 1],
  ['lib/ai/runs/store.ts', 5],
  ['lib/ai/tools/execute.ts', 2],
  ['lib/ai/usage.ts', 1],
  ['lib/assistant/service.ts', 1],
  ['lib/assistant/tools.ts', 4],
  ['lib/autopilot/policy-scan.ts', 1],
  ['lib/autopilot/scan.ts', 3],
  ['lib/chores/server.ts', 1],
  ['lib/contact-center/provision.ts', 1],
  ['lib/contact-center/server.ts', 4],
  ['lib/feedback/github-sync.ts', 1],
  ['lib/feedback/notify.ts', 1],
  ['lib/guardian/callbacks.ts', 2],
  ['lib/library/ingest.ts', 2],
  ['lib/life-events/launch.ts', 6],
  ['lib/marketing/automation-events.ts', 2],
  ['lib/marketing/automation-runner.ts', 2],
  ['lib/marketing/identity.ts', 3],
  ['lib/marketing/onboarding-contact.ts', 1],
  ['lib/marketing/platform.ts', 3],
  ['lib/marketing/recurring-ads-runner.ts', 2],
  ['lib/network/aggregate-server.ts', 3],
  ['lib/referrals/server.ts', 2],
  ['lib/server/calendar-feeds.ts', 1],
  ['lib/server/notification-emails.ts', 1],
  ['lib/server/profiles.ts', 1],
  ['lib/server/push.ts', 3],
  ['lib/services/approvals/index.ts', 3],
  ['lib/services/groceries/index.ts', 1],
  ['lib/services/home/index.ts', 2],
  ['lib/services/inventory/index.ts', 1],
  ['lib/services/meals/index.ts', 2],
  ['lib/services/memory/index.ts', 4],
  ['lib/services/notes/index.ts', 1],
  ['lib/services/purchases/private-result.ts', 1],
  ['lib/services/tasks/index.ts', 1],
  ['lib/services/trips/index.ts', 3],
  ['lib/social/account-tokens.ts', 5],
  ['lib/social/publish.ts', 1],
  ['lib/stripe/connect.ts', 1],
  ['lib/stripe/issuing.ts', 2],
  ['lib/stripe/treasury.ts', 1],
  ['lib/stripe/webhook.ts', 1],
  ['lib/sync/engine/generic.ts', 3],
  ['lib/sync/engine/google.ts', 3],
  ['lib/twin/project-server.ts', 1],
  ['lib/wallet/server.ts', 1],
]);

describe('the unconfirmed-write class outside server actions only shrinks (C1-S9-61)', () => {
  const found = perFile(NON_ACTION_FILES().flatMap(unconfirmedWritesIn));

  it('no file has MORE unconfirmed writes than its baseline', () => {
    const grew: string[] = [];
    for (const [file, n] of found) {
      const allowed = BASELINE.get(file) ?? 0;
      if (n > allowed) grew.push(`${file}: ${n} > ${allowed}`);
    }
    expect(grew, 'a write that cannot see what it changed was added').toEqual([]);
  });

  it('no file has FEWER than its baseline — a fix must prune it (C1-S9-61)', () => {
    // The stale-entry case below only fires when a file empties. A file going
    // from two to one stayed at two here, so the baseline drifted above the code
    // and the slack could be spent on a new write without anything going red.
    // Found when a probe counted 120 against a baseline of 121 and every case
    // still passed.
    const shrank: string[] = [];
    for (const [file, allowed] of BASELINE) {
      const n = found.get(file) ?? 0;
      if (n > 0 && n < allowed) shrank.push(`${file}: ${n} < ${allowed}`);
    }
    expect(shrank, 'lower these entries to match the code').toEqual([]);
  });

  it('no NEW file joins the class', () => {
    const added = [...found.keys()].filter((f) => !BASELINE.has(f)).sort();
    expect(added, 'a file grew its first unconfirmed write').toEqual([]);
  });

  it('the baseline lists no file that is already clean', () => {
    const stale = [...BASELINE.keys()].filter((f) => !found.has(f)).sort();
    expect(stale, 'BASELINE lists files with no unconfirmed writes left — remove them').toEqual([]);
  });

  it('the baseline total matches what finalaudit.md records', () => {
    const total = [...BASELINE.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(137);
  });
});

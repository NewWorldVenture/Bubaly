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
// Known unconfirmed writes. ONLY REMOVE or DECREASE entries.
//
// Burn-down: 137 across 74 files (C1-S9-61 baseline) → 131/68 (C1-S9-62: six
// route writes confirmed; eight more documented as deliberate or log-only
// and left counted, each with its reason beside the code) → 119/66 (C1-S9-63:
// the guardian screening webhook, the trip builder's rollback, and the crons;
// the deliberate ones stay counted with their reasons) → 114/63 (C1-S9-64:
// the Stripe mirrors, a wallet hold, a referral rollback) → 98/55 (C1-S9-65:
// lib/services) → 89/50 (C1-S9-66: lib/ai) → 83/49 (C1-S9-67:
// lib/marketing) → 68/44 (C1-S9-68: sync, life events, lib/server,
// lib/social).
const BASELINE = new Map<string, number>([
  ['app/api/ai/briefing/route.ts', 1],
  ['app/api/blog/like/route.ts', 1],
  ['app/api/blog/save/route.ts', 1],
  ['app/api/blog/unsubscribe/route.ts', 1],
  ['app/api/cron/checkout-abandoned/route.ts', 1],
  ['app/api/cron/family-routines/route.ts', 3],
  ['app/api/cron/guardian-learning/route.ts', 1],
  ['app/api/cron/return-reminders/route.ts', 2],
  ['app/api/cron/wallet-allowance/route.ts', 1],
  ['app/api/guardian/inbound/whatsapp/route.ts', 1],
  ['app/api/guardian/status/voicemail/route.ts', 1],
  ['app/api/push/unsubscribe/route.ts', 1],
  ['app/api/sync/[provider]/disconnect/route.ts', 1],
  ['app/api/sync/google/disconnect/route.ts', 1],
  ['app/api/vacations/ai/route.ts', 1],
  ['app/api/weekend/discover/route.ts', 1],
  ['lib/ai/runs/store.ts', 2],
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
  ['lib/marketing/automation-events.ts', 1],
  ['lib/marketing/automation-runner.ts', 1],
  ['lib/marketing/identity.ts', 2],
  ['lib/marketing/platform.ts', 2],
  ['lib/marketing/recurring-ads-runner.ts', 1],
  ['lib/network/aggregate-server.ts', 3],
  ['lib/server/notification-emails.ts', 1],
  ['lib/server/profiles.ts', 1],
  ['lib/server/push.ts', 3],
  ['lib/services/approvals/index.ts', 2],
  ['lib/services/meals/index.ts', 1],
  ['lib/social/account-tokens.ts', 4],
  ['lib/stripe/treasury.ts', 1],
  ['lib/stripe/webhook.ts', 1],
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
    expect(total).toBe(68);
  });
});

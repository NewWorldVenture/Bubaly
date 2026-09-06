import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

// `notify()` is where a notification acquires the two things a family relies
// on: the quiet-hours window, and the unread-duplicate guard. A raw
// `.from('notifications').insert(...)` gets neither — it lands at 2am and it
// lands again on the next retry.
//
// Fifteen call sites bypassed it. The three that woke a house most often —
// every screened text, every WhatsApp, every voicemail — went through it first.
// Five more followed: autopilot, gift, locator, close-auctions and
// return-reminders. The batch generator was the last, and took a different route
// (see below). What remains is enumerated below WITH A REASON, so it is a list
// someone chose rather than a list nobody counted, and so the next one has to be
// added here deliberately.
//
// The crons matter more than their names suggest, because cron schedules are in
// UTC and families are not. `autopilot-scan` runs at 06:30 UTC — 23:30 for a
// family on US Pacific time — so Bubaly's own unprompted suggestion was the
// thing most likely to light up a phone at half past eleven at night.

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' ? []
      : e.isDirectory() ? walk(`${dir}/${e.name}`)
      : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []);

/** Files that write `notifications` rows without going through the service. */
function rawInsertSites(): string[] {
  const found = new Set<string>();
  for (const file of ['app', 'lib', 'components'].flatMap(walk)) {
    if (file.startsWith('lib/services/notifications')) continue; // the service itself
    const src = readFileSync(file, 'utf8');
    if (/from\('notifications'\)\s*\n?\s*\.insert\(/.test(src) || /from\('notifications'\)\.insert\(/.test(src)) {
      found.add(file);
    }
  }
  return [...found].sort();
}

// Each entry is a promise that this site does not need the window, or a debt
// with a named reason. Both kinds have to be written down.
const ALLOWED: Record<string, string> = {
  // URGENT BY NATURE — these must reach a family at any hour, and routing them
  // through notify() would only be correct with `urgent: true`, which is a
  // no-op against a raw insert. Converting them buys the duplicate guard and
  // nothing else; worth doing, not worth risking a missed emergency to rush.
  'app/api/guardian/escalate/route.ts': 'a guardian escalation is the alert a family must get at 3am',
  'app/api/guardian/screen/route.ts': 'the emergency branch of call screening',
  'app/api/contact-center/sms/route.ts': 'only fires when shouldNotifyFamily(intent) — an urgent inbound message',
  'app/api/contact-center/voice/transcription/route.ts': 'titled "Urgent voicemail at your family line"; same gate',

  // NO DEBT LEFT. This last one still writes its own batch, and that is now a
  // justified exemption rather than something owed: 150 rows through notify()
  // would be 150 dedupe reads on a cron, re-solving duplicates this function
  // already handles per type. What it was actually missing was the quiet-hours
  // window, and it takes that from `deliveryTimeFor` — the same function
  // notify() uses. Asserted in its own block below, because "does not call
  // notify()" and "ignores quiet hours" turned out to be different claims, and
  // only the second one was ever the problem.
  'lib/server/notifications.ts': 'batches its own insert on purpose (150 rows, own per-type dedupe) but takes the quiet-hours window from deliveryTimeFor',
};

describe('a notification that can wake a house goes through notify()', () => {
  it('every raw insert site is one someone decided on', () => {
    const undeclared = rawInsertSites().filter((f) => !(f in ALLOWED));
    expect(
      undeclared,
      `these write notifications without the quiet-hours window or the duplicate guard:\n  ${undeclared.join('\n  ')}\n` +
      'Route them through notify(), or add them to ALLOWED with the reason they do not need it.',
    ).toEqual([]);
  });

  it('does not keep an exemption for a site that no longer writes one', () => {
    // A stale allowlist entry is how a list stops describing the code. If a
    // file was converted, its entry has to go with it.
    const sites = new Set(rawInsertSites());
    const stale = Object.keys(ALLOWED).filter((f) => !sites.has(f));
    expect(stale, `converted or deleted — drop from ALLOWED: ${stale.join(', ')}`).toEqual([]);
  });

  it('the three loudest inbound routes are converted', () => {
    // Named individually rather than counted, because "fewer than before" is
    // not a property — these specific three fired on every screened message.
    for (const file of [
      'app/api/guardian/inbound/sms/route.ts',
      'app/api/guardian/inbound/whatsapp/route.ts',
      'app/api/guardian/status/voicemail/route.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must not write notifications directly`).not.toMatch(/from\('notifications'\)/);
      expect(src, `${file} must go through notify()`).toContain('await notify(scope, {');
      // And it must ask for the family's real zone: scopeForSystem's DEFAULT_TZ
      // fallback would evaluate the window against the wrong clock, which is
      // worse than not checking it at all.
      expect(src).toContain('systemScopeForFamily(');
    }
  });

  it('none of the converted three marks itself urgent', () => {
    // The whole point is that a routine screened message can wait. If one of
    // these ever needs `urgent`, that is a product decision, not a default.
    for (const file of [
      'app/api/guardian/inbound/sms/route.ts',
      'app/api/guardian/inbound/whatsapp/route.ts',
      'app/api/guardian/status/voicemail/route.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/urgent:\s*true/);
    }
  });
});

describe('the five that followed', () => {
  const READ = (f: string) => readFileSync(f, 'utf8');

  // Named individually rather than counted. "Five fewer raw inserts" is not a
  // property a family can feel; "the autopilot suggestion no longer arrives at
  // 23:30" is.
  for (const file of [
    'lib/autopilot/scan.ts',
    'app/gift/actions.ts',
    'app/(app)/dashboard/locator/actions.ts',
    'app/api/cron/close-auctions/route.ts',
    'app/api/cron/return-reminders/route.ts',
  ]) {
    it(`${file} goes through notify() and asks for the family's real zone`, () => {
      const src = READ(file);
      expect(src, `${file} must not write notifications directly`)
        .not.toMatch(/from\('notifications'\)\s*\n?\s*\.insert\(/);
      expect(src).toContain('notify(');
      // scopeForSystem's DEFAULT_TZ fallback would evaluate the window against
      // the wrong clock, which is worse than not checking it at all.
      expect(src).toContain('systemScopeForFamily(');
    });
  }

  it('only the locator marks itself urgent, and on purpose', () => {
    // An auction result, a gift and an overdue nudge can all wait for morning.
    for (const file of [
      'lib/autopilot/scan.ts',
      'app/gift/actions.ts',
      'app/api/cron/close-auctions/route.ts',
      'app/api/cron/return-reminders/route.ts',
    ]) {
      expect(READ(file), `${file} should not need urgent`).not.toMatch(/urgent:\s*true/);
    }
    // The locator does, and the reason is the whole argument: the geofence
    // alerts quiet hours would actually hold are the NIGHT-TIME ones, and a
    // child leaving the house at 2am is precisely the alert a parent must not
    // receive at 7am. Daytime arrivals fall outside the window anyway, so this
    // costs a family nothing and protects the one case that matters.
    expect(READ('app/(app)/dashboard/locator/actions.ts')).toMatch(/urgent:\s*true/);
  });

  it('the crons build one scope per family, not one for all of them', () => {
    // Both walk rows belonging to different households. A single scope would
    // apply one family's quiet hours — and one family's timezone — to everyone
    // the cron touches.
    for (const file of ['app/api/cron/close-auctions/route.ts', 'app/api/cron/return-reminders/route.ts']) {
      expect(READ(file), `${file} must key its scopes by family`).toMatch(/new Map<string, ServiceScope \| null>\(\)/);
    }
  });
});

describe('the batch generator takes the window without taking the round trips', () => {
  const src = readFileSync('lib/server/notifications.ts', 'utf8');

  it('stamps every row from the shared delivery-time function', () => {
    // ONE definition of "when does this land". Two would eventually disagree,
    // and the one that drifts is the one nobody is testing.
    expect(src).toContain("import { deliveryTimeFor } from '@/lib/services/notifications'");
    expect(src).toContain('const { sendAt } = await deliveryTimeFor(scope);');
    expect(src).toContain('for (const row of allRows) row.send_at = sendAt;');
  });

  it('resolves the window ONCE for the whole batch', () => {
    // Every row belongs to one family, so a per-row lookup would be the same
    // answer fetched 150 times — which is the cost that kept this off notify().
    expect(src.match(/deliveryTimeFor\(/g) ?? []).toHaveLength(1);
  });

  it('asks for the family’s real zone', () => {
    expect(src).toContain('systemScopeForFamily(');
  });

  it('sends rather than holds when the family cannot be read', () => {
    // A notice that arrives is recoverable; one held for eight hours against a
    // guessed clock is not.
    expect(src).toMatch(/could not read the family for quiet hours/);
  });

  it('does not mark itself urgent', () => {
    // Everything it produces is a courtesy notice about a day's events,
    // reminders and medications.
    expect(src).not.toMatch(/urgent:\s*true/);
  });
});

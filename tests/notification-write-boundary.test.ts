import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

// `notify()` is where a notification acquires the two things a family relies
// on: the quiet-hours window, and the unread-duplicate guard. A raw
// `.from('notifications').insert(...)` gets neither — it lands at 2am and it
// lands again on the next retry.
//
// Fifteen call sites bypassed it. The three that woke a house most often —
// every screened text, every WhatsApp, every voicemail — now go through it.
// The rest are enumerated below WITH A REASON, so what remains is a list
// someone chose rather than a list nobody counted, and so the sixteenth has to
// be added here deliberately.

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

  // DEBT, named. None is urgent; each should move to notify() and none is
  // frequent enough to be the 2am problem the converted three were.
  'lib/server/notifications.ts': 'the generator writes its own batch; it predates the service and needs its own tranche',
  'lib/autopilot/scan.ts': '"Autopilot handled X" — not urgent, should move',
  'app/gift/actions.ts': '"X sent a gift" — not urgent, should move',
  'app/(app)/dashboard/locator/actions.ts': 'geofence arrive/leave — not urgent, should move',
  'app/api/cron/close-auctions/route.ts': '"You won X" — not urgent, should move',
  'app/api/cron/return-reminders/route.ts': '"Overdue: X" — not urgent, should move',
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

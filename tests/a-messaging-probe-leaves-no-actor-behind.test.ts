import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A probe that acts as a simulated member clears that member when it is done.
 *
 * The audit probes impersonate people by setting `request.jwt.claim.sub` and
 * `request.jwt.claims` (the shim's auth.uid() reads either). A probe that ends
 * with an actor still set hands that identity to whatever the same session runs
 * next: a later cleanup then runs as a member instead of the owner, and a later
 * probe's "anonymous" leg is not anonymous. Every probe the messaging lane adds
 * or changes ends by clearing both keys after the last time it sets one.
 */
const PROBES = [
  'docs/audit/messaging-canonical-history.probe.sql',
  'docs/audit/messaging-participant-boundaries.probe.sql',
  'docs/audit/messaging-notification.probe.sql',
  'docs/audit/messaging-membership-lifecycle.probe.sql',
  'docs/audit/a-read-receipt-is-the-readers-own-check.sql',
  'docs/audit/conversation-owner-check.sql',
  'docs/audit/family-media-answers-to-the-family-check.sql',
  'docs/audit/message-sender-check.sql',
  'docs/audit/removed-member-access-check.sql',
];

// A claim set to anything but the empty string: set_config(...) or SET [LOCAL].
const ACTOR_SET = /set_config\('request\.jwt\.claims?(?:\.sub)?',\s*(?=\S)(?!'')[^,]+,|set(?: local)? request\.jwt\.claim\.sub\s*=\s*'[^']+'/g;
const CLEARS = [
  /set_config\('request\.jwt\.claim\.sub',\s*'',/,
  /set_config\('request\.jwt\.claims',\s*'',/,
];

function lastActorSet(sql: string): number {
  let last = -1;
  for (const match of sql.matchAll(ACTOR_SET)) last = match.index ?? last;
  return last;
}

describe('a messaging probe leaves no actor behind', () => {
  it.each(PROBES)('%s clears both claim keys after it last sets an actor', (path) => {
    const sql = readFileSync(path, 'utf8');
    const last = lastActorSet(sql);
    expect(last, `${path} no longer sets an actor; drop it from this list`).toBeGreaterThan(-1);
    const teardown = sql.slice(last);
    for (const clear of CLEARS) expect(teardown, `${path} must end with ${clear}`).toMatch(clear);
  });

  it('the scan recognises an actor left behind', () => {
    const leaky = "begin;\nset local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';\nrollback;\n";
    const last = lastActorSet(leaky);
    expect(last).toBeGreaterThan(-1);
    expect(CLEARS.some((clear) => clear.test(leaky.slice(last)))).toBe(false);
    const cleared = `${leaky}do $$ begin\n  perform set_config('request.jwt.claim.sub', '', false);\n  perform set_config('request.jwt.claims', '', false);\nend $$;\n`;
    expect(CLEARS.every((clear) => clear.test(cleared.slice(lastActorSet(cleared))))).toBe(true);
  });
});

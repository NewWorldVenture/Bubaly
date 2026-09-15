// Who a CRM contact belongs to must not be decided by a column its subject can
// rewrite, nor by an unescaped LIKE pattern.
//
// `upsertOnboardingContact` runs as the SERVICE ROLE against `crm_contacts`,
// whose RLS is admin-only, and the row its lookup matches is the row it then
// OVERWRITES with the caller's name, email, phone and family_id. Two separate
// faults made that reachable, and each is sufficient on its own:
//
//   1. The callers preferred `profiles.email` over the verified `auth.user.email`.
//      `profiles.email` is a plain text column, and `profiles_update_self`
//      constrains WHICH ROW you may update, not which columns — so its owner can
//      set it to anything, including a stranger's exact address.
//   2. The lookup passed that value straight into `.ilike()`. `%` then matched
//      every contact and `.limit(1)` picked one.
//
// Measured on a database replayed from the migrations, as `authenticated`, with
// controls proving crm_contacts stayed closed to ordinary users throughout
// (0 rows readable, 0 rows changed by a direct write, value untouched):
//
//   attacker set their own profiles.email to '%' ....... 1 row
//   server read profiles.email ......................... '%'
//   .ilike matched a contact they never owned .......... yes
//   victim contact rows overwritten .................... 1  (first_name=Attacker)
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { escapeLike } from '@/lib/supabase/escape-like';

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');
const onboarding = read('app/onboarding/actions.ts');
const contact = read('lib/marketing/onboarding-contact.ts');
const identity = read('lib/marketing/identity.ts');
const profileActions = read('app/(app)/dashboard/settings/profile-actions.ts');

/** The `email:` value each call to `fn` resolves, read from the lines after it. */
function emailKeysOf(source: string, fn: string): string[] {
  const lines = source.split('\n');
  const keys: string[] = [];
  lines.forEach((line, i) => {
    if (!line.includes(`${fn}(admin, {`)) return;
    // The property sits within a few lines; comments may precede it.
    const window = lines.slice(i + 1, i + 12);
    const hit = window.find((l) => /^\s*email:/.test(l));
    if (hit) keys.push(hit.replace(/^\s*email:\s*/, '').replace(/,\s*$/, ''));
  });
  return keys;
}

describe('the CRM identity key is the verified address', () => {
  it('every upsertOnboardingContact call prefers auth.user.email', () => {
    const keys = emailKeysOf(onboarding, 'upsertOnboardingContact');
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const key of keys) {
      expect(key, `an upsertOnboardingContact call resolves email as "${key}"`)
        .toMatch(/^auth\.user\.email/);
    }
  });

  it('the automation recipient is the verified address too', () => {
    // runSteps sends `to: recipient.email` through Resend from the product's own
    // FROM_EMAIL, so a writable column here mails strangers on our behalf.
    const keys = emailKeysOf(onboarding, 'fireAutomationEvent');
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const key of keys) {
      expect(key, `a fireAutomationEvent call resolves email as "${key}"`)
        .toMatch(/^auth\.user\.email/);
    }
  });

  it('no caller lets a profiles column win over the verified address', () => {
    // The exact shapes that were live: profile?.email ?? auth.user.email, and
    // prof?.email ?? profile.email ?? auth.user.email. saveUserProfile's own
    // `email: profile.email` is the user writing their OWN row and is fine, so
    // this matches only the `??` chains that pick an identity key.
    expect(onboarding).not.toMatch(/email:\s*prof(ile)?\??\.email\s*\?\?/);
  });
});

describe('the identity lookups escape their LIKE pattern', () => {
  const sites: [string, string][] = [
    ['lib/marketing/onboarding-contact.ts', contact],
    ['lib/marketing/identity.ts', identity],
    ['app/(app)/dashboard/settings/profile-actions.ts', profileActions],
  ];

  it('each passes escapeLike() into .ilike on crm_contacts email', () => {
    for (const [name, src] of sites) {
      const call = /\.ilike\('email',\s*([^)]+)\)/.exec(src)?.[1] ?? '';
      expect(call, `${name} matches crm_contacts email with "${call}"`).toContain('escapeLike(');
    }
  });

  it('a wildcard stops being a wildcard', () => {
    // What the service-role lookup would receive after the fix.
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('victim@bigcorp.test')).toBe('victim@bigcorp.test');
  });
});

// A kid login stays in the family that made it.
//
// A kid login's address is synthetic and deterministic from its username
// (`child.<username>@kids.bubaly.app`), and any household's parent or adult may
// write an invite to any address. `accept_invite` compared only addresses, so a
// child who opened a stranger's join link while signed in was enrolled in that
// household, where its adults could message them and assign them chores, and
// the child's own parents could not see it. Reproduced on a replay of every
// runnable migration.
//
// The database half is the held 0495 (supabase/reserved/), proven by
// docs/audit/reserved/a-member-invited-back-gets-the-invited-role-check.sql in
// .github/workflows/invite-rejoin-role-runtime.yml. Until it is released, the
// join page is what stands between a child and that link, which is what these
// pin: the helper that recognises a kid login, and the page asking it before
// it asks the database.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHILD_LOGIN_EMAIL_DOMAIN, isChildLoginEmail, syntheticChildEmail } from '@/lib/onboarding/child-login';

describe('isChildLoginEmail recognises a kid login, and only a kid login', () => {
  it('recognises every address syntheticChildEmail makes', () => {
    for (const username of ['emma', 'a_b', 'kid.2', 'xx-yy']) {
      expect(isChildLoginEmail(syntheticChildEmail(username))).toBe(true);
    }
  });

  it('reads the address in any case and around stray spaces', () => {
    expect(isChildLoginEmail(' Child.Emma@KIDS.Bubaly.App ')).toBe(true);
  });

  it('is false for an ordinary or look-alike address, and for no address', () => {
    for (const email of [
      'parent@example.com',
      'child.emma@kids.bubaly.app.example.com',
      'child.emma@notkids.bubaly.app',
      'kids.bubaly.app@example.com',
      '',
      null,
      undefined,
    ]) {
      expect(isChildLoginEmail(email), String(email)).toBe(false);
    }
  });

  it('keeps the address syntheticChildEmail has always made', () => {
    // Sign-in derives the address from the username without storing it, so a
    // different domain would sign every existing kid out for good.
    expect(CHILD_LOGIN_EMAIL_DOMAIN).toBe('kids.bubaly.app');
    expect(syntheticChildEmail('emma')).toBe('child.emma@kids.bubaly.app');
  });
});

describe('the join page refuses a kid login before it asks the database', () => {
  const source = readFileSync('components/auth/join-invite.tsx', 'utf8');

  it('checks the signed-in account and stops with the kid sentence before accept_invite', () => {
    const check = source.indexOf('isChildLoginEmail(auth.user.email)');
    const rpc = source.indexOf("rpc('accept_invite'");
    expect(check, 'the join page no longer asks whether the account is a kid login').toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(-1);
    expect(check, 'the kid-login check must run before the database is asked').toBeLessThan(rpc);
    const guard = source.slice(check, rpc);
    expect(guard).toContain("t('joinInvite.aKidLoginCannotJoin')");
    expect(guard).toMatch(/return;/);
  });

  it('says the same sentence when the database refuses a kid login', () => {
    const rpc = readFileSync('supabase/reserved/0495_a_member_invited_back_gets_what_the_invite_grants.sql', 'utf8');
    expect(rpc).toContain("raise exception 'A kid login cannot join another family'");
    expect(source).toMatch(/\/cannot join another family\/i\.test\(error\?\.message \?\? ''\) \? t\('joinInvite\.aKidLoginCannotJoin'\)/);
  });

  it('every full catalogue has the sentence', () => {
    for (const code of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>;
      expect(messages['joinInvite.aKidLoginCannotJoin'], code).toBeTruthy();
    }
  });
});

// ROLE-L03: accepting an invite that failed showed the database's own English
// ("This invite was issued to a different email", "Invite is invalid or
// expired") or a hard-coded English fallback, to someone who may not read
// English — and the one failure a person can fix (they are signed in as the
// wrong account) read like the invite was broken. The component now names
// the two raises accept_invite has and a transport failure, each a catalogue
// sentence.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('components/auth/join-invite.tsx', 'utf8');
// The latest definition of accept_invite, whose raise the regex below reads.
const rpc = readFileSync('supabase/migrations/0136_accept_invite_idempotent.sql', 'utf8');
const KEYS = ['joinInvite.couldNotJoinTryAgain', 'joinInvite.inviteIsForADifferentEmail', 'joinInvite.inviteIsInvalidOrExpired'];

describe('an invite that fails says why, in the reader\'s language', () => {
  it('never shows the database\'s message or an English literal', () => {
    const failure = source.slice(source.indexOf("rpc('accept_invite'"), source.indexOf("setState({ phase: 'done' })"));
    // The message may be READ to tell the two raises apart, never SHOWN.
    expect(failure).not.toMatch(/message: error|message: \(?error\?\.message/);
    expect(failure).not.toMatch(/message: '[A-Z]/);
    for (const key of KEYS) expect(failure).toContain(`t('${key}')`);
  });

  it('tells a signed-in-as-someone-else invitee what to do', () => {
    expect(rpc).toMatch(/raise exception 'This invite was issued to a different email'/);
    expect(source).toMatch(/\/different email\/i\.test\(error\?\.message \?\? ''\) \? t\('joinInvite\.inviteIsForADifferentEmail'\)/);
  });

  it('every full catalogue says all three', () => {
    for (const code of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>;
      for (const key of KEYS) expect(messages[key], `${code} ${key}`).toBeTruthy();
    }
  });
});

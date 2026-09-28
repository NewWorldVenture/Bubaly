import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REFUSAL_DIGEST_PREFIX, refusalError, refusalForThrown } from '@/lib/actions/refusal';
import { SocialAccessError } from '@/lib/social/access';

// P-24 (finalaudit.md, B11). A child signed in with a PIN opened Auto →
// Licenses, filled "Add license" and pressed Add. The action refused, as it
// should — but the form's alert read "Minified React error #441; visit
// https://react.dev/errors/441 …". `useActionError` shows the thrown message on
// the premise that it is the action's own translated sentence, and in a
// production build it never is: Next replaces it with React's redaction text
// and keeps only the error's `digest`. The same child adding to the social
// media library got the section's "This page hit a snag" page.

// What the browser receives in production for a thrown server action.
function redacted(digest: string): Error & { digest: string } {
  const e = new Error('Minified React error #441; visit https://react.dev/errors/441 for the full message') as Error & { digest: string };
  e.digest = digest;
  return e;
}

describe('refusalForThrown', () => {
  it('names the refusal a digest carries, in production and in development', () => {
    const thrown = refusalError("You don't have permission to do that.", 'notAllowed');
    expect(refusalForThrown(thrown, true)).toBe('notAllowed');
    expect(refusalForThrown(thrown, false)).toBe('notAllowed');
  });

  it('never lets React\'s redaction text reach the reader', () => {
    expect(refusalForThrown(redacted('774151663'), true)).toBe('notSaved');
    // A redaction is recognisable by its text too, whatever the build says.
    expect(refusalForThrown(redacted('774151663'), false)).toBe('notSaved');
    const rsc = Object.assign(new Error('An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.'), { digest: '1' });
    expect(refusalForThrown(rsc, false)).toBe('notSaved');
  });

  it('leaves an action\'s own message alone where it survives (development, a plain client throw)', () => {
    expect(refusalForThrown(new Error('Could not save that license.'), false)).toBeNull();
    expect(refusalForThrown(new Error('Could not save that license.'), true)).toBeNull();
    expect(refusalForThrown('not an error', true)).toBeNull();
    expect(refusalForThrown(null, true)).toBeNull();
  });
});

describe('the throws a family member can meet carry their reason in the digest', () => {
  it('a missing social permission is a refusal, not an outage', () => {
    const e = new SocialAccessError('upload_media') as SocialAccessError & { digest?: string };
    expect(e.digest).toBe(`${REFUSAL_DIGEST_PREFIX}notAllowed`);
    expect(e).toBeInstanceOf(SocialAccessError);
    expect(e.permission).toBe('upload_media');
  });

  const files = [
    'app/(app)/dashboard/auto/actions.ts',
    'app/(app)/dashboard/home/actions.ts',
    'app/(app)/dashboard/paperwork/actions.ts',
    'app/(app)/dashboard/social/actions.ts',
    'app/(app)/dashboard/contacts/[id]/actions.ts',
  ];
  it.each(files)('%s throws no bare describeActionError', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/throw new Error\(describeActionError\(/);
    expect(src).not.toMatch(/wroteNoRows\(data\)\) throw new Error\(/);
  });
});

describe('the hook every inline form reports through', () => {
  it('asks refusalForThrown before showing a thrown message', () => {
    const src = readFileSync('components/ui/action-error.tsx', 'utf8');
    expect(src).toMatch(/refusalForThrown\(/);
    expect(src).toMatch(/actionRefusal\.\$\{/);
  });
});

describe('refusalForError', () => {
  it('reads "no error, and no row came back" as not saved, not as bad input', async () => {
    const { refusalForError } = await import('@/lib/actions/refusal');
    expect(refusalForError(null)).toBe('notSaved');
    expect(refusalForError(undefined)).toBe('notSaved');
    expect(refusalForError({ code: '42501', message: 'new row violates row-level security policy' })).toBe('notAllowed');
  });
});

describe('an AI engine that is not set up is unavailable, not a server fault', () => {
  it.each(['app/api/ai/relationship/route.ts', 'app/api/ai/weekly-briefing/route.ts'])('%s answers 503 for a provider failure', (file) => {
    const src = readFileSync(file, 'utf8');
    const tail = src.slice(src.lastIndexOf('} catch (err) {'));
    expect(tail).toMatch(/describeAIError\(err\)\.code !== 'unknown'[\s\S]*status: 503/);
  });
});

// P-26 (B11). The votes on screen arrive by realtime and can lag a tap: the
// PIN child's second vote inserted again and was refused as a duplicate (409),
// so the vote did not change.
describe('a vote the screen has not seen yet is not refused as a duplicate', () => {
  it('the watchlist replaces a member\'s vote on its key and re-reads the list', () => {
    const src = readFileSync('components/modules/watchlist-module.tsx', 'utf8');
    const fn = src.slice(src.indexOf('async function castVote('), src.indexOf('async function setStatus('));
    expect(fn).toMatch(/\.upsert\([\s\S]*onConflict: 'title_id,member_id'/);
    expect(fn).not.toMatch(/from\('watchlist_votes'\)\.insert\(/);
    expect(fn).toMatch(/votes\.refresh\(\)/);
  });
  it('a poll clears a single-choice vote by poll and member, accepts its own duplicate, and re-reads', () => {
    const src = readFileSync('components/modules/voting-module.tsx', 'utf8');
    const fn = src.slice(src.indexOf('async function vote('), src.indexOf('async function setStatus('));
    expect(fn).toMatch(/if \(poll\.kind === 'single'\) \{/);
    expect(fn).toMatch(/error\.code !== '23505'/);
    expect(fn).toMatch(/finally \{\s*void refreshVotes\(\);/);
  });
});

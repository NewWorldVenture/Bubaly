import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { at, between, bodyOf } from './helpers/source-order';

/**
 * Audit C1-S9-19 — a refused read must not render as "you have nothing".
 *
 * `components/ui/partial-read-banner.tsx` already states the rule in its own
 * header: *"a zero that means 'we could not check' must never be mistaken for
 * an all-clear."* It was adopted on six pages out of the 185 that read from the
 * database. A scan of every `page.tsx` found 26 reads that destructure `data`
 * and drop `error`, then fall back to `?? []`.
 *
 * These two are the ones where the empty state is a dangerous lie rather than a
 * cosmetic one, so they are fixed and pinned here. The rest are recorded as
 * triaged in finalaudit.md, not silently counted as clean.
 */
const PAGES = [
  {
    file: 'app/(app)/guardian/history/page.tsx',
    table: 'guardian_communications',
    // The AI Call Guardian's log, often watching over an elderly relative. A
    // refused read rendered an empty list under the heading "0 total" — a
    // family asking whether anything had been intercepted was told, in a
    // number, that nothing had.
    why: 'the scam-call interception log',
  },
  {
    file: 'app/(app)/family/members/page.tsx',
    table: 'family_members',
    // "No members yet" for a household of five, under a heading that still
    // names the family. Nothing destructive is reachable, but it is the most
    // alarming false empty in the set.
    why: 'the family roster',
  },
  {
    file: 'app/(app)/guardian/rules/page.tsx',
    table: 'guardian_routing_rules',
    // An empty call-screening list reads as "this family has configured no
    // protection", which is indistinguishable from a family that truly hasn't.
    why: 'call routing rules',
  },
  {
    file: 'app/(app)/family/permissions/page.tsx',
    table: 'permissions',
    // An empty permission matrix reads as "no role can do anything", which is
    // not a state the product can be in — so the only safe conclusion is wrong.
    why: 'the role permission matrix',
  },
] as const;

describe('a refused read is declared, not rendered as empty (C1-S9-19)', () => {
  it.each(PAGES)('$file captures the error for $why', ({ file, table }) => {
    const src = readFileSync(file, 'utf8');
    // The destructure must take `error`, not just `data`. Dropping it is the
    // whole defect: `?? []` then makes a refusal indistinguishable from none.
    // Other fields may sit between `data` and `error` (guardian/history also
    // destructures `count`), so this requires both in one destructure rather
    // than pinning their adjacency.
    expect(src).toMatch(/const \{ data: \w+[^}]*, error: \w+Error \}/);
    expect(src).toContain(`${table}: \${describeReadError(`);
  });

  it.each(PAGES)('$file renders the banner before the data it qualifies', ({ file }) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('<PartialReadBanner');
    expect(src).toContain('failures={readFailures}');
    // The banner must be computed from the read, and appear in the tree — a
    // `readFailures` that is built and never rendered is the same silence.
    expect(at(src, 'const readFailures')).toBeLessThan(at(src, '<PartialReadBanner'));
  });

  it.each(PAGES)('$file titles the banner through the translator', ({ file }) => {
    // These are family-facing pages, translated throughout. The six pages that
    // adopted this banner first are admin screens and pass an English literal;
    // copying that here would have put untranslated copy in front of families
    // in eleven locales.
    const src = readFileSync(file, 'utf8');
    expect(src).toContain("title={t('shared.someInformationCouldNotBeLoaded')}");
  });

  it('the shared title exists in every base catalogue', () => {
    // A key present only in en-US still renders (the chain falls back to
    // English), so a missing translation would not fail anything else here.
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(catalogue['shared.someInformationCouldNotBeLoaded'], `${locale} is missing the banner title`).toBeTruthy();
    }
  });
});

describe('a destructive path is not opened by a false empty (C1-S9-27)', () => {
  it('the independence ladder fails closed rather than rendering empty', () => {
    // Two things make this one different from the display pages above. The
    // `members` read directly above it is ALREADY guarded — with a comment
    // describing this very hazard — so a silently emptied ladder renders beside
    // a correct roster, reading as "this child has achieved nothing" rather
    // than as a failure. And it is destructive: `startMilestoneAction` upserts
    // `status: 'in_progress'` on (family_id, member_id, domain, title) with no
    // read, so a parent tapping Start on a rung the child already ACHIEVED
    // silently reverts it.
    const page = readFileSync('app/(app)/dashboard/independence/page.tsx', 'utf8');
    // The try/catch that used to stand here caught nothing: supabase-js
    // RESOLVES with { data, error } for a refused read and rejects only on a
    // transport failure. It described a guard that was not there.
    expect(page).not.toMatch(/try \{[\s\S]{0,200}?from\('independence_milestones'\)/);
    expect(page).toContain('milestones.error');
    // A genuinely absent table still degrades — that is what the original
    // comment was for — but nothing else does.
    expect(page).toContain('isMissingRelationError(milestones.error)');
    expect(page).toContain('<ErrorState');
    // And the premise: the action still has no read of its own to merge with.
    const action = readFileSync('app/(app)/dashboard/independence/actions.ts', 'utf8');
    expect(action).toContain("onConflict: 'family_id,member_id,domain,title'");
    expect(action).toContain("status: 'in_progress'");
  });

  it('the guardian log withholds its count rather than asserting zero', () => {
    // A banner beside "0 total" would still be asserting the zero.
    const page = readFileSync('app/(app)/guardian/history/page.tsx', 'utf8');
    expect(page).toMatch(/readFailures\.length === 0 \? <p[^>]*>\{count \?\? 0\} total/);
  });
});

describe('unloadable evidence is not shown as absent evidence (C1-S9-29)', () => {
  it('the missions page counts proof it could not sign', () => {
    // This is the one screen whose whole job is evidence review. A failed
    // `createSignedUrl` used to drop out silently, and ReviewCard renders the
    // proof block only under `mediaUrls.length > 0` — so a submission WITH
    // media_paths whose signing failed looked exactly like one with no proof,
    // and a parent could approve a proof-required mission blind, releasing
    // points or real cash.
    const page = readFileSync('app/(app)/missions/page.tsx', 'utf8');
    expect(page).toContain('const expectedProof =');
    expect(page).toContain('const proofUnavailable = expectedProof.length > mediaUrls.length;');
    // It has to reach the card, not just be computed.
    expect(page).toContain('proofUnavailable,');
  });

  it('the review card says so, in the user\'s language', () => {
    const card = readFileSync('app/(app)/missions/review-card.tsx', 'utf8');
    expect(card).toContain('item.proofUnavailable');
    expect(card).toContain("t('reviewCard.proofCouldNotBeLoaded')");
    // Announced, not merely styled — a reviewer using a screen reader is
    // exactly the person who cannot see that the images are missing.
    expect(card).toMatch(/role="status"[\s\S]{0,220}?reviewCard\.proofCouldNotBeLoaded/);
    // And it must render independently of the proof block, which is hidden in
    // precisely the case this notice exists for.
    const notice = card.indexOf('item.proofUnavailable');
    const block = card.indexOf('item.mediaUrls.length > 0');
    expect(notice).toBeLessThan(block);
  });

  it('the copy exists in every base catalogue', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(catalogue['reviewCard.proofCouldNotBeLoaded'], `${locale} is missing it`).toBeTruthy();
    }
  });
});

describe('a refused inbox is not inbox zero (C1-S9-30)', () => {
  const page = () => readFileSync('app/(app)/dashboard/paperwork/page.tsx', 'utf8');

  it('the paperwork page checks the error instead of catching one that never arrives', () => {
    const source = page();
    // The `try/catch` described a guard that was not there: supabase-js resolves
    // with `{ data, error }` for anything the database answers, so the catch
    // never saw a refusal, and `data ?? []` rendered the module's most confident
    // sentence — "Inbox zero 🎉 — nothing needs your signature, payment, or
    // reply." — over permission slips, medical forms and bills with deadlines.
    expect(source).not.toMatch(/catch\s*\{\s*\/\*\s*table not applied yet/);
    expect(source).toContain('inbox.error');
    expect(source).toContain('<ErrorState');
  });

  it('it still degrades for the unapplied table, and ONLY for that', () => {
    const source = page();
    // Migration 0169 is the tolerance the original comment was for. A broader
    // version would be this same defect wearing a new spelling.
    expect(source).toContain('isMissingRelationError');
    expect(source).toMatch(/if \(inbox\.error && !isMissingRelationError\(inbox\.error\)\)/);
  });

  it('the error bail precedes the fallback that would clobber it', () => {
    const source = page();
    expect(at(source, 'if (inbox.error &&')).toBeLessThan(at(source, 'inbox.data ?? []'));
  });

  it('the copy exists in every base catalogue', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(catalogue['paperwork.couldNotLoadYourInbox'], `${locale} is missing it`).toBeTruthy();
    }
  });
});

describe('a failed Pay-ID lookup is not a dead Pay-ID (C1-S9-31)', () => {
  const page = () => readFileSync('app/pay/[handle]/page.tsx', 'utf8');

  it('both public reads check their error', () => {
    const source = page();
    // This page is reached by someone outside the family trying to send money.
    // A dropped error told them the child's Pay-ID is dead and sent them to ask
    // the family for a new one — a support ticket and an abandoned gift over a
    // fault that may be transient, with nothing on the page to suggest retrying.
    expect(source).toContain('error: phError');
    expect(source).toContain('error: linkError');
    expect(source).toMatch(/if \(phError\) return/);
    expect(source).toMatch(/if \(linkError\) return/);
  });

  it('the failure shell is distinct from the no-link dead-end', () => {
    const source = page();
    expect(source).toContain("t('pay.couldNotCheckThisPayId')");
    expect(source).toContain("t('pay.noActiveGiftLink')");
    // Two different messages, or the fix is cosmetic.
    expect(source.indexOf("t('pay.couldNotCheckThisPayId')")).not.toBe(source.indexOf("t('pay.noActiveGiftLink')"));
  });

  it('the failure shell says nothing about the handle', () => {
    const source = page();
    // The privacy property the dead-end exists for: the shell must render from
    // the read's outcome alone, identically for a handle that exists and one
    // that does not. If `Unavailable` ever took the handle or the row, it could
    // become an existence oracle for anyone who can guess a Pay-ID.
    const unavailable = between(source, 'function Unavailable(', 'function Shell(');
    expect(unavailable).not.toContain('handle');
    expect(unavailable).not.toContain('ph.');
  });

  it('the copy exists in every base catalogue', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      for (const key of ['pay.couldNotCheckThisPayId', 'pay.pleaseTryAgainInAMoment']) {
        expect(catalogue[key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
  });
});

describe('a security control the user chose does not fail open (C1-S9-44)', () => {
  const layout = () => readFileSync('app/(app)/layout.tsx', 'utf8');

  it('the app-lock preference read is checked before the gate decision', () => {
    // This read decides whether App Lock is applied across the ENTIRE
    // authenticated app. A refused read left `prefs` null, `appLock` null, and
    // the gate simply not rendered — so a user who set a PIN to protect their
    // family's data on a shared or stolen device had that protection silently
    // removed, with nothing on screen to say so.
    const source = layout();
    expect(source).toContain('error: prefsError');
    expect(source).toContain('if (prefsError)');
    expect(at(source, 'if (prefsError)')).toBeLessThan(at(source, 'const appLockRaw'));
  });

  it('the closed answer withholds the app instead of rendering it', () => {
    // The only thing that makes this a fix rather than a message: the bail must
    // not fall through to `children`. A banner above an unlocked app would be
    // the defect with an apology attached.
    const bail = bodyOf(layout(), 'if (prefsError)', 'return <AppLockUnavailable />;');
    expect(bail).toContain('console.error');
    expect(bail).not.toContain('{children}');
    const fallback = bodyOf(layout(), 'async function AppLockUnavailable', '\n}');
    expect(fallback).not.toContain('children');
    expect(fallback).not.toContain('SessionKeeper');
  });

  it('it does not impersonate the lock screen it cannot verify against', () => {
    // `AppLockGate` checks the PIN against the `salt` and `hash` from this very
    // read, so a gate rendered without them could only ever reject — locking
    // the user out permanently rather than asking for their PIN.
    const fallback = bodyOf(layout(), 'async function AppLockUnavailable', '\n}');
    expect(fallback).not.toContain('AppLockGate');
    expect(fallback).not.toContain('salt');
    expect(fallback).not.toContain('hash');
  });

  it('the billing gates above still fail OPEN, which is their correct direction', () => {
    // The contrast is the point, and pinning it stops a later sweep from
    // "consistently" hardening these too: locking a paying family out of their
    // own data over a billing outage is the worse error, and `resolveEntitlement`
    // is documented as failing open for that reason.
    const source = layout();
    expect(source).toContain('resolveEntitlement fails open');
    expect(source).not.toMatch(/const \{[^}]*error: entError/);
  });

  it('the copy exists in every base catalogue', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      for (const key of ['appLock.weCouldNotConfirmYourLockSettings', 'appLock.stayingLockedUntilWeCanCheck']) {
        expect(catalogue[key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
  });
});

/**
 * Audit C1-S9-45 — the page-side remainder, triaged by C1-S9-40's rule: does
 * the fallback give a SMALLER answer, or a DIFFERENT one?
 */
const PAGE_BAILS = [
  {
    file: 'app/(app)/dashboard/vacations/[id]/layout.tsx',
    binding: 'tripError',
    // `notFound()` is a statement that this trip does not exist, and this is a
    // LAYOUT — a refused read 404s every page under the trip at once.
    keeps: 'notFound();',
  },
  {
    file: 'app/(app)/missions/new/page.tsx',
    binding: 'membersError',
    // The list a mission is ASSIGNED to: an empty one showed a parent with three
    // children the same screen a family with none sees.
    keeps: 'const kids = members ?? [];',
  },
  {
    file: 'app/s/[slug]/page.tsx',
    binding: 'surveyError',
    // `closed` is computed from `!survey`, so a refused read turned respondents
    // away from a survey that was open. They do not come back.
    keeps: "const closed = !survey || survey.status !== 'active';",
  },
  {
    file: 'app/reviews/page.tsx',
    binding: 'reviewsError',
    // `ratingStats` is computed from this list, so a refused read published a
    // rating derived from no reviews on the page whose job is social proof.
    keeps: 'const rows = reviews ?? [];',
  },
  {
    file: 'app/(app)/marketplace/store/page.tsx',
    binding: 'storeError',
    // A null store is also "you have not opened one", and creating a second
    // collides on (family_id, member_id).
    keeps: 'const [{ count: followers }',
  },
  {
    file: 'app/(app)/marketplace/saved/page.tsx',
    binding: 'savesError',
    keeps: 'const ids = (saves ?? []).map',
  },
] as const;

describe('a different answer fails visibly (C1-S9-45)', () => {
  it.each(PAGE_BAILS)('$file checks $binding before the fallback it would reach', ({ file, binding, keeps }) => {
    const source = readFileSync(file, 'utf8');
    expect(source, `${binding} is not bound`).toContain(`error: ${binding}`);
    expect(source).toContain(`if (${binding})`);
    // The original branch is KEPT — it is correct for a genuine absence.
    expect(source, 'the genuine empty/absent branch was removed').toContain(keeps);
    expect(at(source, `if (${binding})`), 'the check must precede the branch it guards')
      .toBeLessThan(at(source, keeps));
  });

  it.each(PAGE_BAILS)('$file returns instead of falling through', ({ file, binding }) => {
    // Without a return this is a log, not a fix.
    const bail = bodyOf(readFileSync(file, 'utf8'), `if (${binding})`, '\n  }');
    expect(bail).toContain('return');
  });
});

describe('a smaller answer is logged, not escalated (C1-S9-45)', () => {
  it.each([
    ['app/(app)/referrals/page.tsx', 'wasReferredError'],
    ['app/reviews/new/page.tsx', 'settingsError'],
  ])('%s degrades without failing the page', (file, binding) => {
    // A hidden "you were referred" note and hidden external review links change
    // nothing the reader can act on wrongly. Asserting the ABSENCE of a bail
    // here stops a later sweep from "consistently" hardening them into errors.
    const source = readFileSync(file, 'utf8');
    expect(source).toContain(`error: ${binding}`);
    expect(source).toContain('console.warn');
    expect(bodyOf(source, `if (${binding})`, '\n  }')).not.toContain('return');
  });
});

describe('the page-side sweep is closed with a ratchet (C1-S9-45)', () => {
  it('every page read still binding only `data` is one of the accepted kinds', () => {
    // The API side got this under C1-S9-43; pages get the same treatment, and
    // for the same reason: 21 → 12 is a number that looks like progress, and a
    // ratchet is the claim that the remainder is defensible read by read.
    //
    // Keyed by file and BINDING NAME rather than line, because the API version
    // broke on its own commit when an unrelated fix shifted line numbers.
    const accepted = new Set([
      // Tracked by tests/silent-empty-read-ratchet.test.ts, which owns its own
      // baseline and demands pruning as each is fixed.
      'app/(app)/dashboard/billing/page.tsx::data',
      'app/(app)/dashboard/family-digital-twin/page.tsx::savedSimRows',
      'app/(app)/dashboard/money-timeline/page.tsx::data',
      // auth.getUser() — the signed-out branch hands off to the section layouts
      // that actually enforce auth, which this file's header states it does not.
      'app/(app)/layout.tsx::auth',
      // Display-name maps: the fallback narrows a label and never changes an
      // answer or an action (C1-S9-40's rule).
      'app/(app)/marketplace/creators/[id]/page.tsx::members',
      'app/(app)/marketplace/negotiations/page.tsx::members',
      'app/(app)/marketplace/reviews/page.tsx::members',
      'app/gift/[token]/page.tsx::cw', 'app/gift/[token]/page.tsx::m', 'app/gift/[token]/page.tsx::fam',
      // C1-S9-29: the storage error is deliberately unbound. What matters there
      // is the COUNT — `expectedProof.length > mediaUrls.length` — which is what
      // turns a failed signing into a stated gap instead of a silent one, and is
      // guarded above.
      'app/(app)/missions/page.tsx::data',
      // Verified benign: pre-fills a name field, and the write is the user's own
      // submission, so a failed read costs one retyped name.
      'app/onboarding/page.tsx::profile',
    ]);
    const files = execSync("find app -name 'page.tsx' -o -name 'layout.tsx'", { encoding: 'utf8' }).trim().split('\n');
    const found = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
        .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const line of source.split('\n')) {
        const m = line.match(/const \{ data(?:: (\w+))? \} = await/);
        if (m) found.add(`${file}::${m[1] ?? 'data'}`);
      }
    }
    const unexpected = [...found].filter((f) => !accepted.has(f)).sort();
    expect(unexpected, 'a page read binding only `data` that has not been triaged').toEqual([]);
  });
});

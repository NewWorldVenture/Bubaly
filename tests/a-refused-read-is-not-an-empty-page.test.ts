import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

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

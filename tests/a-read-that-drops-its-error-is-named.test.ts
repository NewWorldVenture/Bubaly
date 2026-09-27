import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A read whose error is dropped cannot tell "there is nothing" from "I could not
 * look". Six of these were consequential and are fixed (DATA-002, Q62):
 *
 *   vacations/[id]/layout   a failed read answered 404 — "your trip is gone"
 *   trip-concierge          a failed history read looked like no conversation,
 *                           so the next message started a second one
 *   independence page       a try/catch that could never fire (PostgREST
 *                           resolves, it does not throw) rendered no milestones
 *   plan-write-backs        a failed read offered to add, again, the event,
 *                           reminder and task the plan had already added
 *   guardian rules page     a failed read showed a parent no call-screening
 *                           rules, inviting them to rebuild ones that exist
 *   home daily insights     a failed read of today's dismissals emptied the
 *                           block list, and the upsert then set every dismissed
 *                           insight back to active
 *
 * The ones left each fall back to a harmless default — a display name, a
 * default headline, a missing score badge — and are named here with that
 * reason. A new one fails until someone decides which kind it is.
 */

const HARMLESS: Record<string, string> = {
  'components/vacations/trip-overview.tsx vacation_travel_scores': 'the latest score badge; absent renders no badge',
  'app/gift/[token]/page.tsx child_wallets': "the recipient's name on a public gift page; falls back to a generic greeting",
  'app/gift/[token]/page.tsx family_members': 'same — the display name only',
  'app/gift/[token]/page.tsx families': 'same — the family name only',
  'app/(app)/marketplace/reviews/page.tsx family_members': 'member display names for labels; ids still render',
  'app/(app)/marketplace/negotiations/page.tsx family_members': 'member display names for labels',
  'app/(app)/marketplace/creators/[id]/page.tsx family_members': 'member display names for labels',
  'components/dashboard/ai-home-dashboard.tsx daily_insights': 'the re-read of active insights; a failure hides the insight card and writes nothing',
};

const ROOT = join(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const DROPPED = /const \{ data(?:: [a-zA-Z]+)? \} = await [a-zA-Z_.()]*\.from\('([a-z_]+)'\)\s*\.select/g;

const found = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))].flatMap((p) => {
  const path = p.slice(ROOT.length + 1).split(sep).join('/');
  return [...readFileSync(p, 'utf8').matchAll(DROPPED)].map((m) => `${path} ${m[1]}`);
});

describe('a read that drops its error is named, with why that is harmless', () => {
  it('no new read drops its error', () => {
    const unnamed = found.filter((f) => !(f in HARMLESS));
    expect(unnamed, 'read `error` and show it, or name the site in HARMLESS with the default it falls back to:\n' + unnamed.join('\n')).toEqual([]);
  });

  it('every named site still exists (a fixed one leaves the list)', () => {
    const stale = Object.keys(HARMLESS).filter((k) => !found.includes(k));
    expect(stale).toEqual([]);
  });

  it('the six consequential reads now read their error', () => {
    const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
    // main's C1-S9-45 renders the failure in place of throwing it; either way
    // a failed read is answered before `notFound()` can call it a missing trip.
    const layout = src('app/(app)/dashboard/vacations/[id]/layout.tsx');
    expect(layout).toMatch(/if \(tripError\) \{[\s\S]{0,300}<ErrorState[\s\S]{0,200}\n\s*if \(!trip\) return <AppNotFound /);
    const concierge = src('components/vacations/trip-concierge.tsx');
    expect(concierge).toMatch(/if \(convoError\) \{ setLoadFailed\(true\); return; \}/);
    expect(concierge).toMatch(/if \(msgsError\) \{ setLoadFailed\(true\); return; \}/);
    expect(concierge).toMatch(/busy \|\| loadFailed\) return;/);
    const independence = src('app/(app)/dashboard/independence/page.tsx');
    expect(independence).toMatch(/if \((?:milestones\.)?error && !isMissingRelationError\((?:milestones\.)?error\)\)/);
    expect(independence).not.toMatch(/catch \{ \/\* table not applied yet \*\/ \}/);
    const writeBacks = src('components/concierge/plan-write-backs.tsx');
    expect(writeBacks).toMatch(/if \(error\) \{ setLoadFailed\(true\); return; \}/);
    expect(writeBacks).toMatch(/busy === o\.kind \|\| loadFailed/);
    // Main fixed the same read the same way and its spelling was kept at the
    // merge; what is asserted is that the error decides what renders.
    expect(src('app/(app)/guardian/rules/page.tsx')).toMatch(/\{error \? <ErrorState/);
    expect(src('components/dashboard/ai-home-dashboard.tsx')).toMatch(/const toUpsert = existingError \? \[\] : candidates/);
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Ratchet guard for the cross-cutting silent-empty read class (PLA-0624/0625):
// a browser Supabase read `const { data } = await supabase.from(...).select(...)`
// that DROPS `error` and renders `data ?? []` turns a transient load failure into
// a false "you have nothing" state. messages-module (A-11) was fixed (PLA-0624);
// the remaining sites live in other agents' units and are burned down by their
// owners (see COORDINATION.md §3e). This test does two things:
//   1. Regression-locks the A-11 fix: messages-module must never reintroduce it.
//   2. Ratchets the class DOWN: the offending-file set must stay a SUBSET of the
//      known baseline — a NEW file introducing the pattern fails CI. As owners
//      fix files they delete them from BASELINE; when it hits [], delete this test.

const SHAPE = /const \{ data \} = await/;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function offendingFiles(): string[] {
  const roots = ['components', 'app'].filter((d) => {
    try { return statSync(d).isDirectory(); } catch { return false; }
  });
  const hits: string[] = [];
  for (const root of roots) {
    for (const f of tsxFiles(root)) {
      const src = readFileSync(f, 'utf8');
      if (SHAPE.test(src) && /\.from\(|createClient|supabase/.test(src)) {
        hits.push(f.replace(/\\/g, '/'));
      }
    }
  }
  return hits.sort();
}

// Known offenders as of PLA-0625 (2026-07-17). ONLY REMOVE entries as they are
// fixed — never add. New entries here mean the class grew, which defeats the point.
const BASELINE = new Set<string>([
  'app/(app)/dashboard/billing/page.tsx',
  'app/(app)/dashboard/concierge-calls/page.tsx',
  'app/(app)/dashboard/independence/page.tsx',
  // journeys + onboarding-funnel fixed under A-05 (PLA-0790) — now capture `error`
  // and render MiniError instead of a false-empty; removed from baseline.
  'app/(app)/dashboard/money-timeline/page.tsx',
  'app/(app)/dashboard/paperwork/page.tsx',
  // feedback-board comment thread fixed under A-17 §3e (PLA-0796) — a failed
  // read now shows a retryable message, not a silent empty discussion. Removed.
  'app/(app)/missions/page.tsx',
  // marketing lp/[slug] + f/[id] fixed under A-17 §3e slice (PLA-0793) — loaders
  // now throw on a real read error (retryable 5xx) instead of 404-ing a live page;
  // notFound() reserved for a genuinely missing row. Removed from baseline.
  'components/app/app-context.tsx',
  'components/concierge/plan-write-backs.tsx',
  // assistant-module fixed under A-05 (PLA-0792) — conversation-list + message
  // reads keep prior state on error instead of false-emptying; removed.
  'components/modules/billing-module.tsx',
  'components/modules/concierge-calls-module.tsx',
  // grocery-module fixed under A-10 (PLA-0625) — removed from baseline.
  // settings-module fixed under A-05 (PLA-0791) — profile read now captures
  // `error` + guards the destructive save; removed from baseline.
  // weather-module fixed under A-05 (PLA-0792) — loadSaved keeps prior cities
  // on a failed read instead of clobbering to []; removed.
]);

describe('silent-empty read ratchet (PLA-0624/0625)', () => {
  const offenders = offendingFiles();

  it('introduces NO new silent-empty read site beyond the known baseline', () => {
    const novel = offenders.filter((f) => !BASELINE.has(f));
    expect(
      novel,
      `New silent-empty read(s) — capture 'error' and surface it (see COORDINATION.md §3e), do NOT add to BASELINE:\n${novel.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the A-11 messages-module fix (never reintroduces the drop)', () => {
    expect(offenders).not.toContain('components/modules/messages-module.tsx');
  });

  it('baseline does not list already-fixed files (keep the ratchet honest)', () => {
    // Every baseline entry should still actually exhibit the shape; a stale entry
    // (already fixed but left in BASELINE) hides a slot a real regression could
    // slide into. Prune fixed files from BASELINE.
    const stale = [...BASELINE].filter((f) => !offenders.includes(f));
    expect(stale, `BASELINE lists files that no longer have the pattern — remove them:\n${stale.join('\n')}`).toEqual([]);
  });
});

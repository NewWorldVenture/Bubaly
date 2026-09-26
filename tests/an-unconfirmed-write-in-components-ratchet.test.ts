import { describe, expect, it } from 'vitest';
import { filesMatching, perFile, unconfirmedWritesIn } from './helpers/unconfirmed-writes';

/**
 * Audit C1-S9-77 — the unconfirmed-write class in `components/`.
 *
 * The two write ratchets (C1-S9-50, C1-S9-61) scan `app/` and `lib/`. Every
 * client module under `components/` — the ones that write straight to
 * Supabase from the browser, under RLS — sat outside both, and the census found
 * 198 updates and deletes across 70 files that never ask what they
 * changed. Under RLS that matters more, not less: a policy that refuses a row
 * refuses it with NO error — zero rows, and the module's "Saved" toast.
 *
 * Same scanner, same rules as C1-S9-61: a count per file, never a line; only
 * remove or decrease entries as they are fixed; a new file or a grown count
 * fails. This baseline is an inventory, not a verdict — many members will be
 * deliberate and stay with their reasons beside them.
 */
// Known unconfirmed writes in components/. ONLY REMOVE or DECREASE entries.
//
// Burn-down: 198 across 70 files (C1-S9-77 baseline) → 183/64 (C1-S9-77:
// family membership, health, visits, immunizations, care, devices, and the
// reminder completion that could schedule a recurrence twice) → 182/64 (the
// concierge plan status move that licensed materialising the plan) → 172/63
// (projects: the quote acceptance chain, C1-S9-79).
const BASELINE = new Map<string, number>([
  ['components/family/check-in-view.tsx', 1],
  ['components/family/driving-safety-view.tsx', 1],
  ['components/family/play-dates-view.tsx', 2],
  ['components/marketplace/listing-questions.tsx', 1],
  ['components/meals/favorites-view.tsx', 1],
  ['components/meals/nutrition-view.tsx', 1],
  ['components/memories/create-memory.tsx', 2],
  ['components/modules/announcements-module.tsx', 2],
  ['components/modules/assistant-module.tsx', 2],
  ['components/modules/behavior-module.tsx', 2],
  ['components/modules/binder-module.tsx', 2],
  ['components/modules/career-module.tsx', 9],
  ['components/modules/celebrations-module.tsx', 1],
  ['components/modules/chores-module.tsx', 1],
  ['components/modules/closet-module.tsx', 6],
  ['components/modules/concierge-module.tsx', 1],
  ['components/modules/connections-module.tsx', 1],
  ['components/modules/contacts-module.tsx', 2],
  ['components/modules/decisions-module.tsx', 2],
  ['components/modules/declutter-module.tsx', 9],
  ['components/modules/expenses-module.tsx', 3],
  ['components/modules/family-tree-module.tsx', 2],
  ['components/modules/home-module.tsx', 3],
  ['components/modules/homework-module.tsx', 3],
  ['components/modules/inbox-module.tsx', 3],
  ['components/modules/insurance-module.tsx', 1],
  ['components/modules/inventory-module.tsx', 7],
  ['components/modules/journal-module.tsx', 2],
  ['components/modules/language-module.tsx', 7],
  ['components/modules/life-events-module.tsx', 1],
  ['components/modules/marketplace-module.tsx', 2],
  ['components/modules/meals-module.tsx', 2],
  ['components/modules/messages-module.tsx', 4],
  ['components/modules/moving-module.tsx', 8],
  ['components/modules/notifications-module.tsx', 3],
  ['components/modules/pets-module.tsx', 2],
  ['components/modules/photos-module.tsx', 3],
  ['components/modules/planning-module.tsx', 2],
  ['components/modules/recipes-module.tsx', 4],
  ['components/modules/relationship-module.tsx', 6],
  ['components/modules/reminders-module.tsx', 2],
  ['components/modules/routines-panel.tsx', 3],
  ['components/modules/screen-time-module.tsx', 2],
  ['components/modules/security-module.tsx', 2],
  ['components/modules/settings-module.tsx', 2],
  ['components/modules/shopping-module.tsx', 2],
  ['components/modules/sleep-module.tsx', 3],
  ['components/modules/subscriptions-module.tsx', 4],
  ['components/modules/tax-vault-module.tsx', 1],
  ['components/modules/timetable-module.tsx', 2],
  ['components/modules/trip-memories-module.tsx', 1],
  ['components/modules/utilities-module.tsx', 1],
  ['components/modules/voice-module.tsx', 1],
  ['components/modules/voting-module.tsx', 4],
  ['components/modules/watchlist-module.tsx', 7],
  ['components/modules/weather-module.tsx', 2],
  ['components/modules/weekend-module.tsx', 4],
  ['components/modules/wishlists-module.tsx', 4],
  ['components/vacations/shared.tsx', 2],
  ['components/vacations/trip-budget.tsx', 1],
  ['components/vacations/trip-itinerary.tsx', 2],
  ['components/vacations/trip-overview.tsx', 1],
  ['components/vacations/trip-packing.tsx', 2],
]);

const COMPONENT_FILES = () => filesMatching("grep -rlE '\\.(update|delete)\\(' components --include='*.ts' --include='*.tsx'");

describe('the unconfirmed-write class in components/ only shrinks (C1-S9-77)', () => {
  const found = perFile(COMPONENT_FILES().flatMap(unconfirmedWritesIn));

  it('no file has MORE unconfirmed writes than its baseline', () => {
    const grew: string[] = [];
    for (const [file, n] of found) {
      const allowed = BASELINE.get(file) ?? 0;
      if (n > allowed) grew.push(`${file}: ${n} > ${allowed}`);
    }
    expect(grew, 'a write that cannot see what it changed was added').toEqual([]);
  });

  it('no file has FEWER than its baseline — a fix must prune it', () => {
    const shrank: string[] = [];
    for (const [file, allowed] of BASELINE) {
      const n = found.get(file) ?? 0;
      if (n > 0 && n < allowed) shrank.push(`${file}: ${n} < ${allowed}`);
    }
    expect(shrank, 'lower these entries to match the code').toEqual([]);
  });

  it('no NEW file joins the class', () => {
    const added = [...found.keys()].filter((f) => !BASELINE.has(f)).sort();
    expect(added, 'a file grew its first unconfirmed write').toEqual([]);
  });

  it('the baseline lists no file that is already clean', () => {
    const stale = [...BASELINE.keys()].filter((f) => !found.has(f)).sort();
    expect(stale, 'BASELINE lists files with no unconfirmed writes left — remove them').toEqual([]);
  });

  it('the baseline total matches what finalaudit.md records', () => {
    const total = [...BASELINE.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(172);
  });
});

// IMPORT-001 — the part of it that could be closed without a product decision.
//
// Three of the importer's five kinds duplicated on a re-import (tasks, grocery,
// notes) and the review step showed two of them as a bare count that reads like
// a reviewed list. Only ONE of the three has an identity the repo has already
// decided on: `lib/services/groceries/index.ts addItems` deduplicates a typed
// add "on the normalised name against OPEN items only: 'milk' added a week ago
// and already bought should be addable again, but adding it twice before the
// shop should not produce two lines." The importer borrows that rule instead of
// inventing one for a keyless list.
//
// Every case below exists because HALF the fix is worthless:
//
//   * the review has to PROPOSE the skip (`prepareImport` → `plan.grocery`), and
//   * the commit has to RE-DECIDE it, so a stale review, a second browser tab,
//     or a direct call to the server action cannot write the second copy;
//   * the scope has to be the same on both sides — the unbought items of the
//     list the import writes to — or the badge describes one set and the insert
//     obeys another;
//   * and a read that FAILS has to stop the import, because an empty duplicate
//     set reads as "you have none of this yet", which is exactly how the whole
//     file gets imported twice.
//
// The other half of the row is copy, and it is pinned here too: tasks and notes
// are still NOT de-duplicated — `chores` has no done-ness column to key "same
// chore, still open" against, and `lib/services/notes/index.ts` declines a key
// on purpose — so the review step has to SAY that in every populated locale
// rather than show a count, and the partial-failure sentence must stop promising
// the grocery duplication this change removes.
//
// No timezone surface here: an `ImportedItem` is `{ name, extra }` and carries
// no instant, which is the finding that killed the "key tasks on the due date"
// idea in the first place.
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { resolveImportedItems } from '@/lib/migrate/resolve';

const MEMBERS = [{ id: 'm-emma', displayName: 'Emma' }];

describe('the borrowed rule, in the pure resolver', () => {
  it('flags an item still to buy on the list the import writes to', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      grocery: [{ name: 'Milk' }, { name: 'Bread' }],
      existingGrocery: [{ name: 'milk' }],
    });
    expect(plan.grocery.map((g) => g.duplicate)).toEqual([true, false]);
    expect(plan.duplicateGrocery).toBe(1);
  });

  it('flags the SECOND copy inside one file, not the first', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      grocery: [{ name: 'Bananas' }, { name: 'banana' }],
    });
    // Two exports of one list is the ordinary case for a family leaving an app,
    // and the borrowed `normalizeName` is what makes "Bananas" and "banana" one
    // line rather than two — case and a trailing plural are not differences.
    expect(plan.grocery.map((g) => g.duplicate)).toEqual([false, true]);
  });

  it('proposes no owner for a grocery item, because the insert has nowhere to put one', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      grocery: [{ name: 'Emma yoghurt' }],
    });
    expect(plan.grocery[0]).toEqual({ index: 0, name: 'Emma yoghurt', duplicate: false });
  });
});

// ── The server: same rule, both halves of the flow ───────────────────────────

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { commitImport, prepareImport } from '@/app/(app)/dashboard/migrate/actions';

const FAMILY = 'family-1';
const USER = 'user-1';
const LIST = 'list-imported';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

/** Make every query against one table answer like a transport failure. */
function failReadsOn(table: string) {
  const original = db.from.bind(db) as (name: string) => unknown;
  const failing: unknown = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown) =>
          resolve({ data: null, error: { code: '08006', message: 'connection failed', details: null, hint: null }, count: null });
      }
      return () => failing;
    },
  });
  vi.spyOn(db, 'from').mockImplementation(((name: string) => (name === table ? failing : original(name))) as never);
}

/** The live import list, with one item still to buy and one already bought. */
function seedImportList() {
  db.seed('grocery_lists', [
    { id: LIST, family_id: FAMILY, name: 'Imported Groceries', is_archived: false, archived_at: null, created_by: USER },
  ]);
  db.seed('grocery_items', [
    { id: 'g-milk', family_id: FAMILY, list_id: LIST, name: 'Milk', is_checked: false, created_by: USER },
    { id: 'g-eggs', family_id: FAMILY, list_id: LIST, name: 'Eggs', is_checked: true, created_by: USER },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      grocery_lists: { is_archived: false, archived_at: null },
      grocery_items: { is_checked: false, quantity: null, category: null, source_meal_id: null, idempotency_key: null },
      chore_assignments: { status: 'todo' },
    },
  });
  db.seed('family_members', [{ id: 'm-emma', family_id: FAMILY, display_name: 'Emma', is_active: true }]);
  mocks.requireUserContext.mockResolvedValue({ user: { id: USER }, active: { familyId: FAMILY } });
  mocks.createServer.mockResolvedValue(db);
});

describe('the review step proposes the skip', () => {
  it('compares against the unbought items of the import list, so last week’s shop is importable again', async () => {
    seedImportList();
    const res = await prepareImport({
      source: 'cozi',
      grocery: [{ name: 'milk' }, { name: 'Eggs' }, { name: 'Bread' }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Milk is still on the list → already here. Eggs was bought → addable again.
    expect(res.plan.grocery.map((g) => g.duplicate)).toEqual([true, false, false]);
    expect(res.plan.duplicateGrocery).toBe(1);
  });

  it('proposes nothing already here on a family’s first import', async () => {
    const res = await prepareImport({ source: 'cozi', grocery: [{ name: 'Milk' }] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.duplicateGrocery).toBe(0);
  });

  it('fails closed rather than proposing an empty shopping list', async () => {
    seedImportList();
    failReadsOn('grocery_items');
    const res = await prepareImport({ source: 'cozi', grocery: [{ name: 'Milk' }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('migrateActions.couldNotCheckYourShoppingListForDuplicates');
    expect(res.retryable).toBe(true);
  });
});

describe('the commit re-decides it', () => {
  it('leaves out a grocery item the reviewer skipped', async () => {
    const res = await commitImport({
      source: 'cozi',
      grocery: [{ name: 'Bread' }, { name: 'Milk', skip: true }],
    });
    expect(res.ok).toBe(true);
    expect(db.table('grocery_items').map((r) => r.name)).toEqual(['Bread']);
    if (res.ok) expect(res.counts.grocery).toBe(1);
  });

  it('refuses the second copy even when the payload asks for it, which is what a stale review sends', async () => {
    seedImportList();
    // No `skip` anywhere: this is the shape a review loaded before the first
    // import finished, or a caller that never went through the wizard at all.
    const res = await commitImport({
      source: 'cozi',
      grocery: [{ name: 'milk' }, { name: 'MILKS' }, { name: 'Bread' }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(db.table('grocery_items').filter((r) => r.list_id === LIST).map((r) => r.name).sort())
      .toEqual(['Bread', 'Eggs', 'Milk']);
    expect(res.counts.grocery).toBe(1);
    expect(res.skipped).toBe(2);
  });

  it('writes into the same live list the review compared against', async () => {
    seedImportList();
    await commitImport({ source: 'cozi', grocery: [{ name: 'Bread' }] });
    expect(db.table('grocery_lists')).toHaveLength(1);
    expect(db.table('grocery_items').find((r) => r.name === 'Bread')?.list_id).toBe(LIST);
  });

  it('leaves no empty list behind when every item is already there', async () => {
    const res = await commitImport({ source: 'cozi', grocery: [{ name: 'Milk', skip: true }] });
    expect(res.ok).toBe(true);
    expect(db.table('grocery_lists')).toHaveLength(0);
    expect(db.table('grocery_items')).toHaveLength(0);
  });

  it('fails closed rather than importing a second copy when the shopping list cannot be read', async () => {
    failReadsOn('grocery_lists');
    const res = await commitImport({ source: 'cozi', grocery: [{ name: 'Milk' }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('migrateActions.couldNotCheckYourShoppingListForDuplicates');
    expect(res.retryable).toBe(true);
    expect(db.table('grocery_items')).toHaveLength(0);
  });

  it('still adds a task and a note twice, which is why the review step has to say so', async () => {
    // Not an oversight and not a gap left open by this change: `chores` has no
    // done-ness column of its own (it lives on `chore_assignments.status`), and
    // lib/services/notes/index.ts declines a key on purpose — "two identical
    // notes are two rows, which is the honest outcome". Pinned so that a silent
    // "same name, so dropped" cannot arrive without someone choosing a scope.
    await commitImport({ source: 'cozi', tasks: [{ name: 'Take the bins out' }], notes: [{ name: 'Wifi code' }] });
    await commitImport({ source: 'cozi', tasks: [{ name: 'Take the bins out' }], notes: [{ name: 'Wifi code' }] });
    expect(db.table('chores')).toHaveLength(2);
    expect(db.table('notes')).toHaveLength(2);
  });
});

// ── The copy half: the kinds that repeat say so, in every populated locale ────

const MESSAGES = path.join(process.cwd(), 'lib/i18n/messages');
/** The catalogues that hold real copy. en-GB/es-MX/es-US/fr-CA are declared placeholders. */
const POPULATED = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const catalogue = (locale: string) =>
  JSON.parse(fs.readFileSync(path.join(MESSAGES, `${locale}.json`), 'utf8')) as Record<string, string>;

describe('the review step says which kinds are added as they are', () => {
  it.each(POPULATED)('%s translates all three sentences the review step now renders', (locale) => {
    const messages = catalogue(locale);
    for (const key of [
      'migrateWizard.reviewTasksAddedAsIs',
      'migrateWizard.reviewNotesAddedAsIs',
      'migrateWizard.reviewGroceryStillToBuy',
      'migrateActions.couldNotCheckYourShoppingListForDuplicates',
    ]) {
      expect(messages[key], `${locale} is missing ${key}`).toBeTruthy();
    }
  });

  it.each(POPULATED)('%s no longer offers the bare count that read like a reviewed list', (locale) => {
    expect(catalogue(locale)['migrateWizard.reviewGroceryAndNotes']).toBeUndefined();
  });

  it('stops telling the family a failed import would duplicate their groceries', () => {
    // The failure path and the write path have to agree: grocery items are now
    // de-duplicated on a second run, so this sentence may only name tasks and
    // notes. It named all three before, and it was right to.
    const sentence = catalogue('en-US')['migrateActions.theImportStoppedPartWayThrough'];
    expect(sentence).toContain('add the tasks and notes a second time');
    expect(sentence).not.toContain('grocery items and notes a second time');
  });

  it('renders every one of those sentences through t(), rather than leaving one hardcoded', () => {
    const wizard = fs.readFileSync(path.join(process.cwd(), 'components/migrate/migrate-wizard.tsx'), 'utf8');
    for (const key of [
      'migrateWizard.reviewTasksAddedAsIs',
      'migrateWizard.reviewNotesAddedAsIs',
      'migrateWizard.reviewGroceryStillToBuy',
    ]) {
      expect(wizard).toContain(`tr('${key}'`);
    }
    expect(wizard).not.toContain('reviewGroceryAndNotes');
  });
});

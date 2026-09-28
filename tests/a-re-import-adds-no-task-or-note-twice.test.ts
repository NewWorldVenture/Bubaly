// IMPORT-001, the half the grocery fix left open: tasks and notes.
//
// A family that re-imports a corrected export used to get every task and every
// note a second time, and the review step could only warn them it would. Both
// kinds are now keyed on the WHOLE imported row — `itemKey(name, extra)`, title
// and details — against every `chores` / `notes` row in the family, the same
// way events are keyed on title + start:
//
//   * the review PROPOSES the skip (`prepareImport` → `plan.tasks` / `plan.notes`,
//     rendered with the same Already-here badge and Skip box as the other kinds),
//   * the commit RE-DECIDES it, so a stale review or a direct call to the server
//     action cannot write the second copy,
//   * a read that FAILS stops the import instead of reading as "nothing here",
//   * and a row that differs in wording (a new description, a different body)
//     is still added — the key recognises an import's own copy, it does not
//     guess that two similar chores are one.
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { resolveImportedItems } from '@/lib/migrate/resolve';

const MEMBERS = [{ id: 'm-emma', displayName: 'Emma' }];

describe('the resolver flags a task or note the family already holds', () => {
  it('matches a task on its title and details, ignoring case and spacing', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      tasks: [
        { name: 'Take the  BINS out', extra: 'Tuesday night' },
        { name: 'Take the bins out', extra: 'Friday too' },
        { name: 'Emma: tidy room' },
      ],
      existingTasks: [{ name: 'take the bins out', extra: 'Tuesday night' }],
    });
    expect(plan.tasks.map((t) => t.duplicate)).toEqual([true, false, false]);
    expect(plan.duplicateTasks).toBe(1);
    // The member proposal is untouched by the duplicate check.
    expect(plan.tasks[2].memberId).toBe('m-emma');
  });

  it('matches a note only when its title AND body match', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      notes: [
        { name: 'Wifi code', extra: 'hunter2' },
        { name: 'Wifi code', extra: 'correct-horse' },
        { name: 'Wifi code', extra: 'correct-horse' },
      ],
      existingNotes: [{ name: 'Wifi code', extra: 'hunter2' }],
    });
    // Existing copy → flagged; changed body → added; second copy in one file → flagged.
    expect(plan.notes.map((n) => n.duplicate)).toEqual([true, false, true]);
    expect(plan.duplicateNotes).toBe(2);
  });

  it('treats a missing title or body the way the insert stores it', () => {
    // The commit writes `description: extra ?? null` and `body: extra ?? ''`;
    // either way an import with no details must match its own earlier copy.
    const plan = resolveImportedItems({
      members: MEMBERS,
      tasks: [{ name: 'Hoover' }],
      notes: [{ name: 'Bins' }],
      existingTasks: [{ name: 'Hoover', extra: null }],
      existingNotes: [{ name: 'Bins', extra: '' }],
    });
    expect(plan.tasks[0].duplicate).toBe(true);
    expect(plan.notes[0].duplicate).toBe(true);
  });
});

// ── The server: the review proposes, the commit re-decides ───────────────────

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { commitImport, prepareImport } from '@/app/(app)/dashboard/migrate/actions';

const FAMILY = 'family-1';
const USER = 'user-1';
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

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { chore_assignments: { status: 'todo' } },
  });
  db.seed('family_members', [{ id: 'm-emma', family_id: FAMILY, display_name: 'Emma', is_active: true }]);
  mocks.requireUserContext.mockResolvedValue({ user: { id: USER }, active: { familyId: FAMILY } });
  mocks.createServer.mockResolvedValue(db);
});

const FILE = {
  source: 'cozi',
  tasks: [{ name: 'Take the bins out', extra: 'Tuesday night' }, { name: 'Emma: tidy room' }],
  notes: [{ name: 'Wifi code', extra: 'hunter2' }],
};

describe('a second import of the same file', () => {
  it('adds no task and no note a second time, even when the payload asks for them', async () => {
    const first = await commitImport(FILE);
    expect(first.ok && first.counts).toMatchObject({ tasks: 2, notes: 1 });
    // No `skip` anywhere: a stale review, or a caller that never used the wizard.
    const second = await commitImport(FILE);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.counts).toMatchObject({ tasks: 0, notes: 0 });
    expect(second.skipped).toBe(3);
    expect(db.table('chores')).toHaveLength(2);
    expect(db.table('notes')).toHaveLength(1);
  });

  it('still adds what changed, and assigns only the task it actually wrote', async () => {
    await commitImport(FILE);
    const res = await commitImport({
      source: 'cozi',
      tasks: [
        { name: 'Take the bins out', extra: 'Tuesday night', memberId: 'm-emma' },
        { name: 'Hoover', memberId: 'm-emma' },
      ],
      notes: [{ name: 'Wifi code', extra: 'correct-horse' }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.counts).toMatchObject({ tasks: 1, notes: 1 });
    const hoover = db.table('chores').find((r) => r.title === 'Hoover');
    expect(db.table('chore_assignments').map((a) => a.chore_id)).toEqual([hoover?.id]);
    expect(db.table('notes').map((n) => n.body).sort()).toEqual(['correct-horse', 'hunter2']);
  });

  it('is shown in the review before anything is written', async () => {
    await commitImport(FILE);
    const res = await prepareImport(FILE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.tasks.map((t) => t.duplicate)).toEqual([true, true]);
    expect(res.plan.notes.map((n) => n.duplicate)).toEqual([true]);
    expect(res.plan.duplicateTasks + res.plan.duplicateNotes).toBe(3);
  });
});

describe('a duplicate check that cannot run stops the import', () => {
  it.each([
    ['chores', 'migrateActions.couldNotCheckYourChoresForDuplicates'],
    ['notes', 'migrateActions.couldNotCheckYourNotesForDuplicates'],
  ])('when %s cannot be read, in the review and in the commit', async (table, key) => {
    failReadsOn(table);
    const review = await prepareImport(FILE);
    expect(review).toMatchObject({ ok: false, error: key, retryable: true });
    const commit = await commitImport(FILE);
    expect(commit).toMatchObject({ ok: false, error: key, retryable: true });
    expect(db.table(table)).toHaveLength(0);
  });
});

// ── The review step shows it, in every populated locale ──────────────────────

const POPULATED = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const catalogue = (locale: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'lib/i18n/messages', `${locale}.json`), 'utf8')) as Record<string, string>;

describe('the review step shows what will be skipped, not a bare count', () => {
  const wizard = fs.readFileSync(path.join(process.cwd(), 'components/migrate/migrate-wizard.tsx'), 'utf8');

  it('sends the reviewer’s skip for tasks and notes, and asks the review about notes', () => {
    expect(wizard).toContain(`skip: skipped('task', i, plan.tasks[i]?.duplicate ?? false)`);
    expect(wizard).toContain(`skip: skipped('note', i, plan.notes[i]?.duplicate ?? false)`);
    expect(wizard).toMatch(/prepareImport\(\{[^}]*notes: preview\.notes/);
  });

  it('no longer tells the family that tasks and notes are added again', () => {
    expect(wizard).not.toContain('reviewTasksAddedAsIs');
    expect(wizard).not.toContain('reviewNotesAddedAsIs');
  });

  it.each(POPULATED)('%s has the new failure sentences and drops the retired ones', (locale) => {
    const messages = catalogue(locale);
    expect(messages['migrateActions.couldNotCheckYourChoresForDuplicates']).toBeTruthy();
    expect(messages['migrateActions.couldNotCheckYourNotesForDuplicates']).toBeTruthy();
    expect(messages['migrateWizard.reviewTasksAddedAsIs']).toBeUndefined();
    expect(messages['migrateWizard.reviewNotesAddedAsIs']).toBeUndefined();
  });

  it('stops promising that a failed import would add tasks and notes a second time', () => {
    expect(catalogue('en-US')['migrateActions.theImportStoppedPartWayThrough'])
      .not.toContain('tasks and notes a second time');
  });
});

// commitImport writes each kind after reading the family's rows to de-dupe
// against, with no transaction around the two. Two consequences, pinned here:
//
//   * Two calls for the same submission running at once (a network retry of the
//     server action, a double submit) both read the de-dupe set before either
//     insert commits, and both wrote the whole file. The browser now sends a
//     submission id and the commit claims it atomically before reading.
//   * Chores and their assignments are two writes. When the assignments failed,
//     the chores stayed; the re-run the failure message invites de-duped them as
//     already here and never assigned them. The chores are now taken back, so
//     the re-run creates them again with their owners.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { commitImport } from '@/app/(app)/dashboard/migrate/actions';

const FAMILY = 'family-1';
const USER = 'user-1';
const SUBMISSION = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let claimFails = false;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  claimFails = false;
  const hits = new Map<string, number>();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { chore_assignments: { status: 'todo' }, grocery_lists: { is_archived: false, archived_at: null }, grocery_items: { is_checked: false } },
    rpc: {
      // Postgres's atomic counter, as 0156/0179 define it.
      rate_limit_hit: (args) => {
        if (claimFails) throw new Error('rate limiter unavailable');
        const key = String(args.p_key);
        if (!key.includes(`:${USER}:`)) throw new Error('rate limit key must be scoped to the authenticated caller');
        const count = (hits.get(key) ?? 0) + 1;
        hits.set(key, count);
        return [{ allowed: count <= Number(args.p_limit), retry_after: 0 }];
      },
    },
  });
  db.seed('family_members', [{ id: 'm-emma', family_id: FAMILY, display_name: 'Emma', is_active: true }]);
  mocks.requireUserContext.mockResolvedValue({ user: { id: USER }, active: { familyId: FAMILY } });
  mocks.createServer.mockResolvedValue(db);
});

const FILE = {
  source: 'cozi',
  events: [{ title: 'Piano', startsAt: '2026-11-02T16:00:00.000Z', endsAt: null, allDay: false, location: null, description: null }],
  tasks: [{ name: 'Take the bins out', extra: 'Tuesday night', memberId: 'm-emma' }, { name: 'Hoover' }],
  grocery: [{ name: 'Milk' }],
  notes: [{ name: 'Wifi code', extra: 'hunter2' }],
  contacts: [{ name: 'Dr Patel', emails: ['patel@example.test'], phones: [] }],
};

describe('two commits of the same submission at once', () => {
  it('write the file once', async () => {
    const [a, b] = await Promise.all([
      commitImport({ ...FILE, submissionId: SUBMISSION }),
      commitImport({ ...FILE, submissionId: SUBMISSION }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser).toMatchObject({ ok: false, error: 'migrateActions.thisImportWasAlreadySent' });
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('chores')).toHaveLength(2);
    expect(db.table('chore_assignments')).toHaveLength(1);
    expect(db.table('grocery_lists')).toHaveLength(1);
    expect(db.table('grocery_items')).toHaveLength(1);
    expect(db.table('notes')).toHaveLength(1);
    expect(db.table('family_contacts')).toHaveLength(1);
  });

  it('a different submission (a new commit) still runs, and still de-dupes', async () => {
    await commitImport({ ...FILE, submissionId: SUBMISSION });
    const again = await commitImport({ ...FILE, submissionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(again).toMatchObject({ ok: true, counts: { events: 0, tasks: 0, grocery: 0, notes: 0, contacts: 0 } });
  });

  it('writes nothing when the claim cannot be made', async () => {
    claimFails = true;
    const res = await commitImport({ ...FILE, submissionId: SUBMISSION });
    expect(res).toMatchObject({ ok: false, error: 'migrateActions.couldNotStartTheImport', retryable: true });
    expect(db.table('calendar_events')).toHaveLength(0);
    expect(db.table('chores')).toHaveLength(0);
  });

  it('the wizard sends one held submission id per commit', () => {
    const wizard = readFileSync('components/migrate/migrate-wizard.tsx', 'utf8');
    expect(wizard).toContain('submissionRef.current ??= newSubmissionId();');
    expect(wizard).toContain('submissionId: submissionRef.current,');
  });

  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'])('%s carries the two new sentences', (locale) => {
    const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
    expect(messages['migrateActions.thisImportWasAlreadySent']).toBeTruthy();
    expect(messages['migrateActions.couldNotStartTheImport']).toBeTruthy();
  });
});

describe('chores whose assignments could not be written', () => {
  function failAssignmentsOnce() {
    const original = db.from.bind(db) as unknown as (name: string) => Record<string, unknown>;
    let failed = false;
    vi.spyOn(db, 'from').mockImplementation(((name: string) => {
      const builder = original(name);
      if (name === 'chore_assignments' && !failed) {
        builder.insert = () => {
          failed = true;
          return { then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { code: '08006', message: 'connection failed' }, count: null }) };
        };
      }
      return builder;
    }) as never);
  }

  it('are taken back, so running the file again assigns them', async () => {
    failAssignmentsOnce();
    const first = await commitImport({ source: 'cozi', tasks: FILE.tasks });
    expect(first).toMatchObject({ ok: false, error: 'migrateActions.theImportStoppedPartWayThrough' });
    expect(db.table('chores')).toHaveLength(0);

    const second = await commitImport({ source: 'cozi', tasks: FILE.tasks });
    expect(second).toMatchObject({ ok: true, counts: { tasks: 2 }, assigned: 1 });
    const bins = db.table('chores').find((c) => c.title === 'Take the bins out');
    expect(db.table('chore_assignments')).toEqual([expect.objectContaining({ chore_id: bins?.id, member_id: 'm-emma' })]);
  });
});

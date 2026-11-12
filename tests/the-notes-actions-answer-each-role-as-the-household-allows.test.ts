// The four noticeboard actions, called the way the page calls them, by every
// household role, with valid input and with another family's ids.
//
// THE POLICY, from the sources rather than from the action:
//   - `notes` is a household resource every member reads and writes: 0004's
//     loop gives it the `is_family_member(family_id)` policies, and nothing
//     later narrows them (navigation.ts lists Notes at minLevel 0, no `manage`).
//   - A guest is refused every write by 0464's guard trigger
//     (supabase/migrations/0464_a_guest_views_the_household.sql:83, the
//     `household_write_is_not_a_guests()` trigger on `notes`), answered 42501.
//     The in-memory client cannot run a trigger, so `withGuestGuard` answers the
//     same 42501 for a guest's write to `notes` and the action's handling of it
//     is what is asserted.
//   - The family is the session's: `created_by` and `family_id` come from the
//     scope (app/(app)/dashboard/notes/actions.ts header), and a note of another
//     family is "not found" (lib/services/notes `noteForWrite`).
//
// Mocked: the session, the server client factory, next/cache and the
// translator (the real en-US source catalogue through `translate`).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import {
  CALLERS, FAMILY_A, FAMILY_B, roleOf, userIdOf, withGuestGuard, type Caller,
} from './helpers/role-callers';

const harness = vi.hoisted(() => ({
  caller: 'parent' as string | null,
  db: null as unknown,
  revalidatePath: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { harness.revalidatePath.push(path); } }));
vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller)
      : callers.signedOut()),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { saveNoteAction, setNotePinnedAction, deleteNoteAction, duplicateNoteAction } =
  await import('@/app/(app)/dashboard/notes/actions');

const NOTE_A = 'a0000000-0000-4000-8000-0000000a0001';
const NOTE_B = 'b0000000-0000-4000-8000-0000000b0001';
const PERMISSION = "You don't have permission to do that. Ask a family admin if you think this is a mistake.";
const NOT_FOUND = 'That note could not be found.';

/** Every caller the database lets write a note: everyone but a guest. */
const WRITERS: Caller[] = CALLERS.filter((c) => c !== 'guest');

let db: InMemorySupabase;
const notes = () => db.table('notes');
const noteRow = (id: string) => notes().find((row) => row.id === id) as Row | undefined;
/** Family B's rows, as a deep copy, to prove a call left them exactly as they were. */
const familyB = () => structuredClone(notes().filter((row) => row.family_id === FAMILY_B));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = withGuestGuard(db, ['notes'], () => (harness.caller ? roleOf(harness.caller as Caller) : null));
  harness.caller = 'parent';
  harness.revalidatePath = [];
  db.seed('notes', [
    { id: NOTE_A, family_id: FAMILY_A, title: 'Bins', body: 'Bins go out Tuesday', is_pinned: false, created_by: userIdOf('parent') },
    { id: NOTE_B, family_id: FAMILY_B, title: 'Theirs', body: 'Another family', is_pinned: false, created_by: userIdOf('parent', FAMILY_B) },
  ]);
});

const as = (caller: Caller | null) => { harness.caller = caller; };

describe('saveNoteAction (ACTION-F6A01A5733FD)', () => {
  it.each(WRITERS)('ACTION-F6A01A5733FD a %s creates a note in their own family, attributed to them', async (caller) => {
    as(caller);
    const result = await saveNoteAction(null, { title: 'Dentist', body: 'Thursday 4pm' });

    const created = notes().filter((row) => row.title === 'Dentist');
    expect(created).toEqual([expect.objectContaining({ family_id: FAMILY_A, body: 'Thursday 4pm', created_by: userIdOf(caller) })]);
    expect(result).toEqual({ ok: true, id: created[0].id });
    expect(harness.revalidatePath).toEqual(['/dashboard/notes']);
  });

  it.each(WRITERS)('ACTION-F6A01A5733FD a %s edits a note of their own family', async (caller) => {
    as(caller);
    const result = await saveNoteAction(NOTE_A, { title: 'Bins', body: 'Bins go out Wednesday', base: { title: 'Bins', body: 'Bins go out Tuesday' } });

    expect(result).toEqual({ ok: true, id: NOTE_A });
    expect(noteRow(NOTE_A)).toEqual(expect.objectContaining({ family_id: FAMILY_A, body: 'Bins go out Wednesday' }));
  });

  it('ACTION-F6A01A5733FD a guest is refused a new note and a change, and nothing is written', async () => {
    as('guest');
    const before = structuredClone(notes());

    expect(await saveNoteAction(null, { title: 'Grandma', body: 'Hello' })).toEqual({ ok: false, error: PERMISSION });
    expect(await saveNoteAction(NOTE_A, { title: 'Bins', body: 'Changed by a guest' })).toEqual({ ok: false, error: PERMISSION });

    expect(notes()).toEqual(before);
    expect(harness.revalidatePath).toEqual([]);
  });

  it('ACTION-F6A01A5733FD a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    const before = structuredClone(notes());
    await expect(saveNoteAction(null, { title: 'x', body: 'y' })).rejects.toThrow('NEXT_REDIRECT');
    expect(notes()).toEqual(before);
  });

  it("ACTION-F6A01A5733FD another family's note id is not found, and neither family changes", async () => {
    const before = structuredClone(notes());
    const result = await saveNoteAction(NOTE_B, { title: 'Theirs', body: 'Overwritten', base: { title: 'Theirs', body: 'Another family' } });

    expect(result).toEqual({ ok: false, error: NOT_FOUND });
    expect(notes()).toEqual(before);
  });
});

describe('setNotePinnedAction (ACTION-73BFC71CAD3A)', () => {
  it.each(WRITERS)('ACTION-73BFC71CAD3A a %s pins a note of their own family', async (caller) => {
    as(caller);
    expect(await setNotePinnedAction(NOTE_A, true)).toEqual({ ok: true, id: NOTE_A });
    expect(noteRow(NOTE_A)?.is_pinned).toBe(true);
  });

  it('ACTION-73BFC71CAD3A a guest is refused the pin and the note stays unpinned', async () => {
    as('guest');
    expect(await setNotePinnedAction(NOTE_A, true)).toEqual({ ok: false, error: PERMISSION });
    expect(noteRow(NOTE_A)?.is_pinned).toBe(false);
  });

  it("ACTION-73BFC71CAD3A another family's note id is not found and stays unpinned", async () => {
    const before = familyB();
    expect(await setNotePinnedAction(NOTE_B, true)).toEqual({ ok: false, error: NOT_FOUND });
    expect(familyB()).toEqual(before);
    expect(noteRow(NOTE_A)?.is_pinned).toBe(false);
  });
});

describe('deleteNoteAction (ACTION-06405B2537DE)', () => {
  it.each(WRITERS)('ACTION-06405B2537DE a %s deletes a note of their own family', async (caller) => {
    as(caller);
    expect(await deleteNoteAction(NOTE_A)).toEqual({ ok: true, id: NOTE_A });
    expect(noteRow(NOTE_A)).toBeUndefined();
    expect(noteRow(NOTE_B)).toBeDefined();
  });

  it('ACTION-06405B2537DE a guest is refused and the note is still there', async () => {
    as('guest');
    expect(await deleteNoteAction(NOTE_A)).toEqual({ ok: false, error: PERMISSION });
    expect(noteRow(NOTE_A)).toEqual(expect.objectContaining({ body: 'Bins go out Tuesday' }));
  });

  it("ACTION-06405B2537DE another family's note id is not found and is not deleted", async () => {
    const before = structuredClone(notes());
    expect(await deleteNoteAction(NOTE_B)).toEqual({ ok: false, error: NOT_FOUND });
    expect(notes()).toEqual(before);
  });
});

describe('duplicateNoteAction (ACTION-F1089720B176)', () => {
  it.each(WRITERS)('ACTION-F1089720B176 a %s copies a note of their own family into it', async (caller) => {
    as(caller);
    const result = await duplicateNoteAction(NOTE_A);

    const copies = notes().filter((row) => row.title === 'Copy of Bins');
    expect(copies).toEqual([expect.objectContaining({ family_id: FAMILY_A, body: 'Bins go out Tuesday', created_by: userIdOf(caller) })]);
    expect(result).toEqual({ ok: true, id: copies[0].id });
  });

  it('ACTION-F1089720B176 a guest is refused and no copy is made', async () => {
    as('guest');
    expect(await duplicateNoteAction(NOTE_A)).toEqual({ ok: false, error: PERMISSION });
    expect(notes()).toHaveLength(2);
  });

  it("ACTION-F1089720B176 another family's note is not copied, into either family", async () => {
    const before = structuredClone(notes());
    expect(await duplicateNoteAction(NOTE_B)).toEqual({ ok: false, error: NOT_FOUND });
    expect(notes()).toEqual(before);
  });
});

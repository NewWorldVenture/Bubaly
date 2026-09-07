// §7 — the family noticeboard goes through the service.
//
// `lib/services/notes` was written for one caller, the AI's `notes.create`
// tool, and carried only a create. `components/modules/notes-module.tsx` did
// the rest itself — delete, pin, duplicate, and the editor's insert-or-update —
// all filtering `id` alone.
//
// Tenancy was NOT the hole here: RLS on `notes` checks
// `is_family_member(family_id)`, so a foreign id was refused by the database.
// What the page went around were the service's OWN two rules — the length
// bounds, and the household trail line. So a family deleting a note left no
// record while Bubaly saving one did, which is §7's third symptom on a table a
// household touches every week.
import { beforeEach, describe, expect, it } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createNote, deleteNote, updateNote, MAX_BODY, MAX_TITLE } from '@/lib/services/notes';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const OTHER = 'family-2';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

/** A member — the actor whose changes the trail was missing. */
const scope: () => ServiceScope = () => ({
  db, familyId: FAMILY, userId: 'user-1', memberId: 'member-1',
  role: 'child', actorKind: 'member', tz: 'America/New_York',
});

const notes = () => db.table('notes');
const trail = () => db.table('audit_logs');

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      notes: { title: null, body: '', is_pinned: false, checklist: null, created_by: null },
      audit_logs: { resource_id: null, metadata: null },
    },
  });
  db.seed('notes', [
    { id: 'n1', family_id: FAMILY, title: 'Bins', body: 'Out on Tuesday', is_pinned: false },
    { id: 'n2', family_id: FAMILY, title: null, body: 'Call the dentist about Emma', is_pinned: false },
    { id: 'theirs', family_id: OTHER, title: 'Not ours', body: 'Another household', is_pinned: false },
  ]);
});

describe('the household trail records what a person does to a note', () => {
  it('names the note it deleted, from the row it read before deleting it', async () => {
    const res = await deleteNote(scope(), 'n1');
    expect(res.ok).toBe(true);
    expect(notes().find((n) => n.id === 'n1')).toBeUndefined();
    expect(trail().map((r) => r.metadata as { title: string })).toEqual([
      { actor: 'member', title: 'Deleted the note "Bins"' },
    ]);
  });

  it('falls back to the body when a note has no title, rather than saying "a note"', async () => {
    await deleteNote(scope(), 'n2');
    const line = trail()[0].metadata as { title: string };
    expect(line.title).toBe('Deleted the note "Call the dentist about Emma"');
  });

  it('calls a pin a pin, not a generic edit', async () => {
    await updateNote(scope(), 'n1', { pinned: true });
    expect((trail()[0].metadata as { title: string }).title).toBe('Pinned the note "Bins"');

    await updateNote(scope(), 'n1', { pinned: false });
    expect((trail()[1].metadata as { title: string }).title).toBe('Unpinned the note "Bins"');
  });

  it('calls an edit an edit when the words changed too', async () => {
    await updateNote(scope(), 'n1', { title: 'Bins', body: 'Out on Wednesday now', pinned: true });
    expect((trail()[0].metadata as { title: string }).title).toBe('Updated the note "Bins"');
  });

  it('records the verb, so the activity page can say what kind of change it was', async () => {
    await updateNote(scope(), 'n1', { body: 'Out on Wednesday' });
    await deleteNote(scope(), 'n2');
    expect(trail().map((r) => r.action)).toEqual(['update', 'delete']);
  });
});

describe('the boundary the client filter left off', () => {
  it('will not touch another household\'s note', async () => {
    const res = await updateNote(scope(), 'theirs', { body: 'changed' });
    expect(res.ok).toBe(false);
    expect(notes().find((n) => n.id === 'theirs')?.body).toBe('Another household');
  });

  it('will not delete another household\'s note', async () => {
    const res = await deleteNote(scope(), 'theirs');
    expect(res.ok).toBe(false);
    expect(notes().find((n) => n.id === 'theirs')).toBeDefined();
    expect(trail()).toEqual([]);
  });

  it('reports a note that is not there instead of succeeding silently', async () => {
    const res = await deleteNote(scope(), 'no-such-note');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('could not be found');
  });
});

describe('what a note is allowed to contain', () => {
  it('accepts a title with no body, which the page has always allowed', async () => {
    // `notes-module`'s own check is `if (!body && !title)` — EITHER is content.
    // `createNote` refused an empty body outright, so routing the page through
    // it would have turned a working note into an error.
    const res = await createNote(scope(), { title: 'Bins go out Tuesday', body: '' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.body).toBe('');
  });

  it('still refuses a note with nothing in it at all', async () => {
    const res = await createNote(scope(), { title: '   ', body: '' });
    expect(res.ok).toBe(false);
  });

  it('refuses an edit that would empty a note, rather than leaving a blank card', async () => {
    const res = await updateNote(scope(), 'n2', { body: '' });
    expect(res.ok).toBe(false);
    expect(notes().find((n) => n.id === 'n2')?.body).toBe('Call the dentist about Emma');
  });

  it('lets a titled note have its body cleared', async () => {
    const res = await updateNote(scope(), 'n1', { body: '' });
    expect(res.ok).toBe(true);
    expect(notes().find((n) => n.id === 'n1')?.body).toBe('');
  });

  it('applies the length bounds the browser never had', async () => {
    // The module has no maxLength on either field, so a family pasting a
    // document got a row nothing can render while Bubaly got a refusal.
    const long = await createNote(scope(), { body: 'x'.repeat(MAX_BODY + 1) });
    expect(long.ok).toBe(false);
    const wide = await createNote(scope(), { title: 'x'.repeat(MAX_TITLE + 1), body: 'ok' });
    expect(wide.ok).toBe(false);
    expect(notes().filter((n) => n.family_id === FAMILY)).toHaveLength(2);
  });

  it('refuses an update that changes nothing rather than writing an empty patch', async () => {
    const res = await updateNote(scope(), 'n1', {});
    expect(res.ok).toBe(false);
  });
});

describe('the colour picker writes nothing, and this is where that stops being silent', () => {
  // `notes-module` has nine colours, reads `note.color` through a
  // `Record<string, unknown>` cast, and saves it nowhere — because there is no
  // column. The cast is why the type checker never said so. Wiring it up needs
  // a migration, which is a decision rather than a cleanup, so this asserts the
  // state as it IS: the day someone adds the column, this fails and points at
  // the save that still needs to carry it.
  it('has no color column on public.notes, in the create or in any later alter', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/0002_tables.sql'), 'utf8');
    const table = sql.slice(sql.indexOf('create table if not exists public.notes'));
    expect(table.slice(0, table.indexOf(');'))).not.toMatch(/^\s*color\s/m);

    // The create is not enough on its own: a later migration could have added
    // it. Sweep them all, so this cannot pass because the column arrived
    // somewhere else.
    const added = globSync('supabase/migrations/*.sql', { cwd: process.cwd() })
      .filter((f) => /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?notes\b[\s\S]{0,200}?\bcolor\b/i
        .test(readFileSync(join(process.cwd(), f), 'utf8')));
    expect(added, 'a notes.color column exists now — wire the picker in notes-module to save it').toEqual([]);
  });
});

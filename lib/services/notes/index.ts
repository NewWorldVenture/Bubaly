// The family's shared notepad.
//
// This exists so `notes.create` can go through the same executor every other AI
// write goes through. Before it, `public.notes` was written in exactly one
// place — the hand-written chat tool in `lib/assistant/tools.ts` — which meant
// a gated "save a note" approval could be granted by a parent and then not
// execute at all, because the approval replay resolves tool names through the
// registry and the registry had never heard of `add_note`.
//
// `notes.created_by` references `auth.users` (0002_tables.sql:364), so
// `scope.userId` is the right key here. `event_rsvps.member_id` in the same
// tranche references `family_members` instead. The two are not interchangeable
// and each service resolves it per column against the migration that made it.
//
// WHAT THIS DELIBERATELY DOES NOT WRITE: `notes.checklist`. The column exists
// (0002_tables.sql:363, documented as `[{text, done}]`) and nothing in the app
// reads or writes it — `components/modules/notes-module.tsx` parses checklists
// out of the BODY text instead. A service that populated the jsonb would create
// notes whose checklist no screen can show.
import 'server-only';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type FamilyNote = Tables<'notes'>;

/**
 * The database bounds neither column, and the only cap anywhere in the app is a
 * 200-character title slice in the migrate action. A model that pastes an
 * entire email thread into `body` should get a refusal it can act on rather
 * than a row nothing can render.
 */
export const MAX_TITLE = 200;
export const MAX_BODY = 20_000;

export type CreateNoteInput = {
  title?: string | null;
  body: string;
};

export async function createNote(scope: ServiceScope, input: CreateNoteInput): Promise<ServiceResult<FamilyNote>> {
  const body = input.body?.trim() ?? '';
  const titleForEmptyCheck = input.title?.trim() ?? '';
  // A title with no body is a note — "Bins go out Tuesday" needs nothing under
  // it. `notes-module`'s own form has always allowed that ("Note must have
  // content" means EITHER), so refusing it here would have made routing the
  // page through this service a regression rather than a fix. Both empty is
  // still nothing to save.
  if (!body && !titleForEmptyCheck) {
    return fail('A note needs something written in it.', { code: SERVICE_CODES.invalidInput });
  }
  if (body.length > MAX_BODY) {
    return fail(`That note is too long — keep it under ${MAX_BODY.toLocaleString()} characters.`, { code: SERVICE_CODES.invalidInput });
  }

  const title = input.title?.trim() || null;
  if (title && title.length > MAX_TITLE) {
    return fail(`That note title is too long — keep it under ${MAX_TITLE} characters.`, { code: SERVICE_CODES.invalidInput });
  }

  // No `idempotency_key`: 0256 gave that column to six tables and `notes` is not
  // one of them, so writing it would be a PGRST204 against real schema. Two
  // identical notes are two rows, which is the honest outcome — a family that
  // writes the same reminder twice has written it twice.
  const { data, error } = await scope.db
    .from('notes')
    .insert({
      family_id: scope.familyId,
      title,
      body,
      // Attribution is advisory here — RLS on `notes` checks only
      // `is_family_member(family_id)`, so nothing stops a client writing
      // someone else's id. That is exactly why this is taken from the scope and
      // never from a caller's arguments.
      created_by: scope.userId,
    })
    .select('*')
    .single();

  if (error || !data) {
    console.error('[service:notes] create failed', error);
    return fail(describeDbError(error, 'Could not save that note.'), { code: SERVICE_CODES.db });
  }

  await recordActivitySafely(scope, {
    agent: 'notes',
    action: 'create',
    title: title ? `Saved the note "${title}"` : 'Saved a family note',
    detail: body.slice(0, 140),
    href: '/dashboard/notes',
  });
  return ok(data);
}

/**
 * Read a note the caller is allowed to write, family-scoped.
 *
 * `notes-module` filtered `id` alone on every update and delete. RLS on `notes`
 * checks `is_family_member(family_id)`, so a foreign id was refused by the
 * database rather than obeyed — but a refusal the caller cannot distinguish
 * from "no such note" is not the same as a boundary, and the row is needed
 * anyway to name what changed on the household trail.
 */
async function noteForWrite(scope: ServiceScope, noteId: string): Promise<ServiceResult<FamilyNote>> {
  if (!noteId?.trim()) return fail('Which note?', { code: SERVICE_CODES.invalidInput });

  const { data, error } = await scope.db
    .from('notes')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('id', noteId)
    .maybeSingle();
  if (error) {
    console.error('[service:notes] read failed', error);
    return fail(describeDbError(error, 'Could not read that note.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That note could not be found.', { code: SERVICE_CODES.notFound });
  return ok(data);
}

/** What a note's trail line calls it when it has no title. */
function noteTitle(note: Pick<FamilyNote, 'title' | 'body'>): string {
  const title = note.title?.trim();
  if (title) return `"${title}"`;
  const body = note.body?.trim() ?? '';
  return body ? `"${body.slice(0, 40)}${body.length > 40 ? '…' : ''}"` : 'a note';
}

export type UpdateNoteInput = {
  title?: string | null;
  body?: string;
  pinned?: boolean;
};

export async function updateNote(
  scope: ServiceScope,
  noteId: string,
  input: UpdateNoteInput,
): Promise<ServiceResult<FamilyNote>> {
  const existing = await noteForWrite(scope, noteId);
  if (!existing.ok) return existing;

  const patch: Partial<{ title: string | null; body: string; is_pinned: boolean }> = {};

  if (input.title !== undefined) {
    const title = input.title?.trim() || null;
    if (title && title.length > MAX_TITLE) {
      return fail(`That note title is too long — keep it under ${MAX_TITLE} characters.`, { code: SERVICE_CODES.invalidInput });
    }
    patch.title = title;
  }
  if (input.body !== undefined) {
    const body = input.body.trim();
    if (body.length > MAX_BODY) {
      return fail(`That note is too long — keep it under ${MAX_BODY.toLocaleString()} characters.`, { code: SERVICE_CODES.invalidInput });
    }
    patch.body = body;
  }
  if (input.pinned !== undefined) patch.is_pinned = input.pinned;

  if (Object.keys(patch).length === 0) {
    return fail('There is nothing to change on that note.', { code: SERVICE_CODES.invalidInput });
  }

  // The same emptiness rule the create side keeps, applied to what the edit
  // would PRODUCE rather than to what it sends: clearing the body of a titled
  // note is fine, clearing both is deleting it by another name.
  const nextTitle = patch.title !== undefined ? patch.title : existing.data.title;
  const nextBody = patch.body !== undefined ? patch.body : existing.data.body;
  if (!nextTitle?.trim() && !nextBody?.trim()) {
    return fail('A note needs something written in it.', { code: SERVICE_CODES.invalidInput });
  }

  // The family filter on this statement and on the delete below is
  // belt-and-braces, and NO TEST DISTINGUISHES EITHER: `noteForWrite` has
  // already read the row family-scoped and returned not-found for a foreign id,
  // so neither clause can be reached with one. They stay so that a later
  // refactor of that read cannot silently widen the write, but nothing proves
  // them and this comment says so rather than implying coverage.
  const { data, error } = await scope.db
    .from('notes')
    .update(patch)
    .eq('id', noteId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();

  if (error || !data) {
    console.error('[service:notes] update failed', error);
    return fail(describeDbError(error, 'Could not save that note.'), { code: SERVICE_CODES.db });
  }

  // A pin is a pin, not a generic edit: "Pinned the note" is what a family
  // recognises on the activity page, and burying it under "Updated a note"
  // would make the trail describe the mechanism instead of the change.
  const pinOnly = Object.keys(patch).length === 1 && patch.is_pinned !== undefined;
  await recordActivitySafely(scope, {
    agent: 'notes',
    action: 'update',
    title: pinOnly
      ? `${patch.is_pinned ? 'Pinned' : 'Unpinned'} the note ${noteTitle(data)}`
      : `Updated the note ${noteTitle(data)}`,
    href: '/dashboard/notes',
    resourceId: data.id,
  });
  return ok(data);
}

export async function deleteNote(scope: ServiceScope, noteId: string): Promise<ServiceResult<{ id: string }>> {
  const existing = await noteForWrite(scope, noteId);
  if (!existing.ok) return existing;

  const { error } = await scope.db
    .from('notes')
    .delete()
    .eq('id', noteId)
    .eq('family_id', scope.familyId);

  if (error) {
    console.error('[service:notes] delete failed', error);
    return fail(describeDbError(error, 'Could not delete that note.'), { code: SERVICE_CODES.db });
  }

  // Read the title from the row we already have: after the delete there is
  // nothing left to name it with, and a trail line saying "a note" where the
  // family wrote a heading is the hole this record exists to close.
  await recordActivitySafely(scope, {
    agent: 'notes',
    action: 'delete',
    title: `Deleted the note ${noteTitle(existing.data)}`,
    href: '/dashboard/notes',
    resourceId: noteId,
  });
  return ok({ id: noteId });
}

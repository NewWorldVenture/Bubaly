// The write path for the family noticeboard.
//
// `lib/services/notes` existed for exactly one caller — the AI's `notes.create`
// tool — and carried only a create. `components/modules/notes-module.tsx` did
// everything else itself: delete, pin, duplicate and the edit modal's
// insert-or-update, all filtering `id` alone.
//
// Nothing there was a cross-tenant hole — RLS on `notes` checks
// `is_family_member(family_id)`, so a foreign id was refused by the database —
// but the SERVICE's two rules were reachable only through Bubaly: the length
// bounds (a title over 200 or a body over 20,000 characters is a row nothing
// can render) and the household trail line. So a family deleting a note left
// no record of it while Bubaly saving one did, which is §7's third symptom on
// a table a family touches every week.
'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { createNote, deleteNote, updateNote, MAX_TITLE } from '@/lib/services/notes';
import { scopeFromUserContext } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';

const PATH = '/dashboard/notes';

export type NoteActionResult = { ok: true; id: string } | { ok: false; error: string };

/** Session + scope, resolved OUTSIDE the try: `requireUserContext` redirects by throwing. */
async function noteScope() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  return scopeFromUserContext(ctx, supabase);
}

/**
 * One action for both halves of the editor, because the module's own submit is
 * one branch: an id means edit, no id means create. `created_by` and
 * `family_id` are taken from the session here and never from the form, which is
 * what the client insert could not promise.
 */
export async function saveNoteAction(
  noteId: string | null,
  input: { title: string | null; body: string },
): Promise<NoteActionResult> {
  const scope = await noteScope();

  try {
    const result = noteId
      ? await updateNote(scope, noteId, { title: input.title, body: input.body })
      : await createNote(scope, { title: input.title, body: input.body });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[note-action] save failed', err);
    return { ok: false, error: describeActionError(err, 'Could not save that note.') };
  }
}

/**
 * The pin is sent as the value the family asked for, not as a toggle of what
 * the browser last rendered. `!note.is_pinned` from a stale card unpins a note
 * a partner just pinned on another phone; a boolean says what was meant.
 */
export async function setNotePinnedAction(noteId: string, pinned: boolean): Promise<NoteActionResult> {
  if (!noteId) return { ok: false, error: 'That note could not be found.' };
  const scope = await noteScope();

  try {
    const result = await updateNote(scope, noteId, { pinned });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[note-action] pin failed', err);
    return { ok: false, error: describeActionError(err, 'Could not pin that note.') };
  }
}

export async function deleteNoteAction(noteId: string): Promise<NoteActionResult> {
  if (!noteId) return { ok: false, error: 'That note could not be found.' };
  const scope = await noteScope();

  try {
    const result = await deleteNote(scope, noteId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[note-action] delete failed', err);
    return { ok: false, error: describeActionError(err, 'Could not delete that note.') };
  }
}

/**
 * Only an id crosses the wire: the copy is made from the note as the DATABASE
 * has it, not from the card the browser last rendered, so duplicating a note a
 * partner edited copies what they wrote rather than what this tab remembers.
 */
export async function duplicateNoteAction(noteId: string): Promise<NoteActionResult> {
  if (!noteId) return { ok: false, error: 'That note could not be found.' };
  const scope = await noteScope();

  try {
    const { data: source, error } = await scope.db
      .from('notes')
      .select('title, body')
      .eq('family_id', scope.familyId)
      .eq('id', noteId)
      .maybeSingle();
    if (error) throw error;
    if (!source) return { ok: false, error: 'That note could not be found.' };

    // "Copy of " is 8 characters the family did not type, so a note already at
    // the 200-character title bound would otherwise be un-duplicatable. Trim
    // the tail of the original rather than refusing the copy.
    const copied = source.title ? `Copy of ${source.title}`.slice(0, MAX_TITLE) : null;
    const result = await createNote(scope, { title: copied, body: source.body ?? '' });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[note-action] duplicate failed', err);
    return { ok: false, error: describeActionError(err, 'Could not duplicate that note.') };
  }
}

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
const MAX_TITLE = 200;
const MAX_BODY = 20_000;

export type CreateNoteInput = {
  title?: string | null;
  body: string;
};

export async function createNote(scope: ServiceScope, input: CreateNoteInput): Promise<ServiceResult<FamilyNote>> {
  const body = input.body?.trim() ?? '';
  if (!body) return fail('A note needs something written in it.', { code: SERVICE_CODES.invalidInput });
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
    title: title ? `Saved the note "${title}"` : 'Saved a family note',
    detail: body.slice(0, 140),
    href: '/dashboard/notes',
  });
  return ok(data);
}

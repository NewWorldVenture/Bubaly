import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// WHY THIS EXISTS. The Notes module fired browser Supabase writes and dropped
// their `error`:
//  - duplicate() ran `.insert(...)` then unconditionally toasted
//    "Note duplicated" — a failed copy (RLS denial, offline, constraint) lied
//    about success and silently lost the note.
//  - togglePin() ran `.update({ is_pinned })` and optimistically mutated the
//    viewer state, so a failed write left the UI showing a pin the DB never
//    stored.
//
// The invariant is unchanged and is the point of the file: NO SUCCESS CLAIM AND
// NO OPTIMISTIC STATE CHANGE BEFORE THE FAILURE GUARD. What changed is where
// the writes go. The §7 notes tranche moved all four —
// save, pin, delete, duplicate — off PostgREST and onto
// `app/(app)/dashboard/notes/actions.ts`, so the guard is now on `res.ok`
// rather than on a destructured `{ error }`. Rewriting it to match is the
// point; deleting it would drop the invariant along with the shape.
const src = readFileSync('components/modules/notes-module.tsx', 'utf8');

function body(fn: string): string {
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

/** Every write the module performs, and the action each one must reach. */
const WRITES = {
  togglePin: 'setNotePinnedAction',
  duplicate: 'duplicateNoteAction',
  remove: 'deleteNoteAction',
  onSubmit: 'saveNoteAction',
} as const;

describe('notes-module write boundaries fail visibly', () => {
  for (const [fn, action] of Object.entries(WRITES)) {
    it(`${fn} goes through ${action} and surfaces its failure`, () => {
      const b = body(fn);
      expect(b, `${fn} must call ${action}`).toContain(`await ${action}(`);
      expect(b, `${fn} must guard on the result`).toContain('if (!res.ok) return toastError(res.error)');
    });
  }

  it('duplicate only claims success after the failure guard', () => {
    const b = body('duplicate');
    const guard = b.indexOf('if (!res.ok) return toastError');
    const claim = b.indexOf("success(t('notesModule.noteDuplicated')");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it('remove only claims success after the failure guard', () => {
    const b = body('remove');
    const guard = b.indexOf('if (!res.ok) return toastError');
    const claim = b.indexOf("success(t('notesModule.noteDeleted')");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it('the editor only claims success after the failure guard', () => {
    const b = body('onSubmit');
    const guard = b.indexOf('if (!res.ok) return toastError');
    const claim = b.indexOf("success(t(note ? 'notesModule.noteSaved'");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it('togglePin only mutates the viewer state after the failure guard', () => {
    const b = body('togglePin');
    const guard = b.indexOf('if (!res.ok) return toastError');
    const optimistic = b.indexOf('setViewing({ ...note, is_pinned');
    expect(guard).toBeGreaterThan(-1);
    expect(optimistic).toBeGreaterThan(guard);
  });

  it('sends the pin VALUE, not a toggle of what the browser last rendered', () => {
    // `!note.is_pinned` computed from a stale card unpins a note a partner just
    // pinned on another phone. The action takes the state that was meant.
    const b = body('togglePin');
    expect(b).toMatch(/setNotePinnedAction\(note\.id,\s*next\)/);
  });

  it('writes nothing to notes from the browser', () => {
    // The read stays client-side (it is realtime); every WRITE is the service's.
    expect(src).not.toMatch(/from\('notes'\)\s*\.\s*(?:insert|update|delete|upsert)/);
  });
});

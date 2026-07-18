import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The Notes module fired two browser Supabase writes and dropped their `error`:
//  - duplicate() ran `.insert(...)` then unconditionally toasted
//    "Note duplicated" — a failed copy (RLS denial, offline, constraint) lied
//    about success and silently lost the note.
//  - togglePin() ran `.update({ is_pinned })` and optimistically mutated the
//    viewer state, so a failed write left the UI showing a pin the DB never
//    stored.
// Both must capture `error` and surface it via toastError(describeDbError(error))
// before any success claim / optimistic state change, like the sibling
// deleteNote / save paths already do.
const src = readFileSync('components/modules/notes-module.tsx', 'utf8');

function body(fn: string): string {
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

describe('notes-module write boundaries fail visibly', () => {
  for (const fn of ['togglePin', 'duplicate']) {
    it(`${fn} captures the Supabase error and toasts it`, () => {
      const b = body(fn);
      expect(b, `${fn} must destructure { error }`).toMatch(/const \{ error \} = await/);
      expect(b, `${fn} must guard on error`).toContain('if (error) return toastError(describeDbError(error))');
    });
  }

  it('duplicate only claims success after the error guard', () => {
    const b = body('duplicate');
    const guard = b.indexOf('if (error) return toastError');
    const claim = b.indexOf("success('Note duplicated");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it('togglePin only mutates the viewer state after the error guard', () => {
    const b = body('togglePin');
    const guard = b.indexOf('if (error) return toastError');
    const optimistic = b.indexOf('setViewing({ ...note, is_pinned');
    expect(guard).toBeGreaterThan(-1);
    expect(optimistic).toBeGreaterThan(guard);
  });
});

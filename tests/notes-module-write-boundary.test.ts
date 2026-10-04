import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

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

// Feedback can be fenced to a live dialog. A refused save must still return
// unconditionally, before any success claim, including when that dialog closed.
function refusalGuard(b: string): number {
  const file = ts.createSourceFile('notes.tsx', b, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let index = -1;
  const reports = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'toastError'
      && node.arguments[0]?.getText(file) === 'res.error') return true;
    if (ts.isExpressionStatement(node)) return reports(node.expression);
    if (ts.isReturnStatement(node)) return !!node.expression && reports(node.expression);
    if (ts.isIfStatement(node)) return reports(node.thenStatement);
    return ts.isBlock(node) && node.statements.some(reports);
  };
  const onlyFeedback = (branch: ts.Node): boolean => {
    let safe = true;
    const check = (node: ts.Node) => {
      if (ts.isCallExpression(node) && !reports(node)) safe = false;
      ts.forEachChild(node, check);
    };
    check(branch);
    return safe;
  };
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(file).replace(/\s/g, '') === '!res.ok') {
      const branch = node.thenStatement;
      const end = ts.isBlock(branch) ? branch.statements.at(-1) : branch;
      if (end && ts.isReturnStatement(end) && (!end.expression || reports(end.expression)) && reports(branch) && onlyFeedback(branch)) {
        index = node.getStart(file);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return index;
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
      expect(refusalGuard(b), `${fn} must report a refusal and return before success`).toBeGreaterThan(-1);
    });
  }

  it('duplicate only claims success after the failure guard', () => {
    const b = body('duplicate');
    const guard = refusalGuard(b);
    const claim = b.indexOf("success(t('notesModule.noteDuplicated')");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it('remove only claims success after the failure guard', () => {
    const b = body('remove');
    const guard = refusalGuard(b);
    const claim = b.indexOf("success(t('notesModule.noteDeleted')");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it('the editor only claims success after the failure guard', () => {
    const b = body('onSubmit');
    const guard = refusalGuard(b);
    const claim = b.indexOf("success(t(note ? 'notesModule.noteSaved'");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it('togglePin only mutates the viewer state after the failure guard', () => {
    const b = body('togglePin');
    const guard = refusalGuard(b);
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

  it('rejects refusal guards that fall through or omit feedback', () => {
    for (const branch of [
      '{ if (active.current) toastError(res.error); }',
      '{ if (active.current) { toastError(res.error); return; } }',
      '{ return; }',
      "{ toastError(res.error); success('Saved'); return; }",
      '{ const unused = () => toastError(res.error); return; }',
    ]) {
      expect(refusalGuard(`async function onSubmit() { if (!res.ok) ${branch} success('Saved'); }`)).toBe(-1);
    }
  });
});

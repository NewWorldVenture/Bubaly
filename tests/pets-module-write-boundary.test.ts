import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The Pets module's PetDetail.deleteRecord() ran a browser
// `pet_care_records.delete()` and dropped its `error` entirely — a failed
// delete (RLS denial / offline) left the record on screen with no feedback,
// looking like the click never registered. It must capture `{ error }` and
// surface it via toastError(describeDbError(error)), like every other write in
// the module.
const src = readFileSync('components/modules/pets-module.tsx', 'utf8');

function body(fn: string): string {
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

describe('pets-module deleteRecord fails visibly', () => {
  it('captures the Supabase error and toasts it', () => {
    const b = body('deleteRecord');
    expect(b, 'deleteRecord must destructure { error }').toMatch(/const \{ error \} = await/);
    expect(b, 'deleteRecord must guard on error').toContain('if (error) toastError(describeDbError(error))');
  });
});

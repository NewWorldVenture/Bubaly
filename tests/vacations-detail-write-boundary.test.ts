import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// A-13 — the trip detail tabs had three user-initiated writes that fired
// `await …update/delete(...)` and dropped the Supabase error, so a failed
// write silently no-op'd while the optimistic UI implied success (the packing
// checkbox reverts / the deleted item reappears / the dismissed recommendation
// returns on next load). Their sibling writes (packing `add`, budget
// `savePlanned`, itinerary save) already capture `{ error }` and toast it — so
// these three must too.
const packing = readFileSync('components/vacations/trip-packing.tsx', 'utf8');
const overview = readFileSync('components/vacations/trip-overview.tsx', 'utf8');

function body(src: string, fn: string): string {
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

describe('trip-packing writes fail visibly', () => {
  for (const fn of ['toggle', 'remove']) {
    it(`${fn} captures the Supabase error and toasts it`, () => {
      const b = body(packing, fn);
      expect(b, `${fn} must destructure { error }`).toMatch(/const \{ error \} = await/);
      expect(b, `${fn} must toast on error`).toContain('if (error) toastError(error.message)');
    });
  }
});

describe('trip-overview dismissReco fails visibly', () => {
  it('captures the Supabase error and toasts it', () => {
    const b = body(overview, 'dismissReco');
    expect(b).toMatch(/const \{ error \} = await/);
    expect(b).toContain('if (error) toastError(error.message)');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * RLS FILTERS a write; it does not refuse one.
 *
 * `update family_places set geofence_enabled = true where id = $1 and
 * family_id = $2` under a predicate no row satisfies updates the rows the
 * predicate admits — none — and PostgREST answers `error: null`. So a server
 * action branching on `error` alone cannot distinguish "saved" from "that row is
 * not there", and it returns `{ ok: true }` either way.
 *
 * On this surface that is not cosmetic. The geofence switch is what a parent sets
 * to be told when a child arrives somewhere, so a switch reporting ARMED over a
 * row nothing updated means the family is relying on an alert that will never
 * fire, and nothing else in the product would say so. Delete is the same shape
 * one step further: "Place deleted" over a place still on the map.
 *
 * The `.eq('family_id')` on all three already bounds them to one household — the
 * cross-family case is closed by the predicate, not by this. What is left is a
 * STALE id, which on a shared family surface is the ordinary case rather than the
 * exotic one: two parents on the locator page at once.
 */
const ACTIONS = 'app/(app)/dashboard/locator/actions.ts';

/** Line-preserving comment strip: prose is not control flow. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const source = () => withoutComments(readFileSync(`${process.cwd()}/${ACTIONS}`, 'utf8'));

function body(name: string): string {
  const code = source();
  const start = code.indexOf(`export async function ${name}(`);
  expect(start, `${name} was not found in ${ACTIONS}`).toBeGreaterThan(-1);
  const next = code.indexOf('\nexport async function ', start + 1);
  return code.slice(start, next > start ? next : code.length);
}

describe('a place write reports what it actually changed', () => {
  it.each(['savePlace', 'deletePlace', 'setGeofenceEnabled'])('%s reads the row back', (name) => {
    const fn = body(name);
    expect(fn, `${name} does not ask which row it wrote`).toContain(".select('id')");
    // The shared helper since the merge with main (C1-S9-46): `wroteNoRows`
    // over whatever this function binds its readback to.
    expect(fn, `${name} reports success over an empty result`).toMatch(/wroteNoRows\(\w+\)/);
    expect(fn, `${name} does not fail with a message`).toMatch(/return \{ ok: false, error: t\(/);
  });

  it.each(['savePlace', 'deletePlace', 'setGeofenceEnabled'])('%s stays scoped to one family', (name) => {
    const fn = body(name);
    // The readback answers "did anything change". This answers "whose row was it".
    // Both are needed: a readback over an unscoped predicate reports success for a
    // write that really did land — on another household's row.
    expect(fn).toMatch(/\.eq\('family_id', c\.active\.familyId\)/);
    expect(fn, `${name} is not manager-gated`).toMatch(/isManager\(c\.active\.role\)/);
  });

  it('the predicate is the one every other surface uses, spelled the same way', () => {
    // One helper, so a reader who has seen one recognises the other. The local
    // `changedNothing` this file had was main's `wroteNoRows` under another name,
    // and went at the merge with main (2eb62151).
    expect(source()).toMatch(/import \{[^}]*\bwroteNoRows\b[^}]*\} from '@\/lib\/supabase\/errors'/);
    expect(source()).not.toContain('function changedNothing(');
  });

  it('the error messages are catalogue keys, not English literals', () => {
    // These are the strings a parent sees when a geofence did not arm. An English
    // literal here is a product that is translated until something goes wrong.
    for (const key of [
      'actions.couldNotSaveThatPlace',
      'actions.couldNotDeleteThatPlace',
      'actions.couldNotUpdateThatGeofence',
    ]) {
      expect(source(), `${key} is not used`).toContain(key);
    }
  });
});

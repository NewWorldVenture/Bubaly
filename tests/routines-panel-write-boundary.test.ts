import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { at, bodyOf } from './helpers/source-order';

// routines-panel save() replaces a template's steps. It used to delete every
// routine_template_items row for the template and then insert the new set:
// first with a bare await that dropped the delete's error (so a failed clear
// plus a landed insert kept the OLD steps beside the new ones), and then, once
// that error was thrown, still in that order, so a refused INSERT (a lost
// connection, an out-of-range minute) left the routine with no steps at all
// (N19). The new steps now land first and are confirmed; only then are the
// old steps removed, by the ids read before the insert, and that delete must
// remove exactly that many or the new steps are taken back.
const src = readFileSync('components/modules/routines-panel.tsx', 'utf8');
const save = bodyOf(src, 'async function save() {', '\n  }\n');

describe('routines-panel replaces a routine\'s steps without ever leaving it empty', () => {
  it('the routine_template_items delete captures and throws its error', () => {
    expect(save).toContain("const { data: removed, error: delErr } = await sb.from('routine_template_items').delete()");
    expect(save).toContain('if (delErr) throw delErr');
  });

  it('the new steps are inserted and confirmed before the old ones are deleted', () => {
    const insert = at(save, ".from('routine_template_items').insert(");
    const confirmed = at(save, '(inserted?.length ?? 0) !== steps.length');
    const remove = at(save, "const { data: removed, error: delErr } = await sb.from('routine_template_items').delete()");
    expect(insert).toBeLessThan(confirmed);
    expect(confirmed).toBeLessThan(remove);
  });
});

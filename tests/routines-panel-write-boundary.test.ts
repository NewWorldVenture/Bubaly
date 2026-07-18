import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// routines-panel saveTemplate() replaces a template's steps "wholesale": it
// deletes all routine_template_items for the template, then inserts the new
// set. The delete ran with a bare await and dropped its error — if the delete
// silently failed but the insert succeeded, the template kept its OLD steps
// alongside the new ones (duplicates). The delete must throw on error (the
// surrounding try/catch already toasts) so the insert never runs on a failed
// clear.
const src = readFileSync('components/modules/routines-panel.tsx', 'utf8');

describe('routines-panel wholesale-replace clears items safely', () => {
  it('the routine_template_items delete captures and throws its error', () => {
    expect(src).toContain("const { error: delErr } = await sb.from('routine_template_items').delete()");
    expect(src).toContain('if (delErr) throw delErr');
  });

  it('the wholesale-replace insert runs after the delete guard', () => {
    const delGuard = src.indexOf('if (delErr) throw delErr');
    expect(delGuard).toBeGreaterThan(-1);
    // The re-insert of the new step set happens after the guarded clear.
    const insertAfter = src.indexOf(".from('routine_template_items').insert(", delGuard);
    expect(insertAfter).toBeGreaterThan(delGuard);
  });
});

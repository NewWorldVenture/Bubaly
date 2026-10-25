import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(resolve(process.cwd(), 'app/gift/[token]/page.tsx'), 'utf8');

describe('public gift privacy contract', () => {
  it('does not resolve identifying names for inactive gift links', () => {
    // A link whose family closed its account is inactive too, and only the
    // family's standing is read before this line — never its name
    // (tests/a-closed-familys-gift-link-takes-no-pledge.test.ts drives both).
    expect(pageSource).toContain('const active = !!link && link.is_active && !familyClosed;');
    expect(pageSource).toContain('if (active && link?.child_wallet_id)');
    expect(pageSource).toContain('if (active && link?.family_id)');
  });
});

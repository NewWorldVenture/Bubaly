import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import fs from 'node:fs';

const page = readUiSource('app/gift/[token]/page.tsx');

// PLA-0807: the public gift-redemption page must distinguish a genuinely
// missing/expired link (data null, no error → "no longer active") from a
// transient READ FAILURE (error set). On a real error the token may be valid,
// so rendering "no longer active" would wrongly turn a gift-giver away
// mid-payment — it must show a retryable message instead. The identity
// enrichment reads stay best-effort behind the active-link check.
describe('gift/[token] page read boundary', () => {
  it('captures the gift_links read error rather than dropping it', () => {
    expect(page).toContain('const { data: link, error: linkError } = await supabase');
  });

  it('renders a retryable message (not "no longer active") on a real read error', () => {
    expect(page).toContain('if (linkError) {');
    expect(page).toContain("console.error('[gift/token] gift link read failed', linkError);");
    expect(page).toContain("We couldn&apos;t load this gift link right now.");
  });

  it('still treats a missing/expired link as inactive (no error path)', () => {
    // The not-found case (data null, no error) must fall through to the
    // existing active/inactive logic, not the error branch.
    expect(page).toContain('const active = !!link && link.is_active;');
    const errIdx = page.indexOf('if (linkError) {');
    const activeIdx = page.indexOf('const active = !!link && link.is_active;');
    expect(activeIdx).toBeGreaterThan(errIdx);
  });
});

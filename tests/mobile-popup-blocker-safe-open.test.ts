import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// M-030: iOS Safari silently blocks window.open() that is not in the
// synchronous call stack of a user gesture — so every signed-URL flow
// (tap → await createSignedUrl → open) did nothing on iPhone. Those flows must
// pre-open a tab synchronously via preOpenWindow() (with a same-tab fallback),
// never call window.open after an await. Synchronous window.open in a click
// handler (social-feed permalink, contacts tel/maps, profile store link)
// remains fine and is out of scope.
const SIGNED_URL_FILES = [
  'components/modules/files-hub-module.tsx',
  'components/modules/documents-module.tsx',
  'components/modules/tax-vault-module.tsx',
  'components/modules/home-module.tsx',
  'components/admin/document-row-actions.tsx',
];

describe('signed-URL opens are popup-blocker safe (M-030)', () => {
  it('the helper pre-opens synchronously and falls back to same-tab', () => {
    const helper = readFileSync('lib/utils/open-url.ts', 'utf8');
    expect(helper).toContain("window.open('about:blank', '_blank')");
    expect(helper).toContain('w.opener = null;');
    expect(helper).toContain('window.location.assign(url);');
    expect(helper).toContain('w?.close();');
  });

  it('every signed-URL flow uses preOpenWindow and no raw window.open remains there', () => {
    for (const file of SIGNED_URL_FILES) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} should import the helper`).toContain("from '@/lib/utils/open-url'");
      expect(src, `${file} should pre-open inside the gesture`).toContain('preOpenWindow()');
      expect(src, `${file} must not window.open after an await`).not.toContain('window.open(');
    }
  });

  it('cancels the pre-opened tab on failure (no orphaned blank tabs)', () => {
    for (const file of SIGNED_URL_FILES) {
      expect(readFileSync(file, 'utf8'), file).toContain('tab.cancel()');
    }
  });
});

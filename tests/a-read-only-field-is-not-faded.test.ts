import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A11Y-001: a read-only field is content, not a disabled control. WCAG's
// contrast exception covers inactive components; a value someone reads (their
// own email on the settings page) is held to 4.5:1 like any other text. The
// settings page faded it with `opacity-60`: 4.49:1 on the light theme's
// field, measured by axe on /dashboard/settings and /family/settings. It is
// `text-muted` now, which tests/brand-contrast-contract.test.ts holds to 4.5:1
// on every ground in both themes.

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Every JSX tag that is read-only, with the file it is in. */
function readOnlyTags(): { file: string; tag: string }[] {
  const tags: { file: string; tag: string }[] = [];
  for (const file of [...sourceFiles('app'), ...sourceFiles('components')]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<(?:Input|input|Textarea|textarea)\b[^<>]*?\breadOnly\b[^<>]*?\/?>/g)) tags.push({ file, tag: m[0] });
  }
  return tags;
}

describe('a read-only field reads at full contrast', () => {
  it('finds the read-only fields (non-vacuity), the settings email among them', () => {
    const tags = readOnlyTags();
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.some(({ file, tag }) => file.endsWith('settings-module.tsx') && tag.includes('userEmail'))).toBe(true);
  });

  it('none of them is faded with opacity', () => {
    const faded = readOnlyTags().filter(({ tag }) => /\bopacity-\d+/.test(tag)).map(({ file, tag }) => `${file}: ${tag}`);
    expect(faded).toEqual([]);
  });
});

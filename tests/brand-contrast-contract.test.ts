import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_EXTENSIONS = new Set(['.css', '.ts', '.tsx']);

function collectSource(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectSource(path);
      return SOURCE_EXTENSIONS.has(extname(entry.name)) ? readFileSync(path, 'utf8') : '';
    })
    .join('\n');
}

describe('accessible brand color roles', () => {
  it('defines separate action-background and text colors in both themes', () => {
    const globals = readFileSync(resolve('app/globals.css'), 'utf8');
    const tailwind = readFileSync(resolve('tailwind.config.ts'), 'utf8');

    expect(globals.match(/--brand-text:/g)).toHaveLength(2);
    expect(tailwind).toContain("text: 'rgb(var(--brand-text) / <alpha-value>)'");
  });

  it('does not reuse the solid brand color for text', () => {
    const source = [collectSource(resolve('app')), collectSource(resolve('components')), collectSource(resolve('lib'))].join('\n');
    expect(source).not.toMatch(/\btext-brand(?!-[A-Za-z0-9])/);
  });
});

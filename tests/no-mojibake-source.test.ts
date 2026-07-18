import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('no-mojibake-source.test.ts')
        ? [path]
        : [];
  });
}

const mojibakeSequences = [
  'Ã¢â‚¬',
  'Ã‚Â·',
  'Ã°Å¸',
  'Ã¢â‚¬â„¢',
  'Ã¢â‚¬Å“',
];

// PLA-0812: user-facing source strings across ~79 admin/marketing/marketplace/
// module files carried classic UTF-8->cp1252 double-encoding mojibake (e.g.
// `â€"` for `—`, `Â·` for `·`, `â€œ`/`â€\x9d` for curly quotes, `ðŸ¥ž` for 🥞),
// which rendered as garbage in the UI (browser titles, labels, emoji). After the
// repair, no source file may reintroduce these sequences.
describe('no mojibake in source strings (regression guard)', () => {
  it('has zero classic mojibake sequences in app/, lib/, components/', () => {
    // Match the unambiguous double-encoding lead sequences. Scoped to shipped
    // source (.ts/.tsx), excluding this guard file itself.
    const out = sourceFiles('app')
      .concat(sourceFiles('lib'), sourceFiles('components'))
      .flatMap((path) => {
        const contents = readFileSync(path, 'utf8');
        return mojibakeSequences.some((sequence) => contents.includes(sequence)) ? [path] : [];
      })
      .join('\n');
    expect(out, `mojibake reintroduced:\n${out.split('\n').slice(0, 20).join('\n')}`).toBe('');
  });
});

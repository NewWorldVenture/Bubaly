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
  // The five above are the damage encoded a second time, which is what a file
  // looks like after being mis-saved twice. These three are the single round
  // trip the header below describes: the lead of the dash, curly quotes and
  // ellipsis, the middle dot, and the lead of every emoji. They are written as
  // escapes so this list cannot itself be re-encoded into one that never matches.
  '\u00e2\u20ac',
  '\u00c2\u00b7',
  '\u00f0\u0178',
];

// What UTF-8 text looks like when it is read back as cp1252.
const readAsCp1252 = (text: string) => new TextDecoder('windows-1252').decode(Buffer.from(text, 'utf8'));

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

  it('recognises the characters PLA-0812 repaired once they are double-encoded', () => {
    // The scan above is only as good as its list. Each of these is a character
    // the repair restored; mis-decoded once, it must be caught.
    for (const repaired of ['Admin · Settings', 'Bubaly — family', 'don’t', '“quoted”', 'wait…', '🥞']) {
      const broken = readAsCp1252(repaired);
      expect(broken).not.toBe(repaired);
      expect(mojibakeSequences.filter((sequence) => broken.includes(sequence)), broken).not.toEqual([]);
    }
  });
});

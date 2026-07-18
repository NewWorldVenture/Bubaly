import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

// PLA-0812: user-facing source strings across ~79 admin/marketing/marketplace/
// module files carried classic UTF-8->cp1252 double-encoding mojibake (e.g.
// `â€"` for `—`, `Â·` for `·`, `â€œ`/`â€\x9d` for curly quotes, `ðŸ¥ž` for 🥞),
// which rendered as garbage in the UI (browser titles, labels, emoji). After the
// repair, no source file may reintroduce these sequences.
describe('no mojibake in source strings (regression guard)', () => {
  it('has zero classic mojibake sequences in app/, lib/, components/', () => {
    // Match the unambiguous double-encoding lead sequences. Scoped to shipped
    // source (.ts/.tsx), excluding this guard file itself.
    let out = '';
    try {
      out = execSync(
        "grep -rInP '\\xc3\\xa2\\xe2\\x82\\xac|\\xc3\\x82\\xc2\\xb7|\\xc3\\xb0\\xc5\\xb8|\\xc3\\xa2\\xe2\\x82\\xac\\xe2\\x84\\xa2|\\xc3\\xa2\\xe2\\x82\\xac\\xc5\\x93' " +
          "app lib components --include='*.ts' --include='*.tsx' " +
          "| grep -v 'no-mojibake-source.test.ts' || true",
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
      ).trim();
    } catch {
      out = '';
    }
    expect(out, `mojibake reintroduced:\n${out.split('\n').slice(0, 20).join('\n')}`).toBe('');
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Security ratchet (mandate: close security gaps). Shipping code must never use
// dynamic code evaluation — `eval(...)` or `new Function(...)` — which turn any
// string that reaches them into executable code (a classic injection sink).
// Verified clean at authoring time (0 hits across app/ + lib/ + components/).
//
// Note on adjacent surfaces reviewed but intentionally NOT ratcheted here:
// the 3 `dangerouslySetInnerHTML` uses were audited and are safe — marketing
// JSON-LD escapes `<`→< (</script>-breakout guard), the theme script is a
// static developer string, and the QR code renders the `qrcode` library's
// self-contained geometry SVG (the encoded value becomes modules, never markup).
// That surface is legitimately used, so pinning an allowlist would just create
// cross-agent build friction; the clear zero-tolerance invariant is eval/Function.
const ROOTS = ['app', 'lib', 'components'];
const EVAL = /\beval\s*\(/;
const NEW_FUNCTION = /\bnew\s+Function\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !/\.(test|spec)\.[tj]sx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('no dynamic code evaluation in shipping code', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('uses no eval() or new Function()', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (EVAL.test(src)) offenders.push(`${f} :: eval()`);
      if (NEW_FUNCTION.test(src)) offenders.push(`${f} :: new Function()`);
    }
    expect(offenders, `dynamic code evaluation found:\n${offenders.join('\n')}`).toEqual([]);
  });
});

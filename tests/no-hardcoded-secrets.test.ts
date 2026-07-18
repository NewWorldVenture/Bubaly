import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Security ratchet (mandate: close security gaps + credential rotation). Shipping
// code (app/ + lib/ + components/) must contain NO hardcoded secret material —
// every key/secret/token comes from process.env. Verified clean at authoring
// time (0 hits); this guard fails CI if a live Stripe key, Supabase service-role
// JWT, GitHub PAT, Google/AWS/Slack key, or private key is ever committed inline.
// Patterns require a plausible key BODY (20+ chars / real segment lengths) so a
// bare prefix in a comment (e.g. "verify against RESEND_WEBHOOK_SECRET (whsec_…)")
// or `secret.replace(/^whsec_/, '')` is not a false positive.
const ROOTS = ['app', 'lib', 'components'];

const SECRET_PATTERNS: [string, RegExp][] = [
  ['Stripe secret/restricted key', /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}\b/],
  ['Stripe/webhook signing secret', /\bwhsec_[A-Za-z0-9]{20,}\b/],
  ['GitHub personal access token', /\bghp_[A-Za-z0-9]{36}\b/],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{35}\b/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['JWT (e.g. Supabase service-role key)', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['PEM private key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
];

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

describe('no hardcoded secrets in shipping code', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('contains no inline secret material — every secret comes from process.env', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const [label, re] of SECRET_PATTERNS) {
        if (re.test(src)) offenders.push(`${f} :: ${label}`);
      }
    }
    expect(offenders, `hardcoded secrets found:\n${offenders.join('\n')}`).toEqual([]);
  });
});

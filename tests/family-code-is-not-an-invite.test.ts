import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// `families.family_code` is generated and uniquely indexed by 01100, and the
// Family screen shows it. Nothing in the product REDEEMS one: there is no route,
// server action or RPC that reads it as an input. Every reference is a write, a
// display, or the migration that creates it. The only working join path is
// /join?token=… -> rpc('accept_invite', p_token), matching `invites.token`,
// which has no relationship to the family code.
//
// The Invite modal used to lead with it — big monospace string, copy button, and
// the line "Share your family code so a new member can join". Whoever received
// it had nowhere to type it.
//
// (marketplace_circles.join_code DOES have a redemption path, at 0176:
//  `where join_code = upper(trim(p_code))`. The same feature was built for
//  circles and never for families, which is how this got missed.)
//
// This holds the invariant in both directions: while no redemption path exists,
// nothing may present the code as a way to join. Build the redemption path and
// this test tells you it is safe to advertise it again.

const ROOT = join(__dirname, '..');

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.test(e)) out.push(p);
  }
  return out;
}

/** Does anything read family_code as an INPUT (a lookup, not a write/display)? */
function redemptionPath(): string[] {
  const hits: string[] = [];
  const files = [
    ...walk(join(ROOT, 'app'), /\.tsx?$/),
    ...walk(join(ROOT, 'lib'), /\.tsx?$/),
    ...walk(join(ROOT, 'supabase/migrations'), /\.sql$/),
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // A lookup keyed on the code: `.eq('family_code', …)` or `where family_code = …`
    if (/\.eq\(\s*['"]family_code['"]/.test(src) || /where\s+family_code\s*=/i.test(src)) {
      hits.push(relative(ROOT, f).split(sep).join('/'));
    }
  }
  return hits;
}

describe('the family code is not advertised as something it cannot do', () => {
  it('finds the code in the codebase at all (guards the guard)', () => {
    const anywhere = walk(join(ROOT, 'components'), /\.tsx$/)
      .some((f) => readFileSync(f, 'utf8').includes('family_code'));
    expect(anywhere).toBe(true);
  });

  it('either a redemption path exists, or nothing offers the code as a way to join', () => {
    const redemption = redemptionPath();
    if (redemption.length > 0) return; // someone built it — advertise away

    const modal = readFileSync(join(ROOT, 'components/modules/family-module.tsx'), 'utf8');
    const invite = modal.slice(modal.indexOf('function InviteModal'));
    expect(
      /family_code|\bcode\b/.test(invite.slice(0, invite.indexOf('</Modal>'))),
      'the Invite modal presents a family code, but nothing in the product redeems one — '
      + 'build the redemption RPC (see marketplace_circles.join_code in 0176) or do not offer it',
    ).toBe(false);
  });

  it('the working join path is still the token one', () => {
    const rpcs = readFileSync(join(ROOT, 'supabase/migrations/0005_rpcs.sql'), 'utf8');
    expect(rpcs).toMatch(/function public\.accept_invite\(p_token text\)/);
    expect(rpcs).toMatch(/where token = p_token/);
  });
});

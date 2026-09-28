import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `rate_limit_hit` (0179) refuses a key from a signed-in caller unless the key
// names that caller's own id: `p_key !~ ('(^|:)' || auth.uid() || '(:|$)')`
// raises. The limiter treats a raised call as "cannot evaluate" and fails
// closed, so the route answers 429 to every request, forever, with nothing in
// the key's own text to say so.
//
// That is what /api/email/invite did. Its bucket was `email:invite:<familyId>`,
// evaluated on the member's session client, so every invite email was refused
// and the invite form reported, every time, that it could not send the
// invitation. Found by retesting the route on a local stack with every
// migration applied.
//
// So: wherever a rate-limit key is evaluated on a SESSION client
// (`createServer()`), the key must carry the caller's user id. A key meant for
// a household or an address (family-wide, per IP) belongs on the service
// client, which has no `auth.uid()` and is exempt, as every public route here
// already does.

const ROOTS = ['app', 'lib'];
const CALL = /\b(enforceRequestRateLimit|rateLimitDb|enforceAIRateLimit)\(/g;
const DEFINITIONS = new Set(['lib/server/rate-limit-db.ts', 'lib/server/request-rate-limit.ts', 'lib/server/ai-rate-limit.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The first two arguments of the call whose `(` is at `open`, split at depth 0. */
function firstTwoArgs(src: string, open: number): [string, string] | null {
  const args: string[] = [];
  let depth = 0;
  let inTemplate = false;
  let start = open + 1;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '`') inTemplate = !inTemplate;
    if (inTemplate) continue;
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) { args.push(src.slice(start, i).trim()); break; }
      depth--;
    } else if (c === ',' && depth === 0) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
      if (args.length === 2) break;
    }
  }
  return args.length >= 2 ? [args[0], args[1]] : null;
}

type Kind = 'session' | 'service' | 'unknown';

function clientKind(src: string, expr: string): Kind {
  if (/^createServiceClient\(\)$/.test(expr)) return 'service';
  if (/^(await\s+)?createServer\(\)$/.test(expr)) return 'session';
  if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return 'unknown';
  const decl = new RegExp(`\\b(?:const|let)\\s+${expr}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`, 'g');
  const kinds = new Set<Kind>();
  for (const m of src.matchAll(decl)) {
    if (/createServiceClient\(/.test(m[1])) kinds.add('service');
    else if (/createServer\(/.test(m[1])) kinds.add('session');
    else kinds.add('unknown');
  }
  return kinds.size === 1 ? [...kinds][0] : 'unknown';
}

function keyText(src: string, expr: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return expr;
  const m = new RegExp(`\\bconst\\s+${expr}\\s*=\\s*(\`[^\`]*\`)`).exec(src);
  return m ? m[1] : expr;
}

const sites = ROOTS.flatMap((r) => walk(r))
  .filter((f) => !DEFINITIONS.has(f))
  .flatMap((file) => {
    const src = readFileSync(file, 'utf8');
    return [...src.matchAll(CALL)].map((m) => {
      const args = firstTwoArgs(src, m.index! + m[0].length - 1);
      if (!args) return { file, client: 'unknown' as Kind, key: '?' };
      return { file, client: clientKind(src, args[0]), key: keyText(src, args[1]) };
    });
  });

describe('a rate-limit key evaluated on a signed-in session names the caller', () => {
  it('finds the call sites at all', () => {
    // Non-vacuity: an empty set would pass everything below.
    expect(sites.length).toBeGreaterThan(30);
    expect(sites.filter((s) => s.client === 'session').length).toBeGreaterThan(10);
  });

  it("every key not provably on the service client carries the caller's user id", () => {
    // A client this file cannot resolve (one destructured from an auth helper,
    // say) may well be the caller's session, so it is held to the same rule
    // rather than let through unexamined.
    const offenders = sites
      .filter((s) => s.client !== 'service')
      .filter((s) => !/\buser\.id\b|\buserId\b|\bactorId\b/.test(s.key))
      .map((s) => `${s.file}: ${s.key}`);
    expect(offenders, 'rate_limit_hit refuses these on a session client, and the limiter then fails closed (429 forever)').toEqual([]);
  });

  it('the family-wide invite bound is evaluated on the service client', () => {
    const invite = sites.filter((s) => s.file === 'app/api/email/invite/route.ts');
    expect(invite).toHaveLength(1);
    expect(invite[0].client).toBe('service');
    expect(invite[0].key).toContain('familyId');
  });
});

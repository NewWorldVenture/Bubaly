// Every exported function in a 'use server' module is a POST endpoint, and this
// asserts that each one reaches an authentication call — with a short list of named
// exceptions, each of which is public or pre-auth on purpose.
//
// The repository measured this once (439 exported actions, 9 reaching no auth)
// and never ratcheted it, so nothing stopped a tenth. Re-measuring found the
// nine, and three of them were a class the repo had already named in
// tests/server-actions-contract.test.ts's own header — "a parser has no business
// being an endpoint" — found once in the recurring-ads module, fixed there, and
// never swept for elsewhere:
//
//   inboxRequestText            a pure string formatter, one in-module caller
//   paperworkInsertRow          builds a row object; the CALLER inserts it,
//                               after requireUserContext. Exported only so a
//                               test could pin the payload.
//   previewMarketIntentAction   a regex classifier over a string — and no
//                               callers anywhere in the tree.
//
// None of the three read or wrote anything, so none was a disclosure; each was
// an unauthenticated endpoint that did not need to exist. The first is now
// un-exported, the second lives in lib/paperwork/triage.ts beside the helpers it
// calls (the test imports it from there, so the reason it was exported
// survives), and the third is deleted.
//
// TWO ASSERTIONS EXIST TO STOP THIS PASSING VACUOUSLY. Writing the analyser
// produced exactly the bug this whole file guards against: the first version
// only captured `export function` declarations, so a local `assertSuperAdmin()`
// was invisible and it reported 100 unguarded actions instead of 9. A detector
// that cannot see an auth call reports every action as unguarded; one that
// cannot see an action reports none. Both directions are pinned below.
// Audit C1-S7-02.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'supabase', 'mobile']);

/**
 * Names that establish who is calling. A local wrapper counts too — the
 * fixpoint below credits any function that calls one of these, directly or
 * through another function in the same module.
 */
const AUTH_CALL = /\b(requireUserContext|requireUser|requireMember|requireFamily|requireSocialPermission|requireMarketingAdmin|requireAdmin|requireSuperAdmin|assertSuperAdmin|assertAdmin|isSuperAdmin|getUserContext|getUser|familyId)\s*\(/;

/**
 * The six that legitimately reach no auth call, each with the reason. A new
 * entry here is a deliberate decision to publish an endpoint, which is exactly
 * the review this list exists to force.
 */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  'app/(auth)/actions.ts::childSignInAction': 'a sign-in: there is no session yet, by definition',
  'app/(auth)/signup/actions.ts::rememberReferralCodeAction': 'writes a referral cookie before any account exists',
  'app/gift/actions.ts::submitGiftPledgeAction': 'public gift flow behind an unguessable link, rate-limited, caps pending pledges',
  'app/reviews/new/actions.ts::submitReviewAction': 'public review submission behind an unguessable token',
  'app/s/[slug]/actions.ts::submitResponseAction': 'public survey response behind an unguessable slug',
  'lib/i18n/actions.ts::setLocale': 'sets the locale cookie; touches no family data',
  // Added by the parallel session's auth work. All five run BEFORE a session
  // exists — that is the point of them — so no `requireUser`-shaped call can
  // appear and this scan cannot credit them. They are not unauthenticated:
  // each one's credential is the thing it was handed. CREDENTIAL_GATED below
  // pins that, so "pre-auth" cannot quietly become "unchecked".
  'app/(auth)/auth/complete/actions.ts::completeCallbackAction': 'completes a sign-in; the owned PKCE verifier IS the credential, and there is no session yet by definition',
  'app/(auth)/auth/recovery/actions.ts::prepareRecoveryAction': 'password recovery before any session; the emailed implicit tokens are the credential',
  'app/(auth)/auth/recovery/actions.ts::consumeRecoveryAction': 'password recovery; timing-safe compare of the handoff against the recovery cookie, then a grant verification',
  'app/(auth)/auth/recovery/actions.ts::inspectRecoveryAction': 'password recovery; reads identity only after verifying the grant against the cookie token',
  'app/(auth)/auth/recovery/actions.ts::saveRecoveryAction': 'password recovery; the grant plus the cookie token are verified inside updateRecoveryPassword before any write',
};

/**
 * A pre-auth action is exempt from "reaches an auth call", NOT from having a
 * credential. This table names the check each one must still reach. Without it
 * the exception list above would be the only thing standing between a password
 * change and an unauthenticated caller — an allow-list entry is a sentence in a
 * test file, and sentences do not fail builds.
 */
const CREDENTIAL_GATED: Record<string, RegExp> = {
  'app/(auth)/auth/complete/actions.ts::completeCallbackAction': /completeCallback\s*\(/,
  'app/(auth)/auth/recovery/actions.ts::prepareRecoveryAction': /prepareImplicitRecovery\s*\(/,
  'app/(auth)/auth/recovery/actions.ts::consumeRecoveryAction': /timingSafeEqual\s*\([\s\S]*?verifyRecoveryGrant\s*\(/,
  'app/(auth)/auth/recovery/actions.ts::inspectRecoveryAction': /verifyRecoveryGrant\s*\(/,
  'app/(auth)/auth/recovery/actions.ts::saveRecoveryAction': /updateRecoveryPassword\s*\(/,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Every function in the file, exported or not, by brace matching. Local
 * helpers matter: an action that authenticates only through a private
 * `assertSuperAdmin()` is guarded, and a scan that skips non-exported
 * declarations calls it unguarded.
 */
const DECL = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g;

function functionBodies(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(DECL)) {
    let i = match.index! + match[0].length;
    for (let depth = 1; i < source.length && depth > 0; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
    }
    // First '{' at angle-bracket depth zero: a return type such as
    // Promise<Result<{ a: b }>> carries braces that are not the body.
    let angle = 0;
    let open = -1;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '<') angle += 1;
      else if (c === '>') angle = Math.max(0, angle - 1);
      else if (c === '{' && angle === 0) { open = i; break; }
    }
    if (open < 0) continue;
    let depth = 0;
    let close = open;
    for (; close < source.length; close += 1) {
      if (source[close] === '{') depth += 1;
      else if (source[close] === '}' && --depth === 0) break;
    }
    out.set(match[1] ?? match[2], source.slice(open, close));
  }
  return out;
}

type Action = { key: string; guarded: boolean };

function analyse(): Action[] {
  const actions: Action[] = [];
  for (const file of walk(process.cwd())) {
    const source = readFileSync(file, 'utf8');
    if (!/^['"]use server['"];?$/.test((source.split('\n')[0] ?? '').trim())) continue;

    const bodies = functionBodies(source);
    const guarded = new Set([...bodies].filter(([, b]) => AUTH_CALL.test(b)).map(([n]) => n));
    for (let changed = true; changed; ) {
      changed = false;
      for (const [name, body] of bodies) {
        if (guarded.has(name)) continue;
        for (const helper of guarded) {
          if (new RegExp(`\\b${helper}\\s*\\(`).test(body)) { guarded.add(name); changed = true; break; }
        }
      }
    }

    const exported = new Set([
      ...[...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]),
      ...[...source.matchAll(/export\s+const\s+(\w+)\s*=/g)].map((m) => m[1]),
    ]);
    const rel = file.slice(process.cwd().length + 1);
    for (const name of exported) {
      if (!bodies.has(name)) continue;
      actions.push({ key: `${rel}::${name}`, guarded: guarded.has(name) });
    }
  }
  return actions;
}

describe("every 'use server' export reaches an auth call", () => {
  const actions = analyse();

  it('finds the actions at all', () => {
    // A scan that matches nothing reports no unguarded action.
    expect(actions.length).toBeGreaterThan(400);
  });

  it('credits an action that authenticates through a private local helper', () => {
    // The bug this file was written with: adminSetUserBanAction reaches auth
    // only via a non-exported `assertSuperAdmin()`. A scan that reads exported
    // declarations alone calls it unguarded — and then calls ~100 others
    // unguarded too, burying the real six in noise.
    const admin = actions.find((a) => a.key.endsWith('::adminSetUserBanAction'));
    expect(admin, 'adminSetUserBanAction should be in the scan').toBeDefined();
    expect(admin!.guarded, 'must be credited through the private assertSuperAdmin helper').toBe(true);
  });

  it('leaves exactly the actions that are public or pre-auth on purpose', () => {
    const unguarded = actions.filter((a) => !a.guarded).map((a) => a.key).sort();
    expect(unguarded).toEqual(Object.keys(PUBLIC_BY_DESIGN).sort());
  });

  it('gives a reason for every exception', () => {
    for (const [key, reason] of Object.entries(PUBLIC_BY_DESIGN)) {
      expect(reason.length, `${key} needs a reason a reviewer can weigh`).toBeGreaterThan(20);
    }
  });

  it('still requires a credential check in every pre-auth action that claims one', () => {
    for (const [key, pattern] of Object.entries(CREDENTIAL_GATED)) {
      const [rel, name] = key.split('::');
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      const start = src.indexOf(`export async function ${name}`);
      expect(start, `${key} is listed as credential-gated but no longer exists`).toBeGreaterThan(-1);
      const next = src.indexOf('\nexport ', start + 1);
      const body = src.slice(start, next === -1 ? src.length : next);
      expect(pattern.test(body), `${key} no longer reaches its credential check (${pattern})`).toBe(true);
    }
    // Every credential-gated action must also be a declared exception, so one
    // cannot be quietly dropped from PUBLIC_BY_DESIGN and left only here.
    for (const key of Object.keys(CREDENTIAL_GATED)) expect(PUBLIC_BY_DESIGN).toHaveProperty(key);
  });
});

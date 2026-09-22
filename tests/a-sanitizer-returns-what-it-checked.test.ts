import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSameOriginPath, safeInternalRedirect } from '@/lib/auth/redirect';
import { isSafeReturnPath, stepUpPath } from '@/lib/auth/mfa';
import { resolveAuthSelection } from '@/lib/billing/review-selection';

// SEC-014. `safeInternalRedirect` validated the string it was GIVEN and
// returned a different string it never validated.
//
// `/..//evil.com` passes every input test — one leading slash, no backslash, no
// encoded separator — and `new URL('/..//evil.com', base)` resolves it to the
// pathname `//evil.com`, because `..` cannot climb above the root and simply
// vanishes. The parsed URL's origin is still the sentinel base, so the origin
// check passes too. Returning `pathname + search + hash` then handed the caller
// a protocol-relative URL.
//
// Reached, not theorised:
//
//   /login?redirect=/..//evil.com
//     -> resolveAuthSelection(params).next === '//evil.com'
//     -> components/auth/login-form.tsx: const destination = redirectDest || …
//     -> router.push('//evil.com')
//     -> https://evil.com/
//
// after a successful sign-in on the genuine domain, which is the whole value of
// the primitive to a phisher. The raw value would have been harmless: a browser
// resolving `/..//evil.com` against the origin keeps the origin. It was the
// sanitizer's own normalization that created the dangerous string.
//
// The other sinks — callback-completion, phone-auth, native-bootstrap — took
// their value through the sanitizer TWICE, and the second pass rejected
// `//evil.com` on input. They were saved by a round trip, not by a rule.

const ORIGIN = 'https://app.bubaly.com';

/** Where a browser actually goes, which is the only question that matters. */
function origin(path: string): string {
  try { return new URL(path, `${ORIGIN}/login`).origin; } catch { return 'PARSE-ERROR'; }
}

const ATTACKS = [
  '//evil.com', '///evil.com', '\\\\evil.com', '/\\evil.com', '/\\\\evil.com', '\\/evil.com',
  '/..//evil.com', '/../..//evil.com', '/a/..//evil.com', '/..///evil.com',
  '/foo/../..//evil.com', '/..//evil.com/path?x=1', '/..//@evil.com',
  '/%2f%2fevil.com', '/%5c%5cevil.com', '/..%2f%2fevil.com',
  '/a\\b', '/a%5Cb', '/./\\/evil.com', '/.\\/evil.com', '/..\\//evil.com',
  'https://evil.com', 'http://evil.com', '//evil.com/path', '//@evil.com',
  'javascript:alert(1)', '',
];

const LEGITIMATE = [
  '/dashboard', '/dashboard/billing?view=manage', '/join?token=abc',
  '/a/b/c#frag', '/dashboard?q=a+b', '/onboarding?reviewPlan=plus_annual',
];

describe('a sanitizer returns what it checked (SEC-014)', () => {
  it('nothing safeInternalRedirect returns leaves the origin', () => {
    const leaks: string[] = [];
    for (const attack of ATTACKS) {
      const out = safeInternalRedirect(attack, '/home');
      if (out === '/home') continue; // refused
      if (origin(out) !== ORIGIN) leaks.push(`${JSON.stringify(attack)} -> ${JSON.stringify(out)} -> ${origin(out)}`);
    }
    expect(leaks, leaks.join('\n')).toEqual([]);
  });

  it('refuses the exact strings that escaped', () => {
    // Named individually so a future relaxation cannot pass by shrinking the
    // corpus above.
    for (const attack of ['/..//evil.com', '/a/..//evil.com', '/..///evil.com', '/foo/../..//evil.com', '/..//@evil.com']) {
      expect(safeInternalRedirect(attack, '/home'), attack).toBe('/home');
    }
  });

  it('the login-form chain no longer leaves the origin', () => {
    // resolveAuthSelection -> selection.next -> router.push, in one pass, which
    // is what login-form.tsx does.
    for (const attack of ['/..//evil.com', '/a/..//evil.com', '/..///evil.com']) {
      const next = resolveAuthSelection(new URLSearchParams({ redirect: attack })).next;
      expect(next, attack).toBeNull();
    }
    // and a real invite destination still survives the same path
    expect(resolveAuthSelection(new URLSearchParams({ redirect: '/join?token=abc' })).next).toBe('/join?token=abc');
  });

  it('still accepts every legitimate application path unchanged', () => {
    for (const path of LEGITIMATE) {
      expect(safeInternalRedirect(path, '/home'), path).toBe(path);
      expect(isSafeReturnPath(path), path).toBe(true);
      expect(origin(path), path).toBe(ORIGIN);
    }
  });

  it('the output is judged by the same rule as the input', () => {
    // The defect in one sentence: a value that passes going in can fail coming
    // out, and only re-checking catches it.
    expect(isSameOriginPath('/..//evil.com')).toBe(true);
    expect(isSameOriginPath('//evil.com')).toBe(false);
    expect(safeInternalRedirect('/..//evil.com', '/home')).toBe('/home');
  });

  it('the two implementations of the rule agree on every attack', () => {
    // They used to be separate copies and disagreed on eight of these.
    const disagree: string[] = [];
    for (const attack of ATTACKS) {
      const a = safeInternalRedirect(attack, '\u0000REFUSED') !== '\u0000REFUSED';
      const b = isSafeReturnPath(attack);
      if (a !== b) disagree.push(`${JSON.stringify(attack)}: safeInternalRedirect ${a ? 'accepts' : 'refuses'}, isSafeReturnPath ${b ? 'accepts' : 'refuses'}`);
    }
    expect(disagree, disagree.join('\n')).toEqual([]);
  });

  it('the step-up link falls back rather than carrying an attack', () => {
    for (const attack of ['/..//evil.com', '//evil.com', '/\\evil.com']) {
      expect(stepUpPath(attack), attack).toBe('/auth/step-up?next=%2Fdashboard');
    }
    expect(stepUpPath('/dashboard/billing?view=manage')).toBe('/auth/step-up?next=%2Fdashboard%2Fbilling%3Fview%3Dmanage');
  });

  it('there is one same-origin rule, not a second copy', () => {
    const mfa = readFileSync('lib/auth/mfa.ts', 'utf8');
    expect(mfa).toContain("from '@/lib/auth/redirect'");
    // The copy that drifted: an inline `startsWith('//')` test in mfa.ts.
    const code = mfa.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/startsWith\('\/\/'\)/);
  });

  it('every navigation target has a provenance somebody checked', () => {
    // The scan that would have found SEC-014: a router push or a redirect whose
    // argument is a binding, not a literal. All of these were traced by hand;
    // the baseline records what each one is, so a NEW navigation to an
    // unaudited value fails here rather than shipping.
    //
    // Keyed by file and variable rather than by line, so an edit above does not
    // fail it and a new sink does.
    const TRUSTED: Record<string, string> = {
      'app/(app)/auth/step-up/page.tsx|next': 'isSafeReturnPath(rawNext) ? rawNext : \'/dashboard\'',
      'components/auth/callback-completion.tsx|target': "safeInternalRedirect(receipt.destination, '')",
      'components/auth/callback-completion.tsx|destination': "safeInternalRedirect(next, '/home') — a second pass over an already-sanitized prop, which is what saved this sink from SEC-014",
      'components/auth/phone-auth.tsx|destination': "safeInternalRedirect(next, '/onboarding') — likewise a second pass",
      'app/api/blog/unsubscribe/route.ts|home': "new URL('/blog', req.nextUrl.origin) — a constant path",
      'components/app/command-bar.tsx|r.href': 'NAV_CATALOG, the static navigation catalogue',
      'components/app/command-bar.tsx|data.redirect': 'runPagePath(runId) / purchaseApprovalPath(id) — server-built templates with encodeURIComponent, never model text',
      'components/auth/join-invite.tsx|landing': 'resolveLandingPathAction(), a server action',
      'components/auth/login-form.tsx|destination': 'resolveAuthSelection(params).next, or resolveLandingPathAction() — THE SEC-014 SINK',
      'components/auth/signup-form.tsx|next': 'nextDest = resolveAuthSelection(params).next',
      'components/capture/capture-shell.tsx|created.href': 'HREF[tableForKind(kind)], a constant map in lib/capture/save.ts',
      'components/capture/capture-shell.tsx|routed.url': 'the capture router, from the same constant map',
      'components/concierge/ask-bubaly.tsx|data.redirect': 'as command-bar',
      'components/concierge/ask-bubaly.tsx|top.href': 'routeCommand(query, NAV_ITEMS) — NAV_ITEMS is static',
      'components/modules/handle-it-button.tsx|data.redirect': 'as command-bar',
      'components/native/native-bootstrap.tsx|target': 'safeInternalRedirect(parsed.pathname, ...)',
      'lib/auth/require-aal2.ts|decision.to': 'stepUpPath(), which applies isSafeReturnPath',
      'lib/services/onboarding-calendar/oauth.ts|url': 'the provider authorization URL — deliberately external',
      'lib/services/onboarding-calendar/oauth.ts|authUrl': 'the provider authorization URL — deliberately external',
    };

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) files.push(full);
      }
    };
    for (const root of ['app', 'components', 'lib']) walk(root);

    const seen = new Set<string>();
    const unaudited: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = /(?:router\.(?:push|replace)|NextResponse\.redirect|[^.\w]redirect)\(\s*([A-Za-z_$][\w$.]*)\s*[),]/.exec(lines[i]);
        if (!m) continue;
        const key = `${file}|${m[1]}`;
        seen.add(key);
        if (!(key in TRUSTED)) unaudited.push(`${file}:${i + 1} — navigates to \`${m[1]}\`, whose provenance is not recorded`);
      }
    }
    expect(unaudited, unaudited.join('\n')).toEqual([]);

    // And the baseline must not outlive its sinks, or it stops describing the code.
    const stale = Object.keys(TRUSTED).filter((k) => !seen.has(k));
    expect(stale, `no longer present: ${stale.join(', ')}`).toEqual([]);
  });

  it('the AI cannot choose where the browser goes', () => {
    // data.redirect is pushed by three components. Every producer of it must be
    // a path builder, never a string the planner emitted.
    const intake = readFileSync('lib/ai/runs/intake.ts', 'utf8');
    const produced = [...intake.matchAll(/redirect:\s*([^,}\n]+)/g)].map((m) => m[1].trim());
    expect(produced.length).toBeGreaterThanOrEqual(8);
    for (const value of produced) {
      expect(value, `redirect: ${value}`).toMatch(/^(null|runPagePath\(|outcome\.href \?\? null$)/);
    }
    // The one that is not a runPagePath: purchase advice, built from an id.
    expect(readFileSync('lib/ai/planner/purchase-advice.ts', 'utf8')).toContain('const href = purchaseApprovalPath(result.approvalId);');
    expect(readFileSync('lib/ai/chat-request.ts', 'utf8')).toContain('return `/dashboard/concierge/runs/${encodeURIComponent(runId)}`;');
    expect(readFileSync('lib/purchases/private-result.ts', 'utf8')).toContain('return `/dashboard/assistant/purchases/${encodeURIComponent(approvalId)}`;');
  });
});

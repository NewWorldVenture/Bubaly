import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The meta-guard for audit C4-S5-01.
 *
 * `expect(source).toContain('requireMarketingAdmin')` asserts that the
 * identifier is SPELLED somewhere in the file — and an ES module that imports a
 * helper spells it on the import line. Every call site can be deleted and the
 * guard stays green. Claude-4 proved exactly that for 46 assertions across 30
 * files by rewriting each call to `__neutered(` and leaving the import alone;
 * among them an authorization gate, a money audit-log write, four request-size
 * bounds and a cron auth check.
 *
 * The repository already knew the fix and applied it about a fifth of the time
 * (`tests/cron-auth.test.ts:49` has it, `:54` did not): assert the CALL by
 * including the opening paren. This test keeps the bare form from returning for
 * the helpers that were actually proved vacuous.
 *
 * Two limits, stated rather than implied:
 *  - It is a named-helper ratchet, not a general rule. Repo-wide there are
 *    several hundred bare `toContain('ident')` assertions; only the helpers
 *    below have been mutation-tested, and a list of names is the honest scope.
 *  - `success` is deliberately absent: it is an ordinary English word as well
 *    as a toast helper, and a ratchet on it would fail on prose.
 */
const CALL_ONLY = [
  'createServiceClient',
  'describeActionError',
  'durableCookieOptions',
  'fetchPublicText',
  'getMarketingCustomersWithError',
  'getProviderAccessToken',
  'hasConfiguredVariant',
  'hasCronAuthorization',
  'hasInternalSecret',
  'logMarketingAudit',
  'logWalletAudit',
  // Renamed from `markFailedAndThrow` by the parallel session, which also made it
  // distinguish a failure before the provider boundary (retryable) from one
  // after it (status stays 'sending', outcome 'unknown').
  'markFailure',
  'marketingActionFailure',
  'readBoundedRequestBytes',
  'readBoundedRequestFormData',
  'readBoundedRequestJson',
  'requireMarketingAdmin',
  'sharedCaptureText',
  'submitAIRequest',
  'summarizeDigestDelivery',
  'toastError',
];

describe('boundary guards assert the call, not the spelling', () => {
  it('no test asserts a boundary helper by bare identifier', () => {
    const offenders: string[] = [];
    for (const file of readdirSync('tests').filter((f) => f.endsWith('.test.ts'))) {
      // Blank comments, keeping line numbers: this file's own docstring names
      // the helpers it forbids, and a guard that matches its own explanation is
      // the defect one rung up.
      const source = readFileSync(`tests/${file}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, '');
      source.split('\n').forEach((line, i) => {
        for (const helper of CALL_ONLY) {
          if (line.includes(`'${helper}'`) && line.includes('toContain')) {
            offenders.push(`tests/${file}:${i + 1} ${helper}`);
          }
        }
      });
    }
    expect(offenders, "append '(' to the literal so the assertion needs a call site").toEqual([]);
  });

  it('the helpers it names are real exports, so the list cannot rot into decoration', () => {
    // A ratchet over names nobody defines any more would pass forever while
    // guarding nothing, so each name must still be defined as an export.
    const roots = ['lib', 'app', 'components'];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
      }
    };
    roots.forEach(walk);
    const haystack = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    // Definition shapes this repo actually uses: an exported or local function,
    // a const (including an inline arrow), and the destructured rename that
    // binds a hook's member — `const { error: toastError } = useToast()`.
    const defined = (h: string) => new RegExp(
      `(function|const|let)\\s+${h}\\b|:\\s*${h}\\s*[,}]`,
    ).test(haystack);
    const undefinedHelpers = CALL_ONLY.filter((h) => !defined(h));
    expect(undefinedHelpers, 'drop them from CALL_ONLY or fix the name').toEqual([]);
  });
});

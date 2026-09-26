import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';
import { expectTranslates } from './helpers/translated';

/**
 * Audit C1-S9-71 — the last five files in tests/silent-empty-read-ratchet.test.ts.
 *
 * Each read bound only `data`. Triaged by the rule the rest of this pass uses:
 * fix what gives a DIFFERENT answer, log what gives a SMALLER one. One of the
 * five gave a different answer — the billing fee disclosure — and four were
 * smaller answers whose only defect was an error nobody would ever see.
 *
 * Both directions are guarded: the fee branch must say something, and the four
 * logged reads must NOT be escalated into a failed page or an emptied list.
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (p: string) => strip(readFileSync(p, 'utf8'));

/** From `needle` to the brace that closes the block it opens. */
function block(src: string, needle: string): string {
  const start = at(src, needle);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced after ${needle}`);
}

describe('the service fee is never silently undisclosed (billing)', () => {
  const page = read('app/(app)/dashboard/billing/page.tsx');

  it('a refused fee-settings read is checked before the fee decision', () => {
    // The `catch` beneath it cannot see a resolved error, so without this the
    // refused read reached `serviceFeeEnabled(null)` → false → no notice, and a
    // configured fee went unmentioned until the Stripe page.
    expect(page).toMatch(/const \{ data, error \} = await createServiceClient\(\)\s*\n\s*\.from\('stripe_settings'\)/);
    expect(at(page, 'if (error) {')).toBeLessThan(at(page, 'else if (serviceFeeEnabled(data))'));
  });

  it('the error branch says something true either way, and logs', () => {
    const branch = block(page, 'if (error) {');
    expect(branch).toContain("serviceFeeNotice = t('billing.serviceFeeShownAtCheckout');");
    expect(branch).toContain('console.error(');
    // It cannot know the amount, so it must not state one…
    expect(branch).not.toContain('formatServiceFee');
    // …and a notice is not a reason to fail the whole plans page.
    expect(branch).not.toMatch(/\breturn\b|\bthrow\b|notFound\(|redirect\(/);
    expectTranslates(page, 'billing.serviceFeeShownAtCheckout', 'Any Bubaly service fee is shown at checkout, before you pay.');
  });

  it('the configured-fee notice is translated, and still names the amount', () => {
    // It was an English literal handed to a translated module.
    expect(page).toContain("t('billing.serviceFeeAddedAtCheckout', { fee: formatServiceFee(resolveServiceFeeCents(data)) })");
    const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
    expect(en['billing.serviceFeeAddedAtCheckout']).toBe('A one-time {fee} Bubaly service fee is added at checkout.');
    expect(page).not.toMatch(/serviceFeeNotice = ['`]/);
  });

  it('every base catalogue carries both notices, with the {fee} placeholder kept', () => {
    for (const loc of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const m = JSON.parse(readFileSync(`lib/i18n/messages/${loc}.json`, 'utf8')) as Record<string, string>;
      expect(m['billing.serviceFeeAddedAtCheckout'], loc).toContain('{fee}');
      expect(m['billing.serviceFeeShownAtCheckout'], loc).toBeTruthy();
    }
  });
});

describe('the four smaller answers are logged, not escalated', () => {
  it.each([
    {
      file: 'app/(app)/dashboard/money-timeline/page.tsx',
      bind: 'error: statusError } = await supabase',
      log: "if (statusError) console.error('[money-timeline]",
      // Every insight shown unacknowledged is a smaller answer; the timeline
      // itself must still render.
      keeps: 'for (const row of data ?? []) statusByKey[row.dedupe_key] = row.status;',
    },
    {
      file: 'app/(app)/missions/page.tsx',
      bind: "error: signError } = await supabase.storage.from('chore-proof').createSignedUrl(",
      log: "if (signError) console.error('[missions] proof signing failed'",
      // C1-S9-29's count is what states the gap to the parent; logging must
      // sit beside it, not replace it.
      keeps: 'if (data?.signedUrl) mediaUrls.push(data.signedUrl);',
    },
    {
      file: 'components/app/app-context.tsx',
      bind: 'const { data, error } = await supabase',
      log: "if (error) console.error('[app-context] member roster refresh failed",
      // A refused refresh keeps the roster on screen; it must never empty it.
      keeps: 'if (data) setMembers(data);',
    },
    {
      file: 'components/concierge/plan-write-backs.tsx',
      bind: "const { data, error } = await sb.from('concierge_plan_actions')",
      log: "if (error) console.error('[concierge] applied write-backs read failed'",
      keeps: 'if (active && data) setApplied(',
    },
  ])('$file binds the error, logs it, and keeps its fallback', ({ file, bind, log, keeps }) => {
    const src = read(file);
    expect(at(src, bind)).toBeLessThan(at(src, log));
    expect(at(src, log)).toBeLessThan(at(src, keeps));
    // The log is a statement of its own, not the head of a bail.
    const line = src.slice(at(src, log), src.indexOf('\n', at(src, log)));
    expect(line).not.toMatch(/\breturn\b|\bthrow\b|\{\s*$/);
  });

  it('the roster refresh does not empty the roster on a refused read', () => {
    const src = read('components/app/app-context.tsx');
    expect(src).not.toMatch(/setMembers\(\s*\[\]\s*\)/);
  });

  it("plan-write-backs' fallback is safe because the server re-reads the ledger and refuses", () => {
    // The component shows nothing as applied when its read fails, so a manager
    // may tap "apply" on something already done. That is only safe while the
    // materializer refuses to act on a ledger it could not read.
    const svc = read('lib/services/approvals/index.ts');
    const fn = block(svc, 'export async function materializeConciergePlan(');
    const bail = block(fn, 'if (existingError) {');
    // Re-pointed under C1-S9-72 from `return [];`. The refusal is the same; it
    // now also says which kinds are NOT known to exist, instead of handing
    // back the shape that means "already in place".
    expect(bail).toContain('return { applied: [], failed: targets };');
    expect(at(fn, 'if (existingError) {')).toBeLessThan(at(fn, 'for (const kind of targets)'));
  });
});

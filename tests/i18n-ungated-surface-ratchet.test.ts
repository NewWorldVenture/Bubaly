import { describe, expect, it } from 'vitest';
import { scanPaths } from '../scripts/i18n-scan.mjs';

// `app/` + `components/` is deliberately NOT in GATED_SURFACES, and the reason
// in scripts/i18n-scan.mjs is a good one: it was gated once on the strength of a
// zero from a scanner that could not see copy in a data structure, and widening
// the scanner turned that zero into thousands. A surface gated while dirty
// teaches everyone to ignore the gate.
//
// But "it goes back in the list when it scans clean" has no force on its own.
// Between that decision and this file nothing stopped the number growing, and
// nothing would have reported it if it had.
//
// So: a ratchet rather than a gate. The surface does not have to be clean; it
// has to not get worse. This is the same shape as
// tests/silent-empty-read-ratchet.ts, for the same reason.
//
// ── On the number, and a wrong conclusion worth recording ────────────────────
//
// The comment beside GATED_SURFACES records 2,343. Today's scan says 2,812,
// which reads like 469 strings of drift. It is not. Measured with ONE scanner
// held fixed — today's — against both trees:
//
//     current scanner, tree at 0babad30 (when 2,343 was written)   2,903
//     current scanner, tree today                                  2,812
//
// The surface has improved by 91. The apparent increase was the scanner getting
// better at seeing strings — exactly the improvement that produced the 2,343 in
// the first place. Comparing two numbers from two different scanners says
// nothing about the code, and the obvious reading of it was backwards.
//
// Which is also the warning for whoever trips this test: a stricter scanner
// raises the count without a single new hardcoded string being written. That is
// a legitimate reason to raise CEILING, and it is the ONLY one. Say which in
// the commit.
//
// Raised 2,812 -> 2,899 for exactly that reason (I18N-002). The scanner now reads
// a failure message or a toast written as a template literal —
// `error: \`Blocked by household policy: ${reason}\``, `toastError(\`Upload
// failed: ${msg}\`)` — which NOT_COPY's backtick rule had hidden. Measured with
// the tree held fixed: 2,810 before, 2,835 with action errors, 2,899 with toasts
// too; every one of the 89 is a message that already shipped in English.
//
// Then lowered to 2,888 as eleven of them were translated: the Family Wallet's
// toasts and its "Only … available in Spend." refusal, which children see. A
// ceiling that is not lowered when strings are fixed lets them come back free.
//
// Lowered again to 2,872 as sixteen module toasts were translated: copied,
// snoozed, approved, saved, disconnected, a file too large, a pin limit.
//
// Then to 2,848 as 24 more module/vacation toasts were translated: declutter,
// graph, language, moving, planning, projects, routines, scan, shopping,
// weather, workload, calendar, fridge-chef, moments and the trip screens.
//
// Then to 2,835 as the AI daily-limit, sync, weather, social-feed, language,
// medical and feedback-upload messages were translated (the feedback one is
// now a generic message that no longer leaks the storage error).
//
// Then to 2,822 as the thirteen "Blocked by household policy: …" refusals in
// the wallet, money and invest actions were translated — reason included: the
// trust engine's deny paths now carry a catalogue key and code-valued params.
const CEILING = 2822;

describe('the ungated i18n surface does not get worse', () => {
  const findings = scanPaths(['app', 'components']);
  const total = findings.reduce((n: number, r: { findings: unknown[] }) => n + r.findings.length, 0);

  it('scans the surface it claims to (non-vacuity)', () => {
    // A scanner that silently found nothing would satisfy the ceiling forever.
    expect(findings.length).toBeGreaterThan(400);
    expect(total).toBeGreaterThan(1000);
  });

  it(`has no more than ${CEILING} hardcoded strings in app/ + components/`, () => {
    expect(
      total,
      `Hardcoded strings on the ungated surface went UP (${total} > ${CEILING}).\n` +
      'If you added user-visible copy: lift it into lib/i18n/messages/en-US.json,\n' +
      'translate it in the base catalogues, and render it through t().\n' +
      'If you made the scanner stricter: that raises the count without any new\n' +
      'hardcoded string, and is the one legitimate reason to raise CEILING here.\n' +
      'Say which in the commit message — the two are indistinguishable from the\n' +
      'number alone, and reading one as the other gets the direction backwards.',
    ).toBeLessThanOrEqual(CEILING);
  });

  it('lowers the ceiling when the surface improves', () => {
    // A ratchet nobody tightens is a ceiling that drifts up to meet the code.
    // This fails once the gap is wide enough to be worth banking.
    expect(
      CEILING - total,
      `The surface is ${CEILING - total} strings better than the ceiling — lower CEILING to ${total}.`,
    ).toBeLessThan(150);
  });
});

describe('the scanner sees a failure message written as a template literal (I18N-002)', () => {
  it('reports it, with each interpolation shown as a placeholder', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { scanFile } = await import('../scripts/i18n-scan.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'i18n-scan-'));
    const file = join(dir, 'action.ts');
    writeFileSync(file, [
      "export async function a(reason: string) {",
      "  if (reason) return { ok: false, error: `Blocked by household policy: ${reason}` };",
      "  return { ok: false, error: describeActionError(e, `Could not save ${name}.`) };",
      "}",
      "export function B() {",
      "  const { error: toastError } = useToast();",
      "  toastError(`Upload failed: ${message}`);",
      "}",
    ].join('\n'));
    const texts = scanFile(file).map((f: { text: string }) => f.text);
    expect(texts).toContain('Blocked by household policy: …');
    expect(texts).toContain('Could not save ….');
    expect(texts).toContain('Upload failed: …');
  });
});

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
//
// Then to 2,819 with the calendar-sync count and the admin campaign-send and
// lead-score recompute toasts.
//
// Then to 2,802 as the Guardian dashboard was localized as a whole: its
// status contexts, call statuses, stat tiles, heading and both toasts.
//
// Then to 2,800 with the care log: its type labels (chips, entries, picker)
// now come from the catalogue rather than an English constant in lib/.
//
// Then to 2,799 with the moving module's status labels, the same shape.
//
// Then to 2,794 as the last five were translated: the social post-permission
// refusal, the marketplace order-step error (which also stopped echoing the
// caller's status), the admin feedback and ticket-status messages, and the
// voice module's route confirmations. Every template finding the scanner can
// see is now translated; what remains here is ordinary strings.
//
// Raised 2,794 -> 2,936 for the one legitimate reason (I18N-003): the scanner
// now also reads a template literal in a copy-carrying attribute (aria-label,
// title, placeholder, alt, label, description) and one standing alone as a JSX
// child. Measured with the tree held fixed: 142 attribute templates, 0 JSX-child
// ones (the tree's child templates are separators such as ` · ${when}`), every
// one an existing English string a screen reader or tooltip already shows. The
// gated surfaces stay at zero.
//
// Then lowered to 2,934 (two strings translated with A11Y-003 and MAIN-F-D06:
// the contact list's "Unknown" and the notes list's "Untitled"), and raised
// 2,934 -> 2,969 for the one legitimate reason (I18N-005): the scanner now also
// reads a confirm() prompt, template or quoted. Measured with the tree held
// fixed: 35 English questions asked right before something is deleted.
// All 35 then translated (28 confirmPrompt.* keys), 2,969 -> 2,934.
// Then 63 of I18N-003's attribute templates ("Edit ${name}", "Move ${x} up",
// "Approve: ${title}") through 34 shared itemAction.* keys, and the assistant
// pane's "New conversation" fallback, 2,934 -> 2,870.
// Then batch 2: 70 context-specific attribute templates (wallet dialog titles,
// star ratings with a one/many split, inventory, closet, routing placeholders,
// theme toggle, OTP digits and more), 2,870 -> 2,800.
// Then the scanner got more precise: it no longer reads TypeScript between two
// generics (`type A = Tables<'a'>; type B = Tables<'b'>`) as a JSX text node.
// 125 findings were that, not copy, 2,800 -> 2,675.
// Then the medical and dental records page and its printed sheets: per-kind
// catalogue sentences instead of "Add {Doctor}" and "{Dental} Providers",
// 2,675 -> 2,664.
const CEILING = 2664;

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

describe('the scanner sees copy written as a template in an attribute or a JSX child (I18N-003)', () => {
  it('reports the copy shapes and leaves expressions alone', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { scanFile } = await import('../scripts/i18n-scan.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'i18n-scan-'));
    const file = join(dir, 'row.tsx');
    writeFileSync(file, [
      'export function Row({ title, n, name, id }: { title: string; n: number; name: string; id: string }) {',
      '  return (',
      '    <li className={`row ${id}`} key={`row-${id}`}>',
      '      <button aria-label={`Approve: ${title}`} title={`${name} — upgrade to unlock`} />',
      '      <p>{`${n} items left`}</p>',
      '      <p>{` · ${name}`}</p>',
      '      <a href={`/items/${id}`}>{name}</a>',
      '    </li>',
      '  );',
      '}',
    ].join('\n'));
    const texts = scanFile(file).map((f: { text: string }) => f.text);
    expect(texts).toContain('Approve: …');
    expect(texts).toContain('… — upgrade to unlock');
    expect(texts).toContain('… items left');
    // A class list, a key, an href and a bare separator are not copy.
    expect(texts.some((t: string) => /row|items\/|^·/.test(t) && !t.includes('left'))).toBe(false);
  });
});

describe('the scanner sees the question asked before a delete (I18N-005)', () => {
  it('reports a confirm() prompt, template or quoted', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { scanFile } = await import('../scripts/i18n-scan.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'i18n-confirm-'));
    const file = join(dir, 'row.tsx');
    writeFileSync(file, [
      'export function Row({ name, on }: { name: string; on: () => void }) {',
      '  const del = () => { if (confirm(`Remove ${name} from the inventory?`)) on(); };',
      "  const wipe = () => { if (window.confirm('Delete everything in this list?')) on(); };",
      '  return <button onClick={() => { del(); wipe(); }} />;',
      '}',
    ].join('\n'));
    const texts = scanFile(file).map((f: { text: string }) => f.text);
    expect(texts).toContain('Remove … from the inventory?');
    expect(texts).toContain('Delete everything in this list?');
  });
});

describe('the scanner does not count TypeScript as copy', () => {
  it('ignores a type alias between generics and still reports real text beside it', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { scanFile } = await import('../scripts/i18n-scan.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'i18n-types-'));
    const file = join(dir, 'row.tsx');
    writeFileSync(file, [
      "type Tables<T> = { t: T };",
      "type Member = Tables<'family_members'>; type Plan = Tables<'plans'>;",
      'export function Row({ m }: { m: Member; p?: Plan }) {',
      '  return <p>Nothing planned this week</p>;',
      '}',
    ].join('\n'));
    const texts = scanFile(file).map((f: { text: string }) => f.text);
    expect(texts.some((t: string) => /type Plan/.test(t))).toBe(false);
    expect(texts).toContain('Nothing planned this week');
  });
});

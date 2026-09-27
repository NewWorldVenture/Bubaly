import { describe, expect, it } from 'vitest';
import { scanPaths, scannedFileCount } from '../scripts/i18n-scan.mjs';

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
// a legitimate reason to raise CEILING. Say which in the commit.
//
// ── A SECOND legitimate reason, and it arrived the way the first one did ─────
//
// The line above used to end "and it is the ONLY one". It is now two, and the
// second is named here rather than left for someone to argue into existence: a
// MERGE OF TWO INDEPENDENTLY-DEVELOPED TREES. This file was born on main and
// does not exist on the audit branch at 617355b2, so 2,812 was measured over
// ONE tree and had never been held over the other. The merge pointed it at 198
// commits of code it had never scanned. That moves the number for exactly the
// reason a stricter scanner moves it — the instrument is now aimed at code it
// did not previously see — and NOT because anyone wrote a new hardcoded string.
//
// Both reasons share one obligation, which is the whole point of this comment
// block: the number alone cannot distinguish them, so the derivation gets
// written down and the classification is done site by site.
//
// METHOD. The same one the paragraph above uses, and for the same reason: hold
// ONE scanner fixed and vary the tree. Today's scanner, over three trees:
//
//     617355b2  the audit branch's pre-merge tip     2,823
//     origin/main                                    2,811
//     HEAD      the merge of the two                 2,823
//
// So the merge added NOTHING. The audit branch was already at 2,823 on its own,
// main was at 2,811, and the merged tree is the union with no drift on top.
//
// AND A WRONG READING THAT NEARLY LANDED, which is the same trap recorded
// above in a new costume. The first run of this measurement archived only
// `app` and `components` out of each tree — the two paths scanPaths is given.
// But the scanner also reads lib/i18n/messages/INVARIANT.txt, the file that
// says "Bubaly" and the other proper nouns are NOT to be translated, and a
// MISSING invariant file falls back to an EMPTY SET without a word. Both old
// trees therefore scored with every proper noun counted as a finding — 2,846
// and 2,835 — which made the merged tree look like an improvement over both
// and pointed the conclusion in precisely the wrong direction. Two numbers
// from two differently-configured scanners say nothing about the code, twice
// over now. If you re-run this, archive lib/i18n/messages/INVARIANT.txt too.
//
// THE TWELVE, CLASSIFIED. The audit branch's surplus over main was twelve
// findings in seven files, and NOT ONE was newly-shipped untranslated product
// copy. Six were removed on their own merits and six remain, by decision:
//
//   5  date-format PATTERN KEYS — 'MMM d' and 'MMM d, yyyy', passed as
//      `absolutePattern` from five UI call sites. Both are in format.ts's
//      PATTERNS map, so they routed through Intl.DateTimeFormat(code, options)
//      and were already locale-correct; the scanner was reading a mechanism as
//      copy. REMOVED ANYWAY, and not to buy five off this ceiling: `fmtDate`
//      answers an UNMAPPED pattern by falling through to date-fns `format()`,
//      which carries no locale, so a typo ('MMM D') would have failed nowhere
//      and quietly shipped English month names to all eleven locales. The
//      option is now `absoluteWithYear?: boolean`, which is what all seven
//      call sites were choosing between all along.
//   1  `label: 'The AI assistant'` — the only one of eleven assertAIAccess
//      callers passing a label, interpolated into "… is part of Family+".
//      Now derived from FEATURE_CATALOG_BY_KEY[featureKey].label, so the
//      upgrade prompt names the feature the way the plan page the reader is
//      being sent to names it. 'ai-requests' is itself labelled 'Ask Bubaly',
//      so the other ten callers read exactly as before.
//   6  guardian/page.tsx READ-FAILURE DIAGNOSTICS — 'member profiles',
//      'calls today', 'scams stopped' and three more. NOT converted at the
//      time, and the reason was that this ceiling already accepted the same
//      class from main: command-center's 'open chores', 'meal plans' and
//      'expiring docs', and the equivalents on calm and activity, are all
//      inside the 2,811. Every one rendered as
//      `${label}: ${describeReadError(error)}`, and that second half is a
//      Postgres string nothing can translate — so a translated label read
//      "Mitgliederprofile: relation … does not exist". Converting one of the
//      six pages would have left two conventions for one diagnostic, which is
//      the half-conversion this codebase keeps deciding is worse than either
//      end. It is a class, and it gets closed as a class or recorded as one.
//
// 2,823 − 6 = 2,817.
//
// ── AND THE CLASS IS NOW CLOSED AS A CLASS: 2,817 − 10 = 2,807 (I18N-006) ────
//
// The paragraph above was right that translating the label alone makes the
// defect worse, and wrong to conclude from it that the labels had to stay
// English. The joined SENTENCE was the problem, so the join went: PartialReadBanner
// takes `{ label, detail }` and renders the Postgres reason as <code>, which
// marks it as machine output without a word of any language. With the two
// halves separated the label is ordinary product copy and lifts like any other.
//
// All FOUR family-facing pages converted together — nothing is half-done:
// guardian (6 strings this scanner could see, 8 labels in fact), command-center
// (3 of 5), calm (its banner title) and activity. The reason the scanner's count
// and the label count differ is `looksLikeCopy`, which drops single-word
// strings: it never saw 'foi', 'agent' or 'grocery' at all, which is also why
// the note above says six pages when there were nine sites.
//
// The five SUPER ADMIN pages — admin/, admin/reports/, admin/wallet/,
// admin/system/, admin/users/ — are deliberately NOT converted and stay English
// end to end. app/(app)/admin/layout.tsx redirects anyone who is not a super
// admin, so no family reaches them, and their diagnostics are evidence for
// whoever is holding the pager. That is the product decision the row said had to
// be made, and it is checked rather than asserted: the last case of
// tests/a-failed-read-names-itself-in-the-familys-language.test.ts fails if a
// joined English diagnostic appears anywhere outside that gate.
//
// So the delta is the 6 named above plus command-center's 3 and calm's banner
// title. 2,817 − 10 = 2,807.
//
// ── RAISED FOR A STRICTER SCANNER: 2,800 -> 2,889 (I18N-002) ────────────────
//
// The first legitimate reason, and measured the way this block says to measure
// it: the tree held fixed, the scanner varied. The scanner now reads a failure
// message or a toast written as a template literal —
// `error: \`Blocked by household policy: ${reason}\``, `toastError(\`Upload
// failed: ${msg}\`)` — which NOT_COPY's backtick rule had hidden. Over this
// tree the previous scanner counts 2,800 and this one 2,889: eighty-nine
// messages that were already shipping in English, none of them new. The ceiling
// is set to the measurement rather than to 2,807 + 89, so the seven strings of
// slack the surface had banked are banked here too.
//
// Then lowered to 2,878 as eleven of them were translated: the Family Wallet's
// toasts and its "Only … available in Spend." refusal, which children see. A
// ceiling that is not lowered when strings are fixed lets them come back free.
//
// Lowered again to 2,862 as sixteen module toasts were translated: copied,
// snoozed, approved, saved, disconnected, a file too large, a pin limit.
//
// Lowered to 2,838 as twenty-four more module and trip toasts were translated.
//
// Then to 2,825 as the AI daily-limit, sync, weather, social-feed, language,
// medical and feedback-upload messages were translated (the feedback one is
// now a generic message that no longer leaks the storage error).
//
// Then to 2,812 as the thirteen "Blocked by household policy: …" refusals in
// the wallet, money and invest actions were translated — reason included: the
// trust engine's deny paths now carry a catalogue key and code-valued params.
//
// Then to 2,809 with the calendar-sync count and the admin campaign-send and
// lead-score recompute toasts.
//
// Then to 2,792 as the Guardian dashboard was localized as a whole: its
// status contexts, call statuses, stat tiles, heading and both toasts.
//
// Then to 2,790 with the care log: its type labels (chips, entries, picker)
// now come from the catalogue rather than an English constant in lib/.
//
// Then to 2,789 with the moving module's status labels, the same shape.
//
// Then to 2,784 as the last five were translated: the social post-permission
// refusal, the marketplace order-step error (which also stopped echoing the
// caller's status), the admin feedback and ticket-status messages, and the
// voice module's route confirmations. Every template finding the scanner can
// see is now translated; what remains here is ordinary strings.
//
// Raised 2,784 -> 2,926 for the one legitimate reason (I18N-003): the scanner
// now also reads a template literal in a copy-carrying attribute (aria-label,
// title, placeholder, alt, label, description) and one standing alone as a JSX
// child. Measured with the tree held fixed: the previous scanner counts 2,784 and
// this one 2,926, 142 attribute templates and no JSX-child ones (the tree's child
// templates are separators such as ` · ${when}`), every one an existing English
// string a screen reader or tooltip already shows. The gated surfaces stay at zero.
//
// Then lowered to 2,924 as two strings were translated with A11Y-003 and
// MAIN-F-D06: the contact list's "Unknown" and the notes list's "Untitled".
// The scanner also now reads a confirm() prompt, template or quoted (I18N-005).
// Measured with the tree held fixed that adds nothing here: main had already
// replaced the English prompts with its translated confirm dialog, and every
// confirm() left in the tree passes a catalogue key.
//
// Then 63 of I18N-003's attribute templates ("Edit ${name}", "Move ${x} up",
// "Approve: ${title}") through 34 shared itemAction.* keys, and the assistant
// pane's "New conversation" fallback, 2,924 -> 2,860.
//
// Then batch 2: 70 context-specific attribute templates (wallet dialog titles,
// star ratings with a one/many split, inventory, closet, routing placeholders,
// theme toggle, OTP digits and more), 2,860 -> 2,790.
// Then the scanner got more precise: it no longer reads TypeScript between two
// generics (`type A = Tables<'a'>; type B = Tables<'b'>`) as a JSX text node.
// 125 findings were that, not copy, 2,790 -> 2,665.
// Then the medical and dental records page and its printed sheets: per-kind
// catalogue sentences instead of "Add {Doctor}" and "{Dental} Providers",
// 2,665 -> 2,654.
// Then the Insurance Hub and Trip Planner: each policy type, frequency, trip
// status and item kind carries the catalogue key it shows, and the policy
// detail rows are keys, 2,654 -> 2,645.
//
// Then the first batch of sentence templates (two of them confirm prompts
// this scanner already read), 2,645 -> 2,644.
//
// Then sentence-template batch 2, including the English text beside each template
// (the family dashboard's suggestion buttons, budget messages, auction states),
// 2,644 -> 2,636.
//
// Then sentence-template batch 4 and the English text beside it, 2,636 -> 2,617.
// Then the page titles (I18N-004): 248 English `metadata.title` strings moved
// into generateMetadata() and the catalogue, 2,617 -> 2,369.
// Then the command bar's labels, 2,369 -> 2,368.
// ── RAISED 2,807 → 2,819, and it is the merge reason again (PR #548, Q68) ────
//
// Same method as the paragraph above: one scanner, three trees.
//
//     origin/main 7e54596d                          2,807
//     claude/bubaly-repo-connect-etzqg7 pre-merge   2,825
//     HEAD, the merge of the two                    2,819
//
// So the merge LOWERED the branch's number by six and added nothing on top of
// the union. The +12 over main is the branch's own surface, and it
// classifies, site by site, into three kinds (per-file delta, merged − main):
//
//   TYPE-INDEX NOISE, not copy. `Database['public']['Tables'][…]['Insert']`
//   reads to this scanner as the quoted words "Tables" and "Insert". The
//   branch declared the Guardian tables and typed its writes, so these appear
//   where main had casts: guardian/actions.ts, recipes/discover and
//   recipes/vote actions, api/guardian/inbound/voice. The medical-records,
//   moving and projects modules' `type X = Tables<…>` lines are the same shape.
//
//   SERVER FALLBACK SENTENCES passed to describeActionError(error, '…'), the
//   rule tests/the-database-does-not-talk-to-the-browser.test.ts enforces:
//   concierge-calls, moment-actions, sync/feeds, recipes/discover and vote.
//   They replaced raw `error.message` returns, which the scanner could not see
//   and which were worse — Postgres text in front of a family.
//
//   TOAST COPY in modules the branch touched for other reasons (fridge-chef,
//   scan-module, calendar-sync-panel, child-access-manager, two admin controls):
//   real, English, and backlog; each is listed by the scanner by file.
//
// Nothing here is newly-shipped untranslated product copy that main had
// translated; where the branch touched main's translated surface, main's
// strings were kept.
//
// ── MERGED WITH MAIN AFTER #583 (PORT-001): 2,368 and 2,819 -> 2,327 ─────────
//
// The port above stood at 2,368 and main at 2,819, each measured on its own
// tree with its own scanner. The merged tree, measured with the merged scanner
// (main's quoted-or-template toast rule in place of the port's separate toast
// template rule), counts 2,327: lower than either, because each side had
// translated strings the other still counted.
// ── MERGED WITH MAIN THROUGH #606: 2,327 -> 2,339 ──────────────────────────
//
// Raised, for one reason, by exactly what that reason adds. Main's P-10 review
// (711b15c3, #585) changed thirteen withAiRequest call sites to record a FIXED
// English label ("Generate a briefing", "Find a pro", …) in
// ai_requests.request_text instead of what the person typed, because every
// active family member can read that table (0250). Its guard holds every call
// site to a literal, so these cannot become t() calls. They are record labels,
// not copy: the one screen that renders request_text for them is the
// English-only super-admin AI Activity page. The tree stood one under the old
// ceiling, so thirteen new labels move the count by twelve.
//
// PR585/598 integration, 2026-09-27: the unchanged current scanner measures
// 2,650 findings across 593 app/components files with INVARIANT.txt present.
// Bank the translated public/auth/control copy: tighten by169, do not loosen
// the gate or compare differently configured scanners.
//
// ── MERGED WITH MAIN THROUGH #601: -> 2,208 ────────────────────────────────
//
// Both lines above measured their own tree. This tree holds main's translated
// public, auth and control copy AND the port's page titles and labels, and the
// one scanner counts 2,208 across it. Banked as the ceiling.
const CEILING = 2208;

describe('the ungated i18n surface does not get worse', () => {
  const findings = scanPaths(['app', 'components']);
  const total = findings.reduce((n: number, r: { findings: unknown[] }) => n + r.findings.length, 0);

  it('scans the surface it claims to (non-vacuity)', () => {
    // A scanner that silently found nothing would satisfy the ceiling forever.
    // Counted as files READ, not files with findings: the latter falls every
    // time a page is translated (it was > 400; 362 after the page titles), so
    // it measured progress, not whether the scanner was looking.
    expect(scannedFileCount(['app', 'components'])).toBeGreaterThan(900);
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
    // A toast template is reported whole, holes included (main's toast rule,
    // which tests the prose and hands back the real string).
    expect(texts).toContain('Upload failed: ${message}');
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

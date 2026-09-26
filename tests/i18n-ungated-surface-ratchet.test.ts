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
const CEILING = 2807;

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

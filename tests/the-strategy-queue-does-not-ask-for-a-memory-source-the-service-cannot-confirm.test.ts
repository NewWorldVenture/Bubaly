// SPEC-001 — the clause was wrong, not the code, and this keeps it that way.
//
// `docs/STRATEGY_WORK_QUEUE.md` S-14 asked for onboarding answers to be written
// with `family_facts.source = 'onboarding'` AND to be confirmed facts. Those two
// requirements cannot both be met, because in this codebase the source token IS
// the lane selector:
//
//   * `MEMORY_SOURCES` (lib/services/memory/index.ts) refuses an unknown token
//     in TypeScript, before Postgres or its CHECK constraint is ever consulted —
//     so "widen the constraint by migration" would change nothing.
//   * `fromPerson` (same file) sends 'user' and 'import' to the confirmed lane
//     (`family_facts`) and everything else to `family_playbook_suggestions`, the
//     review inbox. An 'onboarding' source would make these answers UNconfirmed.
//
// And the clause's own `asked_for=true` already MEANS source 'user' — that is
// the translation lib/ai/tools/memory.ts does. So the clause was one knob set to
// two contradictory positions, and lib/onboarding/facts.ts writing 'user' with
// the provenance in `notes` is the only faithful reading of it. The remedy was
// to amend the document.
//
// Why this is worth a guard rather than a one-time edit. The failure it prevents
// is not a typo: it is a plausible-looking "fix" in the other direction. A later
// reader who finds the constant disagreeing with the queue has every reason to
// assume the CODE is the deviation — that is exactly what the audit assumed, and
// what the constant's own header used to say. So this pins the two together and,
// when they disagree, says which one is right and why. It reads files rather than
// stubbing anything: the point is the agreement between a document and a shipped
// constant, and there is nothing to mock.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_SOURCES } from '@/lib/services/memory';
import { ONBOARDING_FACT_NOTE, ONBOARDING_FACT_SOURCE } from '@/lib/onboarding/facts';

const QUEUE = 'docs/STRATEGY_WORK_QUEUE.md';

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

/**
 * The OPERATIVE block for a section: from its `### S-nn` heading to the next
 * `###`. This is the half of the document somebody builds from — the BUILD
 * items, the tests-to-add list and "Done when".
 *
 * Scoping matters, and it is the same distinction the migration-name guard
 * draws between documents that are acted on and archives that record. The
 * verification narrative further up the file has to be able to QUOTE the dead
 * `'onboarding'` value in order to explain that it was refused; a blanket ban on
 * the token would fail on the sentence doing the explaining. An instruction has
 * no such need, so inside the operative block every source token must be live.
 */
function operativeSection(heading: string): string {
  const text = read(QUEUE);
  const start = text.indexOf(`\n### ${heading}`);
  expect(start, `${QUEUE} no longer has a "### ${heading}" section`).toBeGreaterThan(-1);
  const after = text.indexOf('\n### ', start + 1);
  return text.slice(start, after === -1 ? text.length : after);
}

/** The verification narrative's S-14 bullet, flattened to one line for prose matching. */
function narrativeBullet(): string {
  const text = read(QUEUE);
  const start = text.indexOf('> * **`S-14`');
  expect(start, `${QUEUE} no longer has an S-14 verification bullet`).toBeGreaterThan(-1);
  const after = text.indexOf('\n> * **`S-1', start + 1);
  return text
    .slice(start, after === -1 ? text.length : after)
    .replace(/^>\s?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The remedy table's S-14 row, whole. Pipes are the column separators, so it is read as prose. */
function remedyRow(): string {
  const row = read(QUEUE).split('\n').find((l) => l.includes('`S-14`') && l.includes('|'));
  expect(row, `${QUEUE} no longer has an S-14 row in the remedy table`).toBeTruthy();
  return row ?? '';
}

/**
 * Every `family_facts.source` value a passage NAMES: `source 'user'`,
 * `source = 'onboarding'`, `family_facts.source = 'x'`. Straight and curly
 * quotes both, because prose in this repository uses both.
 */
function sourceTokensIn(passage: string): string[] {
  return [...passage.matchAll(/source\s*(?:=\s*)?['’"`]([a-z_]+)['’"`]/g)].map((m) => m[1]);
}

/**
 * The claim this guard exists to refuse: that SPEC-001 has two symmetric ways to
 * close, amend-or-migrate. It does not. Matching the CLAIM rather than a fixed
 * sentence is deliberate — the wording differed in the two places it appeared
 * ("amend the clause, or migrate" in the table, "amending the clause or widening
 * the constraint by migration" in the narrative) and a guard keyed to either
 * verbatim string would have missed the other.
 */
const OFFERS_MIGRATION = /amend(?:ing|ed)? the clause,? or (?:migrat|widen|by migrat)/i;

describe('the strategy queue does not ask for a memory source the service cannot confirm', () => {
  it('names, for onboarding answers, only source values rememberFact accepts', () => {
    const section = operativeSection('S-14');
    const named = [...new Set(sourceTokensIn(section))];
    const unknown = named.filter((token) => !(MEMORY_SOURCES as string[]).includes(token));

    expect(unknown,
      `${QUEUE} S-14 instructs a builder to write family_facts.source ${unknown.map((t) => `'${t}'`).join(', ')}, ` +
      'which rememberFact refuses outright (lib/services/memory/index.ts MEMORY_SOURCES). Adding the token to ' +
      'MEMORY_SOURCES would not help either: the source is the confirmed-lane selector, so a new value routes to ' +
      'family_playbook_suggestions instead of family_facts. Amend the clause, do not widen the constraint.',
    ).toEqual([]);
  });

  it('names the source the onboarding wizard actually writes, and the note that carries provenance', () => {
    const section = operativeSection('S-14');

    expect([...new Set(sourceTokensIn(section))],
      `${QUEUE} S-14 and lib/onboarding/facts.ts ONBOARDING_FACT_SOURCE ('${ONBOARDING_FACT_SOURCE}') disagree. ` +
      'They are two halves of one decision and move together.',
    ).toEqual([ONBOARDING_FACT_SOURCE]);

    // The provenance half. 'user' alone would lose WHERE the answer came from,
    // and the note is what the Family Memory UI shows, so the clause has to ask
    // for it or the next builder drops it as decoration.
    expect(section.includes(ONBOARDING_FACT_NOTE),
      `${QUEUE} S-14 no longer names the marker "${ONBOARDING_FACT_NOTE}" that carries onboarding provenance in notes.`,
    ).toBe(true);
  });

  it('records one way to close SPEC-001, not a choice between amending and migrating', () => {
    for (const [where, passage] of [['the remedy table row', remedyRow()], ['the verification narrative', narrativeBullet()]] as const) {
      expect(OFFERS_MIGRATION.test(passage),
        `${QUEUE}: ${where} offers migrating as an alternative to amending the S-14 clause. It is not one — ` +
        'MEMORY_SOURCES rejects an unknown token before Postgres sees it, and the token is the lane selector, so ' +
        `a widened CHECK would file onboarding answers in the review inbox. Passage: ${passage.slice(0, 200)}`,
      ).toBe(false);
    }
  });

  it('keeps the reason migrating is not an option, so the next reader does not rediscover it', () => {
    const bullet = narrativeBullet();
    // Code identifiers, not prose: an editor may rewrite the sentences freely,
    // but deleting the two facts that make the conclusion checkable is the
    // regression — that is how this became a two-option row in the first place.
    for (const identifier of ['MEMORY_SOURCES', 'family_playbook_suggestions']) {
      expect(bullet.includes(identifier),
        `${QUEUE}'s S-14 narrative no longer names ${identifier}, which is the evidence that widening the CHECK ` +
        'cannot close SPEC-001. Without it the row reads as a free choice again.',
      ).toBe(true);
    }
  });

  it('is pinned to the live lane rule: the source it names is one the confirmed lane admits', () => {
    // Read the rule rather than restating it. Hardcoding ['user','import'] here
    // would let the service change its lane rule out from under onboarding while
    // this test went on passing — the coupling IS the thing under guard.
    const service = read('lib/services/memory/index.ts');
    const rule = /const fromPerson = ([^;]+);/.exec(service);
    expect(rule, 'lib/services/memory/index.ts no longer has a `const fromPerson = …;` lane rule').toBeTruthy();

    expect(rule?.[1].includes(`'${ONBOARDING_FACT_SOURCE}'`),
      `The confirmed-lane rule no longer admits '${ONBOARDING_FACT_SOURCE}', so onboarding answers now land in the ` +
      `review inbox unconfirmed. Lane rule: ${rule?.[1]}`,
    ).toBe(true);
    expect(rule?.[1]).toContain('actorKind');
  });

  // Non-vacuity floor. Every case above is a negative — an empty list, a false
  // regex, an absent token — and every one of them passes trivially if the
  // parsers match nothing. So prove each parser reads something real, and prove
  // each can still say NO.
  it('and the parsers are reading the real document, not matching nothing', () => {
    const section = operativeSection('S-14');
    expect(section.length).toBeGreaterThan(1000);
    expect(section).toContain('rememberFact');
    // Three live mentions: the BUILD item, the tests-to-add line, "Done when".
    expect(sourceTokensIn(section).length).toBeGreaterThanOrEqual(3);

    expect(MEMORY_SOURCES.length).toBe(4);
    expect(MEMORY_SOURCES as string[]).toContain('ai_conversation');
    expect(ONBOARDING_FACT_SOURCE).toBe('user');

    // Negative control on the token parser: the clause as originally written must
    // be caught. If this ever comes back empty, case one is vacuous.
    const asWritten = "call rememberFact for each structured answer with source 'onboarding' and asked_for=true";
    expect(sourceTokensIn(asWritten)).toEqual(['onboarding']);
    expect(MEMORY_SOURCES as string[]).not.toContain('onboarding');

    // Negative control on the remedy matcher: both original wordings must trip
    // it, or case three is a regex that can never fire.
    expect(OFFERS_MIGRATION.test('amend the clause, or migrate')).toBe(true);
    expect(OFFERS_MIGRATION.test('closing it means amending the clause or widening the constraint by migration')).toBe(true);
    expect(OFFERS_MIGRATION.test('closed by amending the clause; migrating is not a live option')).toBe(false);

    // And the narrative/table locators found distinct passages, not the same line twice.
    expect(remedyRow()).not.toBe(narrativeBullet());
    expect(narrativeBullet().length).toBeGreaterThan(200);
  });
});

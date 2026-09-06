import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HANDLE_IT_REQUESTS, NOT_HANDLED, handleItRequest } from '@/lib/operating-index/handle-it';

// §48 calls "[Let Bubaly handle it]" the signature moment, and it existed on
// exactly one screen — /dashboard/readiness — which is not where anyone lands.
// A family saw what was wrong and had nothing to press.
//
// The risk in fixing that is the opposite failure: a button on everything,
// including the things a household must decide for itself. So every suggestion
// the operating index can produce is classified — handled with a real request
// sentence, or named in NOT_HANDLED with the reason. This file fails when a new
// one is neither.

const SCORE = readFileSync('lib/operating-index/score.ts', 'utf8');

/** Every suggestion id `buildSuggestions` can emit, read from the source. */
function suggestionIds(): string[] {
  const build = SCORE.slice(SCORE.indexOf('function buildSuggestions'));
  const body = build.slice(0, build.indexOf('\nfunction '));
  return [...new Set([...body.matchAll(/id: '([a-z-]+)', dimension:/g)].map((m) => m[1]))].sort();
}

describe('every suggestion is classified', () => {
  it('the parser still finds the suggestion list', () => {
    // If buildSuggestions is rewritten in a shape this cannot read, the two
    // assertions below would pass vacuously — which is the failure mode that
    // makes a coverage test worthless.
    expect(suggestionIds().length).toBeGreaterThanOrEqual(10);
    expect(suggestionIds()).toContain('resolve-conflicts');
  });

  it('is either handled or deliberately not, never neither', () => {
    const unclassified = suggestionIds()
      .filter((id) => !(id in HANDLE_IT_REQUESTS) && !(id in NOT_HANDLED));
    expect(
      unclassified,
      `new suggestion(s) with no decision: ${unclassified.join(', ')}\n` +
      'Give each one a request sentence in HANDLE_IT_REQUESTS, or a reason in NOT_HANDLED.',
    ).toEqual([]);
  });

  it('is never both', () => {
    const both = Object.keys(HANDLE_IT_REQUESTS).filter((id) => id in NOT_HANDLED);
    expect(both, `contradictory classification: ${both.join(', ')}`).toEqual([]);
  });

  it('classifies nothing that does not exist', () => {
    // A stale entry is how a list stops describing the code.
    const ids = new Set(suggestionIds());
    const ghosts = [...Object.keys(HANDLE_IT_REQUESTS), ...Object.keys(NOT_HANDLED)].filter((id) => !ids.has(id));
    expect(ghosts, `no longer emitted — drop them: ${ghosts.join(', ')}`).toEqual([]);
  });
});

describe('what Bubaly offers to handle', () => {
  it('never offers to move money or to make the family’s decision', () => {
    // The four that matter most: two are payments, two are a household making
    // up its mind. A button here would be Bubaly taking a call that is not its
    // own — and for the approvals one, approving its own requests.
    for (const id of ['fix-negative-balances', 'cover-bills', 'decide-approvals', 'close-votes']) {
      expect(handleItRequest(id), `${id} must not offer a button`).toBeNull();
      expect(NOT_HANDLED[id], `${id} needs a stated reason`).toBeTruthy();
    }
  });

  it('gives the planner a domain, an object and a verb — not "get us ready"', () => {
    // The request is what the planner reads. A vague one produces a run that
    // does nothing useful, which teaches a family the button is broken.
    for (const [id, request] of Object.entries(HANDLE_IT_REQUESTS)) {
      expect(request.length, `${id} is too terse to plan from`).toBeGreaterThan(50);
      expect(request, `${id} should read as a sentence`).toMatch(/\.$/);
      expect(request.toLowerCase(), `${id} is too vague`).not.toMatch(/^get us ready|^handle (it|this)/);
    }
  });

  it('is offered where families actually land, not only on the readiness page', () => {
    const foi = readFileSync('app/(app)/dashboard/family-operating-index/page.tsx', 'utf8');
    expect(foi).toContain('handleItRequest(s.id)');
    expect(foi).toContain('<HandleItButton request={request} />');
    // And the link out survives: handing someone a button is not a reason to
    // take away the door to the module that owns the thing.
    expect(foi).toContain('href={s.href}');
  });
});

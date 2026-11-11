// "Bubaly recommends" blends the vote with an objective fit from the Decision
// Engine (cost and travel). The blend read the fit as `fit?.score ?? 50`,
// meaning "neutral when there is nothing to judge", but the engine answers 0,
// not nothing, for an option with no cost and no travel time. So an option
// whose cost was simply left blank was scored as the WORST possible fit,
// labelled "weaker on cost/travel", and lost 45 blended points to the cheapest
// option that had a number typed in: five votes with no cost scored 55, two
// votes with the lower of two costs scored 67, and the family was told Bubaly
// recommends the option two of them voted for.
//
// A blank is not evidence either way, so it is neutral (50). The same holds
// for a number nothing can be compared with: the engine scores a cost that is
// the only one, or the same on every option, as 0, and once a blank is 50 that
// would put the option with a price BELOW the one without. A metric counts
// toward fit only when the options differ on it. Hard limits are untouched: a
// lone cost over the budget is still over the budget.
import { describe, expect, it } from 'vitest';
import { facilitateConsensus, type ConsensusConstraints, type ConsensusOption } from '@/lib/voting/consensus';

const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const consensus = (options: ConsensusOption[], constraints: ConsensusConstraints = {}) =>
  facilitateConsensus(options, constraints, 'en-US', echo);
const opt = (id: string, votes: number, extra: Partial<ConsensusOption> = {}): ConsensusOption => ({ id, label: id.toUpperCase(), votes, ...extra });
const by = (r: ReturnType<typeof consensus>, id: string) => r.ranked.find((x) => x.id === id)!;

describe('an option whose cost was left blank', () => {
  it('does not lose the recommendation to a far lower-voted option only because that one has a cost typed in', () => {
    const r = consensus([opt('leader', 5), opt('cheap', 2, { costCents: 1000 }), opt('dear', 0, { costCents: 9000 })]);
    expect(r.recommendation?.id).toBe('leader');
    expect(r.voteLeader?.id).toBe('leader');
    expect(r.conflicts).toEqual([]);
    expect(r.ranked.map((x) => [x.id, x.fitScore, x.blendedScore])).toEqual([['leader', 50, 78], ['cheap', 100, 67], ['dear', 0, 0]]);
  });

  it('is scored the same as an option whose cost is the only one in the poll', () => {
    const r = consensus([opt('leader', 3), opt('costed', 2, { costCents: 4000 })]);
    expect(r.ranked.map((x) => [x.id, x.fitScore, x.blendedScore])).toEqual([['leader', 50, 78], ['costed', 50, 59]]);
    expect(r.recommendation?.id).toBe('leader');
  });

  it('is not described as weaker on cost or travel', () => {
    const r = consensus([opt('leader', 3), opt('costed', 2, { costCents: 4000 })]);
    expect(by(r, 'leader').rationale).toBe('3 votes (60%).');
    expect(by(r, 'costed').rationale).toBe('2 votes (40%).');
  });

  it('is neutral, between the best and the worst, when the other options can be compared with each other', () => {
    const r = consensus([opt('blank', 3), opt('cheap', 1, { costCents: 1000 }), opt('dear', 1, { costCents: 9000 })]);
    expect([by(r, 'cheap').fitScore, by(r, 'blank').fitScore, by(r, 'dear').fitScore]).toEqual([100, 50, 0]);
    expect(by(r, 'blank').rationale).not.toContain('weaker on cost/travel');
    expect(by(r, 'dear').rationale).toContain('weaker on cost/travel');
  });
});

describe('a poll where no option has a cost or a travel time', () => {
  it('gives every option the same neutral fit, and calls none of them weaker on cost or travel', () => {
    const r = consensus([opt('a', 5), opt('b', 2), opt('c', 0)]);
    expect(r.ranked.map((x) => [x.id, x.fitScore])).toEqual([['a', 50], ['b', 50], ['c', 50]]);
    expect(r.ranked.map((x) => x.rationale)).toEqual(['5 votes (71%).', '2 votes (29%).', 'no votes yet.']);
    expect(r.recommendation?.id).toBe('a');
  });
});

describe('a metric the options do not differ on', () => {
  it('a lone cost does not put the most-voted option below one with no cost at all', () => {
    const r = consensus([opt('costed', 3, { costCents: 4000 }), opt('blank', 2)]);
    expect(r.ranked.map((x) => [x.id, x.fitScore])).toEqual([['costed', 50], ['blank', 50]]);
    expect(r.recommendation?.id).toBe('costed');
    expect(by(r, 'costed').rationale).toBe('3 votes (60%).');
  });

  it('the same cost on every option that has one is no reason to prefer the option that has none', () => {
    const r = consensus([opt('a', 3, { costCents: 5000 }), opt('b', 1, { costCents: 5000 }), opt('blank', 2)]);
    expect(r.ranked.map((x) => [x.id, x.fitScore])).toEqual([['a', 50], ['blank', 50], ['b', 50]]);
    expect(r.recommendation?.id).toBe('a');
  });

  it('earns no fit credit: there is nothing to compare a lone travel time with', () => {
    const r = consensus([opt('a', 2, { costCents: 1000 }), opt('b', 2, { costCents: 1000, travelMinutes: 20 }), opt('c', 0, { costCents: 9000 })]);
    expect([by(r, 'a').fitScore, by(r, 'b').fitScore, by(r, 'c').fitScore]).toEqual([100, 100, 0]);
  });

  it('is still held to the hard limits: a lone cost over the budget is infeasible', () => {
    const r = consensus([opt('dear', 5, { costCents: 20000 }), opt('blank', 1)], { budgetCents: 10000 });
    expect(by(r, 'dear').feasible).toBe(false);
    expect(by(r, 'dear').violations.join()).toContain('decisionEngine.overBudgetBy');
    expect(r.recommendation?.id).toBe('blank');
    expect(r.conflicts[0]).toMatch(/^votingConsensus\.favoriteDoesNotFitClosestPick /);
  });

  it('and a lone travel time over the limit is infeasible too', () => {
    const r = consensus([opt('far', 5, { travelMinutes: 300 }), opt('blank', 1)], { maxTravelMinutes: 120 });
    expect(by(r, 'far').feasible).toBe(false);
    expect(by(r, 'far').violations.join()).toContain('decisionEngine.overTravelLimit');
  });
});

describe('options that can be compared are still compared', () => {
  it('the cheaper of two costed options keeps its better fit', () => {
    const r = consensus([opt('pop', 9, { costCents: 9000 }), opt('lean', 4, { costCents: 1000 })], { budgetCents: 100000 });
    expect([by(r, 'pop').fitScore, by(r, 'lean').fitScore]).toEqual([0, 100]);
    expect(by(r, 'lean').rationale).toBe('4 votes (31%) · within budget · strong objective fit.');
  });
});

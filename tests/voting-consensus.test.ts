import { describe, it, expect } from 'vitest';
import {
  facilitateConsensus,
  budgetCapForCategory,
  CATEGORY_BUDGET_KEYWORDS,
  type ConsensusOption,
  type ConsensusConstraints,
} from '@/lib/voting/consensus';

// facilitateConsensus hands the READER's locale and translator to the Decision
// Engine, which words the budget breach with them. An echo translator shows the
// sentence chosen and the amount without depending on the catalogue.
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const consensus = (options: ConsensusOption[], constraints: ConsensusConstraints = {}) =>
  facilitateConsensus(options, constraints, 'en-US', echo);

const opt = (id: string, label: string, votes: number, extra: Partial<ConsensusOption> = {}): ConsensusOption => ({
  id, label, votes, ...extra,
});

describe('facilitateConsensus — degenerate cases', () => {
  it('empty options → empty result', () => {
    const r = consensus([]);
    expect(r.ranked).toEqual([]);
    expect(r.recommendation).toBeNull();
    expect(r.voteLeader).toBeNull();
    expect(r.consensusLevel).toBe(0);
    expect(r.totalVotes).toBe(0);
  });

  it('with no metrics/constraints, collapses to the pure vote ranking', () => {
    const r = consensus([
      opt('a', 'Pizza', 5),
      opt('b', 'Tacos', 2),
      opt('c', 'Sushi', 0),
    ]);
    expect(r.ranked.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(r.recommendation?.id).toBe('a');
    expect(r.voteLeader?.id).toBe('a');
    expect(r.totalVotes).toBe(7);
    expect(r.conflicts).toEqual([]);
  });
});

describe('facilitateConsensus — vote share & consensus level', () => {
  it('computes vote percentages of total cast', () => {
    const r = consensus([opt('a', 'A', 3), opt('b', 'B', 1)]);
    const a = r.ranked.find((x) => x.id === 'a')!;
    const b = r.ranked.find((x) => x.id === 'b')!;
    expect(a.votePct).toBe(75);
    expect(b.votePct).toBe(25);
  });

  it('consensusLevel = leader share (high when concentrated, low when split)', () => {
    expect(consensus([opt('a', 'A', 9), opt('b', 'B', 1)]).consensusLevel).toBeCloseTo(0.9, 5);
    expect(consensus([opt('a', 'A', 5), opt('b', 'B', 5)]).consensusLevel).toBeCloseTo(0.5, 5);
  });
});

describe('facilitateConsensus — budget as a hard constraint', () => {
  it('flags the vote favorite when it is over budget and recommends a feasible option', () => {
    const r = consensus(
      [
        opt('lux', 'Steakhouse', 6, { costCents: 20000 }),   // most votes, over budget
        opt('mid', 'Trattoria', 3, { costCents: 8000 }),     // within budget
      ],
      { budgetCents: 10000 },
    );
    const lux = r.ranked.find((x) => x.id === 'lux')!;
    expect(lux.feasible).toBe(false);
    expect(lux.violations.join()).toMatch(/decisionEngine\.overBudgetBy/);
    expect(lux.violations.join()).toContain('$100'); // 200 − 100
    // Infeasible favorite is pushed below the feasible option.
    expect(r.ranked[0].id).toBe('mid');
    expect(r.recommendation?.id).toBe('mid');
    expect(r.voteLeader?.id).toBe('lux'); // raw votes still name the favorite
    // One catalogue sentence around the engine's breach, never English wrapped
    // around a breach that is in the reader's language.
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatch(/^votingConsensus\.favoriteDoesNotFitClosestPick /);
    expect(r.conflicts[0]).toContain('"favorite":"Steakhouse"');
    expect(r.conflicts[0]).toContain('"pick":"Trattoria"');
    expect(r.conflicts[0]).toContain('decisionEngine.overBudgetBy');
    expect(lux.rationale).toMatch(/^decisionEngine\.doesNotFit .*decisionEngine\.overBudgetBy/);
  });
});

describe('facilitateConsensus — required (dietary) tags', () => {
  it('options missing a required tag are infeasible', () => {
    const r = consensus(
      [
        opt('a', 'BBQ Ribs', 4, { tags: ['meat'] }),
        opt('b', 'Veggie Bowl', 1, { tags: ['vegetarian', 'gluten-free'] }),
      ],
      { requiredTags: ['vegetarian'] },
    );
    const a = r.ranked.find((x) => x.id === 'a')!;
    const b = r.ranked.find((x) => x.id === 'b')!;
    expect(a.feasible).toBe(false);
    expect(a.violations).toEqual([`votingConsensus.missingTags ${JSON.stringify({ tags: 'vegetarian' })}`]);
    expect(b.feasible).toBe(true);
    expect(r.recommendation?.id).toBe('b');
  });

  it('tag matching is case-insensitive and trims', () => {
    const r = consensus(
      [opt('a', 'A', 1, { tags: [' Vegetarian '] })],
      { requiredTags: ['vegetarian'] },
    );
    expect(r.ranked[0].feasible).toBe(true);
  });
});

describe('facilitateConsensus — vote-vs-fit conflict surfacing', () => {
  it('surfaces a conflict when votes and objective fit disagree', () => {
    // Both feasible; "cheap" has far better cost fit but fewer votes than "pricey".
    const r = consensus(
      [
        opt('pricey', 'Resort', 6, { costCents: 9000, travelMinutes: 200 }),
        opt('cheap', 'Cabin', 5, { costCents: 1000, travelMinutes: 30 }),
      ],
      { budgetCents: 100000, voteWeight: 0.3 }, // weight fit heavily
    );
    expect(r.recommendation?.id).toBe('cheap');
    expect(r.voteLeader?.id).toBe('pricey');
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatch(/^votingConsensus\.votesLeanElsewhere /);
    expect(r.conflicts[0]).toContain('"favorite":"Resort"');
    expect(r.conflicts[0]).toContain('"pick":"Cabin"');
  });

  it('no conflict when the favorite is also the recommendation', () => {
    const r = consensus(
      [opt('a', 'A', 8, { costCents: 1000 }), opt('b', 'B', 1, { costCents: 9000 })],
      { budgetCents: 100000 },
    );
    expect(r.recommendation?.id).toBe('a');
    expect(r.voteLeader?.id).toBe('a');
    expect(r.conflicts).toEqual([]);
  });
});

describe('facilitateConsensus — voteWeight blending', () => {
  it('higher voteWeight lets the popular-but-pricier option win', () => {
    const options: ConsensusOption[] = [
      opt('pop', 'Popular', 9, { costCents: 9000 }),
      opt('lean', 'Lean', 4, { costCents: 1000 }),
    ];
    const democratic = consensus(options, { budgetCents: 100000, voteWeight: 0.9 });
    const objective = consensus(options, { budgetCents: 100000, voteWeight: 0.1 });
    expect(democratic.recommendation?.id).toBe('pop');
    expect(objective.recommendation?.id).toBe('lean');
  });
});

describe('budgetCapForCategory', () => {
  const budgets = [
    { category: 'Groceries', amount: 300 },
    { category: 'Dining Out', amount: 150 },
    { category: 'Travel', amount: 500 },
  ];

  it('matches a meal poll to the dining budget (cents)', () => {
    expect(budgetCapForCategory('meal', budgets)).toBe(15000);
  });
  it('matches a vacation poll to the travel budget', () => {
    expect(budgetCapForCategory('vacation', budgets)).toBe(50000);
  });
  it('returns undefined for general and for no match', () => {
    expect(budgetCapForCategory('general', budgets)).toBeUndefined();
    expect(budgetCapForCategory('activity', budgets)).toBeUndefined();
  });
  it('every category key has a keyword list', () => {
    for (const k of ['meal', 'shopping', 'vacation', 'activity', 'general']) {
      expect(Array.isArray(CATEGORY_BUDGET_KEYWORDS[k])).toBe(true);
    }
  });
});

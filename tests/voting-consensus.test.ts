import { describe, it, expect } from 'vitest';
import {
  facilitateConsensus,
  budgetCapForCategory,
  CATEGORY_BUDGET_KEYWORDS,
  type ConsensusOption,
} from '@/lib/voting/consensus';

const opt = (id: string, label: string, votes: number, extra: Partial<ConsensusOption> = {}): ConsensusOption => ({
  id, label, votes, ...extra,
});

describe('facilitateConsensus — degenerate cases', () => {
  it('empty options → empty result', () => {
    const r = facilitateConsensus([]);
    expect(r.ranked).toEqual([]);
    expect(r.recommendation).toBeNull();
    expect(r.voteLeader).toBeNull();
    expect(r.consensusLevel).toBe(0);
    expect(r.totalVotes).toBe(0);
  });

  it('with no metrics/constraints, collapses to the pure vote ranking', () => {
    const r = facilitateConsensus([
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
    const r = facilitateConsensus([opt('a', 'A', 3), opt('b', 'B', 1)]);
    const a = r.ranked.find((x) => x.id === 'a')!;
    const b = r.ranked.find((x) => x.id === 'b')!;
    expect(a.votePct).toBe(75);
    expect(b.votePct).toBe(25);
  });

  it('consensusLevel = leader share (high when concentrated, low when split)', () => {
    expect(facilitateConsensus([opt('a', 'A', 9), opt('b', 'B', 1)]).consensusLevel).toBeCloseTo(0.9, 5);
    expect(facilitateConsensus([opt('a', 'A', 5), opt('b', 'B', 5)]).consensusLevel).toBeCloseTo(0.5, 5);
  });
});

describe('facilitateConsensus — budget as a hard constraint', () => {
  it('flags the vote favorite when it is over budget and recommends a feasible option', () => {
    const r = facilitateConsensus(
      [
        opt('lux', 'Steakhouse', 6, { costCents: 20000 }),   // most votes, over budget
        opt('mid', 'Trattoria', 3, { costCents: 8000 }),     // within budget
      ],
      { budgetCents: 10000 },
    );
    const lux = r.ranked.find((x) => x.id === 'lux')!;
    expect(lux.feasible).toBe(false);
    expect(lux.violations.join()).toMatch(/over budget/i);
    // Infeasible favorite is pushed below the feasible option.
    expect(r.ranked[0].id).toBe('mid');
    expect(r.recommendation?.id).toBe('mid');
    expect(r.voteLeader?.id).toBe('lux'); // raw votes still name the favorite
    expect(r.conflicts.join()).toMatch(/favorite.*Steakhouse.*doesn't fit/i);
  });
});

describe('facilitateConsensus — required (dietary) tags', () => {
  it('options missing a required tag are infeasible', () => {
    const r = facilitateConsensus(
      [
        opt('a', 'BBQ Ribs', 4, { tags: ['meat'] }),
        opt('b', 'Veggie Bowl', 1, { tags: ['vegetarian', 'gluten-free'] }),
      ],
      { requiredTags: ['vegetarian'] },
    );
    const a = r.ranked.find((x) => x.id === 'a')!;
    const b = r.ranked.find((x) => x.id === 'b')!;
    expect(a.feasible).toBe(false);
    expect(a.violations.join()).toMatch(/missing vegetarian/i);
    expect(b.feasible).toBe(true);
    expect(r.recommendation?.id).toBe('b');
  });

  it('tag matching is case-insensitive and trims', () => {
    const r = facilitateConsensus(
      [opt('a', 'A', 1, { tags: [' Vegetarian '] })],
      { requiredTags: ['vegetarian'] },
    );
    expect(r.ranked[0].feasible).toBe(true);
  });
});

describe('facilitateConsensus — vote-vs-fit conflict surfacing', () => {
  it('surfaces a conflict when votes and objective fit disagree', () => {
    // Both feasible; "cheap" has far better cost fit but fewer votes than "pricey".
    const r = facilitateConsensus(
      [
        opt('pricey', 'Resort', 6, { costCents: 9000, travelMinutes: 200 }),
        opt('cheap', 'Cabin', 5, { costCents: 1000, travelMinutes: 30 }),
      ],
      { budgetCents: 100000, voteWeight: 0.3 }, // weight fit heavily
    );
    expect(r.recommendation?.id).toBe('cheap');
    expect(r.voteLeader?.id).toBe('pricey');
    expect(r.conflicts.join()).toMatch(/Votes lean toward .*Resort.*but .*Cabin.* scores higher/i);
  });

  it('no conflict when the favorite is also the recommendation', () => {
    const r = facilitateConsensus(
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
    const democratic = facilitateConsensus(options, { budgetCents: 100000, voteWeight: 0.9 });
    const objective = facilitateConsensus(options, { budgetCents: 100000, voteWeight: 0.1 });
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
